// A complete BYOW wallet in one file: the part a vibe coder actually writes.
// Keys, review screen, done. Origin lock, handshake, validation, refusals and error hygiene all come
// from the kit. Everything shown to the user is set with textContent, never innerHTML.

import { generateSeed } from "ripple-keypairs";
import { answerLinkInPage, createWalletServer } from "../../src/wallet/index.js";
import type { Row } from "../../src/xrpl/profile.js";
import { seedSigner, xrplJsNetwork } from "../../src/xrpl/signer.js";
import { xrplHandlers, type XrplNetwork, type XrplReview } from "../../src/xrpl/wallet.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// TOY key storage. A real wallet picks a real story (passkey-derived, hardware, enclave).
let seed = localStorage.getItem("toy-wallet-seed");
if (!seed) localStorage.setItem("toy-wallet-seed", (seed = generateSeed({ algorithm: "ed25519" })));
const signer = seedSigner(seed, ["xrpl:1"]);

// ?mock=1 swaps the network for a fixed one so tests run offline.
const network: XrplNetwork =
  new URLSearchParams(location.search).get("mock") === "1"
    ? { fill: async () => ({ Fee: "12", Sequence: 1, LastLedgerSequence: 4_000_100, ledgerIndex: 4_000_000 }) }
    : xrplJsNetwork({ "xrpl:1": "wss://s.altnet.rippletest.net:51233" });

function show(section: "idle" | "ask" | "done") {
  for (const s of ["idle", "ask", "done"]) $(s).hidden = s !== section;
}

function ask(who: { origin: string | null; originProof: string }, title: string, rows: Row[]): Promise<boolean> {
  $("origin").textContent = who.origin ?? "Unknown site"; // shown verbatim and large; null means nothing vouches for the asker
  // By link the origin is only where the answer is sent, not a page the browser vouched for. Say so.
  $("asker").textContent = who.originProof === "browser" ? "Request from" : "Your answer will be sent to";
  $("title").textContent = title;
  const table = $("rows");
  table.replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement("tr");
      const k = document.createElement("td");
      const v = document.createElement("td");
      k.textContent = r.label;
      v.textContent = r.value;
      if (r.warn) {
        const w = document.createElement("span");
        w.className = "warn";
        w.textContent = r.warn;
        v.append(w);
      }
      tr.append(k, v);
      return tr;
    }),
  );
  show("ask");
  return new Promise((resolve) => {
    $("approve").onclick = () => resolve(true);
    $("reject").onclick = () => resolve(false);
  });
}

const review: XrplReview = {
  connect: ({ address, challenge, ...who }) =>
    ask(who, "Share your address", [
      { label: "Address", value: address },
      { label: "Sign-in proof", value: challenge ? "Yes, bound to this site" : "No" },
    ]),
  sign: ({ address, askedAccount, rows, fee, submit, ...who }) =>
    ask(who, "Sign a transaction", [
      ...(askedAccount && askedAccount !== address ? [{ label: "Warning", value: "The site wants a different account", warn: `It asked for ${askedAccount}. Approving will fail.` }] : []),
      ...rows,
      { label: "Network fee", value: fee },
      { label: "From", value: address },
      { label: "Then", value: submit ? "This wallet submits it" : "The site submits it" },
    ]),
};

const server = createWalletServer({
  info: { name: "Toy Wallet", chains: ["xrpl:1"] },
  ...xrplHandlers({ signer, network, review }),
  onStatus: (s) => {
    if (s.phase === "done") {
      $("done-text").textContent = s.ok ? "Done. You can close this window." : "Declined or failed. You can close this window.";
      show("done");
    }
  },
});

signer.getAccount().then((a) => ($("addr").textContent = a.address));
server.start(); // a site opened this page in a popup
// Or this page was opened with the request in its own URL (no popup): answer it, and the kit sends the user back.
answerLinkInPage(server.core).catch((e: Error) => (($("done-text").textContent = e.message), show("done")));
