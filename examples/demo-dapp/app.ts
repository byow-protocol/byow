// The site's client code. Note what is NOT here: any mention of a particular wallet.
//
// Two rules the code below follows because browsers force them:
//   1. window.open must run synchronously inside the click. So the nonce and the invoices are fetched
//      BEFORE the click, and the click handler does no awaiting before it calls connect()/request().
//   2. prepareByow() runs at page load. Browsers we measured don't need it (the iframe can be made inside the
//      click), but it is free and covers the ones we did not.

import { ByowError, ByowWallet, prepareByow, rememberedWallets, resolveWallet, returnCarrier, walletFromLocation, type WalletInfo } from "../../src/index.js";
import { xrpl, type ConnectResult, type SignResult } from "../../src/xrpl/profile.js";

const CHAIN = "xrpl:1";
// Test knobs, used only by the e2e suite. A real site would hard-code its options.
const knobs = new URLSearchParams(location.search);
const sdkOptions = {
  profiles: [xrpl],
  ...(knobs.get("isolate") === "0" ? { isolateOpener: false } : {}),
  ...(knobs.get("handshakeMs") ? { handshakeTimeoutMs: Number(knobs.get("handshakeMs")) } : {}),
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const remembered = rememberedWallets();

prepareByow();

let challenge: string | null = null;
let wallet: ByowWallet | null = null;
let me: string | null = null;

const setState = (s: string) => ($("status").dataset.state = s);
const fail = (e: unknown) => {
  const msg = e instanceof ByowError ? `${e.code}: ${e.message}` : String(e);
  $("error").textContent = msg;
  $("error").hidden = false;
  setState("error");
};

async function loadChallenge() {
  challenge = ((await (await fetch("/api/challenge", { method: "POST" })).json()) as { challenge: string }).challenge;
  $<HTMLButtonElement>("connect").disabled = false;
}

function renderRemembered() {
  $("remembered").replaceChildren(
    ...remembered.list().map((w) => {
      const o = document.createElement("option");
      o.value = w.url;
      o.label = `${w.name} (${w.origin})`;
      return o;
    }),
  );
}

$<HTMLButtonElement>("connect").onclick = () => {
  const nonce = challenge;
  if (!nonce) return;
  challenge = null;
  $<HTMLButtonElement>("connect").disabled = true;
  $("error").hidden = true;
  setState("connecting");

  const url = $<HTMLInputElement>("wallet-url").value;
  let walletOrigin = "";
  try {
    const resolved = resolveWallet(url);
    walletOrigin = resolved.origin;
    // Two ways to reach the same wallet. A popup lets the browser stamp both origins. A link has no popup and no
    // opener (it works where popups do not, and a hostile wallet page gets no handle on this tab); the wallet
    // comes back to /return, which hands its answer to this tab.
    wallet = $<HTMLInputElement>("by-link").checked
      ? new ByowWallet(returnCarrier({ walletUrl: resolved.href, returnUrl: `${location.origin}/return` }), sdkOptions)
      : new ByowWallet(url, sdkOptions);
  } catch (e) {
    fail(e);
    void loadChallenge();
    return;
  }
  const w = wallet;
  w.request<ConnectResult>("xrpl_connect", { chain: CHAIN, challenge: nonce })
    .then(async (c) => {
      // The server verifies the proof against its own origin and the nonce it issued; the address is a claim until then.
      const r = await fetch("/api/login", { method: "POST", body: JSON.stringify({ proof: c.proof, challenge: nonce }) });
      if (!r.ok) throw new Error("the site could not verify the wallet's proof");
      me = ((await r.json()) as { address: string }).address;
      const info = w.lastInfo as WalletInfo;
      $("status").dataset.isolation = info.isolation ?? "none";
      $("status").dataset.carrier = info.carrier;
      remembered.remember(url, info.manifest?.name ?? "");
      renderRemembered();
      // The origin is the wallet's identity. The name is only a claim, rendered smaller and labelled so.
      // By link nothing stamped the wallet's origin: all this site knows is the address it opened.
      $("origin-label").textContent = info.origin ? "Connected wallet (browser-verified origin)" : "Wallet opened by link (not verified by the browser)";
      $("origin").textContent = info.origin ?? walletOrigin;
      $("claimed").textContent = info.manifest?.name ?? "nothing: a link has no handshake";
      const icon = $<HTMLImageElement>("icon");
      if (info.manifest?.icon) (icon.src = info.manifest.icon), (icon.hidden = false);
      $("me").textContent = me;
      $("session").hidden = false;
      await renderInvoices();
      setState("connected");
    })
    .catch(fail)
    .finally(() => void loadChallenge());
};

async function renderInvoices() {
  const invoices = (await (await fetch("/api/invoices", { method: "POST" })).json()) as { id: string; label: string; tx: Record<string, unknown> }[];
  $("pay").replaceChildren(
    ...invoices.map((inv) => {
      const b = document.createElement("button");
      b.textContent = `Pay ${inv.label}`;
      b.id = `pay-${inv.label.split(" ")[1]!.toLowerCase()}`;
      b.className = "ghost";
      // Sync in the click: no await before request().
      b.onclick = () => {
        if (!wallet || !me) return;
        $("result").textContent = "";
        wallet
          .request<SignResult>("xrpl_signTransaction", { chain: CHAIN, tx_json: inv.tx, account: me })
          .then(async (signed) => {
            const r = await fetch("/api/pay", { method: "POST", body: JSON.stringify({ invoiceId: inv.id, tx_blob: signed.tx_blob }) });
            $("result").textContent = JSON.stringify(await r.json());
            $("result").dataset.ok = String(r.ok);
          })
          .catch(fail);
      };
      return b;
    }),
  );
}

if (knobs.get("carrier") === "return") $<HTMLInputElement>("by-link").checked = true;
const prefill = walletFromLocation(location.search);
if (prefill) $<HTMLInputElement>("wallet-url").value = prefill; // prefill only, never auto-open
renderRemembered();
void loadChallenge();
