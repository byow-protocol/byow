// The wallet core (SPEC 2, 3, 4, 7.5, 11 W1/W3/W7): one message in, at most one out. Everything a wallet must
// get right whatever the carrier. Driven directly, with hand-written handlers and no carrier.

import { describe, expect, it } from "vitest";
import { ByowError, SDK_ERROR_CODES, WIRE_ERRORS, type ErrorCode, type WireErrorCode } from "../src/protocol.js";
import { createWalletCore, type Asker, type Handler, type HandlerContext, type Outcome, type WalletCoreOptions } from "../src/wallet/core.js";

const SITE = "https://site.example";
const ASKER: Asker = { origin: SITE, originProof: "browser", carrier: "window" };
const INFO = { name: "Core Wallet", chains: ["test:1", "test:2"] };

const msg = (id: string, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const code = (o: Outcome): number | undefined => (o.response && "error" in o.response ? o.response.error.code : undefined);
const errorOf = (o: Outcome) => (o.response && "error" in o.response ? o.response.error : undefined);

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** A core whose handlers all count their calls. */
function make(extra: Partial<WalletCoreOptions> = {}, handlers: Record<string, Handler> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown>; ctx: HandlerContext }> = [];
  const spy = (method: string, result: unknown = { ok: method }): Handler => (params, ctx) => {
    calls.push({ method, params, ctx });
    return result;
  };
  const core = createWalletCore({ info: INFO, handlers: { test_do: spy("test_do"), test_other: spy("test_other"), ...handlers }, ...extra });
  return { core, calls, spy };
}

describe("byow_info", () => {
  it("returns the manifest without calling a handler, without UI, and any number of times", async () => {
    const { core, calls } = make();
    let pending = 0;
    for (let i = 0; i < 5; i++) {
      const out = await core.handle(msg("info_" + i, "byow_info"), { ...ASKER, onPending: () => pending++ });
      expect(out.response).toEqual({ jsonrpc: "2.0", id: "info_" + i, result: core.manifest });
      expect(out.spent).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(pending).toBe(0);
  });

  it("the manifest has the name, the versions, the chains and every method including byow_info", async () => {
    const { core } = make();
    expect(core.manifest.name).toBe("Core Wallet");
    expect(core.manifest.versions).toEqual(["0.2"]);
    expect(core.manifest.chains).toEqual(["test:1", "test:2"]);
    expect([...core.manifest.methods].sort()).toEqual(["byow_info", "test_do", "test_other"]);
    expect(core.manifest.transactions).toBeUndefined();
    expect("transactions" in core.manifest).toBe(false);
    // What goes on the wire is JSON-clean.
    expect(JSON.parse(JSON.stringify(core.manifest))).toEqual(core.manifest);
  });

  it("carries transactions, icon and description when given", async () => {
    const icon = "data:image/png;base64,iVBORw0KGgo=";
    const { core } = make({ transactions: { test: ["Pay", "Trust"], other: "*" }, info: { ...INFO, icon, description: "A wallet for tests" } });
    expect(core.manifest.transactions).toEqual({ test: ["Pay", "Trust"], other: "*" });
    expect(core.manifest.icon).toBe(icon);
    expect(core.manifest.description).toBe("A wallet for tests");
    const out = await core.handle(msg("i1", "byow_info"), ASKER);
    expect(out.response).toMatchObject({ result: { transactions: { test: ["Pay", "Trust"], other: "*" } } });
  });

  it("does not list a handler twice if it is named byow_info, and still answers it itself", async () => {
    let ran = false;
    const { core } = make({}, { byow_info: () => ((ran = true), { name: "impostor" }) });
    expect(core.manifest.methods.filter((m) => m === "byow_info")).toHaveLength(1);
    const out = await core.handle(msg("i1", "byow_info"), ASKER);
    expect(ran).toBe(false);
    expect(out.response).toEqual({ jsonrpc: "2.0", id: "i1", result: core.manifest });
  });

  it("an invalid info throws at construction", () => {
    const h = { test_do: () => 1 };
    for (const info of [
      { name: "", chains: ["test:1"] },
      { name: "   ", chains: ["test:1"] },
      { name: "ㅤㅤ", chains: ["test:1"] }, // Hangul fillers: blank on screen
      { name: "​‮", chains: ["test:1"] },
      { name: 5 as unknown as string, chains: ["test:1"] },
      { name: "W", chains: ["not-caip"] },
      { name: "W", chains: ["XRPL:1"] },
      { name: "W", chains: "test:1" as unknown as string[] },
      { name: "W", chains: Array.from({ length: 33 }, (_, i) => `test:${i}`) },
    ]) {
      expect(() => createWalletCore({ info, handlers: h }), JSON.stringify(info)).toThrow();
    }
    expect(() => createWalletCore({ info: INFO, handlers: { "bad method!": () => 1 } })).toThrow();
    expect(() => createWalletCore({ info: INFO, handlers: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`m_${i}`, () => 1])) })).toThrow(); // 64 + byow_info > 64
  });

  it("strips text the spec says to strip from the name, so what the core shows is what a site will", () => {
    const { core } = make({ info: { name: "  Safe‮​Name ", chains: ["test:1"] } });
    expect(core.manifest.name).toBe("SafeName");
  });
});

describe("refusals before any handler runs", () => {
  it("a malformed message with an id is bad_request (-32600) and spends nothing", async () => {
    const { core, calls } = make();
    const big = { blob: "x".repeat(300 * 1024) };
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    for (const bad of [
      msg("m1", "bad method!"),
      msg("m2", "has-dash"),
      msg("m3", ""),
      { jsonrpc: "2.0", id: "m4", method: 5 },
      { jsonrpc: "2.0", id: "m5" },
      msg("m6", "test_do", [{ chain: "test:1" }]), // positional params
      msg("m7", "test_do", "string params"),
      msg("m8", "test_do", null),
      msg("m9", "test_do", big),
      msg("m10", "test_do", { m: new Map() }),
      msg("m11", "test_do", { n: Number.NaN }),
      msg("m12", "test_do", { n: 10n }),
      msg("m13", "test_do", { cyc }),
      msg("m14", "test_do", { d: new Date(0) }),
      msg("m15", "test_do", { b: new Uint8Array(2) }),
      msg("m16", "test_do", { f: () => 1 }),
    ]) {
      const out = await core.handle(bad, ASKER);
      expect(code(out), (bad as { id: string }).id).toBe(WIRE_ERRORS.bad_request);
      expect(code(out)).toBe(-32600);
      expect(out.code).toBe("bad_request");
      expect(out.spent).toBe(false);
      expect(out.response).toMatchObject({ jsonrpc: "2.0", id: (bad as { id: string }).id });
      expect(out.response).not.toHaveProperty("result");
    }
    expect(calls).toEqual([]);
  });

  it("a message with no usable id gets no response at all", async () => {
    const { core, calls } = make();
    const long = "a".repeat(65);
    const noId: unknown[] = [
      { jsonrpc: "2.0", method: "test_do", params: {} },
      { jsonrpc: "2.0", method: "byow_info" },
      { jsonrpc: "2.0", id: "", method: "test_do" },
      { jsonrpc: "2.0", id: "has space", method: "test_do" },
      { jsonrpc: "2.0", id: "bad/id", method: "test_do" },
      { jsonrpc: "2.0", id: long, method: "test_do" },
      { jsonrpc: "2.0", id: 7, method: "test_do" },
      { jsonrpc: "2.0", id: null, method: "test_do" },
      { jsonrpc: "2.0", id: ["x"], method: "test_do" },
      { jsonrpc: "2.0", method: "bad method!", params: [1] }, // malformed with no id
      { jsonrpc: "2.0", id: "", method: "test_do", params: [1] },
    ];
    for (const m of noId) {
      const out = await core.handle(m, ASKER);
      expect(out, JSON.stringify(m)).toEqual({ response: null, spent: false });
    }
    expect(calls).toEqual([]);
  });

  it("answers an id of 1 and of 64 characters", async () => {
    const { core } = make();
    for (const id of ["a", "A-_9".repeat(16)]) {
      expect((await core.handle(msg(id, "byow_info"), ASKER)).response).toMatchObject({ id });
    }
  });

  it("stays silent for anything that is not a request: not JSON-RPC, a notification, a response", async () => {
    const { core, calls } = make();
    for (const m of [
      { hello: "world" },
      { jsonrpc: "1.0", id: "a1", method: "test_do" },
      { jsonrpc: 2, id: "a1", method: "test_do" },
      { jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2"] } },
      { jsonrpc: "2.0", id: "r1", result: { ok: true } },
      { jsonrpc: "2.0", id: "r1", error: { code: 4001, message: "no" } },
    ]) {
      expect(await core.handle(m, ASKER), JSON.stringify(m)).toEqual({ response: null, spent: false });
    }
    expect(calls).toEqual([]);
  });

  it("an unknown method is unsupported_method (-32601), including names that exist on Object.prototype", async () => {
    const { core, calls } = make();
    for (const method of ["nope", "test_missing", "xrpl_connect", "constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "BYOW_INFO"]) {
      const out = await core.handle(msg("u1", method, { chain: "test:1" }), ASKER);
      expect(code(out), method).toBe(-32601);
      expect(out.code).toBe("unsupported_method");
      expect(out.spent).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("a params.chain that is not CAIP-2 is bad_params (-32602)", async () => {
    const { core, calls } = make();
    for (const chain of ["test", "test1", "TEST:1", "te:1", "toolongns1:1", "test:", "test:has space", "test:" + "a".repeat(33), "", ":1", 5, true, {}, ["test:1"], null]) {
      const out = await core.handle(msg("c1", "test_do", { chain }), ASKER);
      expect(code(out), JSON.stringify(chain)).toBe(-32602);
      expect(out.code).toBe("bad_params");
      expect(out.spent).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("a chain that is well formed but not in the manifest is unsupported_chain (4300)", async () => {
    const { core, calls } = make();
    for (const chain of ["test:3", "xrpl:0", "eip155:1", "test:10"]) {
      const out = await core.handle(msg("c2", "test_do", { chain }), ASKER);
      expect(code(out), chain).toBe(4300);
      expect(out.code).toBe("unsupported_chain");
      expect(out.spent).toBe(false);
      expect(JSON.stringify(out.response)).not.toContain("onPending");
    }
    expect(calls).toEqual([]);
  });

  it("positional-array params are bad_request, never read as an object", async () => {
    const { core, calls } = make();
    const out = await core.handle(msg("p1", "test_do", [{ chain: "test:1" }]), ASKER);
    expect(out.code).toBe("bad_request");
    expect(code(out)).toBe(-32600);
    const empty = await core.handle(msg("p2", "test_do", []), ASKER);
    expect(empty.code).toBe("bad_request");
    expect(calls).toEqual([]);
  });

  it("refusals never call onPending, never use up the wallet, and a valid request still runs after each", async () => {
    const { core, calls } = make();
    const pending: string[] = [];
    const asker = { ...ASKER, onPending: (m: string) => pending.push(m) };
    await core.handle(msg("r1", "nope"), asker);
    await core.handle(msg("r2", "test_do", { chain: "bad" }), asker);
    await core.handle(msg("r3", "test_do", { chain: "test:9" }), asker);
    await core.handle(msg("r4", "test_do bad"), asker);
    await core.handle({ jsonrpc: "2.0", method: "test_do" }, asker);
    expect(pending).toEqual([]);
    const ok = await core.handle(msg("r5", "test_do", { chain: "test:1" }), asker);
    expect(ok.response).toEqual({ jsonrpc: "2.0", id: "r5", result: { ok: "test_do" } });
    expect(pending).toEqual(["test_do"]);
    expect(calls).toHaveLength(1);
  });

  it("the request is answered with the id it came with", async () => {
    const { core } = make();
    for (const m of ["nope", "test_do", "byow_info"]) {
      const out = await core.handle(msg("echo_me-1", m), ASKER);
      expect(out.response).toMatchObject({ jsonrpc: "2.0", id: "echo_me-1" });
    }
  });
});

describe("allowSite", () => {
  it("false is site_not_allowed (4100), spent false, and the handler never runs", async () => {
    const { core, calls } = make({ allowSite: () => false });
    const pending: string[] = [];
    const out = await core.handle(msg("s1", "test_do", { chain: "test:1" }), { ...ASKER, onPending: (m) => pending.push(m) });
    expect(code(out)).toBe(4100);
    expect(out.code).toBe("site_not_allowed");
    expect(out.spent).toBe(false);
    expect(calls).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("receives the asker's origin, including null, and decides per origin", async () => {
    const seen: Array<string | null> = [];
    const { core, calls } = make({
      allowSite: (o) => (seen.push(o), o === SITE),
    });
    expect((await core.handle(msg("a1", "test_do"), ASKER)).code).toBeUndefined();
    expect((await core.handle(msg("a2", "test_do"), { ...ASKER, origin: "https://evil.example" })).code).toBe("site_not_allowed");
    expect((await core.handle(msg("a3", "test_do"), { origin: null, originProof: "none", carrier: "link" })).code).toBe("site_not_allowed");
    expect(seen).toEqual([SITE, "https://evil.example", null]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx.origin).toBe(SITE);
  });

  it("a wallet that allows null origins lets a link with no return path through", async () => {
    const { core, calls } = make({ allowSite: (o) => o === null });
    const out = await core.handle(msg("n1", "test_do"), { origin: null, originProof: "none", carrier: "link" });
    expect(out.response).toMatchObject({ result: { ok: "test_do" } });
    expect(calls[0]!.ctx).toMatchObject({ origin: null, originProof: "none", carrier: "link" });
  });

  it("is not consulted for a message nobody will answer", async () => {
    let asked = 0;
    const { core } = make({ allowSite: () => (asked++, true) });
    await core.handle({ jsonrpc: "2.0", method: "test_do" }, ASKER);
    await core.handle("junk", ASKER);
    expect(asked).toBe(0);
  });

  // allowSite is the wallet author's code. Fail closed: a policy that throws has not said yes.
  it("an allowSite that throws is a refusal, not an exception", async () => {
    let ran = false;
    const { core } = make({
      allowSite: () => {
        throw new Error("policy store unreachable");
      },
    }, { test_do: () => ((ran = true), 1) });
    const out = await core.handle(msg("t1", "test_do"), ASKER);
    expect(ran).toBe(false);
    expect(out.response === null || "error" in out.response!).toBe(true);
  });
});

describe("one UI request at a time", () => {
  it("a second request while the first handler is pending is busy (4400); after it settles a new one runs", async () => {
    const gate = deferred();
    const started = deferred();
    const { core, calls } = make({}, {
      test_slow: () => (started.resolve(undefined), gate.promise),
    });
    const first = core.handle(msg("b1", "test_slow"), ASKER);
    await started.promise;

    for (const method of ["test_slow", "test_do", "test_other"]) {
      const out = await core.handle(msg("b2", method), ASKER);
      expect(code(out), method).toBe(4400);
      expect(out.code).toBe("busy");
      expect(out.spent).toBe(false);
    }
    expect(calls).toEqual([]);

    gate.resolve({ done: true });
    expect((await first).response).toEqual({ jsonrpc: "2.0", id: "b1", result: { done: true } });
    expect((await core.handle(msg("b3", "test_do"), ASKER)).response).toMatchObject({ id: "b3", result: { ok: "test_do" } });
    expect(calls).toHaveLength(1);
  });

  it("busy does not stop byow_info, and a refusal still beats busy for what is plainly wrong", async () => {
    const gate = deferred();
    const started = deferred();
    const { core } = make({}, { test_slow: () => (started.resolve(undefined), gate.promise) });
    const first = core.handle(msg("b1", "test_slow"), ASKER);
    await started.promise;
    expect((await core.handle(msg("i1", "byow_info"), ASKER)).response).toEqual({ jsonrpc: "2.0", id: "i1", result: core.manifest });
    expect((await core.handle(msg("i2", "no_such_method"), ASKER)).code).toBe("unsupported_method");
    expect((await core.handle(msg("i3", "bad method!"), ASKER)).code).toBe("bad_request");
    gate.resolve(1);
    await first;
  });

  it("the wallet is free again after a handler throws or rejects", async () => {
    const { core } = make({}, {
      test_throw: () => {
        throw new ByowError("user_rejected", "no");
      },
      test_reject: async () => {
        throw new Error("boom");
      },
    });
    expect((await core.handle(msg("t1", "test_throw"), ASKER)).code).toBe("user_rejected");
    expect((await core.handle(msg("t2", "test_reject"), ASKER)).code).toBe("internal");
    expect((await core.handle(msg("t3", "test_do"), ASKER)).response).toMatchObject({ result: { ok: "test_do" } });
  });

  it("asker.spent makes UI requests busy, while byow_info still answers", async () => {
    const { core, calls } = make();
    const spent = { ...ASKER, spent: true };
    const pending: string[] = [];
    const out = await core.handle(msg("sp1", "test_do", { chain: "test:1" }), { ...spent, onPending: (m) => pending.push(m) });
    expect(code(out)).toBe(4400);
    expect(out.code).toBe("busy");
    expect(out.spent).toBe(false);
    expect((await core.handle(msg("sp2", "byow_info"), spent)).response).toEqual({ jsonrpc: "2.0", id: "sp2", result: core.manifest });
    expect(calls).toEqual([]);
    expect(pending).toEqual([]);
    // A fresh context (a new document) is not affected by another's.
    expect((await core.handle(msg("sp3", "test_do"), ASKER)).response).toMatchObject({ result: { ok: "test_do" } });
  });

  it("many concurrent requests: exactly one runs", async () => {
    const gate = deferred();
    let running = 0;
    let max = 0;
    const { core } = make({}, {
      test_slow: async () => {
        max = Math.max(max, ++running);
        await gate.promise;
        running--;
        return 1;
      },
    });
    const all = Array.from({ length: 10 }, (_, i) => core.handle(msg("c" + i, "test_slow"), ASKER));
    await Promise.resolve();
    gate.resolve(undefined);
    const outs = await Promise.all(all);
    expect(max).toBe(1);
    expect(outs.filter((o) => o.code === "busy")).toHaveLength(9);
    expect(outs.filter((o) => o.response && "result" in o.response)).toHaveLength(1);
  });
});

describe("what a handler is given", () => {
  it("params, origin, originProof, carrier, chain and signal exactly as the asker gave them", async () => {
    const { core, calls } = make();
    const ac = new AbortController();
    const params = { chain: "test:2", text: "hi", nested: { a: [1, 2, { b: null }] } };
    await core.handle(msg("h1", "test_do", params), { origin: "https://delivery.example", originProof: "delivery", carrier: "link", signal: ac.signal });
    expect(calls).toHaveLength(1);
    const { ctx, params: got } = calls[0]!;
    expect(got).toEqual(params);
    expect(ctx).toEqual({ origin: "https://delivery.example", originProof: "delivery", carrier: "link", chain: "test:2", signal: ac.signal });
    expect(ctx.signal).toBe(ac.signal);
    ac.abort();
    expect(ctx.signal.aborted).toBe(true);
  });

  it("origin null with proof none, and each carrier and proof, pass through untouched", async () => {
    const { core, calls } = make();
    await core.handle(msg("h1", "test_do"), { origin: null, originProof: "none", carrier: "link" });
    await core.handle(msg("h2", "test_do"), { origin: SITE, originProof: "browser", carrier: "page" });
    await core.handle(msg("h3", "test_do"), { origin: SITE, originProof: "browser", carrier: "window" });
    expect(calls.map((c) => [c.ctx.origin, c.ctx.originProof, c.ctx.carrier])).toEqual([
      [null, "none", "link"],
      [SITE, "browser", "page"],
      [SITE, "browser", "window"],
    ]);
  });

  it("no chain in the params means no chain in the context, and absent params mean {}", async () => {
    const { core, calls } = make();
    await core.handle(msg("h1", "test_do"), ASKER);
    await core.handle(msg("h2", "test_do", { text: "x" }), ASKER);
    expect(calls[0]!.params).toEqual({});
    expect("chain" in calls[0]!.ctx).toBe(false);
    expect("chain" in calls[1]!.ctx).toBe(false);
  });

  it("with no signal given, the handler still gets a usable AbortSignal that is not aborted", async () => {
    const { core, calls } = make();
    await core.handle(msg("h1", "test_do"), ASKER);
    expect(calls[0]!.ctx.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.ctx.signal.aborted).toBe(false);
  });

  it("onPending fires with the method name before the handler runs, once per handled request", async () => {
    const order: string[] = [];
    const { core } = make({}, { test_order: () => (order.push("handler"), 1) });
    await core.handle(msg("o1", "test_order"), { ...ASKER, onPending: (m) => order.push("pending:" + m) });
    await core.handle(msg("o2", "byow_info"), { ...ASKER, onPending: (m) => order.push("pending:" + m) });
    expect(order).toEqual(["pending:test_order", "handler"]);
  });

  it("an async handler's result is awaited, and the outcome names the method", async () => {
    const { core } = make({}, { test_async: async () => ((await Promise.resolve()), { later: true }) });
    const out = await core.handle(msg("a1", "test_async"), ASKER);
    expect(out).toEqual({ response: { jsonrpc: "2.0", id: "a1", result: { later: true } }, spent: true, method: "test_async" });
  });
});

describe("what comes out", () => {
  it("a successful handler is { jsonrpc, id, result } and spends the context", async () => {
    const { core } = make();
    const out = await core.handle(msg("ok1", "test_do", { chain: "test:1" }), ASKER);
    expect(out.response).toEqual({ jsonrpc: "2.0", id: "ok1", result: { ok: "test_do" } });
    expect(out.spent).toBe(true);
    expect(out.code).toBeUndefined();
    expect(out.method).toBe("test_do");
  });

  it("a handler that returns undefined still answers with a result member the site can see", async () => {
    const { core } = make({}, { test_void: () => undefined });
    const out = await core.handle(msg("v1", "test_void"), ASKER);
    expect(out.response).toMatchObject({ jsonrpc: "2.0", id: "v1" });
    // JSON has no undefined: what travels must still be a response, not a silent drop.
    expect(JSON.parse(JSON.stringify(out.response))).toMatchObject({ jsonrpc: "2.0", id: "v1" });
  });

  it("a response carries a result or an error, never both", async () => {
    const { core } = make({}, {
      test_throw: () => {
        throw new Error("x");
      },
    });
    for (const m of ["test_do", "test_throw", "nope", "byow_info"]) {
      const r = (await core.handle(msg("e1", m), ASKER)).response!;
      expect("result" in r !== "error" in r, m).toBe(true);
    }
  });
});

describe("error hygiene", () => {
  const SECRET = "seed sEdSECRET at /Users/x";

  it("a plain Error becomes internal (-32603) with a generic message that holds none of its text", async () => {
    const { core } = make({}, {
      test_leak: () => {
        throw new Error(SECRET);
      },
      test_leak_async: async () => {
        throw new TypeError(SECRET);
      },
    });
    for (const method of ["test_leak", "test_leak_async"]) {
      const out = await core.handle(msg("l1", method), ASKER);
      expect(code(out)).toBe(-32603);
      expect(out.code).toBe("internal");
      expect(out.spent).toBe(true);
      const wire = JSON.stringify(out.response);
      for (const frag of ["sEdSECRET", "/Users", "seed", "TypeError", "at "]) expect(wire, `${method} leaked ${frag}`).not.toContain(frag);
      expect(errorOf(out)!.message.length).toBeGreaterThan(0);
      expect(errorOf(out)).not.toHaveProperty("data");
    }
  });

  it("anything thrown that is not a ByowError is internal: strings, objects, null, undefined, errors with a code field", async () => {
    const thrown: unknown[] = [SECRET, { message: SECRET }, null, undefined, 42, Object.assign(new Error(SECRET), { code: "user_rejected" }), Object.assign(new Error(SECRET), { code: 4001 }), { code: "user_rejected", message: SECRET }];
    for (const [i, t] of thrown.entries()) {
      const { core } = make({}, {
        test_t: () => {
          throw t;
        },
      });
      const out = await core.handle(msg("t" + i, "test_t"), ASKER);
      expect(out.code, String(i)).toBe("internal");
      expect(code(out)).toBe(-32603);
      expect(JSON.stringify(out.response)).not.toContain("SECRET");
      expect(out.spent).toBe(true);
    }
  });

  it("a ByowError user_rejected is 4001 and spends the context", async () => {
    const { core } = make({}, {
      test_no: () => {
        throw new ByowError("user_rejected", "The user declined.");
      },
    });
    const out = await core.handle(msg("n1", "test_no"), ASKER);
    expect(code(out)).toBe(4001);
    expect(out.code).toBe("user_rejected");
    expect(out.spent).toBe(true);
    expect(errorOf(out)!.message).toBe("The user declined.");
  });

  it("refusals a handler throws do not spend the context (7.5): the site may retry", async () => {
    const retryable: WireErrorCode[] = ["bad_params", "unsupported_tx", "wrong_account", "expired", "unsupported_chain", "unsupported_method", "bad_request", "site_not_allowed"];
    for (const c of retryable) {
      const { core } = make({}, {
        test_r: () => {
          throw new ByowError(c, "refused");
        },
      });
      const out = await core.handle(msg("r1", "test_r"), ASKER);
      expect(code(out), c).toBe(WIRE_ERRORS[c]);
      expect(out.code).toBe(c);
      expect(out.spent, c).toBe(false);
    }
  });

  it("unsupported_tx is 4301 with spent false; wrong_account is 4101", async () => {
    const { core } = make({}, {
      test_tx: () => {
        throw new ByowError("unsupported_tx", "will not sign that");
      },
      test_acct: () => {
        throw new ByowError("wrong_account", "not mine");
      },
    });
    const tx = await core.handle(msg("x1", "test_tx"), ASKER);
    expect([code(tx), tx.spent]).toEqual([4301, false]);
    const acct = await core.handle(msg("x2", "test_acct"), ASKER);
    expect([code(acct), acct.spent]).toEqual([4101, false]);
  });

  it("an SDK-only code thrown by a handler comes out as internal, never as its own code, and its text stays home", async () => {
    for (const c of SDK_ERROR_CODES) {
      const { core } = make({}, {
        test_sdk: () => {
          throw new ByowError(c, `${c}: ${SECRET}`);
        },
      });
      const out = await core.handle(msg("s1", "test_sdk"), ASKER);
      expect(out.code, c).toBe("internal");
      expect(code(out), c).toBe(-32603);
      expect(JSON.stringify(out.response)).not.toContain("SECRET");
      expect(JSON.stringify(out.response)).not.toContain(c); // not even as a name in a message
      expect(out.spent).toBe(true);
    }
  });

  it("a ByowError whose code is not a wire code at all is internal", async () => {
    for (const c of ["toString", "__proto__", "constructor", "nope", ""]) {
      const { core } = make({}, {
        test_bad: () => {
          throw new ByowError(c as ErrorCode, SECRET);
        },
      });
      const out = await core.handle(msg("b1", "test_bad"), ASKER);
      expect(out.code, JSON.stringify(c)).toBe("internal");
      expect(JSON.stringify(out.response)).not.toContain("SECRET");
    }
  });

  it("strips invisible and bidi characters from a message a handler chose to send", async () => {
    const { core } = make({}, {
      test_no: () => {
        throw new ByowError("user_rejected", "declined‮​ㅤ here");
      },
    });
    expect(errorOf(await core.handle(msg("n1", "test_no"), ASKER))!.message).toBe("declined here");
  });

  // `internal` is the code a handler reaches for when it wraps an exception, as in `new ByowError("internal", String(e))`.
  // SPEC 3: its message is always generic, whoever chose the code.
  it("a ByowError('internal', ...) from a handler gets the generic message, not its own text", async () => {
    const { core } = make({}, {
      test_i: () => {
        throw new ByowError("internal", SECRET);
      },
    });
    const out = await core.handle(msg("i1", "test_i"), ASKER);
    expect(code(out)).toBe(-32603);
    expect(JSON.stringify(out.response)).not.toContain("SECRET");
  });
});

describe("handle never throws", () => {
  it("whatever it is given", async () => {
    const { core, calls } = make();
    const cyc: Record<string, unknown> = { jsonrpc: "2.0", id: "cy", method: "test_do", params: {} };
    (cyc.params as Record<string, unknown>).self = cyc.params;
    const cycTop: Record<string, unknown> = { jsonrpc: "2.0" };
    cycTop.self = cycTop;
    const inputs: unknown[] = [
      null,
      undefined,
      "a string",
      '{"jsonrpc":"2.0","id":"s1","method":"byow_info"}', // JSON text is not a message
      0,
      42,
      NaN,
      true,
      10n,
      Symbol("s"),
      () => 1,
      [],
      [msg("a1", "byow_info")],
      {},
      cyc,
      cycTop,
      new Map([["jsonrpc", "2.0"]]),
      new Set(),
      new Date(),
      new Uint8Array(8),
      new ArrayBuffer(8),
      Object.create(null),
      Object.assign(Object.create(null), msg("np1", "byow_info")),
      Promise.resolve(msg("pr1", "byow_info")),
      { jsonrpc: "2.0", id: "d1", method: "test_do", params: { deep: nest(100) } },
      { jsonrpc: "2.0", id: "d2", method: "test_do", params: { wide: Array.from({ length: 30_000 }, () => 1) } },
    ];
    for (const input of inputs) {
      const out = await core.handle(input, ASKER);
      expect(out, String(typeof input)).toHaveProperty("spent");
    }
    expect(calls).toEqual([]);
    // The ones with ids got a bad_request or nothing, never a handler run.
    expect((await core.handle(cyc, ASKER)).code).toBe("bad_request");
    expect((await core.handle(inputs[inputs.length - 2], ASKER)).code).toBe("bad_request");
    expect((await core.handle(inputs[inputs.length - 1], ASKER)).code).toBe("bad_request");
  });

  it("with a message just under the size limit, it is processed; just over, it is bad_request", async () => {
    const { core } = make({}, { test_big: (p) => ({ n: String(p.blob).length }) });
    const wrapperLen = JSON.stringify(msg("big1", "test_big", { blob: "" })).length;
    const under = await core.handle(msg("big1", "test_big", { blob: "x".repeat(256 * 1024 - wrapperLen) }), ASKER);
    expect(under.response).toMatchObject({ result: { n: 256 * 1024 - wrapperLen } });
    const over = await core.handle(msg("big2", "test_big", { blob: "x".repeat(256 * 1024 - wrapperLen + 1) }), ASKER);
    expect(over.code).toBe("bad_request");
  });

  // onPending is the carrier's status callback. If it could throw past the core, the wallet would stay `busy` for good.
  it("an onPending that throws neither makes handle throw nor wedges the wallet", async () => {
    const { core, calls } = make();
    const throwing: Asker = {
      ...ASKER,
      onPending: () => {
        throw new Error("carrier bug");
      },
    };
    await expect(core.handle(msg("op1", "test_do"), throwing)).resolves.toBeDefined();
    const next = await core.handle(msg("op2", "test_do"), ASKER);
    expect(next.code).not.toBe("busy");
    expect(calls.length).toBeGreaterThan(0);
  });

  // On the page carrier a site hands `request(message)` any object it likes, including one whose getters throw.
  it("a message whose properties throw when read is ignored, not thrown", async () => {
    const { core } = make();
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, getOwnPropertyDescriptor: () => { throw new Error("trap"); }, has: () => { throw new Error("trap"); }, ownKeys: () => { throw new Error("trap"); } });
    const throwingGetter = { jsonrpc: "2.0", get id(): string { throw new Error("getter"); }, method: "byow_info" };
    for (const m of [hostile, throwingGetter]) {
      await expect(core.handle(m, ASKER)).resolves.toBeDefined();
    }
  });

  // A wallet announced in the page's own world receives the page's object by reference. The core works on its own
  // copy, so a page cannot show the wallet one transaction and swap in another while the user is deciding.
  it("the sender cannot change a message after it has been judged", async () => {
    const approve = deferred<void>();
    let signed: unknown;
    const { core } = make({}, {
      test_slow: async (params) => {
        await approve.promise; // the user is reading the review screen
        signed = (params.payment as { to: string }).to;
        return {};
      },
    });
    const params = { payment: { to: "the shop" } };
    const pending = core.handle(msg("swap1", "test_slow", params), ASKER);
    params.payment.to = "the attacker";
    approve.resolve();
    await pending;
    expect(signed).toBe("the shop");
  });
});

function nest(depth: number): unknown {
  let v: unknown = "leaf";
  for (let i = 0; i < depth; i++) v = { v };
  return v;
}
