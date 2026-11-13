// End to end, in real browsers, across real origins: a site that has never heard of the wallet, a
// wallet written against the kit, and a server that believes nothing it is told.
import { chromium, firefox, webkit, type BrowserContext, type Browser, type Page, type BrowserType } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExamples, freePort, hijacker, killServers, redirector, root, spawnServer } from "./harness.js";

const all: [string, BrowserType][] = [["chromium", chromium], ["webkit", webkit], ["firefox", firefox]];
const only = process.env.E2E_ENGINES?.split(",");
const engines = only ? all.filter(([n]) => only.includes(n)) : all;
const results = { siteUrl: "", walletUrl: "" };

beforeAll(async () => {
  buildExamples();
  const [sitePort, walletPort] = [await freePort(), await freePort()];
  results.siteUrl = `http://localhost:${sitePort}`;
  results.walletUrl = `http://localhost:${walletPort}`;
  await spawnServer(["examples/demo-dapp/dist/server.mjs", String(sitePort)], results.siteUrl + "/");
  await spawnServer(["examples/static-server.mjs", "examples/toy-wallet", String(walletPort)], results.walletUrl + "/");
});
afterAll(killServers);

describe.each(engines)("%s", (name, type) => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;

  beforeAll(async () => void (browser = await type.launch()));
  afterAll(async () => void (await browser.close()));
  const fresh = async (query = "") => {
    await ctx?.close();
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await page.goto(results.siteUrl + "/" + query);
    await page.waitForSelector("#connect:not([disabled])");
  };
  const state = () => page.locator("#status").getAttribute("data-state");
  const connectTo = async (url: string) => {
    await page.fill("#wallet-url", url);
    const [popup] = await Promise.all([ctx.waitForEvent("page"), page.click("#connect")]);
    return popup;
  };
  const walletUrl = () => `${results.walletUrl}/?mock=1`;

  it("connects an unknown wallet, proves ownership, and pays an XRP invoice and an RLUSD invoice", async () => {
    await fresh();
    const popup = await connectTo(walletUrl());
    await popup.waitForSelector("#ask:not([hidden])");
    // The wallet shows the browser-stamped origin of the site, verbatim.
    expect(await popup.textContent("#origin")).toBe(results.siteUrl);
    expect(await popup.textContent("#rows")).toContain("Sign-in proof");
    await popup.click("#approve");

    await page.waitForSelector('#status[data-state="connected"]', { state: "attached" });
    expect(await page.textContent("#origin")).toBe(results.walletUrl); // identity = origin
    expect(await page.textContent("#claimed")).toBe("Toy Wallet"); // name = claim
    expect(await page.textContent("#me")).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
    expect(await page.locator("#status").getAttribute("data-isolation")).toBe(name === "firefox" ? "top-reachable" : "contained");

    // XRP invoice. The wallet window lingers, so this navigates it rather than opening a new one.
    await page.click("#pay-xrp");
    await popup.waitForSelector("#ask:not([hidden])");
    const xrpRows = await popup.textContent("#rows");
    expect(xrpRows).toContain("1 XRP");
    expect(xrpRows).toContain("Destination tag");
    expect(xrpRows).toContain("Source tag");
    await popup.click("#approve");
    await page.waitForFunction(() => document.getElementById("result")!.textContent!.includes("hash"));
    expect(JSON.parse((await page.textContent("#result"))!)).toMatchObject({ ok: true, submitted: false });

    // RLUSD invoice: hex currency decoded for the human, issuer always shown.
    await page.click("#pay-rlusd");
    await popup.waitForSelector("#ask:not([hidden])");
    const rlusdRows = await popup.textContent("#rows");
    expect(rlusdRows).toContain("5 RLUSD");
    expect(rlusdRows).toContain("Issuer");
    await popup.click("#approve");
    await page.waitForFunction(() => document.getElementById("result")!.textContent!.includes("hash"));
    expect(JSON.parse((await page.textContent("#result"))!).ok).toBe(true);
  });

  it("remembers the wallet for next time, as data the site stores on its own origin", async () => {
    await fresh();
    const popup = await connectTo(walletUrl());
    await popup.click("#approve");
    await page.waitForSelector('#status[data-state="connected"]', { state: "attached" });
    await page.reload();
    await page.waitForSelector("#connect:not([disabled])");
    expect(await page.locator("#remembered option").count()).toBe(1);
  });

  it("treats a rejection as the user's no, and a closed window the same", async () => {
    await fresh();
    let popup = await connectTo(walletUrl());
    await popup.waitForSelector("#ask:not([hidden])");
    await popup.click("#reject");
    await page.waitForSelector('#status[data-state="error"]', { state: "attached" });
    expect(await page.textContent("#error")).toContain("user_rejected");

    await page.waitForSelector("#connect:not([disabled])");
    popup = await connectTo(walletUrl());
    await popup.waitForSelector("#ask:not([hidden])");
    await popup.close();
    await page.waitForSelector('#status[data-state="error"]', { state: "attached" });
    expect(await page.textContent("#error")).toContain("user_rejected");
  });

  it("refuses a hostile wallet URL without ever opening a window", async () => {
    await fresh();
    let opened = false;
    ctx.on("page", () => (opened = true));
    for (const bad of ["javascript:alert(1)", "https://trusted.example@evil.example/", "http://not-local.example/"]) {
      await page.fill("#wallet-url", bad);
      await page.click("#connect");
      await page.waitForSelector('#status[data-state="error"]', { state: "attached" });
      expect(await page.textContent("#error")).toContain("invalid_wallet_url");
      await page.waitForSelector("#connect:not([disabled])");
    }
    expect(opened).toBe(false);
  });

  it("refuses a wallet that redirected to a different origin than the one the user typed", async () => {
    await fresh();
    const r = await redirector(walletUrl());
    const popup = await connectTo(`http://localhost:${r.port}/`);
    await page.waitForSelector('#status[data-state="error"]', { state: "attached" });
    expect(await page.textContent("#error")).toContain("origin_mismatch");
    await popup.waitForEvent("close").catch(() => {}); // the SDK closes a wallet it refused
    r.close();
  });

  it("explains a URL that is not a BYOW wallet, naming the usual cause", async () => {
    await fresh("?handshakeMs=1500");
    await connectTo(results.siteUrl + "/"); // a perfectly good web page that is not a wallet
    await page.waitForSelector('#status[data-state="error"]', { state: "attached", timeout: 10_000 });
    const text = await page.textContent("#error");
    expect(text).toContain("timeout");
    expect(text).toContain("Cross-Origin-Opener-Policy");
  });

  // The headline security property. A wallet URL is arbitrary, so the window it opens in must not be able
  // to steer the site's own tab. Control case first: without isolation the hijack works in every engine.
  const hijackTest = name === "firefox" ? it.skip : it;
  it("control: with isolation OFF, a hostile wallet window takes over the site's tab", async () => {
    await fresh("?isolate=0&handshakeMs=1500");
    const evil = await hijacker();
    await connectTo(`http://localhost:${evil.port}/`);
    await page.waitForFunction(() => document.title === "PHISH", undefined, { timeout: 5000 });
    evil.close();
  });

  hijackTest("with isolation ON (default), the hostile wallet window cannot navigate the site's tab", async () => {
    await fresh("?handshakeMs=1500");
    const evil = await hijacker();
    await connectTo(`http://localhost:${evil.port}/`);
    await page.waitForSelector('#status[data-state="error"]', { state: "attached", timeout: 10_000 }); // it never speaks BYOW
    expect(await page.title()).toBe("BYOW demo site");
    expect(page.url()).toContain(results.siteUrl);
    evil.close();
  });

  // The link carrier through a return URL: no popup, no opener, no server. The wallet opens in a tab with the
  // request in its URL, and navigates back to the site's return page, which hands the answer to the asking tab.
  it("by link: signs in and pays through a return URL, with no popup", async () => {
    await fresh("?carrier=return");
    const tab = await connectTo(walletUrl());
    await tab.waitForSelector("#ask:not([hidden])");
    expect(await tab.textContent("#asker")).toBe("Your answer will be sent to"); // not "Request from": nothing stamped it
    expect(await tab.textContent("#origin")).toBe(results.siteUrl);
    expect(tab.url()).not.toContain("byow:"); // the wallet took the request out of its address bar
    await tab.click("#approve");

    // The server verified a proof whose origin the WALLET wrote: this site's, because that is where its answer went.
    await page.waitForSelector('#status[data-state="connected"]', { state: "attached" });
    expect(await page.locator("#status").getAttribute("data-carrier")).toBe("link");
    expect(await page.textContent("#origin-label")).toContain("not verified by the browser");
    expect(await page.textContent("#me")).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);

    const [tab2] = await Promise.all([ctx.waitForEvent("page"), page.click("#pay-xrp")]);
    await tab2.waitForSelector("#ask:not([hidden])");
    expect(await tab2.textContent("#rows")).toContain("1 XRP");
    await tab2.click("#approve");
    await page.waitForFunction(() => document.getElementById("result")!.textContent!.includes("hash"));
    expect(JSON.parse((await page.textContent("#result"))!)).toMatchObject({ ok: true });
  });

  it("by link: a rejection in the wallet's tab reaches the site as the user's no", async () => {
    await fresh("?carrier=return");
    const tab = await connectTo(walletUrl());
    await tab.waitForSelector("#ask:not([hidden])");
    await tab.click("#reject");
    await page.waitForSelector('#status[data-state="error"]', { state: "attached" });
    expect(await page.textContent("#error")).toContain("user_rejected");
  });

  // The fix for the engine where a popup cannot be contained. Opened by link there is no opener at all, so the
  // same hostile page that hijacks an unisolated popup has nothing to steer. Not skipped anywhere.
  it("by link: a hostile wallet page has no handle on the site's tab, in every engine", async () => {
    await fresh("?carrier=return");
    const evil = await hijacker();
    const tab = await connectTo(`http://localhost:${evil.port}/`);
    await tab.waitForLoadState();
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await page.waitForTimeout(1000); // the hijacker tries at once and again 200 ms later
    expect(await page.title()).toBe("BYOW demo site");
    expect(page.url()).toContain(results.siteUrl);
    evil.close();
  });
});

// `root` is exported for the checker suite that shares this harness.
void root;
