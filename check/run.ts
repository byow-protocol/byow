// byow-check: drives a real browser against a wallet URL and reports conformance with the BYOW spec.
//   L0  handshake and message hygiene: no human needed
//   L1  safety behaviours that must hold before any UI: no human needed
//   L2  interactive: needs --approve / --reject CSS selectors for the wallet's buttons
// Exit code 1 if any L0 or L1 check fails.

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit, type BrowserContext, type Page } from "playwright";
import { WIRE_ERRORS, hasUnsafeText, parseManifest, type Manifest, type WireErrorCode } from "../src/protocol.js";
import { verifySignIn } from "../src/xrpl/verify.js";

// The CLI bundles this file into .build/, so static assets are found via the directory it passes in.
const here = process.env.BYOW_CHECK_DIR ?? path.dirname(fileURLToPath(import.meta.url));
type Status = "pass" | "fail" | "skip";
interface Result { id: string; level: 0 | 1 | 2; title: string; status: Status; detail: string }
interface Options { url: string; browser: "chromium" | "webkit" | "firefox"; approve?: string; reject?: string; json?: string; headed: boolean }

function parseArgs(argv: string[]): Options {
  const o: Options = { url: "", browser: "chromium", headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--approve") o.approve = argv[++i];
    else if (a === "--reject") o.reject = argv[++i];
    else if (a === "--json") o.json = argv[++i];
    else if (a === "--browser") o.browser = argv[++i] as Options["browser"];
    else if (a === "--headed") o.headed = true;
    else if (!a.startsWith("--")) o.url = a;
  }
  if (!o.url) {
    console.error("usage: byow-check <wallet-url> [--approve <css>] [--reject <css>] [--browser chromium|webkit|firefox] [--json file] [--headed]");
    process.exit(2);
  }
  return o;
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const serveFile = (file: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(fs.readFileSync(path.join(here, file)));
};
const listen = (port: number, host: string, h: http.RequestListener) => new Promise<http.Server>((r) => { const s = http.createServer(h); s.listen(port, host, () => r(s)); });

export async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const walletUrl = new URL(o.url);
  const [pa, pb] = [await freePort(), await freePort()];
  // Two different origins on loopback: 127.0.0.1 hosts the harness, localhost hosts the second-origin relay.
  const topOrigin = `http://127.0.0.1:${pa}`;
  const relayBase = `http://localhost:${pb}/`;
  const servers = [await listen(pa, "127.0.0.1", serveFile("harness.html")), await listen(pb, "127.0.0.1", serveFile("relay.html"))];

  const engine = { chromium, webkit, firefox }[o.browser];
  const browser = await engine.launch({ headless: !o.headed });
  const ctx: BrowserContext = await browser.newContext();
  const page = await ctx.newPage();
  const popups: Page[] = [];
  ctx.on("page", (p) => popups.push(p));
  await page.goto(topOrigin + "/");

  // --- primitives -------------------------------------------------------------------------------
  const open = async (): Promise<boolean> => {
    await page.evaluate((u) => void ((window as any).__want = u), walletUrl.href);
    const from = await page.evaluate(() => (window as any).H.mark());
    await page.click("#open");
    const ready = await page.evaluate((f) => (window as any).H.waitFor({ ready: true }, 15000, f), from);
    markFrom = from;
    return !!ready;
  };
  let markFrom = 0;
  const send = (msg: unknown) => page.evaluate((m) => (window as any).H.send(m), msg as object);
  const wait = (spec: object, ms: number): Promise<{ origin: string; data: any } | null> => page.evaluate(([s, t, f]) => (window as any).H.waitFor(s, t, f), [spec, ms, markFrom] as const);
  const req = (id: string, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  /** Fresh wallet document, then one request, then its response (or null). */
  const ask = async (id: string, method: string, params?: unknown, ms = 2500) => {
    if (!(await open())) return { ready: false as const, res: null };
    await send(req(id, method, params));
    return { ready: true as const, res: (await wait({ id }, ms))?.data ?? null };
  };
  const strays = () => page.evaluate((f) => (window as any).H.responses(f) as number, markFrom);
  const clickInWallet = async (selector: string): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      for (const p of popups) {
        try {
          if (new URL(p.url()).origin === new URL(walletUrl.href).origin && (await p.locator(selector).first().isVisible())) {
            await p.locator(selector).first().click();
            return true;
          }
        } catch { /* page navigating */ }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };

  let manifest: Manifest | undefined;
  const results: Result[] = [];
  const check = async (id: string, level: 0 | 1 | 2, title: string, run: () => Promise<[Status, string]>) => {
    let r: [Status, string];
    try { r = await run(); } catch (e) { r = ["fail", `harness error: ${(e as Error).message.split("\n")[0]}`]; }
    results.push({ id, level, title, status: r[0], detail: r[1] });
  };
  // Errors travel as integers; this reads the raw number so a wallet that sends a string or an unknown code is named as such.
  const nameOf = new Map<number, string>(Object.entries(WIRE_ERRORS).map(([n, c]) => [c, n]));
  const errCode = (res: any): string => {
    if (!res) return "(no response)";
    if (res.jsonrpc !== "2.0") return "(not JSON-RPC 2.0)";
    if ("error" in res) return typeof res.error?.code === "number" ? nameOf.get(res.error.code) ?? `unknown code ${res.error.code}` : `non-integer code ${JSON.stringify(res.error?.code)}`;
    return "result" in res ? "(ok)" : "(neither result nor error)";
  };
  const expectError = async (id: string, method: string, params: unknown, code: WireErrorCode): Promise<[Status, string]> => {
    const { ready, res } = await ask(id, method, params);
    if (!ready) return ["fail", "wallet never said ready"];
    return errCode(res) === code ? ["pass", `answered ${code} (${WIRE_ERRORS[code]})`] : ["fail", `expected ${code}, got ${errCode(res)}`];
  };
  const alive = async (): Promise<boolean> => { await send(req("alive", "byow_info")); return !!(await wait({ id: "alive" }, 2500)); };
  const xrplChain = () => manifest?.chains.find((c) => c.startsWith("xrpl:"));
  const offers = (m: string) => !!manifest?.methods.includes(m);
  const PAY = { TransactionType: "Payment", Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", Amount: "1000000" };
  const toHex = (t: string) => Buffer.from(t, "utf8").toString("hex").toUpperCase();

  // --- L0 ---------------------------------------------------------------------------------------
  await check("ready", 0, "announces byow_ready with its versions", async () => {
    if (!(await open())) return ["fail", "no byow_ready within 15s (COOP on the wallet? not a BYOW wallet?)"];
    const m = await wait({ ready: true }, 100);
    const versions = m?.data.params?.versions;
    if (!Array.isArray(versions) || !versions.includes("0.2")) return ["fail", `versions ${JSON.stringify(versions)} lacks 0.2`];
    const redirected = m!.origin !== walletUrl.origin;
    return [redirected ? "fail" : "pass", redirected ? `byow_ready came from ${m!.origin}, not ${walletUrl.origin}: a redirecting wallet is refused by default` : `from ${m!.origin}`];
  });
  await check("info", 0, "byow_info returns a valid manifest", async () => {
    const { ready, res } = await ask("i1", "byow_info");
    if (!ready) return ["fail", "wallet never said ready"];
    if (errCode(res) !== "(ok)") return ["fail", `byow_info -> ${errCode(res)}`];
    try { manifest = parseManifest(res.result); } catch (e) { return ["fail", (e as Error).message]; }
    if (!manifest.versions.includes("0.2")) return ["fail", "manifest.versions lacks 0.2"];
    if (!manifest.methods.includes("byow_info")) return ["fail", "manifest.methods lacks byow_info"];
    return ["pass", `"${manifest.name}", ${manifest.chains.length} chain(s), ${manifest.methods.length} method(s)`];
  });
  await check("connect-offered", 0, "offers xrpl_connect and at least one chain", async () => {
    if (!manifest) return ["fail", "no valid manifest to read"];
    if (!offers("xrpl_connect")) return ["fail", "xrpl_connect is missing from manifest.methods"];
    return manifest.chains.length ? ["pass", `${manifest.chains.join(", ")}`] : ["fail", "manifest.chains is empty"];
  });
  await check("unknown-method", 0, "unknown method -> unsupported_method", () => expectError("u1", "byow_does_not_exist", {}, "unsupported_method"));
  await check("malformed-with-id", 0, "malformed request that has an id -> bad_request", () => expectError("m1", "has spaces!", {}, "bad_request"));
  await check("malformed-no-id", 0, "request without an id is ignored, wallet stays responsive", async () => {
    if (!(await open())) return ["fail", "wallet never said ready"];
    await send({ jsonrpc: "2.0", method: "byow_info" });
    await new Promise((r) => setTimeout(r, 800));
    if (await strays()) return ["fail", "answered a request that had no id"];
    return (await alive()) ? ["pass", "ignored, then answered the next request"] : ["fail", "stopped responding"];
  });
  await check("positional-params", 0, "params as an array -> bad_request, never read as positional", () =>
    expectError("pp1", offers("xrpl_connect") ? "xrpl_connect" : "byow_info", [{ chain: xrplChain() ?? "xrpl:1", challenge: "conformance-check-0" }], "bad_request"));
  await check("oversize", 0, "a 300 KB message is not processed and does not wedge the wallet", async () => {
    if (!(await open())) return ["fail", "wallet never said ready"];
    await send(req("big", "byow_info", { pad: "x".repeat(300_000) }));
    const r = await wait({ id: "big" }, 1500);
    if (errCode(r?.data) === "(ok)") return ["fail", "processed an oversize message"];
    return (await alive()) ? ["pass", r ? "refused it" : "dropped it, still responsive"] : ["fail", "stopped responding"];
  });
  await check("ignores-non-byow", 0, "messages that are not JSON-RPC 2.0 are ignored", async () => {
    if (!(await open())) return ["fail", "wallet never said ready"];
    const junk = [{ hello: "world" }, "text", null, 42, { jsonrpc: 2 }, { jsonrpc: "1.0", id: "j1", method: "byow_info" }, { byow: "0.1", type: "request", id: "j2", method: "byow_info" }];
    for (const j of junk) await send(j);
    await new Promise((r) => setTimeout(r, 600));
    return (await strays()) ? ["fail", "replied to junk"] : (await alive()) ? ["pass", "silent, still responsive"] : ["fail", "stopped responding"];
  });

  // --- L1 ---------------------------------------------------------------------------------------
  await check("manifest-clean", 1, "manifest text has no control or bidi characters", async () => {
    const { res } = await ask("i2", "byow_info");
    const raw = res?.result;
    const bad = [raw?.name, raw?.description].filter((s) => typeof s === "string" && hasUnsafeText(s));
    return bad.length ? ["fail", "name/description contain control or bidi characters"] : ["pass", "clean"];
  });
  await check("origin-lock", 1, "ignores a second origin once it has locked onto the first", async () => {
    if (!(await open())) return ["fail", "wallet never said ready"];
    await send(req("first", "byow_info"));
    if (!(await wait({ id: "first" }, 2500))) return ["fail", "did not answer the first request"];
    const winName = await page.evaluate(() => (window as any).H.winName);
    const walletOrigin = await page.evaluate(() => (window as any).H.walletOrigin);
    await page.evaluate(() => void ((window as any).H.relayResult = null));
    await page.evaluate(([u]) => (window as any).H.navigateOpener(u), [`${relayBase}?name=${winName}&target=${encodeURIComponent(walletOrigin)}&top=${encodeURIComponent(topOrigin)}`]);
    await page.waitForFunction(() => (window as any).H.relayResult, undefined, { timeout: 8000 });
    const got = (await page.evaluate(() => (window as any).H.relayResult)).got as any[];
    await page.evaluate(() => (window as any).H.resetFrame());
    const leaked = got.filter((g) => g.data?.jsonrpc === "2.0" && ("result" in g.data || "error" in g.data));
    return leaked.length ? ["fail", `answered a request from a second origin (${leaked[0].origin})`] : ["pass", "second origin got no response"];
  });
  await check("unsupported-chain-before-ui", 1, "unsupported chain is refused before any UI", async () => {
    if (!offers("xrpl_connect")) return ["skip", "wallet has no xrpl_connect"];
    return expectError("c1", "xrpl_connect", { chain: "bogus:99" }, "unsupported_chain");
  });
  await check("bad-params-before-ui", 1, "bad params are refused before any UI", async () => {
    const chain = xrplChain();
    if (!offers("xrpl_connect") || !chain) return ["skip", "wallet has no xrpl_connect or no XRPL chain"];
    return expectError("c2", "xrpl_connect", { chain, challenge: "not a valid challenge!" }, "bad_params");
  });
  await check("chain-outside-manifest", 1, "a signing request for a chain outside the manifest is refused before any UI", async () => {
    if (!offers("xrpl_signTransaction")) return ["skip", "wallet does not offer xrpl_signTransaction"];
    return expectError("e1", "xrpl_signTransaction", { chain: "bogus:99", tx_json: PAY }, "unsupported_chain");
  });
  await check("no-auto-approve", 1, "a valid xrpl_connect waits for the user", async () => {
    const chain = xrplChain();
    if (!offers("xrpl_connect") || !chain) return ["skip", "wallet has no xrpl_connect or no XRPL chain"];
    const { ready, res } = await ask("a1", "xrpl_connect", { chain, challenge: "conformance-check-1" }, 2500);
    if (!ready) return ["fail", "wallet never said ready"];
    return res ? ["fail", `answered without anyone approving: ${errCode(res)}`] : ["pass", "still waiting after 2.5s"];
  });
  await check("one-ui-request-per-document", 1, "a second UI request while one is pending gets busy", async () => {
    const chain = xrplChain();
    if (!offers("xrpl_connect") || !chain) return ["skip", "wallet has no xrpl_connect or no XRPL chain"];
    if (!(await open())) return ["fail", "wallet never said ready"];
    const params = { chain, challenge: "conformance-check-2" };
    await send(req("b1", "xrpl_connect", params));
    await new Promise((r) => setTimeout(r, 300));
    await send(req("b2", "xrpl_connect", params));
    const r = await wait({ id: "b2" }, 2500);
    return errCode(r?.data) === "busy" ? ["pass", "second request got busy"] : ["fail", `second request got ${errCode(r?.data)}`];
  });
  await check("no-auto-sign", 1, "XRPL: a valid xrpl_signTransaction is not signed without the user", async () => {
    const chain = xrplChain();
    if (!offers("xrpl_signTransaction") || !chain) return ["skip", "wallet does not offer xrpl_signTransaction"];
    const { ready, res } = await ask("s1", "xrpl_signTransaction", { chain, tx_json: PAY }, 3000);
    if (!ready) return ["fail", "wallet never said ready"];
    // An error (say, an unfunded account) is fine; a signature nobody approved is not.
    return errCode(res) === "(ok)" ? ["fail", "returned a signed transaction without anyone approving"] : ["pass", res ? `answered ${errCode(res)}` : "still waiting after 3s"];
  });
  await check("signature-field-refused", 1, "XRPL: a tx that sets TxnSignature is refused before any UI", async () => {
    const chain = xrplChain();
    if (!offers("xrpl_signTransaction") || !chain) return ["skip", "wallet does not offer xrpl_signTransaction"];
    return expectError("x1", "xrpl_signTransaction", { chain, tx_json: { ...PAY, TxnSignature: "AB".repeat(64) } }, "bad_params");
  });
  await check("sign-in-memo-refused", 1, "XRPL: a tx carrying a byow/sign-in memo is refused before any UI", async () => {
    const chain = xrplChain();
    if (!offers("xrpl_signTransaction") || !chain) return ["skip", "wallet does not offer xrpl_signTransaction"];
    const statement = JSON.stringify({ origin: "https://other-site.example", chain, challenge: "conformance-check-3", iat: Math.floor(Date.now() / 1000) });
    const memo = { Memo: { MemoType: toHex("byow/sign-in"), MemoData: toHex(statement) } };
    return expectError("x2", "xrpl_signTransaction", { chain, tx_json: { ...PAY, Memos: [memo] } }, "bad_params");
  });

  // --- L2 ---------------------------------------------------------------------------------------
  const l2 = !!(o.approve && o.reject);
  const skipL2 = (): [Status, string] => ["skip", "pass --approve and --reject selectors to run interactive checks"];
  await check("reject", 2, "rejecting yields user_rejected", async () => {
    const chain = xrplChain();
    if (!l2) return skipL2();
    if (!offers("xrpl_connect") || !chain) return ["skip", "wallet has no xrpl_connect or no XRPL chain"];
    if (!(await open())) return ["fail", "wallet never said ready"];
    await send(req("r1", "xrpl_connect", { chain }));
    if (!(await clickInWallet(o.reject!))) return ["fail", `could not find ${o.reject} in the wallet window`];
    const r = await wait({ id: "r1" }, 4000);
    return errCode(r?.data) === "user_rejected" ? ["pass", "answered user_rejected"] : ["fail", `got ${errCode(r?.data)}`];
  });
  await check("approve-connect", 2, "approving returns an address and a sign-in proof that verifies for this origin", async () => {
    const chain = xrplChain();
    if (!l2) return skipL2();
    if (!offers("xrpl_connect") || !chain) return ["skip", "wallet has no xrpl_connect or no XRPL chain"];
    if (!(await open())) return ["fail", "wallet never said ready"];
    const challenge = "conformance-" + Math.random().toString(36).slice(2, 12);
    await send(req("p1", "xrpl_connect", { chain, challenge }));
    if (!(await clickInWallet(o.approve!))) return ["fail", `could not find ${o.approve} in the wallet window`];
    const r = (await wait({ id: "p1" }, 6000))?.data;
    if (errCode(r) !== "(ok)") return ["fail", `got ${errCode(r)}`];
    const { address, publicKey, proof } = r.result ?? {};
    if (typeof address !== "string" || typeof publicKey !== "string") return ["fail", "result has no address and publicKey"];
    if (typeof proof !== "string") return ["fail", "a challenge was sent but no proof came back"];
    const v = verifySignIn(proof, { origin: topOrigin, chain, challenge });
    if (!v.ok) return ["fail", `proof does not verify for ${topOrigin}, this chain and challenge: ${v.reason}`];
    if (v.address !== address || v.publicKey !== publicKey.toUpperCase()) return ["fail", "the proof is for a different account or key than the result names"];
    return ["pass", `proof verifies for ${topOrigin}`];
  });

  await browser.close();
  servers.forEach((s) => s.close());

  // --- report -----------------------------------------------------------------------------------
  const tag = { pass: "PASS", fail: "FAIL", skip: "skip" };
  console.log(`\nbyow-check 0.2   ${walletUrl.href}   (${o.browser})\n`);
  for (const level of [0, 1, 2] as const) {
    console.log({ 0: "L0  handshake and messages", 1: "L1  safety before any UI", 2: "L2  interactive" }[level]);
    for (const r of results.filter((x) => x.level === level)) console.log(`  ${tag[r.status]}  ${r.id.padEnd(30)} ${r.detail}`);
    console.log();
  }
  const n = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(`${n("pass")} passed, ${n("fail")} failed, ${n("skip")} skipped`);
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ tool: "byow-check", spec: "0.2", url: walletUrl.href, browser: o.browser, date: new Date().toISOString(), results }, null, 2));
  return results.some((r) => r.level < 2 && r.status === "fail") ? 1 : 0;
}
