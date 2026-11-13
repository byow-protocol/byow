// The window carrier, site side: the wallet is a web page, opened in a popup, spoken to over postMessage.
// Zero dependencies, browser only.
//
// A wallet URL is arbitrary, so this file assumes the page behind it is hostile: the popup is opened so it
// cannot steer the site's own tab, its origin is pinned from its first message, and nothing it sends is used
// before it has been parsed strictly.

import {
  ByowError,
  CORE_INFO,
  SUPPORTED_VERSIONS,
  fromWireError,
  highestCommonVersion,
  newId,
  parseManifest,
  parseMessage,
  rpcRequest,
} from "../protocol.js";
import { resolveWallet } from "./discovery.js";
import type { CallSpec, Carrier, WalletInfo } from "./wallet.js";

/**
 * How well the wallet window is kept away from the site's own tab.
 * contained     the popup's opener is a same-origin iframe and this engine stops a popup from
 *               navigating opener.top. Measured on Chromium 151 and WebKit 26.5 (experiments/opener). For other
 *               versions and for derivatives (WebViews, Electron) this is ASSUMED from the engine family via the
 *               user agent, not tested at runtime: a cross-origin probe page would be needed and there is none.
 * top-reachable the opener is the iframe, but this engine still lets the popup navigate the site's
 *               top-level tab via opener.top (measured: Firefox). A hostile wallet URL can redirect the site tab.
 * none          the popup was opened directly; opener is the site's own window. Fully navigable.
 */
export type Isolation = "contained" | "top-reachable" | "none";

export interface WindowOptions {
  /** Open the wallet from a same-origin iframe so popup.opener is not the site's window. Default true. */
  isolateOpener?: boolean;
  /** Refuse to talk to a wallet unless isolation is "contained". Default false. */
  requireContainedIsolation?: boolean;
  /** Accept a wallet whose final origin differs from the URL the user gave (it redirected). Default false. */
  allowCrossOriginRedirect?: boolean;
  /** Site policy hook: return false to refuse a wallet origin. Default: allow every wallet. */
  allowOrigin?: (origin: string) => boolean;
  /** Allow http://localhost wallets (development). Default true. */
  allowInsecureLocalhost?: boolean;
  /** window.open features. */
  windowFeatures?: string;
  /** ms from opening the popup to the wallet saying ready. Default 20000. */
  handshakeTimeoutMs?: number;
  /** ms to wait for the user to decide on a request. Default 300000. */
  requestTimeoutMs?: number;
}

// One hidden about:blank iframe per page, same origin as the site and with no script of its own. Wallet
// popups are opened FROM it, so popup.opener is this frame and not the site's own window.
let sharedFrame: HTMLIFrameElement | null = null;

/** Call at page load. Idempotent. A precaution: see windowCarrier. */
export function prepareByow(): void {
  if (typeof document === "undefined") return;
  const mount = () => {
    if (sharedFrame?.isConnected || !document.body) return;
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.style.cssText = "display:none;width:0;height:0;border:0";
    document.body.appendChild(f);
    sharedFrame = f;
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

const CONTAINED_ENGINE = typeof navigator !== "undefined" && /AppleWebKit\//.test(navigator.userAgent);

const NO_READY_HINT =
  "The wallet never said ready. Usual causes: this site sends Cross-Origin-Opener-Policy: same-origin (use same-origin-allow-popups), " +
  "the URL is not a BYOW wallet, or the window was closed.";

// The site has stopped listening, so the wallet window must not keep a live approve button: a user who approves
// after this would sign something the site already reported as failed.
const GIVE_UP = ["timeout", "invalid_response", "origin_mismatch", "wallet_not_allowed", "unsupported_version", "unsupported_method", "unsupported_chain", "unsupported_tx"];

/**
 * A wallet at a URL, or at a bare domain (its front door, /.well-known/byow). Safe to create inside the click
 * handler. Calling prepareByow() at page load is still advised: Chromium, WebKit and Firefox all let a popup
 * open from an iframe created inside the click (experiments/opener, variant C), but creating it early costs
 * nothing and covers engines we did not measure.
 */
export function windowCarrier(walletUrl: string | URL, options: WindowOptions = {}): Carrier {
  const url = resolveWallet(String(walletUrl), { allowInsecureLocalhost: options.allowInsecureLocalhost ?? true });
  const opts = {
    isolateOpener: options.isolateOpener ?? true,
    requireContainedIsolation: options.requireContainedIsolation ?? false,
    allowCrossOriginRedirect: options.allowCrossOriginRedirect ?? false,
    windowFeatures: options.windowFeatures ?? "popup=yes,width=440,height=760",
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 20_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 300_000,
    allowOrigin: options.allowOrigin,
  };
  const windowName = "byow-" + newId().slice(0, 12);
  let busy = false;
  if (opts.isolateOpener) prepareByow();

  /** Must run synchronously inside the user's click: any await before window.open and browsers block it. */
  const openPopup = (): { win: Window; host: Window; isolation: Isolation } => {
    const via = opts.isolateOpener ? sharedFrame?.contentWindow : null;
    if (via) {
      const win = via.open(url.href, windowName, opts.windowFeatures);
      if (win) return { win, host: via, isolation: CONTAINED_ENGINE ? "contained" : "top-reachable" };
    }
    const win = window.open(url.href, windowName, opts.windowFeatures);
    if (!win) throw new ByowError("popup_blocked", "The browser blocked the wallet window. Open it from a click.");
    return { win, host: window, isolation: "none" };
  };

  return {
    kind: "window",
    call(spec: CallSpec) {
      if (busy) return Promise.reject(new ByowError("busy", "A request is already in flight on this wallet handle."));
      // Everything up to and including openPopup is synchronous on purpose.
      let opened: ReturnType<typeof openPopup>;
      try {
        opened = openPopup();
      } catch (e) {
        return Promise.reject(e);
      }
      busy = true;
      const { win, host, isolation } = opened;
      const chan = new Channel(host, win, url.origin, opts);
      return (async () => {
        try {
          if (opts.requireContainedIsolation && isolation !== "contained") {
            throw new ByowError("wallet_not_allowed", `Wallet isolation is "${isolation}"; this site requires "contained".`);
          }
          const wallet = await chan.ready(opts.handshakeTimeoutMs);
          const v = highestCommonVersion(SUPPORTED_VERSIONS, wallet.versions);
          if (!v) throw new ByowError("unsupported_version", "No protocol version in common with this wallet.", { wallet: wallet.versions, sdk: SUPPORTED_VERSIONS });

          const manifest = parseManifest(await chan.call(CORE_INFO, {}, 10_000));
          if (!manifest.versions.includes(v)) throw new ByowError("invalid_response", "Wallet manifest does not list the version it announced.");
          spec.check(manifest); // refuse here, before the user is shown anything
          const info: WalletInfo = { carrier: "window", origin: wallet.origin, manifest, isolation };

          const result = await chan.call(spec.method, spec.params, opts.requestTimeoutMs, true);
          return { result, info };
        } catch (e) {
          if (e instanceof ByowError && GIVE_UP.includes(e.code)) {
            try {
              win.close();
            } catch {
              /* already gone */
            }
          }
          throw e;
        } finally {
          chan.dispose();
          busy = false;
        }
      })();
    },
  };
}

/** One popup document's conversation. Pins the wallet origin on byow_ready; ignores everything else. */
class Channel {
  private pinned: string | null = null;
  private onReady: ((w: { origin: string; versions: string[] }) => void) | null = null;
  private onFatal: ((e: ByowError) => void) | null = null;
  private pending = new Map<string, (r: { ok: true; result: unknown } | { ok: false; error: ByowError }) => void>();
  private closedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: Window,
    private readonly win: Window,
    private readonly expectedOrigin: string,
    private readonly opts: { allowCrossOriginRedirect: boolean; allowOrigin?: (o: string) => boolean },
  ) {
    // Replies may come to the opener (the isolating iframe) or, from wallets that answer `event.source`,
    // to the top window that sent the request. Listen on both; the source and origin gates are identical.
    host.addEventListener("message", this.onMessage);
    if (host !== window) window.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    this.host.removeEventListener("message", this.onMessage);
    window.removeEventListener("message", this.onMessage);
    if (this.closedTimer) clearInterval(this.closedTimer);
  }

  ready(timeoutMs: number): Promise<{ origin: string; versions: string[] }> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ByowError("timeout", NO_READY_HINT)), timeoutMs);
      this.onReady = (w) => {
        clearTimeout(t);
        resolve(w);
      };
      this.onFatal = (e) => {
        clearTimeout(t);
        reject(e);
      };
    });
  }

  call(method: string, params: Record<string, unknown>, timeoutMs: number, interactive = false): Promise<unknown> {
    const origin = this.pinned;
    if (!origin) return Promise.reject(new ByowError("internal", "call before ready"));
    const id = newId();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new ByowError("timeout", "The wallet did not answer in time."));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(t);
        if (r.ok) resolve(r.result);
        else reject(r.error);
      });
      // A user who closes the window has said no. Anything else (timeout, blocked) is not a "no".
      if (interactive && !this.closedTimer) {
        this.closedTimer = setInterval(() => {
          if (this.win.closed && this.pending.has(id)) {
            this.pending.delete(id);
            clearTimeout(t);
            reject(new ByowError("user_rejected", "The wallet window was closed."));
          }
        }, 300);
      }
      this.win.postMessage(rpcRequest(id, method, params), origin);
    });
  }

  private onMessage = (ev: MessageEvent): void => {
    if (ev.source !== this.win) return; // some other window, or a stale popup
    if (ev.origin === "null") return; // opaque origins have no identity to pin
    if (this.pinned && ev.origin !== this.pinned) return; // the popup navigated: not the wallet we pinned

    const msg = parseMessage(ev.data);
    if (msg.kind === "ready") {
      if (this.pinned) return;
      if (!this.opts.allowCrossOriginRedirect && ev.origin !== this.expectedOrigin) {
        this.onFatal?.(new ByowError("origin_mismatch", `The wallet redirected away from ${this.expectedOrigin} to ${ev.origin}.`, { expected: this.expectedOrigin, actual: ev.origin }));
        return;
      }
      if (this.opts.allowOrigin && !this.opts.allowOrigin(ev.origin)) {
        this.onFatal?.(new ByowError("wallet_not_allowed", `This site does not accept the wallet at ${ev.origin}.`, { origin: ev.origin }));
        return;
      }
      this.pinned = ev.origin;
      this.onReady?.({ origin: ev.origin, versions: msg.versions });
      return;
    }
    if (!this.pinned || msg.kind !== "response") return;
    const done = this.pending.get(msg.id);
    if (!done) return;
    this.pending.delete(msg.id);
    if (msg.ok) done({ ok: true, result: msg.result });
    else done({ ok: false, error: fromWireError(msg.error) });
  };
}
