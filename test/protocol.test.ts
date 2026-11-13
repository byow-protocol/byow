import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  ByowError,
  MAX_MESSAGE_CHARS,
  SDK_ERROR_CODES,
  WIRE_ERRORS,
  highestCommonVersion,
  isJsonValue,
  isWireErrorCode,
  parseManifest,
  parseMessage,
  readyMessage,
  rpcError,
  rpcRequest,
  rpcResult,
  safeText,
  sanitizeData,
  toWireError,
  type WireErrorCode,
} from "../src/protocol.js";

const rq = (over: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: "abc-1", method: "xrpl_connect", params: { chain: "xrpl:1" }, ...over });
const rs = (over: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: "a", ...over });

describe("parseMessage", () => {
  it("ignores anything that is not JSON-RPC 2.0, so the channel can be shared", () => {
    expect(parseMessage({ type: "request" }).kind).toBe("ignore");
    expect(parseMessage("hi").kind).toBe("ignore");
    expect(parseMessage(null).kind).toBe("ignore");
    expect(parseMessage(undefined).kind).toBe("ignore");
    expect(parseMessage([]).kind).toBe("ignore");
    expect(parseMessage({ byow: 1 }).kind).toBe("ignore");
    expect(parseMessage({ byow: "0.1", type: "request", id: "a", method: "byow_info" }).kind).toBe("ignore"); // the 0.1 envelope
    expect(parseMessage({ jsonrpc: "1.0", id: "a", method: "byow_info" }).kind).toBe("ignore");
    expect(parseMessage({ jsonrpc: 2, id: "a", method: "byow_info" }).kind).toBe("ignore");
  });

  it("parses a request, and absent params mean {}", () => {
    expect(parseMessage(rq())).toMatchObject({ kind: "request", req: { jsonrpc: "2.0", id: "abc-1", method: "xrpl_connect", params: { chain: "xrpl:1" } } });
    expect(parseMessage({ jsonrpc: "2.0", id: "a", method: "byow_info" })).toMatchObject({ kind: "request", req: { params: {} } });
  });

  it("flags a malformed request but keeps the id so the wallet can answer bad_request", () => {
    expect(parseMessage(rq({ id: "x1", method: "no spaces allowed" }))).toMatchObject({ kind: "malformed", id: "x1" });
    expect(parseMessage(rq({ id: "x1", method: "m".repeat(65) }))).toMatchObject({ kind: "malformed", id: "x1" });
    expect(parseMessage(rq({ id: "x1", method: 5 }))).toMatchObject({ kind: "malformed", id: "x1" });
  });

  it("refuses positional-array params: half of all wallets would read them one way and half the other", () => {
    expect(parseMessage(rq({ id: "x1", params: [{ chain: "xrpl:1" }] }))).toMatchObject({ kind: "malformed", id: "x1" });
    expect(parseMessage(rq({ id: "x1", params: [] }))).toMatchObject({ kind: "malformed", id: "x1" });
    expect(parseMessage(rq({ id: "x1", params: "xrpl:1" }))).toMatchObject({ kind: "malformed", id: "x1" });
    expect(parseMessage(rq({ id: "x1", params: null }))).toMatchObject({ kind: "malformed", id: "x1" });
  });

  it("gives a request with no usable id no id at all: there is nothing to answer", () => {
    const noId = { jsonrpc: "2.0", method: "byow_info" };
    for (const m of [noId, { ...noId, id: 5 }, { ...noId, id: null }, { ...noId, id: "" }, { ...noId, id: "a".repeat(65) }, { ...noId, id: "has space" }, { ...noId, id: "../x" }]) {
      const p = parseMessage(m);
      expect(p.kind, JSON.stringify(m)).toBe("malformed");
      expect((p as { id?: string }).id).toBeUndefined();
    }
    expect(parseMessage({ ...noId, id: "a".repeat(64) }).kind).toBe("request"); // the longest id there is
    expect(parseMessage({ ...noId, id: "Az09_-" }).kind).toBe("request");
  });

  it("parses the byow_ready notification", () => {
    expect(parseMessage({ jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2", "0.10"] } })).toEqual({ kind: "ready", versions: ["0.2", "0.10"] });
    expect(parseMessage(readyMessage())).toEqual({ kind: "ready", versions: ["0.2"] });
    for (const params of [{}, { versions: "0.2" }, { versions: ["x.y"] }, { versions: Array(9).fill("0.2") }, { versions: [2] }, undefined]) {
      expect(parseMessage({ jsonrpc: "2.0", method: "byow_ready", params }).kind, JSON.stringify(params)).toBe("malformed");
    }
  });

  it("parses a result, including a null one", () => {
    expect(parseMessage(rs({ result: { ok: 1 } }))).toEqual({ kind: "response", id: "a", ok: true, result: { ok: 1 } });
    expect(parseMessage(rs({ result: null }))).toEqual({ kind: "response", id: "a", ok: true, result: null });
  });

  it("refuses a response that carries both a result and an error", () => {
    expect(parseMessage(rs({ result: 1, error: { code: 4001, message: "no" } }))).toMatchObject({ kind: "malformed", id: "a" });
    expect(parseMessage(rs({ result: null, error: { code: 4001, message: "no" } }))).toMatchObject({ kind: "malformed", id: "a" });
  });

  it("refuses a response with neither, a non-object error, or no usable id", () => {
    expect(parseMessage(rs()).kind).toBe("malformed");
    expect(parseMessage(rs({ error: "nope" }))).toMatchObject({ kind: "malformed", id: "a" });
    expect(parseMessage(rs({ error: [4001] }))).toMatchObject({ kind: "malformed", id: "a" });
    const p = parseMessage({ jsonrpc: "2.0", result: 1 });
    expect(p.kind).toBe("malformed");
    expect((p as { id?: string }).id).toBeUndefined();
  });

  it("maps every integer in the error table to its name", () => {
    for (const [name, code] of Object.entries(WIRE_ERRORS)) {
      expect(parseMessage(rs({ error: { code, message: "m" } })), name).toMatchObject({ kind: "response", ok: false, error: { code: name } });
    }
  });

  it("turns an error code this protocol does not define into internal", () => {
    for (const code of [9999, 0, -1, -32000, 4002, 1.5, "pwned", "user_rejected" /* names do not travel */, null, undefined, {}]) {
      const p = parseMessage(rs({ error: { code, message: "x" } }));
      expect(p, String(code)).toMatchObject({ kind: "response", ok: false, error: { code: "internal" } });
    }
  });

  it("strips bidi and control characters from a wallet's error message", () => {
    const p = parseMessage(rs({ error: { code: -32600, message: "ok‮evil\u0000" } }));
    expect((p as { error: { message: string } }).error.message).toBe("okevil");
  });

  it("drops oversize and non-serialisable messages, keeping the id when there is one", () => {
    expect(parseMessage(rq({ id: "a", params: { x: "x".repeat(MAX_MESSAGE_CHARS) } }))).toMatchObject({ kind: "malformed", id: "a" });
    const cyc: Record<string, unknown> = rq({ id: "a" });
    cyc.self = cyc;
    expect(parseMessage(cyc)).toMatchObject({ kind: "malformed", id: "a" });
    expect(parseMessage(rs({ result: "x".repeat(MAX_MESSAGE_CHARS) }))).toMatchObject({ kind: "malformed", id: "a" });
  });
});

describe("rpc builders", () => {
  it("rpcError puts the integer on the wire, not the name", () => {
    expect(rpcError("a", { code: "user_rejected", message: "no" })).toEqual({ jsonrpc: "2.0", id: "a", error: { code: 4001, message: "no" } });
    expect(rpcError("a", { code: "busy", message: "b", data: { n: 1 } })).toEqual({ jsonrpc: "2.0", id: "a", error: { code: 4400, message: "b", data: { n: 1 } } });
    expect("data" in (rpcError("a", { code: "busy", message: "b" }) as { error: object }).error).toBe(false);
    expect("result" in rpcError("a", { code: "busy", message: "b" })).toBe(false);
  });

  it("every code round-trips through JSON and parseMessage as the same name", () => {
    for (const name of Object.keys(WIRE_ERRORS) as WireErrorCode[]) {
      const wire = JSON.parse(JSON.stringify(rpcError("id1", { code: name, message: "m" })));
      expect(typeof wire.error.code).toBe("number");
      expect(parseMessage(wire)).toMatchObject({ kind: "response", id: "id1", ok: false, error: { code: name } });
    }
  });

  it("builds results and requests", () => {
    expect(rpcResult("a", { x: 1 })).toEqual({ jsonrpc: "2.0", id: "a", result: { x: 1 } });
    expect(rpcRequest("a", "byow_info")).toEqual({ jsonrpc: "2.0", id: "a", method: "byow_info", params: {} });
    expect(parseMessage(rpcRequest("a", "xrpl_connect", { chain: "xrpl:0" }))).toMatchObject({ kind: "request", req: { params: { chain: "xrpl:0" } } });
    expect(readyMessage()).toEqual({ jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2"] } });
  });
});

describe("the error table (SPEC 3)", () => {
  it("is exactly the specified integers", () => {
    expect(WIRE_ERRORS).toEqual({
      bad_request: -32600,
      unsupported_method: -32601,
      bad_params: -32602,
      internal: -32603,
      user_rejected: 4001,
      site_not_allowed: 4100,
      wrong_account: 4101,
      unsupported_chain: 4300,
      unsupported_tx: 4301,
      expired: 4302,
      busy: 4400,
    });
  });

  it("the codes only the SDK raises are never wire codes", () => {
    expect([...SDK_ERROR_CODES].sort()).toEqual(["invalid_response", "invalid_wallet_url", "origin_mismatch", "popup_blocked", "timeout", "unsupported_version", "wallet_not_allowed"]);
    for (const c of SDK_ERROR_CODES) expect(isWireErrorCode(c), c).toBe(false);
    for (const gone of ["tx_failed", "not_confirmed"]) expect(isWireErrorCode(gone), gone).toBe(false);
  });
});

describe("parseManifest", () => {
  const good = { name: "Toy", chains: ["xrpl:1"], methods: ["byow_info", "xrpl_connect"], versions: ["0.2"] };

  it("accepts a valid manifest", () => {
    expect(parseManifest(good)).toMatchObject({ name: "Toy", chains: ["xrpl:1"], versions: ["0.2"] });
  });

  it("sanitises the name and rejects one that is empty afterwards", () => {
    expect(parseManifest({ ...good, name: "Safe‮Wallet" }).name).toBe("SafeWallet");
    expect(() => parseManifest({ ...good, name: "​‮" })).toThrow(ByowError);
  });

  it("rejects bad chains, methods and versions; drops (not rejects) a bad icon", () => {
    expect(() => parseManifest({ ...good, chains: ["xrpl"] })).toThrow();
    expect(() => parseManifest({ ...good, methods: ["a b"] })).toThrow();
    expect(() => parseManifest({ ...good, versions: [] })).toThrow();
    expect(parseManifest({ ...good, icon: "https://evil.example/x.png" }).icon).toBeUndefined();
    expect(parseManifest({ ...good, icon: "data:image/svg+xml;base64,AAAA" }).icon).toBeUndefined();
    expect(parseManifest({ ...good, icon: "data:image/png;base64,iVBORw0KGgo=" }).icon).toBeDefined();
  });

  it("enforces the manifest's limits (SPEC 4)", () => {
    const png = (n: number) => "data:image/png;base64," + "A".repeat(n);
    expect(parseManifest({ ...good, icon: png(48 * 1024 - 22) }).icon).toBeDefined();
    expect(parseManifest({ ...good, icon: png(48 * 1024) }).icon).toBeUndefined(); // too big: dropped, not fatal
    expect(parseManifest({ ...good, description: "d".repeat(500) }).description).toHaveLength(200);
    expect(parseManifest({ ...good, name: "n".repeat(100) }).name).toHaveLength(64);
    expect(() => parseManifest({ ...good, chains: Array.from({ length: 33 }, (_, i) => `xrpl:${i}`) })).toThrow(ByowError);
    expect(() => parseManifest({ ...good, methods: Array.from({ length: 65 }, (_, i) => `m${i}`) })).toThrow(ByowError);
    expect(() => parseManifest({ ...good, versions: Array(9).fill("0.2") })).toThrow(ByowError);
    expect(() => parseManifest({ ...good, versions: ["v0.2"] })).toThrow(ByowError);
    expect(() => parseManifest(null)).toThrow(ByowError);
    expect(() => parseManifest([])).toThrow(ByowError);
  });

  it("parses transactions: a list of types, or \"*\", per chain family", () => {
    expect(parseManifest({ ...good, transactions: { xrpl: ["Payment", "TrustSet"] } }).transactions).toEqual({ xrpl: ["Payment", "TrustSet"] });
    expect(parseManifest({ ...good, transactions: { xrpl: "*" } }).transactions).toEqual({ xrpl: "*" });
    expect(parseManifest({ ...good, transactions: { xrpl: "*", eip155: ["eth_sendTransaction"] } }).transactions).toEqual({ xrpl: "*", eip155: ["eth_sendTransaction"] });
    expect(parseManifest(good).transactions).toBeUndefined(); // absent means unknown
  });

  it("drops a malformed transactions field instead of failing the whole manifest", () => {
    const bad: unknown[] = [
      "Payment",
      ["Payment"],
      { xrpl: "everything" },
      { xrpl: [5] },
      { xrpl: ["Pay ment"] },
      { xrpl: ["Payment", "<script>"] },
      { xrpl: ["x".repeat(41)] },
      { XRPL: "*" },
      { xrpl: "*", broken: 1 }, // one bad family spoils the field, not the manifest
      Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`fam${i}`, "*"])),
      { xrpl: Array(129).fill("Payment") },
    ];
    for (const transactions of bad) {
      const m = parseManifest({ ...good, transactions });
      expect(m.transactions, JSON.stringify(transactions)).toBeUndefined();
      expect(m.name).toBe("Toy");
    }
  });
});

describe("safeText and toWireError", () => {
  it("removes text that reads differently than it is", () => {
    expect(safeText("a‪b⁦c​d")).toBe("abcd");
  });
  it("never leaks an arbitrary exception message to the site", () => {
    expect(toWireError(new Error("seed is sEdSECRET at /Users/shane/x"))).toEqual({ code: "internal", message: "the wallet failed to process the request" });
    expect(toWireError(new ByowError("user_rejected", "no")).code).toBe("user_rejected");
    expect(toWireError(new ByowError("timeout", "sdk-only code")).code).toBe("internal");
  });
});

describe("review findings: protocol regressions", () => {
  it("safeText strips blank-looking and invisible characters an allow-nothing block-list missed", () => {
    const sneaky = ["ㅤ", "ﾠ", "ᅟ", "ᅠ", "᠎", "͏", "឴", "឵", "⠀", "￼", "️", "\u{E0041}", " ", " ", " ", " ", "　"];
    for (const c of sneaky) expect(safeText(`a${c}b`), JSON.stringify(c)).toBe("ab");
    expect(safeText("Plain Name 1.0")).toBe("Plain Name 1.0");
    expect(safeText("محفظة")).toBeTruthy(); // ordinary non-Latin text survives
  });

  it("a manifest name made only of blank characters is rejected, not shown as a blank wallet", () => {
    expect(() => parseManifest({ name: "ㅤㅤ", chains: ["xrpl:1"], methods: ["xrpl_connect"], versions: ["0.2"] })).toThrow(/name/);
  });

  it("sanitises error.data that reaches the caller", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "msg": "<img onerror=x>‮", "big": "' + "x".repeat(5000) + '"}');
    const p = parseMessage(rs({ error: { code: -32600, message: "m", data: evil } }));
    const data = (p as any).error.data;
    expect(Object.prototype.hasOwnProperty.call(data, "__proto__")).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect(data.msg).not.toContain("‮");
    expect(data.big.length).toBeLessThanOrEqual(200);
    expect(sanitizeData({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toBeDefined(); // deep input is bounded, not a crash
  });

  it("accepts only what JSON can express", () => {
    expect(isJsonValue({ a: [1, "x", null, true, { b: 2 }] })).toBe(true);
    expect(isJsonValue({ chain: undefined })).toBe(true); // an undefined property is absent in JSON
    for (const bad of [new Map(), new Set(), new Date(), new ArrayBuffer(8), new Uint8Array(4), 10n, NaN, Infinity, () => 1, Symbol("x")]) {
      expect(isJsonValue({ x: bad }), String(bad)).toBe(false);
    }
    expect(parseMessage(rq({ id: "a", method: "m", params: { buf: new ArrayBuffer(8) } }))).toMatchObject({ kind: "malformed", id: "a" });
    expect(parseMessage(rs({ result: { m: new Map() } }))).toMatchObject({ kind: "malformed", id: "a" });
  });

  it("bounds depth and node count", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(isJsonValue(deep)).toBe(false);
    expect(isJsonValue(Array.from({ length: 25_000 }, () => 1))).toBe(false);
    expect(parseMessage(rq({ id: "a", params: { deep } }))).toMatchObject({ kind: "malformed", id: "a" });
  });

  it("accepts messages deserialised in another realm (the isolating iframe's), which have a different Object.prototype", () => {
    // This is exactly the shape the site SDK receives: a prototype comparison against our own Object.prototype
    // rejected every wallet message and no unit test noticed, because they all built objects in one realm.
    const foreign = vm.runInNewContext('({ jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2"] }, nested: { a: [1, { b: 2 }] } })');
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(isJsonValue(foreign)).toBe(true);
    expect(parseMessage(foreign).kind).toBe("ready");
    const foreignReq = vm.runInNewContext('({ jsonrpc: "2.0", id: "a", method: "xrpl_connect", params: { chain: "xrpl:1" } })');
    expect(parseMessage(foreignReq).kind).toBe("request");
    expect(isJsonValue(vm.runInNewContext("({ x: new Map() })"))).toBe(false); // still rejects non-JSON from another realm
    expect(isJsonValue(vm.runInNewContext("({ x: new Uint8Array(4) })"))).toBe(false);
  });

  it("tolerates an undefined property (structured clone keeps it, JSON drops it)", () => {
    expect(parseMessage(rq({ id: "a", method: "xrpl_connect", params: { chain: undefined } })).kind).toBe("request");
    expect(parseMessage(rq({ id: "a", extra: undefined })).kind).toBe("request");
  });

  it("picks versions numerically, so 0.10 beats 0.9", () => {
    expect(highestCommonVersion(["0.9", "0.10"], ["0.9", "0.10"])).toBe("0.10");
    expect(highestCommonVersion(["0.1"], ["0.2"])).toBeUndefined();
  });
});
