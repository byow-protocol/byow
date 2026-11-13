// The link carrier end to end, with no browser: a site asks through a mailbox or a return URL, a wallet core
// answers the link, and the site's SDK verifies what came back. Everything is in-process.

import { describe, expect, it } from "vitest";
import { ByowError, ByowWallet, completeReturn, mailboxCarrier, parseLink, returnCarrier } from "../src/index.js";
import { createMailbox } from "../src/mailbox.js";
import { answerLink, createWalletCore, type WalletCore } from "../src/wallet/index.js";
import { seedSigner } from "../src/xrpl/signer.js";
import { xrplVerified, verifySignIn } from "../src/xrpl/verify.js";
import { xrplHandlers, type XrplReview } from "../src/xrpl/wallet.js";
import type { ConnectResult, SignResult } from "../src/xrpl/profile.js";

const SEED = "sEdTM1uX8pu2do5XvTnutH6HsouMaM2"; // the ed25519 example seed from the XRPL docs: public, holds nothing
const SITE = "https://site.example";
const CHALLENGE = "nonce_0123456789abcdef";

/** A fetch that reaches an in-process mailbox mounted at https://site.example/byow. */
function mailboxFetch(mailbox = createMailbox()): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const wait = Number(url.searchParams.get("wait"));
    const r = await mailbox.handle({
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/byow/, ""),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(wait > 0 ? { wait } : {}),
    });
    return new Response(r.body ?? null, { status: r.status });
  }) as typeof fetch;
}

function wallet(review: Partial<XrplReview> = {}, seen: { origin?: string | null; proof?: string } = {}): WalletCore {
  return createWalletCore({
    info: { name: "Test Wallet", chains: ["xrpl:1"] },
    ...xrplHandlers({
      signer: seedSigner(SEED, ["xrpl:1"]),
      network: {
        fill: async () => ({ Fee: "12", Sequence: 7, LastLedgerSequence: 4_000_100, ledgerIndex: 4_000_000 }),
        submit: async () => ({ accepted: true, engineResult: "tesSUCCESS" }),
      },
      review: {
        connect: async (v) => ((seen.origin = v.origin), (seen.proof = v.originProof), true),
        sign: async (v) => ((seen.origin = v.origin), (seen.proof = v.originProof), true),
        ...review,
      },
    }),
  });
}

describe("link through a mailbox", () => {
  it("connects with a sign-in proof the site verifies, and the wallet sees where its answer goes", async () => {
    const doFetch = mailboxFetch();
    const seen: { origin?: string | null; proof?: string } = {};
    const core = wallet({}, seen);
    let link = "";
    const site = new ByowWallet(
      mailboxCarrier({
        mailbox: `${SITE}/byow`,
        fetch: doFetch,
        onLink: (l) => {
          link = l;
          void answerLink(core, l, { fetch: doFetch }); // the user scans the QR
        },
      }),
      { profiles: [xrplVerified({ origin: SITE })] },
    );

    const r = await site.request<ConnectResult>("xrpl_connect", { chain: "xrpl:1", challenge: CHALLENGE });
    expect(r.address).toMatch(/^r/);
    expect(seen).toEqual({ origin: SITE, proof: "delivery" });
    expect(site.lastInfo).toEqual({ carrier: "link", origin: null, manifest: null });

    // The link names the mailbox and a key, and holds nothing readable.
    const parsed = parseLink(link);
    expect(parsed.kind === "request" && parsed.mailbox?.startsWith(`${SITE}/byow/`)).toBe(true);
    expect(link).not.toContain(CHALLENGE);

    // What a server would do with the proof.
    const check = verifySignIn(r.proof!, { origin: SITE, chain: "xrpl:1", challenge: CHALLENGE });
    expect(check).toMatchObject({ ok: true, address: r.address, masterKey: true });
    expect(verifySignIn(r.proof!, { origin: "https://evil.example", chain: "xrpl:1", challenge: CHALLENGE })).toEqual({ ok: false, reason: "signed for a different origin" });
  });

  it("signs a transaction the site verifies field by field", async () => {
    const doFetch = mailboxFetch();
    const core = wallet();
    const site = new ByowWallet(mailboxCarrier({ mailbox: `${SITE}/byow`, fetch: doFetch, onLink: (l) => void answerLink(core, l, { fetch: doFetch }) }), { profiles: [xrplVerified({ origin: SITE })] });
    const tx_json = { TransactionType: "Payment", Destination: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", Amount: "1000000", DestinationTag: 42, SourceTag: 7 };
    const r = await site.request<SignResult>("xrpl_signTransaction", { chain: "xrpl:1", tx_json });
    expect(r.submitted).toBe(true);
    expect(r.engine_result).toBe("tesSUCCESS");
    expect(r.hash).toMatch(/^[0-9A-F]{64}$/);
  });

  it("passes a wallet's refusal back as the same error any carrier gives", async () => {
    const doFetch = mailboxFetch();
    const core = wallet({ connect: async () => false });
    const site = new ByowWallet(mailboxCarrier({ mailbox: `${SITE}/byow`, fetch: doFetch, onLink: (l) => void answerLink(core, l, { fetch: doFetch }) }), { profiles: [xrplVerified({ origin: SITE })] });
    await expect(site.request("xrpl_connect", { chain: "xrpl:1" })).rejects.toMatchObject({ code: "user_rejected" });
  });

  it("a mailbox that swaps the answer for the request is caught: boxes are bound to their direction", async () => {
    const mailbox = createMailbox();
    const real = mailboxFetch(mailbox);
    let stolen = "";
    const evil: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") stolen = JSON.parse(String(init.body)).box;
      if (url.includes("/response") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ box: stolen }), { status: 200 });
      return real(input, init);
    }) as typeof fetch;
    const site = new ByowWallet(mailboxCarrier({ mailbox: `${SITE}/byow`, fetch: evil, onLink: () => {} }), { profiles: [xrplVerified({ origin: SITE })] });
    await expect(site.request("xrpl_connect", { chain: "xrpl:1" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses an expired link without asking the user", async () => {
    const doFetch = mailboxFetch();
    let asked = false;
    const core = wallet({ connect: async () => ((asked = true), true) });
    let late: Promise<unknown> = Promise.resolve();
    const site = new ByowWallet(
      mailboxCarrier({ mailbox: `${SITE}/byow`, fetch: doFetch, onLink: (l) => (late = answerLink(core, l, { fetch: doFetch, now: () => Date.now() + 3_600_000 })) }),
      { profiles: [xrplVerified({ origin: SITE })] },
    );
    await expect(site.request("xrpl_connect", { chain: "xrpl:1" })).rejects.toMatchObject({ code: "expired" });
    await late;
    expect(asked).toBe(false);
  });
});

describe("link through a return URL (same device, no server)", () => {
  const RETURN = `${SITE}/return`;

  /** The wallet page: answers the link it was opened with and navigates back, where the return page finishes. */
  const walletTab = (core: WalletCore, referrer = `${SITE}/checkout`) => (url: string) =>
    void answerLink(core, url, { referrer }).then((a) => {
      expect(a.delivered).toBe("return");
      expect(completeReturn({ win: { location: { href: a.returnTo! } } })).toBe(true);
    });

  it("carries the request out in the wallet's URL and the answer back in the return URL", async () => {
    const seen: { origin?: string | null; proof?: string } = {};
    const core = wallet({}, seen);
    let opened = "";
    const site = new ByowWallet(
      returnCarrier({ walletUrl: "https://wallet.example/.well-known/byow", returnUrl: RETURN, openUrl: (u) => ((opened = u), walletTab(core)(u)) }),
      { profiles: [xrplVerified({ origin: SITE })] },
    );
    const r = await site.request<ConnectResult>("xrpl_connect", { chain: "xrpl:1", challenge: CHALLENGE });
    expect(opened.startsWith("https://wallet.example/.well-known/byow#byow:")).toBe(true);
    expect(seen).toEqual({ origin: SITE, proof: "delivery" });
    expect(verifySignIn(r.proof!, { origin: SITE, chain: "xrpl:1", challenge: CHALLENGE }).ok).toBe(true);
  });

  it("a wallet refuses a link one site made to answer to another", async () => {
    const core = wallet();
    const link = await new Promise<string>((resolve) => {
      void new ByowWallet(returnCarrier({ walletUrl: "https://wallet.example/", returnUrl: RETURN, openUrl: resolve, timeoutMs: 50 }), { profiles: [xrplVerified({ origin: SITE })] })
        .request("xrpl_connect", { chain: "xrpl:1" })
        .catch(() => {});
    });
    await expect(answerLink(core, link, { referrer: "https://phish.example/page" })).rejects.toMatchObject({ code: "site_not_allowed" });
  });

  it("an answer for some other request is ignored, and the site times out rather than believing it", async () => {
    const core = wallet();
    const other = new ByowWallet(returnCarrier({ walletUrl: "https://wallet.example/", returnUrl: RETURN, openUrl: walletTab(core) }), { profiles: [xrplVerified({ origin: SITE })] });
    const waiting = new ByowWallet(returnCarrier({ walletUrl: "https://wallet.example/", returnUrl: RETURN, openUrl: () => {}, timeoutMs: 150 }), { profiles: [xrplVerified({ origin: SITE })] });
    const pending = waiting.request("xrpl_connect", { chain: "xrpl:1" });
    await other.request("xrpl_connect", { chain: "xrpl:1" }); // its answer is broadcast to every listening tab
    await expect(pending).rejects.toBeInstanceOf(ByowError);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });
});
