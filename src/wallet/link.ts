// The link carrier, wallet side: the request arrived as a link (scanned, tapped, pasted, or in this page's
// own URL), and the answer leaves through the link's mailbox or its return URL.
// Zero dependencies. Runs in a page, a phone app, a script or an agent: anything with fetch and WebCrypto.

import { ByowError, rpcError, type RpcResponse } from "../protocol.js";
import { deliveryOrigin, formatAnswerLink, hasLink, open, parseLink, seal } from "../link.js";
import type { WalletCore } from "./core.js";

export interface LinkAnswer {
  /** What the wallet answered. null if it had nothing to say (the link held no usable request). */
  response: RpcResponse | null;
  /**
   * Where the answer went: sealed into the link's mailbox, written into the return URL, or nowhere, because
   * the link has no return path and the ledger (or the user) carries the result.
   */
  delivered: "mailbox" | "return" | "none";
  /** Send the user here to finish, if set. When `delivered` is "return" this URL carries the answer. */
  returnTo?: string;
}

export interface AnswerLinkOptions {
  fetch?: typeof fetch;
  /** document.referrer, when the wallet is a page. Used to refuse a link that one site made to answer to another. */
  referrer?: string;
  signal?: AbortSignal;
  /** Unix ms. Injected for tests. */
  now?: () => number;
}

/**
 * Answer one link. The request runs through the same core as every other carrier, so the same handlers, the
 * same refusals and the same review screen apply. Throws only when the link itself cannot be used
 * (bad_request, unsupported_version, site_not_allowed); show that to the user, there is nobody to tell.
 */
export async function answerLink(core: WalletCore, linkText: string, o: AnswerLinkOptions = {}): Promise<LinkAnswer> {
  const link = parseLink(linkText);
  if (link.kind !== "request") throw new ByowError("bad_request", "This link carries an answer, not a request.");
  const doFetch = o.fetch ?? fetch;
  const origin = deliveryOrigin(link);

  // On the same device a browser says which page sent the user here. A page that sends users to sign for some
  // OTHER origin is the shape of a phishing link, so refuse it. No referrer (an app, a QR, a pasted link) proves nothing.
  if (o.referrer && origin && !link.mailbox) {
    let from: string | null = null;
    try {
      from = new URL(o.referrer).origin;
    } catch {
      /* not a URL: treat as absent */
    }
    if (from && from !== origin) throw new ByowError("site_not_allowed", `This link was opened from ${from} but sends its answer to ${origin}.`);
  }

  let message: unknown = link.request;
  if (link.mailbox) {
    const r = await doFetch(`${link.mailbox}/request`, { ...(o.signal ? { signal: o.signal } : {}) });
    if (!r.ok) throw new ByowError("bad_request", "This request is gone. It may have expired or been withdrawn.");
    message = await open(link.key!, "request", ((await r.json()) as { box?: unknown })?.box);
    if (message === undefined) throw new ByowError("bad_request", "This request could not be opened with the link's key.");
  }

  const expired = link.expires !== undefined && Math.floor((o.now ?? Date.now)() / 1000) > link.expires;
  const id = (message as { id?: unknown } | undefined)?.id;
  const response = expired
    ? typeof id === "string"
      ? rpcError(id, { code: "expired", message: "This request has expired." })
      : null
    : (
        await core.handle(message, {
          origin,
          originProof: origin ? "delivery" : "none",
          carrier: "link",
          ...(o.signal ? { signal: o.signal } : {}),
        })
      ).response;

  if (!response) return { response: null, delivered: "none" };
  if (link.mailbox) {
    const box = await seal(link.key!, "response", response);
    const r = await doFetch(`${link.mailbox}/response`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ box }), ...(o.signal ? { signal: o.signal } : {}) });
    // The site stopped waiting (or was answered already). The user should know their approval reached nobody.
    if (!r.ok) throw new ByowError("expired", "The site is no longer waiting for this answer.");
    return { response, delivered: "mailbox", ...(link.returnUrl ? { returnTo: link.returnUrl } : {}) };
  }
  if (link.returnUrl) return { response, delivered: "return", returnTo: formatAnswerLink(link.returnUrl, response, link.version) };
  return { response, delivered: "none" };
}

type LinkWindow = { location: { href: string; replace(url: string): void }; history?: { replaceState(data: unknown, unused: string, url?: string): void }; document?: { referrer: string } };

/**
 * For a wallet that is a web page: if this page was opened with a link in its URL, answer it and send the user
 * back. Resolves null when the URL holds no link. Call it once, at load, next to the window carrier's start().
 */
export async function answerLinkInPage(core: WalletCore, o: AnswerLinkOptions & { win?: LinkWindow } = {}): Promise<LinkAnswer | null> {
  const win = o.win ?? (window as unknown as LinkWindow);
  const href = win.location.href;
  if (!hasLink(href)) return null;
  // Take the request out of the address bar and the history before anything else: it is not for sharing or reloading.
  try {
    win.history?.replaceState(null, "", href.slice(0, href.indexOf("#")));
  } catch {
    /* some embedders forbid it */
  }
  const answer = await answerLink(core, href, { referrer: win.document?.referrer ?? "", ...o });
  if (answer.returnTo) win.location.replace(answer.returnTo);
  return answer;
}
