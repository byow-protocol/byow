# BYOW: Bring Your Own Wallet

> Inherits from ~/Projects/CLAUDE.md

A protocol that lets any website work with any wallet. The site integrates once, and a wallet nobody
has heard of, written yesterday, works: no registry, no per-wallet code, no API keys. The site trusts
nothing a wallet says until a signature or the ledger confirms it.

## Status

**0.2 draft. Public on GitHub at `byow-protocol/byow`, in its own org (2026-11-12). Not on npm.**

- **0.1** was a prototype built in one session on 2026-10-02: the popup case only, spun out of Clasp's
  connect layer.
- **0.2** is the redesign of 2026-11-11. **The design of record is that day's conversation, not the 0.1
  code**; where they disagreed, 0.2 follows the conversation (`docs/ROADMAP.md` §1-2).
- **Built:** one JSON-RPC request format over three carriers (window, link, page), the XRPL profile with a
  sign-in proof every wallet can produce, the site SDK, the wallet kit, the verifier, a reference mailbox,
  `byow-check`, a toy wallet and a demo site.
- **Proven in real browsers** (Chromium, WebKit, Firefox): the window carrier, and the link carrier through
  a return URL. The link carrier through a mailbox and the page carrier are tested in-process only: nothing
  has travelled between two devices or run in a real extension.
- **Sketched only:** `inbox`, a site endpoint for agents, the xrpl-connect bridge, multi-signing, the EVM
  profile (SPEC 18, 5.5).
- **First real wallet:** Clasp speaks BYOW, live on claspwallet.com since 2026-11-12 (built on its `byow`
  branch the day before), and passes `byow-check`'s 19 no-human checks on all three engines. What it showed is in `docs/ROADMAP.md` §4a.
- **Health on 2026-11-11:** typecheck clean; 412 unit and in-process tests pass; e2e 36 pass and 1 skipped on
  Chromium, WebKit and Firefox (the skip is the Firefox opener-isolation case, a known gap); the toy wallet
  passes all 21 `byow-check` checks on each engine and the naive wallet fails 15. Breaking 18 safety rules in
  the source one at a time made the unit suite fail every time.

## Read before doing anything

| Doc | Purpose |
|---|---|
| `SPEC.md` | **Start here.** The protocol. Every claim is marked [built], [measured] or [sketch]. |
| `docs/ROADMAP.md` | Why 0.2 replaced 0.1, what is left in order, what must be proven first, Shane's open decisions. |
| `docs/BUILD_A_WALLET.md` | What to hand a coding agent so it builds a wallet that passes the checker. |
| `experiments/opener/RESULTS.md` | The browser measurements behind SPEC 7.2 and Appendix A. |

## Commands

```bash
npm run typecheck
npm test               # unit and in-process integration, a few seconds
npm run e2e            # real Chromium, WebKit and Firefox across real origins. About 2.5 minutes.
                       # Needs: npx playwright install webkit firefox
npm run build          # tsc to dist/, which is what package.json's exports point at
npm run check -- <wallet url> --approve <css> --reject <css>    # byow-check against any wallet
node scripts/build-examples.mjs                                  # bundles the toy wallet and demo site
node scripts/build-logo.mjs                                      # redraws the logo into assets/
```

## Rules

**The protocol**
- **Verify, never believe.** Every claim a wallet makes is checked by a signature or by the ledger.
  A change that lets a site take a wallet's word for an address, a hash or a payment removes the one
  property that makes strangers' wallets safe to accept: a lying wallet can only hurt its own user.
- **A wallet's policy is not the protocol** (Shane, 2026-11-11: Clasp conforms to BYOW, never the
  reverse). The protocol says a wallet fills only what is absent, never alters what a site sent, and may
  refuse. WHAT it refuses lives in the kit's defaults (`describeTx`), not in a profile's validation and
  not in the site SDK. 0.1 got this wrong by refusing site-set `Flags` at the protocol level.
- **Identity is what the carrier can prove, and no more.** A browser-stamped origin on window and page;
  on a link, only where the answer is delivered. Names and icons are claims.
- **One core on each side, three thin carriers.** Anything a wallet must get right regardless of how the
  request arrived belongs in `src/wallet/core.ts`; anything a site must check regardless belongs in
  `src/site/wallet.ts` and the profile. A carrier decides only who is asking and how the answer travels.
- **Complexity goes into the SDK and the kit, never into what a wallet author writes.** The toy wallet
  is about 85 lines. A change that makes it longer needs a reason.
- **An optional feature must fall back to a core flow by itself** when the other side lacks it.
- **New behaviour is a new method name.** A method's params and result never change shape.
- **The SDK ships no list of wallets.** Whoever ships the default list is the gatekeeper.
- **In 0.x anything may break. At 1.0 the wire freezes:** message shapes, error codes, method names,
  the link grammar, the sign-in transaction. Settle names before then.

**Measured facts** (don't re-derive them; re-measure when engines change)
- A popup opened to an arbitrary URL can replace the site's tab in every engine. Opening it from a
  same-origin `about:blank` iframe contains that in Chromium and WebKit and not in Firefox (SPEC 7.2).
- Isolation changes who talks to whom. A wallet must accept its opener and the opener's ancestors,
  and the SDK must listen on both the iframe and the top window. Both were real bugs, and only e2e
  caught them.
- `window.open` must run synchronously inside the click. One `await` before it and the browser
  blocks the popup, so nonces and invoices are fetched before the click. `Carrier.call` keeps that
  promise: nothing asynchronous happens before the window opens.
- The sign-in transaction (empty AccountSet, `Sequence: 0`, `Fee: "0"`, `LastLedgerSequence: 1`) is
  refused by testnet on each lock alone (SPEC Appendix B). Unmeasured: mainnet, and any hardware wallet.
- Playwright's WebKit is not Safari. Real Safari, mobile browsers and in-app browsers are unmeasured.

**The checker**
- `check/` speaks the raw protocol. It may share the strict parsers in `src/protocol.ts` and the verifier,
  and it never imports the site SDK (`src/site/`, `src/index.ts`): if it did, an SDK bug would pass its
  own check.
- Never edit `byow-check` to make a wallet pass.
- `examples/naive-wallet` must keep failing. It is the negative control.

**The spec**
- Keep the marks honest. A claim becomes [built] only with a test, and [measured] only with a run
  recorded in an appendix. "Tested in-process" is not "run in a browser"; say which.
- Each of the 12 `[review]` items has a regression test. Don't remove one without the other.

**Publishing**
- The repo is public on GitHub (`byow-protocol/byow`, Shane's go-ahead of 2026-11-12), so whatever is
  pushed is published. Push only when he asks. No `npm publish` without his go-ahead; `"private": true`
  stays until then.
- Commits carry no AI attribution: no `Co-Authored-By: Claude` or `Claude-Session` lines.

**The logo** (chosen 2026-11-12: a paper bag with a wallet dropped in it)
- `scripts/build-logo.mjs` draws every file in `assets/`. Change the script and rerun it; never edit an
  SVG by hand. Its header records the construction and what was tried and dropped.

## Structure

| Path | Contents |
|---|---|
| `SPEC.md` | The protocol. |
| `src/protocol.ts` | The wire, shared by both sides: JSON-RPC parsing, error codes, text hygiene, the manifest, the `Profile` interface. Zero dependencies. |
| `src/link.ts` | Links (`byow:` grammar, format and parse) and sealing (AES-256-GCM). Shared, zero dependencies. |
| `src/site/` | Site SDK. `wallet.ts` is `ByowWallet`, the one handle over any carrier. `window.ts` (popup, opener isolation, origin pinning), `page.ts` (wallets announced in the browser), `link.ts` (mailbox and return-URL carriers), `discovery.ts` (typed, remembered, prefilled; the front door). |
| `src/wallet/` | Wallet kit. `core.ts` is the one core: validation, refusals before UI, one UI request at a time, error hygiene. `window.ts` (`createWalletServer`), `page.ts` (`announceWallet`), `link.ts` (`answerLink`). |
| `src/xrpl/` | The XRPL profile (`profile.ts`: params, results, the sign-in transaction, the kit's default signing policy), wallet handlers (`wallet.ts`), a reference signer and network on xrpl.js (`signer.ts`), the verifier (`verify.ts`: `verifySignIn`, `keyMayActFor`, `checkSignedTx`, `checkSignedPayment`, and the checking profile `xrplVerified`). |
| `src/mailbox.ts` | The reference mailbox: four routes over a map, plus a node:http adapter. |
| `check/` | `byow-check`: runs any wallet URL against the spec in a real browser, on its own raw-protocol harness. |
| `examples/` | `toy-wallet` (a whole wallet in one file), `demo-dapp` (a site that has never heard of any wallet), `naive-wallet` (fails the checker on purpose). |
| `experiments/opener/` | The script and results for the opener-isolation measurements. |
| `assets/` | The logo: mark, wordmark, lockups, GitHub's social preview. Drawn by `scripts/build-logo.mjs`. |
| `test/` | Unit and in-process integration tests, and `e2e/` across three engines and real origins. |

## Neighbours

- **Clasp** (`~/Projects/clasp/`) is the first wallet that should conform. Its own connect wire
  (`clasp-connect`) would be replaced, not grandfathered. Its docs are useful here as a record of
  verified ecosystem facts and nothing more.
- **XRPLClaw** is the worked example site: one "pay with any wallet" button (SPEC Appendix C).
- **xrpl-connect** (XRPL Commons) is a library of hand-written wallet adapters, not a protocol. The
  plan is to accept its adapters as a bridge to wallets that won't adopt BYOW (`docs/ROADMAP.md` §4).
