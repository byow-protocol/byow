// The page carrier, site side: wallets that live in this browser (an extension, or the wallet app whose
// built-in browser is showing this page) announce themselves, and the site lists whoever answered.
// Zero dependencies, browser only.
//
// Such a wallet has no origin to pin. What stands in for it is that the user installed it: it is offered
// because it is already in their browser, under the name it claims. Everything it says is still parsed as
// strictly as any other wallet's.

import { ByowError, CORE_INFO, EVENT_ANNOUNCE, EVENT_DISCOVER, ICON_RE, MAX_ICON_CHARS, SUPPORTED_VERSIONS, fromWireError, highestCommonVersion, isPlainObject, newId, parseManifest, parseMessage, rpcRequest, safeText } from "../protocol.js";
import type { CallSpec, Carrier, WalletInfo } from "./wallet.js";

export interface AnnouncedWallet {
  /** Stable for this page load. */
  id: string;
  /** Claimed by the wallet. */
  name: string;
  icon?: string;
  /** Hand this to `new ByowWallet(carrier, { profiles })`. */
  carrier: Carrier;
}

export interface PageOptions {
  /** ms to wait for the user to decide on a request. Default 300000. */
  requestTimeoutMs?: number;
}

/**
 * Listen for wallets announcing themselves and ask those already present to announce again. `onWallet` runs
 * once per wallet. Returns a function that stops listening. Call it at page load: discovery needs no click.
 */
export function discoverWallets(onWallet: (w: AnnouncedWallet) => void, o: PageOptions & { target?: EventTarget } = {}): () => void {
  const target = o.target ?? window;
  const seen = new Set<string>();
  const onAnnounce = (ev: Event) => {
    const d = (ev as CustomEvent).detail as unknown;
    if (!isPlainObject(d) || typeof d.request !== "function") return;
    const id = typeof d.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(d.id) ? d.id : null;
    if (!id || seen.has(id) || seen.size >= 16) return;
    const info = isPlainObject(d.info) ? d.info : {};
    const name = typeof info.name === "string" ? safeText(info.name, 64) : "";
    if (!name) return;
    const versions = Array.isArray(d.versions) ? d.versions.filter((v): v is string => typeof v === "string") : [];
    seen.add(id);
    const icon = typeof info.icon === "string" && info.icon.length <= MAX_ICON_CHARS && ICON_RE.test(info.icon) ? info.icon : undefined;
    onWallet({ id, name, ...(icon ? { icon } : {}), carrier: pageCarrier(d.request as PageRequest, versions, o) });
  };
  target.addEventListener(EVENT_ANNOUNCE, onAnnounce);
  target.dispatchEvent(new Event(EVENT_DISCOVER));
  return () => target.removeEventListener(EVENT_ANNOUNCE, onAnnounce);
}

type PageRequest = (message: unknown) => Promise<unknown>;

function pageCarrier(request: PageRequest, versions: string[], o: PageOptions): Carrier {
  const timeoutMs = o.requestTimeoutMs ?? 300_000;
  let busy = false;

  /** One request, one answer, with the answer treated as hostile: wrong id, wrong shape or silence all fail. */
  const call = async (method: string, params: Record<string, unknown>, ms: number): Promise<unknown> => {
    const id = newId();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      Promise.resolve().then(() => request(rpcRequest(id, method, params))),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new ByowError("timeout", "The wallet did not answer in time.")), ms))),
    ])
      .catch((e: unknown) => {
        // A wallet's own exception text is not ours to pass on.
        throw e instanceof ByowError ? e : new ByowError("invalid_response", "The wallet failed instead of answering.");
      })
      .finally(() => clearTimeout(timer));
    const msg = parseMessage(answer);
    if (msg.kind !== "response" || msg.id !== id) throw new ByowError("invalid_response", "The wallet did not answer the request it was sent.");
    if (!msg.ok) throw fromWireError(msg.error);
    return msg.result;
  };

  return {
    kind: "page",
    async call(spec: CallSpec) {
      if (busy) throw new ByowError("busy", "A request is already in flight on this wallet handle.");
      busy = true;
      try {
        const v = highestCommonVersion(SUPPORTED_VERSIONS, versions);
        if (!v) throw new ByowError("unsupported_version", "No protocol version in common with this wallet.", { wallet: versions, sdk: SUPPORTED_VERSIONS });
        const manifest = parseManifest(await call(CORE_INFO, {}, 10_000));
        if (!manifest.versions.includes(v)) throw new ByowError("invalid_response", "Wallet manifest does not list the version it announced.");
        spec.check(manifest);
        const info: WalletInfo = { carrier: "page", origin: null, manifest };
        return { result: await call(spec.method, spec.params, timeoutMs), info };
      } finally {
        busy = false;
      }
    },
  };
}
