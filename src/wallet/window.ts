// The window carrier, wallet side: the wallet is a web page that a site opened in a popup.
//
// What this file adds to the core for every wallet page built on it:
//   - requests are accepted only from window.opener (or its ancestors), and only from the first origin that spoke
//   - every reply is addressed to that origin, never "*" (the one "*" send is byow_ready, which carries no data)
//   - one UI-bearing request per document; after it the document is spent
//   - the window closes itself: at once on the user's "no", after a linger on success
// Zero dependencies, browser only.

import { readyMessage, parseMessage, type Manifest, type RpcResponse } from "../protocol.js";
import { createWalletCore, type WalletCore, type WalletCoreOptions } from "./core.js";

export type ServerStatus =
  | { phase: "standalone" } // opened directly, not by a site
  | { phase: "waiting" }
  | { phase: "locked"; origin: string }
  | { phase: "pending"; origin: string; method: string }
  | { phase: "done"; origin: string; ok: boolean };

type WalletWindow = Pick<Window, "addEventListener" | "removeEventListener" | "close"> & { opener: Window | null };

export interface WalletServerOptions extends WalletCoreOptions {
  /** Reuse a core that also serves another carrier in this page. When given, the core options above are ignored. */
  core?: WalletCore;
  /** ms the window stays open after a successful answer so a follow-up request can reuse it. Default 30000. */
  lingerMs?: number;
  onStatus?: (s: ServerStatus) => void;
  /** Injected for tests. */
  win?: WalletWindow;
}

export interface WalletServer {
  readonly manifest: Manifest;
  readonly core: WalletCore;
  start(): void;
  stop(): void;
  status(): ServerStatus;
  /** Cancel the post-answer auto-close (e.g. the wallet is showing a receipt the user is reading). */
  keepOpen(): void;
}

export function createWalletServer(options: WalletServerOptions): WalletServer {
  const win: WalletWindow = options.win ?? window;
  const core = options.core ?? createWalletCore(options);

  let locked: string | null = null;
  let finished = false;
  let state: ServerStatus = { phase: "waiting" };
  let readyTimer: ReturnType<typeof setInterval> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const abort = new AbortController();

  const setStatus = (s: ServerStatus) => {
    state = s;
    options.onStatus?.(s);
  };

  const sendTo = (target: Window, origin: string, res: RpcResponse) => {
    try {
      target.postMessage(res, origin);
    } catch {
      /* the site went away */
    }
  };

  const scheduleClose = (ms: number) => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      try {
        win.close();
      } catch {
        /* not ours to close */
      }
    }, ms);
  };

  // With opener isolation the popup's opener is the site's hidden iframe, but the site's top-level script is
  // what calls postMessage, so the sender is the opener's parent/top. Accept the opener and its ancestors;
  // anything else (a stray window that found us by name) is ignored. The origin pin below is the real lock.
  const fromOpener = (src: MessageEventSource | null, opener: Window): boolean => {
    if (src === null || src === undefined) return false;
    if (src === opener) return true;
    try {
      return src === opener.parent || src === opener.top;
    } catch {
      return false;
    }
  };

  async function onMessage(ev: MessageEvent): Promise<void> {
    const opener = win.opener;
    if (!opener || !fromOpener(ev.source, opener)) return;
    if (ev.origin === "null") return;
    if (locked && ev.origin !== locked) return; // the opener navigated somewhere else: not the site that was approved

    // Lock only onto a message we can act on or answer. One with no usable id is ignored outright and must
    // not let whoever spoke first claim the document.
    const peek = parseMessage(ev.data);
    if (peek.kind === "ignore" || peek.kind === "ready" || peek.kind === "response") return;
    if (peek.kind === "malformed" && !peek.id) return;

    if (!locked) {
      locked = ev.origin;
      if (readyTimer) clearInterval(readyTimer);
      setStatus({ phase: "locked", origin: locked });
    }
    const origin = locked;

    let pending = false;
    const out = await core.handle(ev.data, {
      origin,
      originProof: "browser",
      carrier: "window",
      signal: abort.signal,
      spent: finished,
      onPending: (method) => {
        pending = true;
        setStatus({ phase: "pending", origin, method });
      },
    });
    if (!out.response) return;
    sendTo(opener, ev.origin, out.response);

    if (out.code === "site_not_allowed") {
      finished = true; // this document refuses this site for good
      scheduleClose(300);
      return;
    }
    if (!out.spent) {
      if (pending) setStatus({ phase: "locked", origin });
      return;
    }
    finished = true;
    setStatus({ phase: "done", origin, ok: out.code === undefined });
    // The user's own "no" closes the window at once; a success or a failure stays up so they can read it.
    scheduleClose(out.code === "user_rejected" ? 300 : options.lingerMs ?? 30_000);
  }

  const listener = (ev: Event) => void onMessage(ev as MessageEvent);
  const onHide = () => abort.abort();

  return {
    manifest: core.manifest,
    core,
    status: () => state,
    keepOpen() {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = null;
    },
    start() {
      if (!win.opener) {
        setStatus({ phase: "standalone" });
        return;
      }
      win.addEventListener("message", listener);
      win.addEventListener("pagehide", onHide);
      // byow_ready carries only the supported versions, so "*" is safe. Re-sent briefly in case the
      // site attached its listener a tick late; the site pins the first one and ignores the rest.
      const send = () => {
        try {
          win.opener?.postMessage(readyMessage(core.manifest.versions), "*");
        } catch {
          /* opener gone */
        }
      };
      send();
      let n = 0;
      readyTimer = setInterval(() => {
        if (locked || ++n > 25) return void (readyTimer && clearInterval(readyTimer));
        send();
      }, 300);
    },
    stop() {
      win.removeEventListener("message", listener);
      win.removeEventListener("pagehide", onHide);
      if (readyTimer) clearInterval(readyTimer);
      if (closeTimer) clearTimeout(closeTimer);
      abort.abort();
    },
  };
}
