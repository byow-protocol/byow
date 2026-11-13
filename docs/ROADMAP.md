# BYOW: what changed in 0.2, and what is left

`SPEC.md` is the protocol. This file is the reasoning around it: why 0.2 replaced 0.1, what is still to
build, what has to be proven before anything freezes, and the decisions that are Shane's.

The design of record is the conversation of 2026-11-11, which started from the problem (any site, any
wallet) and not from the 0.1 prototype. Where the two disagreed, 0.2 follows the conversation.

## 1. Why 0.2 replaced 0.1

0.1 was spun out of one wallet's popup connect layer. It did the popup case carefully and measured an
attack nobody else had written down (a popup opened to an arbitrary URL can replace the site's tab). It also
had two limits a protocol cannot have.

**It reached only wallets that are websites.**

| Out of 0.1's reach | Why |
|---|---|
| A browser extension wallet | It has no https URL to open |
| A phone or desktop app, a script, an agent | There is no window to open |
| A phone wallet used from a desktop site | Two devices, no popup between them |
| Browsers with no popups (many in-app browsers) | `window.open` is missing or blocked |
| Firefox, safely | A popup can still steer the site's tab |

**Its XRPL profile carried one wallet's signing rules as protocol.** A request that set `Flags`,
`TicketSequence` or `Signers` was refused by the profile itself, on both sides. So a site could not ask for an
NFT sell offer (it needs `Flags: 1`), an `OfferCreate` with `tfSell`, a partial payment or a ticketed
transaction. Those rules are a sound policy for one wallet and the wrong law for everyone.

## 2. What 0.2 changed

| | 0.1 | 0.2 |
|---|---|---|
| Carriers | Popup only | Window, link and page: one wallet core and one site core, a thin wrapper each |
| Messages | Its own envelope, string error codes | JSON-RPC 2.0, which every developer and every coding agent already knows |
| Methods | `byow_connect`, `xrpl_signTransaction`, `xrpl_signAndSubmit` | `xrpl_connect`, `xrpl_signTransaction` with a `submit` flag |
| Transaction fields | The wallet owns `Fee`, `Flags`, `Sequence`...; a site that sets one is refused | The wallet fills only what is absent, never alters what was sent, and may refuse by its own policy |
| Sign-in proof | A signature over text | A signed transaction that can never apply, which every wallet can produce |
| Capabilities | Chains and methods | Also the transaction types the wallet signs |
| Finding a wallet | The exact URL | The exact URL, or a bare domain's front door (`/.well-known/byow`), or announced, or scanned |
| A wallet's answer | Believed for its hash and address | Checked field by field against what was asked |

Kept from 0.1 unchanged: opener isolation and its measurements, origin pinning, one UI request per popup
document, text hygiene, refuse-before-UI, error hygiene, the conformance checker's design, and the twelve
review findings with their regression tests.

## 3. Why these rules

Where connect standards get captured, and what closes each point here:

| Capture point | Elsewhere | Here |
|---|---|---|
| The relay | WalletConnect's relay requires a project ID | A link names its own mailbox; the site hosts it or picks one, and pays for its own traffic |
| The wallet list | xrpl-connect ships a fixed list of nine | The SDK ships none. A list is a file of URLs a site chooses |
| API keys | Xaman's per-app key | None exist |
| The spec | Vendor extensions that sites come to depend on | A small core that freezes; new behaviour is a new method name |
| Attribution | Wallets and sites both want the `SourceTag` | The wallet adds only what the ledger needs; everything else is the site's |

Who has to move first: nobody. A standard dies when wallets and sites must adopt together (XLS-72d closed
with three comments). So a site has to gain on day one with no wallet having changed, which is what the
bridge in section 4 is for.

Left out on purpose: sessions, key exchange, a registry, a message-signing scheme, events outside the page
carrier, iframes, permission scopes, a built-in wallet list.

## 4. What is left to build

In order. Each lands as a spec section, SDK and kit code, tests, and a checker level where one applies.

1. **Run the link carrier between two real devices.** The return-URL shape runs in three engines, and is the
   measured fix for Firefox. The mailbox and the QR have only run in-process.
2. **Checker levels for the link and page carriers.** Today `byow-check` covers a wallet that is a website.
3. **A real extension** using the page carrier, to prove the relay shape in SPEC 9.
4. **The bridge to wallets that will not adopt BYOW.** The SDK accepts xrpl-connect's `WalletAdapter`
   objects as wallets, so a site that switches keeps Xaman, Crossmark, GemWallet and Ledger and gains every
   BYOW wallet. xrpl-connect as read on 2026-11-11 (v1.0, MIT): adapters are registered only when its manager
   is constructed, and adding one is a nine-step fork-and-PR.
5. **`inbox`** (SPEC 18): what lets a phone wallet keep push notifications on its own service.
6. **A site endpoint for programs** (SPEC 18): sign-in for agents with no page and no QR.
7. **Multi-signing and Batch co-signing** as new methods.
8. **Same-tab return** on phones (SPEC 19.4).
9. **The EVM profile** (SPEC 5.5).
10. ~~**Clasp conforms**~~ **Built 2026-11-11** on Clasp's `byow` branch, live on claspwallet.com since
    2026-11-12: see section 4a.

## 4a. The first real wallet: what Clasp's conformance showed

Clasp is a passkey wallet, live on mainnet, with its own connect wire and integrators that depend on it.
It was made to speak BYOW in an afternoon, without this repo's wallet kit, and it passes `byow-check`'s
19 no-human checks on Chromium, WebKit and Firefox. What that taught:

- **A real wallet adds BYOW beside what it has.** Clasp kept its own wire for its existing integrators and
  for its EVM side, which BYOW cannot carry yet. One file translates a BYOW request into the wallet's own
  and back. That is the realistic adoption path for any wallet with users, and it cost about 250 lines.
- **The kit is optional, the parsers are not.** Clasp has its own popup and review screens, so it did not
  use `createWalletServer`. It did reuse `src/protocol.ts` and `src/xrpl/profile.ts` as they are. Those two
  files are what a wallet with its own UI needs from this repo, and they are worth publishing on their own.
- **"Never alters" bit immediately, as it should.** Clasp used to add `tfSetNoRipple` to every trust line a
  site asked for. Over BYOW it refuses a trust line that does not carry the flag and says how to ask.
- **A wallet that waits for validation fits.** Clasp submits and waits for the ledger before it answers. It
  returns the signed transaction with `submitted: true` and the validated result as `engine_result`, also
  when that result is a `tec`.
- **`byow-check` cannot drive a passkey.** Its interactive level clicks one selector, once. Clasp's approval
  is a touch and then a button, behind a credential the checker's browser does not hold. The checker needs
  a way to run against a wallet a person is operating, and to click through more than one step.
- **Unpublished means vendored.** Clasp carries copies of three files from this repo. Every wallet and site
  that adopts before this is on npm will do the same, and the copies will drift.
- **The front door needs care on hosts that set COOP site-wide.** A redirect from `/.well-known/byow` carries
  headers too, and a `same-origin` COOP on it severs the opener. SPEC 7.6 should say so.
- **Policy is where adoption stalls, not protocol.** Clasp signed a Payment and a TrustSet for sites and
  refused a memo or a source tag. Blume's bridge sends both, and XRPLClaw sends a source tag, so neither
  could use Clasp through BYOW. BYOW made that visible in one line of manifest; it could not make the
  decision. Shane made it the same day, in two steps: first memos and source tags, then open signing
  as Clasp's core principle. Clasp now signs any transaction a site sends, exactly as sent, and shows
  every field of it first (first-class screens for a payment, a trust line and an offer; field by
  field, drawn by each field's ledger type, for everything else; account handovers said in words). It
  refuses only what the ledger can't take and a sign-in statement for another site. That matches what
  this protocol always allowed a wallet to do, and it is the stance that makes BYOW worth adopting: a
  wallet that refuses whole classes of transaction is one a site can't rely on.
- **The kit's default policy is now the outlier.** The reference kit (`describeTx`) still renders
  Payment and TrustSet and refuses the rest. Clasp's field-by-field review (`tx-fields.ts`,
  `tx-review.ts`) is the better default for a kit people fork: every wallet built on it would sign any
  transaction and show all of it. Worth porting before the kit is published.
- **A wallet that rebuilds a request must carry every field through.** Clasp's popup rebuilds a site's
  transaction from its whitelist. Had the memo been lost there, the bridge payment would still have gone
  out, to the bridge, with nothing to route by. BYOW's `checkSignedTx` would have caught it, but only after
  the money moved, because Clasp submits before it answers. Clasp now builds in one place and signs every
  accepted shape in a test that runs `checkSignedTx` on the result. That test belongs in the kit: any
  wallet built on it should get it for free.

## 4b. The first real site: Blume's bridge (not started)

Blume's swap, pad and lend are EVM apps and wait for the EVM profile. Its bridge has an XRP Ledger side
that is Xaman-only today, with payment rows to copy by hand for any other wallet. That is where BYOW fits:

1. ~~Clasp signs what the bridge sends~~ Done 2026-11-11: memos, source tags, `SendMax`, any type.
2. The bridge offers "another wallet" beside Xaman: `xrpl_connect` with a challenge where it uses a Xaman
   sign-in today, and `xrpl_signTransaction` for each payment it already builds. Its trust lines gain
   `Flags: 131072`. Its one-Batch path stays Xaman's; a BYOW wallet gets the two-payment path.
3. The bridge gets the site SDK from npm, or carries a copy.

## 4c. The first real site: XRPLClaw sign-in (built 2026-11-12, not deployed)

XRPLClaw's sign-in chooser gained "Another wallet": the user types a wallet's address (Clasp is suggested),
and the server checks the proof with `verifySignIn` and the ledger. Run in Chromium, WebKit and Firefox
against a mainnet build of the toy wallet, and against live claspwallet.com up to its passkey screen.
Building it found three gaps, fixed in the spec and the verifier the same day:

- **A brand-new wallet is not on the ledger.** A fresh Clasp account has never been funded, so `account_info`
  answers `actNotFound` and `keyMayActFor` had no AccountRoot to read. Only the master key can speak for an
  account that does not exist, so `keyMayActForAccount(address, key, null)` accepts exactly that (SPEC 5.2).
  A failed lookup is not "not found".
- **A site has more than one origin.** xrplclaw.com serves both the apex and `www` without a redirect.
  `verifySignIn` takes a list of the site's own origins (SPEC 14).
- **The verifier imported xrpl's own dependencies** (`ripple-keypairs`, `ripple-binary-codec`), which a
  strict installer does not hoist. It now imports only from `xrpl`, its declared peer.

Still vendored (the site carries copies of six files), which is the case for publishing to npm.

## 5. Prove before anything freezes

- Real Safari, mobile browsers and in-app browsers. Nothing has been measured on a phone.
- A real Ledger signs the sign-in transaction. If it refuses a zero fee or sequence, the expiry lock alone
  was refused on testnet (SPEC Appendix B), so the template can shed locks.
- A native app claims `/.well-known/byow` as a universal link on iOS and Android.
- Three wallets of different kinds, built from the docs by someone who did not write them.
- The name. `byow` and `@byow/core` were unregistered on npm on 2026-11-11, and one web search found no
  standard by the name. The `byow:` scheme is unchecked.

## 6. Decisions that are Shane's

- The spec's licence. The code is MIT; a spec is usually CC0 so anyone can implement it.
- ~~When this goes public, and where~~ Public on GitHub, in its own org `byow-protocol`, since 2026-11-12.
- Whether to take it to XRPL Commons, or to the XLS process as a draft.
