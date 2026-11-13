// The page carrier (SPEC 9), both sides, in-process on a plain EventTarget: announceWallet (wallet kit) and
// discoverWallets (site SDK), then ByowWallet over the announced carrier, including wallets that lie.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ByowError, ByowWallet, discoverWallets, isPlainObject, type AnnouncedWallet, type Profile } from "../src/index.js";
import { announceWallet, createWalletCore, type Announcement, type HandlerContext } from "../src/wallet/index.js";

const ORIGIN = "https://site.example";
const ICON = "data:image/png;base64,iVBORw0KGgo=";

const testProfile: Profile = {
  family: "test",
  methods: ["test_echo"],
  validateParams(_m, p) {
    if (typeof p.text !== "string") throw new ByowError("bad_params", "text must be a string");
  },
  parseResult(_m, result) {
    if (!isPlainObject(result) || typeof result.text !== "string") throw new ByowError("invalid_response", "result.text must be a string");
    return { text: result.text };
  },
};

/** Every announcement that reaches a target, as the page would see it. */
function listen(target: EventTarget) {
  const seen: Announcement[] = [];
  target.addEventListener("byow:announce", (e) => seen.push((e as CustomEvent<Announcement>).detail));
  return seen;
}
/** Finds wallets on a target; resolves the first one that turns up. */
function find(target: EventTarget, o: { requestTimeoutMs?: number } = {}) {
  const wallets: AnnouncedWallet[] = [];
  const stop = discoverWallets((w) => wallets.push(w), { target, ...o });
  return { wallets, stop };
}
const announceRaw = (target: EventTarget, detail: unknown) => target.dispatchEvent(new CustomEvent("byow:announce", { detail }));

/** A hand-written wallet that, like a real one, announces now and again on every discover. */
function announceLive(target: EventTarget, detail: unknown) {
  target.addEventListener("byow:discover", () => announceRaw(target, detail));
  announceRaw(target, detail);
}

function realWallet(target: EventTarget, o: { seen?: HandlerContext[]; allowSite?: (o: string | null) => boolean; origin?: () => string } = {}) {
  const calls: Array<{ params: Record<string, unknown>; ctx: HandlerContext }> = [];
  const core = createWalletCore({
    info: { name: "Page Wallet", icon: ICON, chains: ["test:1"] },
    handlers: {
      test_echo: (params, ctx) => {
        calls.push({ params, ctx });
        return { text: String(params.text) };
      },
    },
    ...(o.allowSite ? { allowSite: o.allowSite } : {}),
  });
  const stop = announceWallet(core, { target, origin: o.origin ?? (() => ORIGIN) });
  return { core, calls, stop };
}

describe("announceWallet", () => {
  it("announces immediately, and again on every byow:discover", () => {
    const target = new EventTarget();
    const seen = listen(target);
    const { core } = realWallet(target);
    expect(seen).toHaveLength(1);
    target.dispatchEvent(new Event("byow:discover"));
    target.dispatchEvent(new Event("byow:discover"));
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]); // the same frozen detail, so the id is stable for this page load
    expect(seen[0]!.info.name).toBe(core.manifest.name);
  });

  it("the detail is frozen and has an id, info.name, versions and a request function", () => {
    const target = new EventTarget();
    const seen = listen(target);
    realWallet(target);
    const d = seen[0]!;
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.info)).toBe(true);
    expect(Object.isFrozen(d.versions)).toBe(true);
    expect(typeof d.id).toBe("string");
    expect(d.id.length).toBeGreaterThanOrEqual(8);
    expect(d.info).toEqual({ name: "Page Wallet", icon: ICON });
    expect(d.versions).toEqual(["0.2"]);
    expect(typeof d.request).toBe("function");
    expect(() => {
      "use strict";
      (d as { id: string }).id = "other";
    }).toThrow();
    expect(() => {
      "use strict";
      d.versions.push("9.9");
    }).toThrow();
    expect(() => {
      "use strict";
      (d.info as { name: string }).name = "Impostor";
    }).toThrow();
  });

  it("claims no global", () => {
    const before = new Set(Object.getOwnPropertyNames(globalThis));
    realWallet(new EventTarget());
    expect(Object.getOwnPropertyNames(globalThis).filter((n) => !before.has(n))).toEqual([]);
  });

  it("each page load gets its own id, and two wallets announce separately", () => {
    const target = new EventTarget();
    const seen = listen(target);
    realWallet(target);
    realWallet(target);
    expect(new Set(seen.map((d) => d.id)).size).toBe(2);
  });

  it("the returned function stops re-announcing", () => {
    const target = new EventTarget();
    const seen = listen(target);
    const { stop } = realWallet(target);
    expect(seen).toHaveLength(1);
    stop();
    target.dispatchEvent(new Event("byow:discover"));
    expect(seen).toHaveLength(1);
  });

  it("uses a relayed request function when given one, and never calls the core itself then", async () => {
    const target = new EventTarget();
    const seen = listen(target);
    const core = createWalletCore({ info: { name: "Relayed", chains: ["test:1"] }, handlers: { test_echo: () => ({ text: "from core" }) } });
    const relayed: unknown[] = [];
    announceWallet(core, { target, request: async (m) => (relayed.push(m), null) });
    expect(await seen[0]!.request({ jsonrpc: "2.0", id: "r1", method: "test_echo", params: {} })).toBeNull();
    expect(relayed).toHaveLength(1);
  });

  it("the default request reads the origin on every call, from the wallet's own side, as a browser-proven asker", async () => {
    const target = new EventTarget();
    const seen = listen(target);
    let origin = "https://one.example";
    const { calls } = realWallet(target, { origin: () => origin });
    await seen[0]!.request({ jsonrpc: "2.0", id: "o1", method: "test_echo", params: { text: "a" } });
    origin = "https://two.example";
    await seen[0]!.request({ jsonrpc: "2.0", id: "o2", method: "test_echo", params: { text: "b" } });
    expect(calls.map((c) => [c.ctx.origin, c.ctx.originProof, c.ctx.carrier])).toEqual([
      ["https://one.example", "browser", "page"],
      ["https://two.example", "browser", "page"],
    ]);
  });

  it("an announcement's request resolves null for a message with nothing to answer, and never rejects", async () => {
    const target = new EventTarget();
    const seen = listen(target);
    realWallet(target);
    for (const m of [null, "junk", 5, { jsonrpc: "2.0", method: "test_echo" }, { not: "jsonrpc" }]) {
      await expect(seen[0]!.request(m)).resolves.toBeNull();
    }
  });
});

describe("discoverWallets", () => {
  afterEach(() => vi.useRealTimers());

  it("finds a wallet announced before it started listening, and one announced after", () => {
    const target = new EventTarget();
    realWallet(target); // before: only the discover event can reach the site
    const { wallets } = find(target);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({ name: "Page Wallet", icon: ICON });
    expect(typeof wallets[0]!.id).toBe("string");
    expect(wallets[0]!.carrier.kind).toBe("page");
    realWallet(target); // after
    expect(wallets).toHaveLength(2);
    expect(wallets[1]!.id).not.toBe(wallets[0]!.id);
  });

  it("dispatches byow:discover itself, so a wallet that is already there answers", () => {
    const target = new EventTarget();
    let discovers = 0;
    target.addEventListener("byow:discover", () => discovers++);
    find(target);
    expect(discovers).toBe(1);
  });

  it("reports each wallet once, however many times it announces", () => {
    const target = new EventTarget();
    const { wallets } = find(target);
    realWallet(target);
    for (let i = 0; i < 20; i++) target.dispatchEvent(new Event("byow:discover"));
    const { wallets: late } = find(target); // a second listener starts late
    expect(wallets).toHaveLength(1);
    expect(late).toHaveLength(1);
  });

  it("ignores announcements with no request function", () => {
    const target = new EventTarget();
    const { wallets } = find(target);
    for (const request of [undefined, null, "not a function", {}, 5]) announceRaw(target, { id: "wallet-id-0001", info: { name: "Nope" }, versions: ["0.2"], request });
    announceRaw(target, { id: "wallet-id-0002", info: { name: "Nope" }, versions: ["0.2"] });
    expect(wallets).toEqual([]);
  });

  it("ignores announcements that are not an object, or have no usable name", () => {
    const target = new EventTarget();
    const { wallets } = find(target);
    const request = async () => null;
    for (const detail of [null, undefined, "string", 5, [], true]) announceRaw(target, detail);
    for (const name of ["", "   ", "ㅤㅤ", "⠀", "​‍⁠", "‮", "️", "  ", undefined, 5, null, {}]) {
      announceRaw(target, { id: "wallet-id-" + wallets.length + String(name).length, info: { name }, versions: ["0.2"], request });
    }
    announceRaw(target, { id: "wallet-id-noinfo", versions: ["0.2"], request });
    announceRaw(target, { id: "wallet-id-infostr", info: "Name", versions: ["0.2"], request });
    expect(wallets).toEqual([]);
  });

  it("ignores a malformed id, and never lets two different wallets share an accepted id", () => {
    const target = new EventTarget();
    const { wallets } = find(target);
    const request = async () => null;
    for (const id of [undefined, null, 5, {}, "", "short", "has space in it", "bad/slash/id", "a".repeat(65), "emoji-\u{1F600}-id!!", "<script>alert(1)</script>"]) {
      announceRaw(target, { id, info: { name: "Bad Id" }, versions: ["0.2"], request });
    }
    expect(wallets).toEqual([]);
    announceRaw(target, { id: "123e4567-e89b-12d3-a456-426614174000", info: { name: "Good" }, versions: ["0.2"], request });
    announceRaw(target, { id: "123e4567-e89b-12d3-a456-426614174000", info: { name: "Same id, other name" }, versions: ["0.2"], request });
    expect(wallets.map((w) => w.name)).toEqual(["Good"]);
  });

  it("sanitises the name and caps it at 64 characters", () => {
    const target = new EventTarget();
    const { wallets } = find(target);
    announceRaw(target, { id: "wallet-id-0001", info: { name: "Nice‮Wallet​" }, versions: ["0.2"], request: async () => null });
    announceRaw(target, { id: "wallet-id-0002", info: { name: "L".repeat(200) }, versions: ["0.2"], request: async () => null });
    expect(wallets[0]!.name).toBe("NiceWallet");
    expect(wallets[1]!.name).toHaveLength(64);
  });

  it("drops an icon that is not a small data-URI image, but still lists the wallet", () => {
    const target = new EventTarget();
    const { wallets } = find(target);
    const bad = [
      "https://evil.example/logo.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/html;base64,PGI+eDwvYj4=",
      "data:image/png,rawbytes",
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "data:image/png;base64," + "A".repeat(48 * 1024), // over the size cap
      "data:image/png;base64,AA\"onerror=\"x",
      5,
      {},
      "",
    ];
    bad.forEach((icon, i) => announceRaw(target, { id: `wallet-id-bad${i}`, info: { name: "W" + i, icon }, versions: ["0.2"], request: async () => null }));
    expect(wallets).toHaveLength(bad.length);
    for (const w of wallets) expect("icon" in w, w.name).toBe(false);
    announceRaw(target, { id: "wallet-id-good1", info: { name: "Good", icon: ICON }, versions: ["0.2"], request: async () => null });
    expect(wallets.at(-1)!.icon).toBe(ICON);
    for (const type of ["png", "jpeg", "webp"]) {
      announceRaw(target, { id: "wallet-id-" + type, info: { name: type, icon: `data:image/${type};base64,AAAA` }, versions: ["0.2"], request: async () => null });
      expect(wallets.at(-1)!.icon).toBe(`data:image/${type};base64,AAAA`);
    }
  });

  it("the returned function stops listening", () => {
    const target = new EventTarget();
    const { wallets, stop } = find(target);
    realWallet(target);
    expect(wallets).toHaveLength(1);
    stop();
    realWallet(target);
    announceRaw(target, { id: "wallet-id-after1", info: { name: "After" }, versions: ["0.2"], request: async () => null });
    expect(wallets).toHaveLength(1);
  });

  it("stops listening for this site only: another listener on the same target still hears", () => {
    const target = new EventTarget();
    const a = find(target);
    const b = find(target);
    a.stop();
    realWallet(target);
    expect(a.wallets).toHaveLength(0);
    expect(b.wallets).toHaveLength(1);
  });

  it("lists at most 16 wallets (a hostile page cannot flood the picker)", () => {
    const target = new EventTarget();
    const { wallets } = find(target);
    for (let i = 0; i < 40; i++) announceRaw(target, { id: `wallet-id-${String(i).padStart(4, "0")}`, info: { name: "W" + i }, versions: ["0.2"], request: async () => null });
    expect(wallets).toHaveLength(16);
  });
});

describe("a site and a wallet, end to end", () => {
  it("a request succeeds, and the wallet sees the origin its own side read, proven by the browser, on the page carrier", async () => {
    const target = new EventTarget();
    const w = realWallet(target, { origin: () => "https://the-real-page.example" });
    const { wallets } = find(target);
    const wallet = new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] });

    expect(wallet.lastInfo).toBeNull();
    const result = await wallet.request("test_echo", { chain: "test:1", text: "hello" });
    expect(result).toEqual({ text: "hello" });

    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.params).toEqual({ chain: "test:1", text: "hello" });
    expect(w.calls[0]!.ctx).toMatchObject({ origin: "https://the-real-page.example", originProof: "browser", carrier: "page", chain: "test:1" });
    expect(wallet.lastInfo).toEqual({ carrier: "page", origin: null, manifest: w.core.manifest });
  });

  it("the site can make several requests in turn on one handle", async () => {
    const target = new EventTarget();
    const w = realWallet(target);
    const { wallets } = find(target);
    const wallet = new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] });
    expect(await wallet.request("test_echo", { text: "1" })).toEqual({ text: "1" });
    expect(await wallet.request("test_echo", { text: "2" })).toEqual({ text: "2" });
    expect(w.calls).toHaveLength(2);
  });

  it("a wallet's refusal reaches the site as the same error as on any carrier", async () => {
    const target = new EventTarget();
    const core = createWalletCore({
      info: { name: "Refuser", chains: ["test:1"] },
      handlers: {
        test_echo: () => {
          throw new ByowError("user_rejected", "The user declined.");
        },
      },
    });
    announceWallet(core, { target, origin: () => ORIGIN });
    const { wallets } = find(target);
    const wallet = new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] });
    await expect(wallet.request("test_echo", { text: "x" })).rejects.toMatchObject({ code: "user_rejected" });
    expect(wallet.lastInfo).toBeNull();
  });

  it("a wallet that refuses the site by policy answers site_not_allowed", async () => {
    const target = new EventTarget();
    realWallet(target, { allowSite: (o) => o === "https://friend.example" });
    const { wallets } = find(target);
    const wallet = new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] });
    await expect(wallet.request("test_echo", { text: "x" })).rejects.toMatchObject({ code: "site_not_allowed" });
  });

  it("stops before the real request when the manifest lacks the chain; the handler never runs", async () => {
    const target = new EventTarget();
    const w = realWallet(target);
    const { wallets } = find(target);
    const wallet = new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] });
    await expect(wallet.request("test_echo", { chain: "test:99", text: "x" })).rejects.toMatchObject({ code: "unsupported_chain" });
    expect(w.calls).toEqual([]);
  });

  it("the site validates params before any wallet hears about them", async () => {
    const target = new EventTarget();
    const requested: unknown[] = [];
    announceLive(target, { id: "wallet-id-spy01", info: { name: "Spy" }, versions: ["0.2"], request: async (m: unknown) => (requested.push(m), null) });
    const { wallets } = find(target);
    const wallet = new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] });
    await expect(wallet.request("test_echo", { text: 5 })).rejects.toMatchObject({ code: "bad_params" });
    await expect(wallet.request("test_unknown", {})).rejects.toMatchObject({ code: "unsupported_method" });
    expect(requested).toEqual([]);
  });
});

describe("hostile wallets", () => {
  const MANIFEST = { name: "Hostile", versions: ["0.2"], chains: ["test:1"], methods: ["byow_info", "test_echo"] };
  type Call = { method: string; id: string };

  /**
   * A hand-written wallet, announced straight onto the target. `on(call)` decides each answer; by default
   * byow_info gets a valid manifest and test_echo gets an echo.
   */
  function hostile(
    on: (req: { id: string; method: string; params: Record<string, unknown> }, calls: Call[]) => unknown,
    o: { versions?: string[]; requestTimeoutMs?: number } = {},
  ) {
    const target = new EventTarget();
    const calls: Call[] = [];
    const request = async (m: unknown) => {
      const req = m as { id: string; method: string; params: Record<string, unknown> };
      calls.push({ method: req.method, id: req.id });
      return on(req, calls);
    };
    announceLive(target, { id: "hostile-wallet-1", info: { name: "Hostile" }, versions: o.versions ?? ["0.2"], request });
    const { wallets } = find(target, o.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: o.requestTimeoutMs });
    const wallet = new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] });
    return { wallet, calls };
  }
  const info = (req: { id: string }, manifest: unknown = MANIFEST) => ({ jsonrpc: "2.0", id: req.id, result: manifest });
  const echo = (req: { id: string; params: Record<string, unknown> }) => ({ jsonrpc: "2.0", id: req.id, result: { text: String(req.params.text) } });
  const normal = (req: { id: string; method: string; params: Record<string, unknown> }) => (req.method === "byow_info" ? info(req) : echo(req));
  const ask = (w: ByowWallet) => w.request("test_echo", { chain: "test:1", text: "hi" });

  it("sanity: a well-behaved hand-written wallet works", async () => {
    const { wallet, calls } = hostile(normal);
    expect(await ask(wallet)).toEqual({ text: "hi" });
    expect(calls.map((c) => c.method)).toEqual(["byow_info", "test_echo"]);
  });

  it("a response with a different id is invalid_response, for the manifest and for the real request", async () => {
    const wrongOnReal = hostile((r) => (r.method === "byow_info" ? info(r) : { ...echo(r), id: "someone_elses_id" }));
    await expect(ask(wrongOnReal.wallet)).rejects.toMatchObject({ code: "invalid_response" });
    expect(wrongOnReal.calls.map((c) => c.method)).toEqual(["byow_info", "test_echo"]);

    const wrongOnInfo = hostile((r) => ({ ...normal(r), id: "someone_elses_id" }));
    await expect(ask(wrongOnInfo.wallet)).rejects.toMatchObject({ code: "invalid_response" });
    expect(wrongOnInfo.calls.map((c) => c.method)).toEqual(["byow_info"]); // the real request was never sent
  });

  it("each request gets a fresh unguessable id (at least 96 bits), never reused", async () => {
    const { wallet, calls } = hostile(normal);
    await ask(wallet);
    await ask(wallet);
    const ids = calls.map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{24,64}$/);
  });

  it("null, undefined, a string, a number and an array are invalid_response", async () => {
    for (const answer of [null, undefined, "ok", 5, [], true]) {
      const onInfo = hostile(() => answer);
      await expect(ask(onInfo.wallet), `info ${String(answer)}`).rejects.toMatchObject({ code: "invalid_response" });
      expect(onInfo.calls).toHaveLength(1);
      const onReal = hostile((r) => (r.method === "byow_info" ? info(r) : answer));
      await expect(ask(onReal.wallet), `real ${String(answer)}`).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("an object that is not a JSON-RPC response is invalid_response", async () => {
    const answers = (r: { id: string }): unknown[] => [
      { foo: "bar" },
      { id: r.id, result: { text: "no jsonrpc member" } },
      { jsonrpc: "1.0", id: r.id, result: { text: "x" } },
      { jsonrpc: "2.0", id: r.id }, // neither result nor error
      { jsonrpc: "2.0", id: r.id, result: { text: "x" }, error: { code: 4001, message: "both" } },
      { jsonrpc: "2.0", id: r.id, method: "test_echo", params: {} }, // a request echoed back
      { jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2"] } },
      { jsonrpc: "2.0", id: r.id, error: "a string, not an object" },
      { jsonrpc: "2.0", result: { text: "no id" } },
      { jsonrpc: "2.0", id: 7, result: { text: "numeric id" } },
      { jsonrpc: "2.0", id: r.id, result: { text: "x", m: new Map() } },
      { jsonrpc: "2.0", id: r.id, result: { n: Number.NaN } },
    ];
    for (let i = 0; i < answers({ id: "x" }).length; i++) {
      const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r) : answers(r)[i]));
      await expect(ask(wallet), `answer ${i}`).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("a result the profile rejects is invalid_response and does not set lastInfo", async () => {
    const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r) : { jsonrpc: "2.0", id: r.id, result: { nope: 1 } }));
    await expect(ask(wallet)).rejects.toMatchObject({ code: "invalid_response" });
    expect(wallet.lastInfo).toBeNull();
  });

  it("a wallet that throws or rejects gets a generic invalid_response, and its message never reaches the site", async () => {
    const LEAK = "seed sEdSECRET at /Users/x";
    const modes: Array<(r: { method: string }) => unknown> = [
      () => {
        throw new Error(LEAK);
      },
      () => Promise.reject(new Error(LEAK)),
      () => Promise.reject(LEAK),
      () => {
        throw LEAK;
      },
      () => Promise.reject(new TypeError(LEAK)),
    ];
    for (const [i, mode] of modes.entries()) {
      for (const phase of ["byow_info", "test_echo"]) {
        const { wallet } = hostile((r) => (r.method === "byow_info" && phase === "test_echo" ? info(r) : mode(r)));
        const err = await ask(wallet).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, `mode ${i} ${phase}`).toBeInstanceOf(ByowError);
        const e = err as ByowError;
        expect(e.code).toBe("invalid_response");
        expect(e.message).not.toContain("SECRET");
        expect(e.message).not.toContain("/Users");
        expect(JSON.stringify(e.data ?? null)).not.toContain("SECRET");
        expect(String(e)).not.toContain("SECRET");
        expect((e as { cause?: unknown }).cause).toBeUndefined();
      }
    }
  });

  it("an error with an unknown integer code is internal; a known one keeps its meaning; its text is sanitised", async () => {
    for (const code of [-32000, 0, 1, 999, 4002, -1, 12345, 4401, 4001.5, Number.MAX_SAFE_INTEGER]) {
      const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r) : { jsonrpc: "2.0", id: r.id, error: { code, message: "custom" } }));
      await expect(ask(wallet), String(code)).rejects.toMatchObject({ code: "internal" });
    }
    for (const code of ["4001", "user_rejected", null, undefined, {}]) {
      const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r) : { jsonrpc: "2.0", id: r.id, error: { code, message: "custom" } }));
      await expect(ask(wallet), String(code)).rejects.toMatchObject({ code: "internal" }); // a name is not a number
    }
    const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r) : { jsonrpc: "2.0", id: r.id, error: { code: 4001, message: "no‮​ thanks" } }));
    const err = await ask(wallet).catch((e: unknown) => e as ByowError);
    expect(err).toMatchObject({ code: "user_rejected", message: "no thanks" });
  });

  it("error data from a wallet is deep-copied without poisoning keys", async () => {
    const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r) : JSON.parse(`{"jsonrpc":"2.0","id":"${r.id}","error":{"code":4300,"message":"x","data":{"__proto__":{"polluted":true},"ok":"fine","constructor":1}}}`)));
    const err = (await ask(wallet).catch((e: unknown) => e)) as ByowError;
    expect(err.code).toBe("unsupported_chain");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(err.data as object)).toEqual(["ok"]);
  });

  it("a manifest that omits the method is unsupported_method, and the real request is never sent", async () => {
    const { wallet, calls } = hostile((r) => (r.method === "byow_info" ? info(r, { ...MANIFEST, methods: ["byow_info"] }) : echo(r)));
    await expect(ask(wallet)).rejects.toMatchObject({ code: "unsupported_method" });
    expect(calls.map((c) => c.method)).toEqual(["byow_info"]);
    expect(wallet.lastInfo).toBeNull();
  });

  it("a manifest that omits the chain is unsupported_chain, and the real request is never sent", async () => {
    const { wallet, calls } = hostile((r) => (r.method === "byow_info" ? info(r, { ...MANIFEST, chains: ["test:2"] }) : echo(r)));
    await expect(ask(wallet)).rejects.toMatchObject({ code: "unsupported_chain" });
    expect(calls.map((c) => c.method)).toEqual(["byow_info"]);
  });

  it("an invalid manifest is invalid_response, and the real request is never sent", async () => {
    const broken: unknown[] = [
      null,
      "manifest",
      {},
      { ...MANIFEST, name: "" },
      { ...MANIFEST, name: "ㅤㅤ" },
      { ...MANIFEST, versions: [] },
      { ...MANIFEST, versions: "0.2" },
      { ...MANIFEST, chains: ["not caip"] },
      { ...MANIFEST, methods: ["bad method!"] },
      { ...MANIFEST, methods: Array.from({ length: 65 }, (_, i) => "m" + i) },
    ];
    for (const [i, m] of broken.entries()) {
      const { wallet, calls } = hostile((r) => (r.method === "byow_info" ? info(r, m) : echo(r)));
      await expect(ask(wallet), `manifest ${i}`).rejects.toMatchObject({ code: "invalid_response" });
      expect(calls.map((c) => c.method)).toEqual(["byow_info"]);
    }
  });

  it("a manifest's out-of-spec icon is dropped rather than failing the wallet", async () => {
    const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r, { ...MANIFEST, icon: "https://evil.example/x.png", transactions: { test: "not valid" } }) : echo(r)));
    expect(await ask(wallet)).toEqual({ text: "hi" });
    expect(wallet.lastInfo!.manifest).toEqual({ ...MANIFEST });
    expect(wallet.lastInfo!.manifest).not.toHaveProperty("icon");
    expect(wallet.lastInfo!.manifest).not.toHaveProperty("transactions");
  });

  it("announcing versions with nothing in common is unsupported_version, and request is never called", async () => {
    for (const versions of [["9.9"], ["0.1", "1.0"], [], ["0.10"], ["junk"]]) {
      const { wallet, calls } = hostile(normal, { versions });
      await expect(ask(wallet), JSON.stringify(versions)).rejects.toMatchObject({ code: "unsupported_version" });
      expect(calls).toEqual([]);
    }
  });

  it("a wallet that speaks several versions is used if one is shared", async () => {
    const { wallet } = hostile(normal, { versions: ["9.9", "0.2", "0.1"] });
    expect(await ask(wallet)).toEqual({ text: "hi" });
  });

  it("a request that never settles times out with timeout (requestTimeoutMs), and is not a user refusal", async () => {
    const { wallet, calls } = hostile((r) => (r.method === "byow_info" ? info(r) : new Promise(() => {})), { requestTimeoutMs: 40 });
    const t0 = performance.now();
    const err = (await ask(wallet).catch((e: unknown) => e)) as ByowError;
    expect(err).toBeInstanceOf(ByowError);
    expect(err.code).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(250);
    expect(calls.map((c) => c.method)).toEqual(["byow_info", "test_echo"]);
  });

  it("the handle is usable again after a timeout", async () => {
    let hang = true;
    const { wallet } = hostile((r) => (r.method === "byow_info" ? info(r) : hang ? new Promise(() => {}) : echo(r)), { requestTimeoutMs: 30 });
    await expect(ask(wallet)).rejects.toMatchObject({ code: "timeout" });
    hang = false;
    expect(await ask(wallet)).toEqual({ text: "hi" });
  });

  it("a wallet that never answers byow_info is given up on too, with timeout", async () => {
    vi.useFakeTimers();
    try {
      const { wallet, calls } = hostile(() => new Promise(() => {}), { requestTimeoutMs: 40 });
      const settled = ask(wallet).then(
        () => null,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await settled).toMatchObject({ code: "timeout" });
      expect(calls.map((c) => c.method)).toEqual(["byow_info"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer that arrives after the timeout is ignored, and does not break the next request", async () => {
    let late: ((v: unknown) => void) | undefined;
    let first = true;
    const { wallet } = hostile(
      (r) => {
        if (r.method === "byow_info") return info(r);
        if (first) {
          first = false;
          return new Promise((res) => (late = (id) => res({ jsonrpc: "2.0", id, result: { text: "late" } })));
        }
        return echo(r);
      },
      { requestTimeoutMs: 30 },
    );
    await expect(ask(wallet)).rejects.toMatchObject({ code: "timeout" });
    late?.("anything");
    expect(await ask(wallet)).toEqual({ text: "hi" });
  });

  it("a wallet's announcement cannot make the site call anything but request: extra detail fields are inert", async () => {
    const target = new EventTarget();
    let hit = false;
    announceLive(target, {
      id: "hostile-wallet-2",
      info: { name: "Sneaky", toString: () => ((hit = true), "x") },
      versions: ["0.2"],
      request: async (r: { id: string; method: string; params: Record<string, unknown> }) => normal(r),
      call: () => ((hit = true), null),
      kind: "window",
    });
    const { wallets } = find(target);
    expect(wallets[0]!.carrier.kind).toBe("page");
    expect(await new ByowWallet(wallets[0]!.carrier, { profiles: [testProfile] }).request("test_echo", { text: "hi" })).toEqual({ text: "hi" });
    expect(hit).toBe(false);
  });
});
