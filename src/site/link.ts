// The link carrier, site side: the request leaves as a link and the answer comes back through a mailbox
// (another device: show the link as a QR) or through a return URL (the same device, no server at all).
// Zero dependencies.
//
// A link reaches wallets that are not web pages and browsers that have no popups, and it has no
// window.opener to defend. What it gives up is the browser's stamp: the wallet knows only where its answer
// is delivered, and a phishing page can relay a real site's QR. That is true of every cross-device QR login.
// The answer's carrier is reported so a site can ask for more before anything sensitive.

import { ByowError, fromWireError, newId, parseMessage, rpcRequest } from "../protocol.js";
import { formatRequestLink, hasLink, newChannelId, newKey, open, parseLink, seal } from "../link.js";
import type { CallSpec, Carrier, WalletInfo } from "./wallet.js";

const LINK_INFO: WalletInfo = { carrier: "link", origin: null, manifest: null };

/** A wallet's answer, parsed like anything else a wallet says. It must answer the request that was sent. */
function resultOf(answer: unknown, id: string): unknown {
  const msg = parseMessage(answer);
  if (msg.kind !== "response" || msg.id !== id) throw new ByowError("invalid_response", "The wallet did not answer the request it was sent.");
  if (!msg.ok) throw fromWireError(msg.error);
  return msg.result;
}

// ---------------------------------------------------------------------------------------------
// Through a mailbox: for a wallet on another device, or one that is not a web page.

export interface MailboxCarrierOptions {
  /** The mailbox's base URL, e.g. https://site.example/byow. On your own origin, the wallet shows your origin as the asker. */
  mailbox: string;
  /** Called with the link once the request is stored. Show it as a QR, a button, or text to copy. */
  onLink(link: string): void;
  /**
   * A URL to carry the link in its fragment: the wallet's front door when you know the wallet, or a page of
   * your own, so that scanning with a plain camera opens something useful. Default: the bare `byow:` link.
   */
  via?: string;
  /** Where the wallet should send the user once it has answered. */
  returnUrl?: string;
  /** How long the request may be answered. Default 10 minutes. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export function mailboxCarrier(o: MailboxCarrierOptions): Carrier {
  const base = o.mailbox.replace(/\/$/, "");
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  const abort = o.signal ? { signal: o.signal } : {};
  return {
    kind: "link",
    async call(spec: CallSpec) {
      const id = newId();
      const key = newKey();
      const channel = `${base}/${newChannelId()}`;
      const deadline = Date.now() + timeoutMs;

      const box = await seal(key, "request", rpcRequest(id, spec.method, spec.params));
      const put = await doFetch(`${channel}/request`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ box }), ...abort });
      if (!put.ok) throw new ByowError("internal", `The mailbox did not take the request (${put.status}).`);
      o.onLink(formatRequestLink({ mailbox: channel, key, ...(o.returnUrl ? { returnUrl: o.returnUrl } : {}), expires: Math.floor(deadline / 1000) }, o.via));

      while (Date.now() < deadline) {
        const wait = Math.max(1, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
        const r = await doFetch(`${channel}/response?wait=${wait}`, abort);
        if (r.status === 200) {
          const answer = await open(key, "response", ((await r.json()) as { box?: unknown })?.box);
          if (answer === undefined) throw new ByowError("invalid_response", "The answer in the mailbox could not be opened with this request's key.");
          return { result: resultOf(answer, id), info: LINK_INFO };
        }
        if (r.status === 404) break; // the mailbox dropped the channel
        if (r.status !== 204) await new Promise((res) => setTimeout(res, 1000)); // a mailbox that cannot hold a call open
      }
      throw new ByowError("timeout", "No wallet answered the link in time.");
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Through a return URL: the same device, no server. The wallet opens in a new tab and navigates it back to
// the site's own return page, which hands the answer to the tab that asked.

const RETURN_CHANNEL = "byow:return";

export interface ReturnCarrierOptions {
  /** The wallet's URL, or any URL that should carry the link (a native wallet claims its front door as an app link). */
  walletUrl: string;
  /** A page on YOUR origin that calls completeReturn(). */
  returnUrl: string;
  /** How long the request may be answered. Default 10 minutes. */
  timeoutMs?: number;
  /** How the wallet is opened. Default: a new tab with no opener. Runs synchronously inside the click. */
  openUrl?: (url: string) => void;
}

export function returnCarrier(o: ReturnCarrierOptions): Carrier {
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  return {
    kind: "link",
    call(spec: CallSpec) {
      // Everything up to opening the wallet is synchronous on purpose: it runs inside the user's click.
      const id = newId();
      let link: string;
      try {
        link = formatRequestLink({ request: rpcRequest(id, spec.method, spec.params), returnUrl: o.returnUrl, expires: Math.floor((Date.now() + timeoutMs) / 1000) }, o.walletUrl);
        // noopener: the wallet gets no handle on this tab, so there is nothing for a hostile wallet URL to steer.
        (o.openUrl ?? ((url) => void window.open(url, "_blank", "noopener")))(link);
      } catch (e) {
        return Promise.reject(e);
      }
      return new Promise((resolve, reject) => {
        const channel = new BroadcastChannel(RETURN_CHANNEL);
        const finish = (settle: () => void) => {
          clearTimeout(timer);
          channel.close();
          settle();
        };
        const timer = setTimeout(() => finish(() => reject(new ByowError("timeout", "No wallet answered the link in time."))), timeoutMs);
        channel.onmessage = (ev: MessageEvent) => {
          // Anyone can link to the return page, so an answer is never trusted for having arrived. It must answer
          // THIS request (the id is 96 random bits only this tab and the wallet have seen), and what it says is
          // still verified by signature like any other answer.
          const answer = (ev.data as { message?: unknown } | null)?.message;
          const msg = parseMessage(answer);
          if (msg.kind !== "response" || msg.id !== id) return;
          finish(() => {
            try {
              resolve({ result: resultOf(answer, id), info: LINK_INFO });
            } catch (e) {
              reject(e);
            }
          });
        };
      });
    },
  };
}

type ReturnWindow = { location: { href: string }; history?: { replaceState(data: unknown, unused: string, url?: string): void }; close?: () => void };

/**
 * Call this on the return page, at load. If the page was opened with an answer in its URL, it is handed to the
 * tab that asked and true is returned; the page can then tell the user to go back, or close itself.
 */
export function completeReturn(o: { win?: ReturnWindow; close?: boolean } = {}): boolean {
  const win = o.win ?? (window as unknown as ReturnWindow);
  const href = win.location.href;
  if (!hasLink(href)) return false;
  let message: unknown;
  try {
    const link = parseLink(href);
    if (link.kind !== "answer") return false;
    message = link.message;
  } catch {
    return false;
  }
  try {
    win.history?.replaceState(null, "", href.slice(0, href.indexOf("#")));
  } catch {
    /* some embedders forbid it */
  }
  const channel = new BroadcastChannel(RETURN_CHANNEL);
  channel.postMessage({ message });
  channel.close();
  if (o.close) {
    try {
      win.close?.();
    } catch {
      /* not ours to close */
    }
  }
  return true;
}
