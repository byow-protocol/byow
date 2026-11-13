import { describe, expect, it, vi } from "vitest";
import { ByowWallet, type Carrier } from "../src/site/wallet.js";
import { FRONT_DOOR_PATH, parseWalletUrl, rememberedWallets, resolveWallet, walletFromLocation } from "../src/site/discovery.js";
import { xrpl } from "../src/xrpl/profile.js";

describe("parseWalletUrl", () => {
  it("accepts https and http://localhost", () => {
    expect(parseWalletUrl("https://wallet.example/app?x=1").origin).toBe("https://wallet.example");
    expect(parseWalletUrl("http://localhost:5174/").origin).toBe("http://localhost:5174");
    expect(parseWalletUrl("http://127.0.0.1:9").origin).toBe("http://127.0.0.1:9");
    expect(parseWalletUrl("http://[::1]:9/").origin).toBe("http://[::1]:9");
  });
  it("refuses everything else", () => {
    for (const bad of ["http://wallet.example", "javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "https://trusted.example@evil.example/", "https://u:p@wallet.example", "not a url", ""]) {
      expect(() => parseWalletUrl(bad), bad).toThrow();
    }
  });
  it("allows exactly three loopback hosts, not every *.localhost name", () => {
    expect(() => parseWalletUrl("http://evil.localhost:3000/")).toThrow();
  });
  it("refuses http localhost when the integrator turns dev mode off", () => {
    expect(() => parseWalletUrl("http://localhost:1", { allowInsecureLocalhost: false })).toThrow();
  });
  it("shows an IDN lookalike as punycode, so the origin string is honest", () => {
    expect(parseWalletUrl("https://аpple.example/").origin).toBe("https://xn--pple-43d.example");
  });
});

describe("resolveWallet", () => {
  it("uses a full URL exactly as given, query string and all", () => {
    expect(resolveWallet("https://wallet.example/app?x=1&y=two").href).toBe("https://wallet.example/app?x=1&y=two");
    expect(resolveWallet("https://wallet.example/some/deep/path/").href).toBe("https://wallet.example/some/deep/path/");
    expect(resolveWallet("https://shared.example/~alice/wallet?user=alice#start").href).toBe("https://shared.example/~alice/wallet?user=alice#start");
    expect(resolveWallet("  https://wallet.example/app?x=1  ").href).toBe("https://wallet.example/app?x=1"); // what a person pastes
    expect(resolveWallet("https://wallet.example").pathname).toBe("/"); // a full URL is never rewritten to the front door
  });

  it("sends a bare domain to its front door", () => {
    expect(FRONT_DOOR_PATH).toBe("/.well-known/byow");
    expect(resolveWallet("wallet.example").href).toBe("https://wallet.example/.well-known/byow");
    expect(resolveWallet("  wallet.example  ").href).toBe("https://wallet.example/.well-known/byow");
    expect(resolveWallet("my.wallet.example").href).toBe("https://my.wallet.example/.well-known/byow");
    expect(resolveWallet("wallet.example:8443").href).toBe("https://wallet.example:8443/.well-known/byow");
  });

  it("treats a bare localhost, 127.0.0.1 or [::1] (with a port) as http: that is what development wallets are", () => {
    expect(resolveWallet("localhost:5174").href).toBe("http://localhost:5174/.well-known/byow");
    expect(resolveWallet("localhost").href).toBe("http://localhost/.well-known/byow");
    expect(resolveWallet("127.0.0.1:5174").href).toBe("http://127.0.0.1:5174/.well-known/byow");
    expect(resolveWallet("[::1]:5174").href).toBe("http://[::1]:5174/.well-known/byow");
    expect(() => resolveWallet("localhost:5174", { allowInsecureLocalhost: false })).toThrow(); // dev mode off
  });

  it("refuses javascript:, data:, file: and credentials, whether or not they look like a domain", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "https://trusted.example@evil.example/",
      "https://u:p@wallet.example/",
      "user:pass@wallet.example",
      "trusted.example@evil.example",
      "http://wallet.example", // not https, not loopback
      "ftp://wallet.example/",
      "not a url",
      "wallet example",
      "",
      "   ",
    ]) {
      expect(() => resolveWallet(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "invalid_wallet_url" }));
    }
  });

  it("refuses a bare http domain that is not loopback", () => {
    expect(() => resolveWallet("http://wallet.example")).toThrow();
    expect(() => resolveWallet("http://evil.localhost:3000/")).toThrow();
  });

  // SPEC 10 and 13: a bare domain means its front door, and an IDN host is shown as punycode, so a look-alike looks different.
  it("an IDN lookalike domain resolves to its punycode origin", () => {
    expect(resolveWallet("аpple.example").origin).toBe("https://xn--pple-43d.example");
  });
});

describe("walletFromLocation", () => {
  it("prefills only from a valid url or domain", () => {
    expect(walletFromLocation("?byow_wallet=https%3A%2F%2Fw.example%2F")).toBe("https://w.example/");
    expect(walletFromLocation("?byow_wallet=javascript%3Aalert(1)")).toBeNull();
    expect(walletFromLocation("?byow_wallet=data%3Atext%2Fhtml%2C%3Cscript%3E")).toBeNull();
    expect(walletFromLocation("?byow_wallet=https%3A%2F%2Fu%3Ap%40w.example%2F")).toBeNull();
    expect(walletFromLocation("?other=1")).toBeNull();
    expect(walletFromLocation("")).toBeNull();
    expect(walletFromLocation("?byow_wallet=")).toBeNull();
  });

  it("accepts a bare domain, as its front door", () => {
    expect(walletFromLocation("?byow_wallet=wallet.example")).toBe("https://wallet.example/.well-known/byow");
    expect(walletFromLocation("?byow_wallet=localhost%3A5174")).toBe("http://localhost:5174/.well-known/byow");
  });

  it("keeps a full URL's query string intact", () => {
    expect(walletFromLocation("?byow_wallet=https%3A%2F%2Fw.example%2Fapp%3Fx%3D1%26y%3D2")).toBe("https://w.example/app?x=1&y=2");
  });
});

describe("rememberedWallets", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
  };
  it("remembers, sorts by recency and forgets", () => {
    const s = mem();
    const r = rememberedWallets(s);
    r.remember("https://a.example/", "A");
    r.remember("https://b.example/", "B");
    expect(r.list().map((w) => w.name)).toEqual(["B", "A"]);
    r.forget("https://b.example/");
    expect(r.list().map((w) => w.name)).toEqual(["A"]);
  });
  it("forgets a wallet however its URL is spelled", () => {
    const s = mem();
    const r = rememberedWallets(s);
    r.remember("https://a.example", "A");
    r.forget("https://a.example"); // remembered as ".../", forgotten without the slash
    expect(r.list()).toEqual([]);
  });
  it("stores only a URL and a claimed name, on the site's own storage", () => {
    const s = mem();
    rememberedWallets(s).remember("https://a.example/app?x=1", "A");
    expect(Object.keys(JSON.parse(s.raw.get("byow:wallets")!)[0]).sort()).toEqual(["lastUsed", "name", "origin", "url"]);
  });
  it("drops tampered entries instead of trusting them", () => {
    const s = mem();
    s.setItem("byow:wallets", JSON.stringify([{ url: "javascript:alert(1)", name: "x" }, { url: "https://ok.example/", name: "Ok‮" }, 5, null]));
    expect(rememberedWallets(s).list()).toEqual([expect.objectContaining({ url: "https://ok.example/", name: "Ok" })]);
  });
  it("survives broken storage", () => {
    const s = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const r = rememberedWallets(s);
    expect(r.list()).toEqual([]);
    expect(() => r.remember("https://a.example/", "A")).not.toThrow();
  });
});

describe("ByowWallet.request preflight", () => {
  const carrier = () => ({ kind: "window", call: vi.fn(async () => ({ result: {}, info: { carrier: "window", origin: null, manifest: null } })) }) as unknown as Carrier & { call: ReturnType<typeof vi.fn> };

  it("refuses a method with no registered profile, without opening anything", async () => {
    const c = carrier();
    const none = new ByowWallet(c, { profiles: [] });
    await expect(none.request("xrpl_connect", { chain: "xrpl:1" })).rejects.toMatchObject({ code: "unsupported_method" });
    const some = new ByowWallet(c, { profiles: [xrpl] });
    await expect(some.request("eth_requestAccounts", { chain: "eip155:1" })).rejects.toMatchObject({ code: "unsupported_method" });
    expect(c.call).not.toHaveBeenCalled();
  });

  it("refuses to ask for a chain whose family the method's profile does not own, without opening anything", async () => {
    const c = carrier();
    const w = new ByowWallet(c, { profiles: [xrpl] });
    await expect(w.request("xrpl_connect", { chain: "eip155:1" })).rejects.toMatchObject({ code: "bad_params" });
    await expect(w.request("xrpl_connect", { chain: "not-a-chain" })).rejects.toMatchObject({ code: "bad_params" });
    expect(c.call).not.toHaveBeenCalled();
  });

  it("refuses params its profile rejects, before a wallet hears about them", async () => {
    const c = carrier();
    const w = new ByowWallet(c, { profiles: [xrpl] });
    await expect(w.request("xrpl_connect", { chain: "xrpl:1", challenge: "short" })).rejects.toMatchObject({ code: "bad_params" });
    await expect(w.request("xrpl_signTransaction", { chain: "xrpl:1", tx_json: { TransactionType: "Payment", TxnSignature: "AB" } })).rejects.toMatchObject({ code: "bad_params" });
    await expect(w.request("xrpl_connect", [{ chain: "xrpl:1" }] as never)).rejects.toMatchObject({ code: "bad_params" });
    expect(c.call).not.toHaveBeenCalled();
  });

  it("hands a valid request to its carrier, and the carrier's check refuses what the manifest rules out", async () => {
    const c = carrier();
    const w = new ByowWallet(c, { profiles: [xrpl] });
    await w.request("xrpl_connect", { chain: "xrpl:1" }).catch(() => {});
    expect(c.call).toHaveBeenCalledTimes(1);
    const spec = c.call.mock.calls[0]![0] as { method: string; params: unknown; check(m: unknown): void };
    expect(spec).toMatchObject({ method: "xrpl_connect", params: { chain: "xrpl:1" } });
    const m = (over: object) => ({ name: "W", versions: ["0.2"], chains: ["xrpl:1"], methods: ["byow_info", "xrpl_connect"], ...over });
    expect(() => spec.check(m({}))).not.toThrow();
    expect(() => spec.check(m({ methods: ["byow_info"] }))).toThrow(expect.objectContaining({ code: "unsupported_method" }));
    expect(() => spec.check(m({ chains: ["xrpl:0"] }))).toThrow(expect.objectContaining({ code: "unsupported_chain" }));
  });

  it("the carrier's check applies the profile's preflight: a manifest that does not list the transaction type refuses it", async () => {
    const c = carrier();
    const w = new ByowWallet(c, { profiles: [xrpl] });
    await w.request("xrpl_signTransaction", { chain: "xrpl:1", tx_json: { TransactionType: "OfferCreate" } }).catch(() => {});
    const spec = c.call.mock.calls[0]![0] as { check(m: unknown): void };
    const m = (transactions?: object) => ({ name: "W", versions: ["0.2"], chains: ["xrpl:1"], methods: ["byow_info", "xrpl_signTransaction"], ...(transactions ? { transactions } : {}) });
    expect(() => spec.check(m({ xrpl: ["Payment"] }))).toThrow(expect.objectContaining({ code: "unsupported_tx" }));
    expect(() => spec.check(m({ xrpl: "*" }))).not.toThrow();
    expect(() => spec.check(m())).not.toThrow();
  });
});
