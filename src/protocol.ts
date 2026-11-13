// BYOW wire protocol: JSON-RPC 2.0 messages, error codes, text hygiene, the manifest. Zero dependencies.
// Imported by the site SDK, the wallet kit and the conformance checker, so there is exactly one
// definition of what is valid on the wire. The same messages travel over every carrier.

export const BYOW_VERSION = "0.2";
export const SUPPORTED_VERSIONS: readonly string[] = ["0.2"];

/** Largest message either side will look at. Bigger is dropped, not parsed further. */
export const MAX_MESSAGE_CHARS = 256 * 1024;

// ---------------------------------------------------------------------------------------------
// Errors

/**
 * Every error a wallet may put on the wire: the name code and logs use, and the JSON-RPC integer that travels.
 * The -326xx codes are JSON-RPC's own. 4001 is the same number EIP-1193 uses for a user's refusal.
 */
export const WIRE_ERRORS = {
  bad_request: -32600, // the message itself is malformed
  unsupported_method: -32601,
  bad_params: -32602, // the method is known, its params are wrong
  internal: -32603,
  user_rejected: 4001, // the ONLY code that means the user said no
  site_not_allowed: 4100, // the wallet's own policy refuses this site
  wrong_account: 4101,
  unsupported_chain: 4300,
  unsupported_tx: 4301, // a transaction this wallet will not sign (its policy, not a protocol rule)
  expired: 4302,
  busy: 4400,
} as const;

export type WireErrorCode = keyof typeof WIRE_ERRORS;
const WIRE_NAMES = Object.keys(WIRE_ERRORS) as WireErrorCode[];
const NAME_BY_NUMBER = new Map<number, WireErrorCode>(WIRE_NAMES.map((n) => [WIRE_ERRORS[n], n]));

/** Codes only the site SDK raises. A wallet never sends these. */
export const SDK_ERROR_CODES = [
  "timeout",
  "popup_blocked",
  "invalid_wallet_url",
  "invalid_response",
  "origin_mismatch",
  "wallet_not_allowed",
  "unsupported_version",
] as const;

export type ErrorCode = WireErrorCode | (typeof SDK_ERROR_CODES)[number];

export const isWireErrorCode = (c: unknown): c is WireErrorCode => typeof c === "string" && Object.hasOwn(WIRE_ERRORS, c);

export interface WireError {
  code: WireErrorCode;
  message: string;
  data?: unknown;
}

export class ByowError extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "ByowError";
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------------------------
// Text hygiene. Everything a wallet sends is displayed by somebody else's page.

// Anything that is invisible, blank-looking, or reorders text. General categories cover controls (Cc), format
// characters (Cf: zero-width, bidi, soft hyphen, BOM, tag characters), private use (Co), surrogates (Cs),
// unassigned (Cn) and line/paragraph separators. The explicit list covers things Unicode files under letters
// or symbols that still render as blanks (Hangul fillers, braille blank, object replacement, combining grapheme
// joiner, Khmer inherent vowels, Mongolian selectors, variation selectors) and every space other than U+0020.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\uFFFC\u{E0100}-\u{E01EF}]/u;
const UNSAFE_TEXT_G = new RegExp(UNSAFE_TEXT.source, "gu");

export function hasUnsafeText(s: string): boolean {
  return UNSAFE_TEXT.test(s);
}

/**
 * Deep-copy foreign data for display or logging: strings sanitised and capped, keys that can poison
 * prototypes dropped, depth and size bounded. Returns undefined if it does not fit the budget.
 */
export function sanitizeData(v: unknown, depth = 0, budget = { nodes: 64 }): unknown {
  if (--budget.nodes < 0 || depth > 4) return undefined;
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return safeText(v, 200);
  if (Array.isArray(v)) return v.slice(0, 16).map((x) => sanitizeData(x, depth + 1, budget));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, x] of Object.entries(v).slice(0, 16)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[safeText(k, 40)] = sanitizeData(x, depth + 1, budget);
    }
    return out;
  }
  return undefined;
}

/** Strip anything that can make text read differently than it is, then cap it. */
export function safeText(s: string, max = 200): string {
  return s.replace(UNSAFE_TEXT_G, "").trim().slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// Identifiers

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD_RE = /^[A-Za-z0-9_]{1,64}$/;
/** CAIP-2: namespace ":" reference. */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const FAMILY_RE = /^[-a-z0-9]{3,8}$/;
const VERSION_RE = /^\d{1,3}\.\d{1,3}$/;

export const isChainId = (s: unknown): s is string => typeof s === "string" && CAIP2_RE.test(s);
export const chainFamily = (chain: string): string => chain.slice(0, chain.indexOf(":"));
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 96 random bits as hex. Request ids double as the unguessable `state` on carriers with no stamped origin. */
export function newId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------
// Messages: JSON-RPC 2.0

export const CORE_INFO = "byow_info";
/** The one notification: a wallet window telling its opener it has loaded. */
export const CORE_READY = "byow_ready";

/** Page carrier: a wallet living in the browser announces itself with this DOM event... */
export const EVENT_ANNOUNCE = "byow:announce";
/** ...and a site asks wallets already present to announce again with this one. */
export const EVENT_DISCOVER = "byow:discover";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
}
export type RpcResponse =
  | { jsonrpc: "2.0"; id: string; result: unknown }
  | { jsonrpc: "2.0"; id: string; error: { code: number; message: string; data?: unknown } };
export interface RpcReady {
  jsonrpc: "2.0";
  method: typeof CORE_READY;
  params: { versions: string[] };
}

export type Parsed =
  | { kind: "ignore" } // not a JSON-RPC 2.0 message at all: stay silent, the channel may be shared
  | { kind: "ready"; versions: string[] }
  | { kind: "request"; req: RpcRequest }
  | { kind: "response"; id: string; ok: true; result: unknown }
  | { kind: "response"; id: string; ok: false; error: WireError }
  // a message with a bad shape. With a usable id the receiver may answer bad_request; without one it says nothing.
  | { kind: "malformed"; id?: string; why: string };

/**
 * True only for what JSON can express: plain objects and arrays, strings, finite numbers, booleans, null.
 * Structured clone also delivers Map, Set, Date, ArrayBuffer, typed arrays, BigInt and cycles; none belong on this wire.
 * Bounded in depth and node count so a hostile message cannot cost more than a hostile JSON document would.
 */
export function isJsonValue(v: unknown, budget = { nodes: 20_000 }, depth = 0): boolean {
  if (depth > 32 || --budget.nodes < 0) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, budget, depth + 1));
  // An undefined property is simply absent once serialised, so `{chain: undefined}` is fine; undefined elsewhere is not.
  // toString tag, not a prototype comparison: with opener isolation the message is deserialised in the iframe's realm,
  // whose Object.prototype is not ours. Map, Set, Date, ArrayBuffer and typed arrays all have their own tags.
  if (isPlainObject(v) && Object.prototype.toString.call(v) === "[object Object]") return Object.values(v).every((x) => x === undefined || isJsonValue(x, budget, depth + 1));
  return false;
}

const isVersionList = (vs: unknown, min: number): vs is string[] =>
  Array.isArray(vs) && vs.length >= min && vs.length <= 8 && vs.every((x) => typeof x === "string" && VERSION_RE.test(x));

/**
 * Strict parse of anything that arrives: a postMessage, a provider call, a decoded link. Never throws,
 * whatever it is handed. Everything after the first checks reads a private copy of the message, so a sender
 * that keeps a reference (a page calling a wallet in its own world) cannot change it once it has been judged.
 */
export function parseMessage(data: unknown): Parsed {
  try {
    return parseOwnCopy(data);
  } catch {
    // A getter or a Proxy that throws is not a message.
    return { kind: "ignore" };
  }
}

function parseOwnCopy(data: unknown): Parsed {
  if (!isPlainObject(data) || data.jsonrpc !== "2.0") return { kind: "ignore" };
  const firstId = data.id;
  const early = (why: string): Parsed => ({ kind: "malformed", ...(typeof firstId === "string" && ID_RE.test(firstId) ? { id: firstId } : {}), why });
  // Shape first (cheap, bounded), then the size gate on the JSON form.
  if (!isJsonValue(data)) return early("message is not plain JSON");
  const text = JSON.stringify(data);
  if (text.length > MAX_MESSAGE_CHARS) return early("message too large");
  const msg = JSON.parse(text) as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0") return { kind: "ignore" };

  const id = typeof msg.id === "string" && ID_RE.test(msg.id) ? msg.id : undefined;
  const bad = (why: string): Parsed => ({ kind: "malformed", ...(id === undefined ? {} : { id }), why });

  if ("method" in msg) {
    if (msg.method === CORE_READY && msg.id === undefined) {
      const vs = isPlainObject(msg.params) ? msg.params.versions : undefined;
      return isVersionList(vs, 0) ? { kind: "ready", versions: vs } : bad("byow_ready needs params.versions, up to 8 version strings");
    }
    if (!id) return bad("request.id must match [A-Za-z0-9_-]{1,64}");
    if (typeof msg.method !== "string" || !METHOD_RE.test(msg.method)) return bad("request.method is malformed");
    // Params are always an object, never a positional array: a request builder copied from another ecosystem
    // sends `params: [{...}]`, and half of all wallets would read it one way and half the other.
    if (msg.params !== undefined && !isPlainObject(msg.params)) return bad("request.params must be an object");
    return { kind: "request", req: { jsonrpc: "2.0", id, method: msg.method, params: (msg.params as Record<string, unknown>) ?? {} } };
  }

  const hasResult = "result" in msg;
  const hasError = "error" in msg;
  if (!hasResult && !hasError) return bad("neither a request nor a response");
  if (!id) return bad("response.id is malformed");
  if (hasResult && hasError) return bad("a response carries a result or an error, never both");
  if (hasResult) return { kind: "response", id, ok: true, result: msg.result };
  const e = msg.error;
  if (!isPlainObject(e)) return bad("response.error must be an object");
  // An error code this protocol does not define tells the site nothing it can act on.
  const code = (typeof e.code === "number" ? NAME_BY_NUMBER.get(e.code) : undefined) ?? "internal";
  const message = typeof e.message === "string" ? safeText(e.message, 300) : "";
  const safe = sanitizeData(e.data);
  return { kind: "response", id, ok: false, error: { code, message, ...(safe === undefined ? {} : { data: safe }) } };
}

export const rpcRequest = (id: string, method: string, params: Record<string, unknown> = {}): RpcRequest => ({ jsonrpc: "2.0", id, method, params });

export const rpcResult = (id: string, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

export const rpcError = (id: string, e: { code: WireErrorCode; message: string; data?: unknown }): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code: WIRE_ERRORS[e.code], message: e.message, ...(e.data === undefined ? {} : { data: e.data }) },
});

export const readyMessage = (versions: readonly string[] = SUPPORTED_VERSIONS): RpcReady => ({
  jsonrpc: "2.0",
  method: CORE_READY,
  params: { versions: [...versions] },
});

const GENERIC_FAILURE = "the wallet failed to process the request";

/** Turn anything a handler threw into something safe to put on the wire. */
export function toWireError(e: unknown): WireError {
  // `internal` always carries the same words, even when a handler chose the code itself: it is the code handlers
  // reach for when wrapping an exception, and an exception's text may hold paths, seeds in a bad log line, anything.
  if (e instanceof ByowError && isWireErrorCode(e.code) && e.code !== "internal") {
    return { code: e.code, message: safeText(e.message, 300), ...(e.data === undefined ? {} : { data: e.data }) };
  }
  return { code: "internal", message: GENERIC_FAILURE };
}

/** A parsed error response as the exception a site's code catches. */
export const fromWireError = (e: WireError): ByowError => new ByowError(e.code, e.message, e.data);

// ---------------------------------------------------------------------------------------------
// Manifest (the answer to byow_info): what a wallet says about itself, before any request.

export interface Manifest {
  /** A CLAIM. Never an identity. */
  name: string;
  icon?: string;
  description?: string;
  /** Protocol versions this wallet speaks. */
  versions: string[];
  /** CAIP-2 chains. */
  chains: string[];
  /** Methods, including byow_info. */
  methods: string[];
  /**
   * Per chain family, the transaction types this wallet will sign: "*" for any, or a list of type names.
   * Lets a site disable an action up front instead of failing when the user tries it. Absent means unknown.
   */
  transactions?: Record<string, "*" | string[]>;
}

export const ICON_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_ICON_CHARS = 48 * 1024;
const TX_TYPE_RE = /^[A-Za-z0-9_]{1,40}$/;

function parseTransactions(x: unknown): Manifest["transactions"] | undefined {
  if (!isPlainObject(x)) return undefined;
  const entries = Object.entries(x);
  if (entries.length > 8) return undefined;
  const out: Record<string, "*" | string[]> = {};
  for (const [family, v] of entries) {
    if (!FAMILY_RE.test(family)) return undefined;
    if (v === "*") out[family] = "*";
    else if (Array.isArray(v) && v.length <= 128 && v.every((t) => typeof t === "string" && TX_TYPE_RE.test(t))) out[family] = [...new Set(v as string[])];
    else return undefined;
  }
  return out;
}

/** Strict parse of an untrusted manifest. Throws invalid_response; never returns partial data. */
export function parseManifest(x: unknown): Manifest {
  const fail = (why: string): never => {
    throw new ByowError("invalid_response", `wallet manifest invalid: ${why}`);
  };
  if (!isPlainObject(x)) return fail("not an object");
  const name = typeof x.name === "string" ? safeText(x.name, 64) : "";
  if (!name) fail("name is missing or empty");
  const chains = x.chains;
  if (!Array.isArray(chains) || chains.length > 32 || !chains.every(isChainId)) return fail("chains must be up to 32 CAIP-2 ids");
  const methods = x.methods;
  if (!Array.isArray(methods) || methods.length > 64 || !methods.every((m) => typeof m === "string" && METHOD_RE.test(m))) {
    return fail("methods must be up to 64 method names");
  }
  const versions = x.versions;
  if (!isVersionList(versions, 1)) return fail("versions must be 1-8 version strings");
  const out: Manifest = {
    name,
    versions,
    chains: [...new Set(chains as string[])],
    methods: [...new Set(methods as string[])],
  };
  // Icon, description and the transaction list are advice: drop them if odd rather than failing the whole wallet.
  if (typeof x.icon === "string" && x.icon.length <= MAX_ICON_CHARS && ICON_RE.test(x.icon)) out.icon = x.icon;
  if (typeof x.description === "string") out.description = safeText(x.description, 200);
  const transactions = parseTransactions(x.transactions);
  if (transactions) out.transactions = transactions;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Profiles: what one chain family means on this wire.

/** A chain family's rules for what goes out and what comes back. Registered on the site SDK. */
export interface Profile {
  /** CAIP-2 namespace this profile owns, e.g. "xrpl". */
  family: string;
  /** Methods this profile defines. */
  methods: readonly string[];
  /** Site-side pre-flight so a doomed request never reaches a wallet. Structural only. Throws bad_params. */
  validateParams(method: string, params: Record<string, unknown>): void;
  /** Refuse before any UI when the manifest already says the wallet will not do this. */
  preflight?(method: string, params: Record<string, unknown>, manifest: Manifest): void;
  /** Strict parse of a method result against what was asked. Throws invalid_response. */
  parseResult(method: string, result: unknown, params: Record<string, unknown>): unknown;
}

/** Highest "major.minor" present in both lists, compared numerically ("0.10" > "0.9"). */
export function highestCommonVersion(a: readonly string[], b: readonly string[]): string | undefined {
  const num = (v: string) => v.split(".").map(Number) as [number, number];
  return a
    .filter((x) => b.includes(x))
    .sort((x, y) => {
      const [x1, x2] = num(x);
      const [y1, y2] = num(y);
      return x1 - y1 || x2 - y2;
    })
    .pop();
}
