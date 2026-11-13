<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/byow-logo-dark.svg">
  <img alt="BYOW" src="assets/byow-logo.svg" width="240">
</picture>

# BYOW: Bring Your Own Wallet

A protocol that lets any website work with any wallet. The site integrates once, and a wallet nobody has
heard of, written yesterday, works: no registry, no per-wallet code, no API keys, no company in the middle.
The site trusts nothing a wallet says until a signature or the ledger confirms it.

Why: wallets are now cheap to build (an afternoon, or one prompt), and today every site integrates a fixed
list. BYOW makes the wallet a parameter instead of a dependency.

A request is a small JSON-RPC object, and there are three ways to hand it to a wallet:

| Carrier | The wallet is | Status |
|---|---|---|
| **Window** | a website, opened in a popup | Built, and measured in Chromium, WebKit and Firefox |
| **Link** | an app, a script, an agent, or anything on another device (a QR, a deep link) | Built. Same device (a return URL): run in Chromium, WebKit and Firefox. Another device (a mailbox): tested in-process, not yet between two devices |
| **Page** | a browser extension, or an app showing the site in its own browser | Built and tested in-process. Not yet run in a real extension |

**Status: 0.2 draft.** Not on npm yet (`"private": true` keeps it from being published by accident). XRPL
only; the EVM profile is a sketch.
Read **[SPEC.md](SPEC.md)** first. **[docs/ROADMAP.md](docs/ROADMAP.md)** says what is left and what must be
proven before anything freezes.

## What is here

| Path | What |
|---|---|
| `SPEC.md` | The protocol. Marks what is built, measured, or only sketched. |
| `src/protocol.ts`, `src/link.ts` | The wire, shared by both sides: JSON-RPC messages, errors, the manifest; links and sealing. Zero dependencies. |
| `src/site/` | Site SDK: one wallet handle over the three carriers. Zero dependencies. |
| `src/wallet/` | Wallet kit: one core, and a thin wrapper per carrier. Zero dependencies. |
| `src/xrpl/` | The XRPL profile, wallet handlers, a reference signer and network (xrpl.js), the verifier. |
| `src/mailbox.ts` | A reference mailbox for links between two devices: four routes, no dependencies. |
| `check/` | `byow-check`: runs any wallet URL against the spec in a real browser. |
| `examples/toy-wallet` | A complete wallet in one small file. |
| `examples/demo-dapp` | A site that has never heard of any wallet: nonce, proof check, invoice check. |
| `examples/naive-wallet` | A first-draft wallet that `byow-check` correctly fails. Negative example. |
| `experiments/opener` | The browser measurements behind SPEC 7.2 and Appendix A. |
| `docs/BUILD_A_WALLET.md` | What to hand an AI agent to build a wallet safely. |
| `docs/ROADMAP.md` | What changed from 0.1, what is left, and what must be proven first. |
| `assets/` | The logo, and which file to use where. `scripts/build-logo.mjs` draws it. |

## Try it

```bash
npm install
npm test                  # unit and in-process integration tests
npm run e2e               # real Chromium, WebKit and Firefox across real origins (needs: npx playwright install webkit firefox)

node scripts/build-examples.mjs
node examples/static-server.mjs examples/toy-wallet 5174 &
node examples/demo-dapp/dist/server.mjs 5173 &
open http://localhost:5173        # paste  http://localhost:5174/?mock=1  into "Wallet URL"

npm run check -- "http://localhost:5174/?mock=1" --approve '#approve' --reject '#reject'
```

## The three sides

**A site** (never names a wallet):

```ts
import { ByowWallet, prepareByow } from "byow";
import { xrplVerified } from "byow/verify";       // checks every answer in the page; `xrpl` from "byow/xrpl" parses only

prepareByow();                                    // at page load

button.onclick = () => {                          // synchronous: no await before request()
  const wallet = new ByowWallet(input.value, { profiles: [xrplVerified()] });   // a URL, or a bare domain
  wallet.request("xrpl_connect", { chain: "xrpl:1", challenge: nonce })         // nonce fetched BEFORE the click
    .then((account) => login(account.proof, nonce));   // wallet.lastInfo.origin is the identity; its name is only a claim
};

// later, in another click
wallet.request("xrpl_signTransaction", { chain: "xrpl:1", account, tx_json: { TransactionType: "Payment", Destination, Amount } });
```

The same `ByowWallet` works over the other carriers. Give it a carrier instead of a URL:

```ts
import { discoverWallets, mailboxCarrier, returnCarrier } from "byow";

const here = location.origin;
discoverWallets((w) => list.add(w.name, new ByowWallet(w.carrier, { profiles })));               // wallets in this browser
new ByowWallet(mailboxCarrier({ mailbox: `${here}/byow`, onLink: showQr }), { profiles });       // a wallet on another device
new ByowWallet(returnCarrier({ walletUrl, returnUrl: `${here}/return` }), { profiles });         // same device, no popup, no server
```

The site's server mounts the mailbox, and its return page calls `completeReturn()`:

```ts
import { nodeMailbox } from "byow/mailbox";
const mailbox = nodeMailbox();                      // four routes under /byow, holding sealed boxes it cannot read
http.createServer((req, res) => { if (mailbox(req, res)) return; /* ...the rest of the site */ });
```

**A wallet author** (writes the signer and the review screen, nothing else):

```ts
import { createWalletServer, answerLinkInPage } from "byow/wallet";
import { xrplHandlers } from "byow/xrpl/wallet";

const server = createWalletServer({
  info: { name: "My Wallet", chains: ["xrpl:1"] },
  ...xrplHandlers({ signer, network, review }),   // review shows who is asking and the decoded transaction
});
server.start();                                   // a site opened this page in a popup
void answerLinkInPage(server.core);               // or this page was opened with a request in its URL
```

**The site's server** (the whole obligation):

```ts
import { verifySignIn, keyMayActForAccount, checkSignedPayment } from "byow/verify";

verifySignIn(proof, { origin: MY_ORIGINS, chain, challenge });      // login: the origins and the nonce are yours, not the request's
keyMayActForAccount(address, publicKey, accountRoot);               // and, where it matters, one ledger lookup (null = not on the ledger)
checkSignedPayment(txBlob, { account, destination, amount, destinationTag });   // pay: then submit it and watch the ledger
```

## What it does not do

- It does not make an unknown wallet safe to put money in. It makes the wallet unable to lie to the **site**,
  and it makes a wallet **built on the kit** safe by default. Key storage and the honesty of a hand-written
  approval screen stay the wallet author's problem. `byow-check` catches protocol mistakes, not those.
- **Sign-in over a link can be relayed.** A phishing page can show a real site's QR. That is true of every
  cross-device QR login. Sign-in through a popup or an extension resists it. The SDK reports which carrier
  answered.
- Firefox: a hostile wallet URL opened in a popup can still redirect the site's tab (`opener.top`). The SDK
  reports `isolation: "top-reachable"`. The link carrier through a return URL has no opener and avoids it
  (measured in all three engines).
- Not measured: real Safari, mobile browsers, in-app browsers, a real extension, a real hardware wallet.
- EVM is a sketch. Nothing here signs an EVM transaction yet.
