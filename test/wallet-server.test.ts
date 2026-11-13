import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ByowError, WIRE_ERRORS } from "../src/protocol.js";
import { createWalletServer, type Handler } from "../src/wallet/index.js";

// A fake popup window: an EventTarget with an opener that records what is posted to it.
function harness(handlers: Record<string, Handler>, extra: Record<string, unknown> = {}) {
  const sent: { msg: any; target: string }[] = [];
  const opener = { postMessage: (msg: unknown, target: string) => void sent.push({ msg, target }) } as unknown as Window;
  const win = Object.assign(new EventTarget(), { opener, close: vi.fn() });
  const server = createWalletServer({ info: { name: "Test", chains: ["xrpl:1"] }, handlers, win: win as any, ...extra });
  server.start();
  // The core answers asynchronously: let it finish before the test looks at what was sent.
  const post = async (data: unknown, origin = "https://site.example", source: unknown = opener) => {
    win.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
    await vi.advanceTimersByTimeAsync(0);
  };
  const replies = () => sent.filter((s) => s.msg.method === undefined);
  const codes = () => replies().map((r) => r.msg.error?.code ?? "ok");
  return { server, win, opener, sent, post, replies, codes };
}
const req = (id: string, method: string, params?: object) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const E = WIRE_ERRORS;

describe("wallet server", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("announces ready to the opener, and only ready carries '*'", async () => {
    const h = harness({});
    expect(h.sent[0]).toEqual({ target: "*", msg: { jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2"] } } });
    await h.post(req("a", "byow_info"));
    await h.post(req("b", "nope"));
    expect(h.replies().map((r) => r.target)).toEqual(["https://site.example", "https://site.example"]);
    expect(h.sent.filter((s) => s.target === "*")).toHaveLength(1);
  });

  it("answers byow_info with a JSON-RPC result carrying a manifest that lists exactly its handlers", async () => {
    const h = harness({ foo_bar: () => 1 });
    await h.post(req("a", "byow_info"));
    expect(h.replies()[0]?.msg).toMatchObject({ jsonrpc: "2.0", id: "a", result: { name: "Test", chains: ["xrpl:1"], methods: ["byow_info", "foo_bar"], versions: ["0.2"] } });
    expect("error" in h.replies()[0]!.msg).toBe(false);
  });

  it("puts the integer error code on the wire and echoes the id", async () => {
    const h = harness({});
    await h.post(req("req_9-A", "nope"));
    expect(h.replies()[0]?.msg).toMatchObject({ jsonrpc: "2.0", id: "req_9-A", error: { code: E.unsupported_method } });
    expect("result" in h.replies()[0]!.msg).toBe(false);
  });

  it("ignores messages from any window that is not its opener", async () => {
    const h = harness({});
    await h.post(req("a", "byow_info"), "https://site.example", {} /* some other window */);
    expect(h.replies()).toHaveLength(0);
  });

  it("locks to the first origin and ignores a different origin from the same window (opener navigated)", async () => {
    const h = harness({});
    await h.post(req("a", "byow_info"), "https://site.example");
    await h.post(req("evil", "byow_info"), "https://evil.example");
    await h.post(req("evil2", "no_such_method"), "https://evil.example"); // not even a refusal: silence
    await h.post(req("b", "byow_info"), "https://site.example"); // the locked origin is still served
    expect(h.replies().map((r) => r.msg.id)).toEqual(["a", "b"]);
  });

  it("accepts the opener's parent and top: with opener isolation the site's top window sends, the iframe is the opener", async () => {
    const top = {} as Window;
    const iframe = { parent: top, top, postMessage: () => {} } as unknown as Window; // popup.opener
    const sent: any[] = [];
    (iframe as any).postMessage = (m: unknown, target: string) => void sent.push({ m, target });
    const win = Object.assign(new EventTarget(), { opener: iframe, close: vi.fn() });
    createWalletServer({ info: { name: "T", chains: ["xrpl:1"] }, handlers: {}, win: win as any }).start();
    const send = async (source: unknown) => {
      win.dispatchEvent(Object.assign(new Event("message"), { data: req("a", "byow_info"), origin: "https://site.example", source }));
      await vi.advanceTimersByTimeAsync(0);
    };
    const responses = () => sent.filter((s) => s.m.method === undefined);
    await send({}); // unrelated window
    await send(undefined);
    await send(null);
    expect(responses()).toHaveLength(0);
    await send(top); // the real sender in the isolated shape
    expect(responses()).toHaveLength(1);
    expect(responses()[0]!.target).toBe("https://site.example");
  });

  it("ignores opaque-origin senders", async () => {
    const h = harness({});
    await h.post(req("a", "byow_info"), "null");
    expect(h.replies()).toHaveLength(0);
  });

  it("an opaque-origin sender cannot lock the document", async () => {
    const h = harness({});
    await h.post(req("a", "byow_info"), "null");
    await h.post(req("b", "byow_info"), "https://site.example");
    expect(h.replies().map((r) => r.msg.id)).toEqual(["b"]);
  });

  it("refuses unknown methods and unsupported chains BEFORE running any handler", async () => {
    const handler = vi.fn();
    const h = harness({ foo_bar: handler });
    await h.post(req("a", "nope"));
    await h.post(req("b", "foo_bar", { chain: "eip155:1" }));
    expect(h.codes()).toEqual([E.unsupported_method, E.unsupported_chain]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks params.chain against the manifest before any UI, and a refusal does not spend the document", async () => {
    const handler = vi.fn(() => "ok");
    const status: string[] = [];
    const h = harness({ foo_bar: handler }, { onStatus: (s: { phase: string }) => void status.push(s.phase) });
    await h.post(req("a", "foo_bar", { chain: "xrpl:0" })); // well-formed CAIP-2, not in the manifest
    await h.post(req("b", "foo_bar", { chain: "not-a-chain" })); // not CAIP-2 at all
    await h.post(req("c", "foo_bar", { chain: 5 }));
    await h.post(req("d", "foo_bar", { chain: "xrpl:1" }));
    await vi.advanceTimersByTimeAsync(0);
    const codes = h.codes();
    expect(codes[0]).toBe(E.unsupported_chain);
    // SPEC 2: the message is well formed and its params are wrong, so bad_params, not bad_request.
    for (const c of codes.slice(1, 3)) expect(c).toBe(E.bad_params);
    expect(codes[3]).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(1); // only the supported chain reached a handler
    expect(status.filter((p) => p === "pending")).toHaveLength(1); // the user was only ever shown the supported chain's request
  });

  it("an unsupported chain names what is supported, so the site can offer another", async () => {
    const h = harness({ foo_bar: vi.fn() });
    await h.post(req("a", "foo_bar", { chain: "eip155:1" }));
    expect(h.replies()[0]?.msg.error.data).toEqual({ supported: ["xrpl:1"] });
  });

  it("answers a malformed request that has an id with bad_request, and a request with no id with nothing", async () => {
    const h = harness({});
    await h.post(req("a", "has spaces"));
    await h.post({ jsonrpc: "2.0", method: "byow_info" });
    await h.post({ jsonrpc: "2.0", id: 7, method: "byow_info" });
    expect(h.codes()).toEqual([E.bad_request]);
  });

  it("refuses positional-array params with bad_request", async () => {
    const h = harness({ foo_bar: vi.fn() });
    await h.post({ jsonrpc: "2.0", id: "a", method: "foo_bar", params: [{ chain: "xrpl:1" }] });
    expect(h.codes()).toEqual([E.bad_request]);
  });

  it("stays silent on non-JSON-RPC junk, a stray response, and a stray byow_ready", async () => {
    const h = harness({});
    await h.post({ byow: "0.1", type: "request", id: "a", method: "byow_info" }); // the 0.1 envelope
    await h.post({ jsonrpc: "1.0", id: "a", method: "byow_info" });
    await h.post("hello");
    await h.post(null);
    await h.post({ jsonrpc: "2.0", id: "a", result: 1 });
    await h.post({ jsonrpc: "2.0", id: "a", error: { code: 4001, message: "no" } });
    await h.post({ jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2"] } });
    expect(h.replies()).toHaveLength(0);
  });

  it("junk cannot claim the document either: the real site still locks and is answered", async () => {
    const h = harness({});
    await h.post({ byow: "x" }, "https://squatter.example");
    await h.post({ jsonrpc: "2.0", result: 1 }, "https://squatter.example");
    await h.post(req("a", "byow_info"), "https://site.example");
    expect(h.replies().map((r) => r.msg.id)).toEqual(["a"]);
  });

  it("a message with no usable id cannot claim the document: it is ignored and does not lock the origin", async () => {
    const h = harness({});
    await h.post({ jsonrpc: "2.0", method: "byow_info" }, "https://squatter.example");
    await h.post({ jsonrpc: "2.0", id: "has space", method: "byow_info" }, "https://squatter.example");
    await h.post({ jsonrpc: "2.0", id: 5, method: "byow_info" }, "https://squatter.example");
    await h.post(req("a", "byow_info"), "https://site.example");
    expect(h.replies().map((r) => r.msg.id)).toEqual(["a"]); // the real site was still able to lock and be answered
  });

  it("a malformed request WITH an id does lock (it is answered), so the document is the first speaker's", async () => {
    const h = harness({});
    await h.post(req("a", "has spaces"), "https://first.example");
    await h.post(req("b", "byow_info"), "https://second.example");
    expect(h.replies().map((r) => [r.msg.id, r.target])).toEqual([["a", "https://first.example"]]);
  });

  it("answers a request whose params carry chain: undefined (structured clone keeps it)", async () => {
    const h = harness({});
    await h.post({ jsonrpc: "2.0", id: "a", method: "byow_info", params: { chain: undefined } });
    expect(h.replies()[0]?.msg.result).toMatchObject({ name: "Test" });
  });

  it("answers bad_request, not silence, to a request with an id whose params are not JSON", async () => {
    const h = harness({});
    await h.post({ jsonrpc: "2.0", id: "a", method: "byow_info", params: { buf: new ArrayBuffer(8) } });
    expect(h.codes()).toEqual([E.bad_request]);
  });

  it("allows one UI request per document: the second gets busy, then the first still resolves", async () => {
    let finish!: (v: unknown) => void;
    const h = harness({ foo_bar: () => new Promise((r) => (finish = r)) });
    await h.post(req("a", "foo_bar"));
    await h.post(req("b", "foo_bar"));
    expect(h.replies().map((r) => [r.msg.id, r.msg.error?.code])).toEqual([["b", E.busy]]);
    finish({ done: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.replies().find((r) => r.msg.id === "a")?.msg).toEqual({ jsonrpc: "2.0", id: "a", result: { done: true } });
    await h.post(req("c", "foo_bar")); // the document is spent
    expect(h.replies().find((r) => r.msg.id === "c")?.msg.error.code).toBe(E.busy);
  });

  it("byow_info still answers while a UI request is pending and after the document is spent", async () => {
    let finish!: (v: unknown) => void;
    const h = harness({ foo_bar: () => new Promise((r) => (finish = r)) });
    await h.post(req("a", "foo_bar"));
    await h.post(req("i1", "byow_info"));
    expect(h.replies().find((r) => r.msg.id === "i1")?.msg.result).toMatchObject({ name: "Test" });
    finish(1);
    await vi.advanceTimersByTimeAsync(0);
    await h.post(req("b", "foo_bar"));
    await h.post(req("i2", "byow_info"));
    expect(h.replies().find((r) => r.msg.id === "b")?.msg.error.code).toBe(E.busy);
    expect(h.replies().find((r) => r.msg.id === "i2")?.msg.result).toMatchObject({ name: "Test" });
  });

  it("does not use up the document on a refusal, but does on a user rejection and on a crash", async () => {
    let n = 0;
    const h = harness({
      foo_bar: () => {
        if (++n === 1) throw new ByowError("bad_params", "bad params");
        if (n === 2) throw new ByowError("unsupported_tx", "not that");
        if (n === 3) throw new ByowError("user_rejected", "no");
        return "yes";
      },
    });
    for (const id of ["a", "b", "c", "d"]) {
      await h.post(req(id, "foo_bar"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.codes()).toEqual([E.bad_params, E.unsupported_tx, E.user_rejected, E.busy]);

    const crash = harness({ foo_bar: () => { throw new Error("x"); } });
    await crash.post(req("a", "foo_bar"));
    await vi.advanceTimersByTimeAsync(0);
    await crash.post(req("b", "foo_bar"));
    expect(crash.codes()).toEqual([E.internal, E.busy]);
  });

  it("a wallet that throws an SDK-only code puts internal on the wire, never that code", async () => {
    const h = harness({ foo_bar: () => { throw new ByowError("timeout", "sdk only"); } });
    await h.post(req("a", "foo_bar"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.codes()).toEqual([E.internal]);
  });

  it("never leaks a handler's exception message to the site", async () => {
    const h = harness({ foo_bar: () => { throw new Error("seed sEdSECRET in /Users/shane/.wallet"); } });
    await h.post(req("a", "foo_bar"));
    await vi.advanceTimersByTimeAsync(0);
    const r = h.replies()[0]!.msg;
    expect(r.error.code).toBe(E.internal);
    expect(JSON.stringify(r)).not.toMatch(/sEdSECRET|shane/);
  });

  it("passes the browser-stamped origin and the checked chain to handlers", async () => {
    const seen: unknown[] = [];
    const h = harness({ foo_bar: (_p, ctx) => void seen.push({ origin: ctx.origin, chain: ctx.chain, proof: ctx.originProof, carrier: ctx.carrier }) });
    await h.post(req("a", "foo_bar", { chain: "xrpl:1" }), "https://site.example");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ origin: "https://site.example", chain: "xrpl:1", proof: "browser", carrier: "window" }]);
  });

  it("closes itself after a user rejection quickly and after a success only once the linger ends", async () => {
    const a = harness({ foo_bar: () => { throw new ByowError("user_rejected", "no"); } });
    await a.post(req("a", "foo_bar"));
    await vi.advanceTimersByTimeAsync(400);
    expect(a.win.close).toHaveBeenCalled();

    const b = harness({ foo_bar: () => 1 }, { lingerMs: 5000 });
    await b.post(req("a", "foo_bar"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(b.win.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(b.win.close).toHaveBeenCalled();
  });

  it("a refusal that did not spend the document does not close it", async () => {
    const h = harness({ foo_bar: () => { throw new ByowError("bad_params", "no"); } });
    await h.post(req("a", "foo_bar"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.win.close).not.toHaveBeenCalled();
  });

  it("honours a wallet-side site policy with site_not_allowed, not user_rejected (that code means the user said no)", async () => {
    const h = harness({ foo_bar: vi.fn() }, { allowSite: (o: string) => o !== "https://blocked.example" });
    await h.post(req("a", "foo_bar"), "https://blocked.example");
    expect(h.replies()[0]?.msg.error.code).toBe(E.site_not_allowed);
    expect(h.replies()[0]?.msg.error.code).not.toBe(E.user_rejected);
  });

  it("fails fast, in development, if the wallet's own manifest is invalid", async () => {
    expect(() => createWalletServer({ info: { name: "", chains: ["xrpl:1"] }, handlers: {}, win: Object.assign(new EventTarget(), { opener: null, close() {} }) as any })).toThrow(/manifest/);
  });

  it("stays silent when opened directly with no opener", async () => {
    const win = Object.assign(new EventTarget(), { opener: null, close() {} });
    const s = createWalletServer({ info: { name: "T", chains: ["xrpl:1"] }, handlers: {}, win: win as any });
    s.start();
    expect(s.status()).toEqual({ phase: "standalone" });
  });

  it("declares a transactions list in its manifest when given one", async () => {
    const h = harness({ foo_bar: vi.fn() }, { transactions: { xrpl: ["Payment"] } });
    await h.post(req("a", "byow_info"));
    expect(h.replies()[0]?.msg.result.transactions).toEqual({ xrpl: ["Payment"] });
  });
});
