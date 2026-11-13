// The page carrier, wallet side: the wallet has code in the site's own page (a browser extension, or a
// wallet app showing the site in its built-in browser) and announces itself there.
//
// Two DOM events, the pattern Ethereum settled on in EIP-6963. Nobody claims a global, so two wallets in one
// browser never fight over a name on `window`.
//   byow:announce   wallet -> page   detail = { id, info, versions, request }
//   byow:discover   page -> wallets  "announce yourselves again"
//
// An extension must NOT run its core in the page's world: the page owns that world and can rewrite anything
// in it. Run the core in the extension's own world and give this function a `request` that relays to it, with
// `origin` read on the extension's side. `announceWallet(core)` with no relay is for the case where the page's
// world IS the wallet's: an app's built-in browser injecting before any site script runs.

import { EVENT_ANNOUNCE, EVENT_DISCOVER, ICON_RE, safeText, type RpcResponse } from "../protocol.js";
import type { WalletCore } from "./core.js";

export interface Announcement {
  /** Unique per page load. Lets a site tell two announcements of one wallet from two wallets. */
  id: string;
  /** A CLAIM, like any wallet's name. The user installed this wallet, which is why it is offered at all. */
  info: { name: string; icon?: string };
  versions: string[];
  /** One message in, one message out: the same JSON-RPC as every other carrier. Resolves null for a message with nothing to answer. */
  request(message: unknown): Promise<RpcResponse | null>;
}

export interface AnnounceOptions {
  /** Relay a message to the wallet's own world and resolve with its answer. Default: handle it here, in this world. */
  request?: (message: unknown) => Promise<RpcResponse | null>;
  /** The page's origin as the wallet's trusted side reads it. Default: location.origin. */
  origin?: () => string;
  /** Where to announce. Default: window. */
  target?: EventTarget;
}

/** Announce now and on every byow:discover. Returns a function that stops announcing. */
export function announceWallet(core: WalletCore, o: AnnounceOptions = {}): () => void {
  const target = o.target ?? window;
  const origin = o.origin ?? (() => location.origin);
  const { name, icon } = core.manifest;
  const detail: Announcement = Object.freeze({
    id: crypto.randomUUID(),
    info: Object.freeze({ name: safeText(name, 64), ...(icon && ICON_RE.test(icon) ? { icon } : {}) }),
    versions: Object.freeze([...core.manifest.versions]) as string[],
    request: o.request ?? (async (message: unknown) => (await core.handle(message, { origin: origin(), originProof: "browser", carrier: "page" })).response),
  });
  const announce = () => void target.dispatchEvent(new CustomEvent(EVENT_ANNOUNCE, { detail }));
  target.addEventListener(EVENT_DISCOVER, announce);
  announce();
  return () => target.removeEventListener(EVENT_DISCOVER, announce);
}
