// The link carrier's shared half: a request written as a URL, and the sealing that keeps a mailbox blind.
// Zero dependencies (WebCrypto only), so it runs in a page, a phone app, a script or an agent.
//
// A link is the text `byow:` followed by parameters. It stands alone (a QR, a deep link, something pasted), or
// it sits in the fragment of any https URL: a wallet's front door, or a page of the site itself, so that a
// plain camera scan still lands somewhere useful. A link is one-shot: one request, at most one answer.
//
//   v   protocol version                                  required
//   q   the request itself, base64url(JSON)               one of q / c / a
//   c   a mailbox URL: GET {c}/request, POST {c}/response
//   a   an answer, base64url(JSON), on its way back
//   k   the single-use key everything on `c` is sealed with   required with c
//   r   where to send the user afterwards; with no `c`, the answer rides in its fragment
//   e   unix seconds after which the request must not be answered

import { ByowError, SUPPORTED_VERSIONS, parseMessage, type RpcRequest, type RpcResponse } from "./protocol.js";

export const LINK_PREFIX = "byow:";
/** Longest link either side will look at. An inline request or answer is small; a transaction blob is a few KB. */
export const MAX_LINK_CHARS = 64 * 1024;
/** Largest sealed box a mailbox holds or a client opens. */
export const MAX_BOX_CHARS = 512 * 1024;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// ---------------------------------------------------------------------------------------------
// base64url (RFC 4648 section 5, no padding)

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict: only the URL-safe alphabet, no padding, and only the one spelling of each value. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return toBase64Url(out) === text ? out : null;
  } catch {
    return null;
  }
}

const utf8 = new TextEncoder();
const encodeJson = (v: unknown): string => toBase64Url(utf8.encode(JSON.stringify(v)));
function decodeJson(text: string): unknown {
  const bytes = fromBase64Url(text);
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Links

export interface RequestLink {
  kind: "request";
  version: string;
  /** The request, when it travels inside the link. */
  request?: RpcRequest;
  /** The mailbox to fetch it from and answer to, with the key that opens it. */
  mailbox?: string;
  key?: Uint8Array;
  returnUrl?: string;
  /** Unix seconds. */
  expires?: number;
}
export interface AnswerLink {
  kind: "answer";
  version: string;
  /** Unparsed: run it through parseMessage like anything else a wallet says. */
  message: unknown;
}
export type ParsedLink = RequestLink | AnswerLink;

/** https, or http on localhost while developing. No credentials, no fragment: the fragment is where links live. */
function linkUrl(text: string, what: string): string {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new ByowError("bad_request", `${what} is not a URL`);
  }
  const ok = u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname));
  if (!ok) throw new ByowError("bad_request", `${what} must be https`);
  if (u.username || u.password) throw new ByowError("bad_request", `${what} must not contain credentials`);
  // URL.hash is "" for a bare trailing "#", so look at the text too.
  if (u.hash || text.includes("#")) throw new ByowError("bad_request", `${what} must not have a fragment`);
  return u.href;
}

/** The origin a link's answer is delivered to: the mailbox's, else the return URL's, else nobody's. */
export function deliveryOrigin(link: RequestLink): string | null {
  const to = link.mailbox ?? link.returnUrl;
  return to ? new URL(to).origin : null;
}

/** True if this text is, or carries, a BYOW link. Cheap: for deciding whether to look closer. */
export function hasLink(text: string): boolean {
  const t = text.trim();
  return t.startsWith(LINK_PREFIX) || t.includes("#" + LINK_PREFIX);
}

/** Strict parse of a link, standalone or in a URL's fragment. Throws bad_request, or unsupported_version. */
export function parseLink(text: string): ParsedLink {
  const bad = (why: string): never => {
    throw new ByowError("bad_request", `not a usable BYOW link: ${why}`);
  };
  const t = text.trim();
  if (t.length > MAX_LINK_CHARS) bad("too long");
  const at = t.startsWith(LINK_PREFIX) ? 0 : t.indexOf("#" + LINK_PREFIX) + 1;
  if (at === 0 && !t.startsWith(LINK_PREFIX)) bad("no byow: part");

  const p = new Map<string, string>();
  for (const pair of t.slice(at + LINK_PREFIX.length).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 1) bad("malformed parameter");
    const key = pair.slice(0, eq);
    if (p.has(key)) bad(`${key} appears twice`);
    try {
      p.set(key, decodeURIComponent(pair.slice(eq + 1)));
    } catch {
      bad(`${key} is not percent-encoded text`);
    }
  }

  const version = p.get("v");
  if (!version || !/^\d{1,3}\.\d{1,3}$/.test(version)) bad("v is missing");
  if (!SUPPORTED_VERSIONS.includes(version!)) throw new ByowError("unsupported_version", `This link speaks BYOW ${version}, which is not supported here.`, { supported: SUPPORTED_VERSIONS });

  const [q, c, a] = [p.get("q"), p.get("c"), p.get("a")];
  if ([q, c, a].filter((x) => x !== undefined).length !== 1) bad("exactly one of q, c and a is needed");
  if (a !== undefined) {
    const message = decodeJson(a);
    if (message === undefined) bad("a does not decode");
    return { kind: "answer", version: version!, message };
  }

  const link: RequestLink = { kind: "request", version: version! };
  if (q !== undefined) {
    const msg = parseMessage(decodeJson(q));
    if (msg.kind !== "request") bad("q is not a request");
    else link.request = msg.req;
  } else {
    link.mailbox = linkUrl(c!, "c").replace(/\/$/, "");
    const key = fromBase64Url(p.get("k") ?? "");
    if (!key || key.length !== 32) bad("c needs k, a 32-byte key");
    else link.key = key;
  }
  const r = p.get("r");
  if (r !== undefined) link.returnUrl = linkUrl(r, "r");
  const e = p.get("e");
  if (e !== undefined) {
    if (!/^\d{1,12}$/.test(e)) bad("e must be unix seconds");
    link.expires = Number(e);
  }
  return link;
}

const enc = encodeURIComponent;

/** Write a request as a link. `via` puts it in that URL's fragment: a wallet's front door, or a page of the site. */
export function formatRequestLink(l: Omit<RequestLink, "kind" | "version"> & { version?: string }, via?: string): string {
  const parts = [`v=${l.version ?? SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1]}`];
  if (l.request) parts.push(`q=${encodeJson(l.request)}`);
  else if (l.mailbox && l.key) parts.push(`c=${enc(linkUrl(l.mailbox, "the mailbox"))}`, `k=${toBase64Url(l.key)}`);
  else throw new ByowError("bad_request", "a request link carries the request or a mailbox with its key");
  if (l.returnUrl) parts.push(`r=${enc(linkUrl(l.returnUrl, "the return URL"))}`);
  if (l.expires !== undefined) parts.push(`e=${Math.floor(l.expires)}`);
  const payload = LINK_PREFIX + parts.join("&");
  const text = via === undefined ? payload : `${linkUrl(via, "the carrying URL")}#${payload}`;
  if (text.length > MAX_LINK_CHARS) throw new ByowError("bad_request", "the request is too large to travel in a link; use a mailbox");
  return text;
}

/** The return URL with the answer in its fragment: how a wallet answers on the same device with no server. */
export function formatAnswerLink(returnUrl: string, response: RpcResponse, version: string = SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1]!): string {
  const text = `${linkUrl(returnUrl, "the return URL")}#${LINK_PREFIX}v=${version}&a=${encodeJson(response)}`;
  if (text.length > MAX_LINK_CHARS) throw new ByowError("bad_request", "the answer is too large to travel in a link");
  return text;
}

// ---------------------------------------------------------------------------------------------
// Sealing: AES-256-GCM under the link's single-use key. The mailbox stores boxes it cannot read or forge.

export type Sealed = "request" | "response";

export function newKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** 132 random bits, URL-safe: a mailbox channel nobody can guess. */
export function newChannelId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(17))).slice(0, 22);
}

const aesKey = (key: Uint8Array, use: KeyUsage) => crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [use]);
// Bound to its direction, so a mailbox cannot hand a request back as the answer.
const aad = (what: Sealed) => utf8.encode(`byow/${what}`) as BufferSource;

/** Seal one message. The box is base64url(nonce || ciphertext). `nonce` is for test vectors only: never reuse one. */
export async function seal(key: Uint8Array, what: Sealed, message: unknown, nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12))): Promise<string> {
  if (key.length !== 32 || nonce.length !== 12) throw new ByowError("internal", "sealing needs a 32-byte key and a 12-byte nonce");
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad(what) }, await aesKey(key, "encrypt"), utf8.encode(JSON.stringify(message)) as BufferSource);
  const box = new Uint8Array(12 + ct.byteLength);
  box.set(nonce);
  box.set(new Uint8Array(ct), 12);
  return toBase64Url(box);
}

/** Open a box. Returns undefined if it was not sealed with this key for this direction, or is not JSON. */
export async function open(key: Uint8Array, what: Sealed, box: unknown): Promise<unknown> {
  if (typeof box !== "string" || box.length > MAX_BOX_CHARS || key.length !== 32) return undefined;
  const bytes = fromBase64Url(box);
  if (!bytes || bytes.length < 12 + 16) return undefined;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) as BufferSource, additionalData: aad(what) }, await aesKey(key, "decrypt"), bytes.subarray(12) as BufferSource);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pt));
  } catch {
    return undefined;
  }
}
