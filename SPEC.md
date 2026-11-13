# BYOW: Bring Your Own Wallet

**Version 0.2, draft, 2026-11-11.** The key words MUST, SHOULD and MAY are used as in RFC 2119.

How to read the marks:

- **[built]** is implemented in this repo and covered by tests.
- **[measured]** was checked against the real thing, and the numbers are in an appendix: real browsers
  (Chromium 151, WebKit 26.5, Firefox 153, headless, 2026-10-02) or the XRPL testnet (2026-11-11).
- **[sketch]** is a design that has not been built, and may change.
- **[review]** marks one of the 12 issues an independent adversarial review found in the first draft. Each
  has a regression test.

0.2 is a redesign of 0.1, not an increment. 0.1 reached only wallets that are websites, and its XRPL
profile carried one wallet's signing rules. `docs/ROADMAP.md` records what changed and why.

---

## 1. What this is

BYOW lets any website work with any wallet that implements it. The site integrates once. There is nothing
for the site's operator to configure per wallet, nothing for a wallet's author to register anywhere, and no
company in the middle.

It exists because wallets are now cheap to make. Someone can generate a working wallet in an afternoon, and
today it connects to nothing, because every site integrates a fixed list of wallets one by one.

The shape: **a request is a small JSON object, and there are three ways to hand it to a wallet.**

| Carrier | The wallet is | How the request travels | Status |
|---|---|---|---|
| **Window** | a website | The site opens it in a popup; they talk over `postMessage` | [built, measured] |
| **Link** | an app, a script, an agent, a hardware companion, or anything on another device | The request is a URL: a QR, a deep link, something pasted | [built]. Through a return URL: [measured] in three engines. Through a mailbox: in-process only, not yet between two devices |
| **Page** | a browser extension, or an app showing the site in its own browser | The wallet announces itself in the page; the site calls it | [built] in-process; not yet run in a real extension |

The messages are the same on all three. The wallet holds the keys and shows the approval screen. The site
holds no secrets and trusts nothing a wallet says until it has verified it.

### 1.1 Design rules

1. **Verify, never believe.** Every claim a wallet makes is checked by cryptography or by the ledger, never
   taken on its word. A lying wallet can only hurt its own user.
2. **Identity is what the carrier can prove, and no more.** A browser-stamped origin where there is one. A
   name and an icon are claims.
3. **Permissionless by default.** No allow-list, no registration, no API key. An SDK MUST NOT ship a list of
   wallets: whoever ships the default list becomes the gatekeeper this protocol exists to remove. A site MAY
   add a policy of its own; the protocol never requires one.
4. **No sessions.** Every request stands alone and names its chain. "Connected" is something a site
   remembers, not something a wallet grants.
5. **A wallet's policy is not the protocol.** What a wallet will or won't sign is its own business. The
   protocol says only that it must refuse rather than alter.
6. **Fail closed, before any UI.** Malformed, unsupported or unsafe requests are refused without showing the
   user anything.
7. **The complexity goes into the SDK and the kit**, written once, never into what a wallet author writes.
   A wallet author (human or AI) writes the signer and the review screen.
8. **An optional feature must fall back to a core flow by itself** when the other side lacks it.
9. **New behaviour is a new method name.** A method's params and result never change shape.
10. **Chain-agnostic messages, chain-native payloads.** BYOW invents no transaction format.

### 1.2 Non-goals

Key custody standards, account abstraction, standing sessions or permissions, a relay network and a wallet
registry.

### 1.3 Terms

- **Site**: whatever wants an account or a signature. Usually a web page.
- **Wallet**: whatever holds keys and implements this spec.
- **Asker**: who the wallet believes is asking, and how it knows (section 6).
- **Document**: one loaded instance of a wallet page. A new navigation is a new document.

---

## 2. Messages **[built]**

Every message is a [JSON-RPC 2.0](https://www.jsonrpc.org/specification) object. Anything else on a shared
channel MUST be ignored silently.

```jsonc
// site -> wallet
{ "jsonrpc": "2.0", "id": "9f2d...", "method": "xrpl_signTransaction",
  "params": { "chain": "xrpl:0", "tx_json": { "TransactionType": "Payment", "Destination": "r...", "Amount": "1000000" } } }

// wallet -> site
{ "jsonrpc": "2.0", "id": "9f2d...", "result": { "tx_blob": "1200...", "hash": "A1B2...", "submitted": true } }
{ "jsonrpc": "2.0", "id": "9f2d...", "error": { "code": 4001, "message": "The user declined." } }

// wallet -> site, window carrier only: the one notification
{ "jsonrpc": "2.0", "method": "byow_ready", "params": { "versions": ["0.2"] } }
```

| Field | Rule |
|---|---|
| `id` | string, `[A-Za-z0-9_-]{1,64}`. The response echoes it. A request with no valid `id` MUST be ignored: there is nothing to answer. A site SHOULD use at least 96 random bits; on carriers with no stamped origin it is also the unguessable token that ties an answer to its request. |
| `method` | string, `[A-Za-z0-9_]{1,64}` |
| `params` | an **object**, never a positional array. Absent means `{}`. |
| `params.chain` | when present, a [CAIP-2](https://chainagnostic.org) chain id, `[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}`. The wallet MUST check it against its manifest before any UI. |
| size | a message whose JSON form exceeds 256 KiB MUST NOT be processed |
| non-JSON | a message holding anything JSON cannot express (Map, Set, Date, ArrayBuffer, typed arrays, BigInt, NaN, cycles, non-plain objects, depth over 32, over 20,000 nodes) MUST NOT be processed. A property whose value is `undefined` is treated as absent, as `JSON.stringify` would. **[review]** |

A request with a valid `id` whose message is otherwise malformed MUST be answered `bad_request`. One whose
message is well formed but whose params are wrong for its method, a malformed `params.chain` included, MUST be
answered `bad_params`. A response carries a
`result` or an `error`, never both. A receiver MUST work from its own copy of a message: on the page carrier
the sender still holds the object it sent, and must not be able to change it after it has been judged. `error.data` from a wallet is untrusted: the SDK deep-copies it with
strings sanitised and capped, prototype-poisoning keys dropped, and depth and size bounded **[review]**.
Message strings from a wallet are sanitised before display (section 13).

---

## 3. Errors **[built]**

Errors travel as JSON-RPC integers. Code and logs use the names.

| Code | Name | Meaning |
|---|---|---|
| -32600 | `bad_request` | The message itself is malformed |
| -32601 | `unsupported_method` | Method not in the manifest |
| -32602 | `bad_params` | The method is known and its params are wrong |
| -32603 | `internal` | The wallet failed. The message MUST be generic and MUST NOT leak the exception text, paths or secrets. The reference kit sends the same words every time, whatever a handler wrote. |
| 4001 | `user_rejected` | The user said no. The **only** code that means this. |
| 4100 | `site_not_allowed` | The wallet's own policy refuses this site. Not a user decision. |
| 4101 | `wrong_account` | The wallet's account is not the one the site named |
| 4300 | `unsupported_chain` | Chain not in the manifest |
| 4301 | `unsupported_tx` | A transaction this wallet will not sign. Its policy, not a protocol rule. |
| 4302 | `expired` | The request is past its expiry |
| 4400 | `busy` | The wallet is already handling a request, or this document has been used |

A wallet never sends anything else; a site treats an unknown code as `internal`. These names are raised by
the SDK and never sent: `timeout`, `popup_blocked`, `invalid_wallet_url`, `invalid_response`,
`origin_mismatch`, `wallet_not_allowed`, `unsupported_version`.

4001 is the number EIP-1193 uses for a user's refusal, on purpose. An adapter to an EVM library MUST map
only `user_rejected` (and a wallet window the user closed) to 4001, and `timeout`, `popup_blocked` and `busy`
to `-32002`: viem replaces the message of any 4001 with a canned "User rejected the request", so a blocked
popup reported as 4001 makes a mined transaction look like a refusal.

---

## 4. Core method: `byow_info` **[built]**

No params. The wallet MUST answer without showing UI and MAY be asked any number of times. A wallet whose
own policy refuses a site MAY refuse it this too (`site_not_allowed`).

```ts
interface Manifest {
  name: string;          // 1-64 chars after sanitising. A CLAIM. Never an identity.
  icon?: string;         // data:image/(png|jpeg|webp);base64,... only, <= 48 KiB. Anything else is dropped.
  description?: string;  // <= 200 chars after sanitising
  versions: string[];    // 1-8 protocol versions like "0.2"
  chains: string[];      // CAIP-2, <= 32
  methods: string[];     // <= 64, includes "byow_info"
  transactions?: { [family: string]: "*" | string[] };   // what it will sign, per chain family
}
```

`transactions` is how a wallet says up front what it signs: `{ "xrpl": ["Payment", "TrustSet"] }`, or
`{ "xrpl": "*" }` for anything. A site reads it to disable an action instead of failing when the user tries
it. Absent means unknown, and the site finds out by asking.

The site MUST parse the manifest strictly (types, lengths, regexes), strip control, zero-width and bidi
characters from text, drop an out-of-spec `icon` or `transactions` rather than use it, and reject the whole
manifest on any other violation. A site MUST NOT display a wallet's `name` or `icon` with equal or greater
weight than its origin, and SHOULD label the name as a claim.

`byow_info` is the handshake on the window and page carriers. A link is one-shot and has no handshake, so a
site reaching a wallet by link learns what it supports from the answer (section 8).

---

## 5. The XRPL profile **[built]**

A **profile** defines, for one CAIP-2 namespace, its method names, their params and results, and what is
verified. Methods are named `<family>_<method>`.

Chains are `xrpl:<network id>`: `xrpl:0` mainnet, `xrpl:1` testnet, `xrpl:2` devnet. These follow the Chain
Agnostic Namespaces `xrpl` draft. An account is a classic `r...` address; a public key is 33 bytes as hex
(an `ED`-prefixed ed25519 key, or a secp256k1 key).

### 5.1 `xrpl_connect`

Asks for the account the user wants to use, optionally with proof that the wallet controls it.

```ts
params: { chain: string, challenge?: string /* [A-Za-z0-9_-]{8,128} */ }
result: { address: string, publicKey: string, proof?: string /* a signed sign-in transaction, hex */ }
```

- The wallet shows who is asking (section 6) and the address it will share, and waits for the user.
- With a `challenge`, the wallet MUST return a `proof` (5.2) or an error. A site MUST treat an answer with
  no proof as invalid.
- A wallet MUST refuse a `challenge` when it cannot say who is asking (`bad_params`): there is nothing to
  bind the proof to.
- **Until a proof has been verified, the address is a claim.**

### 5.2 Sign-in: a transaction that can never apply **[built, measured]**

Proof of control is a signed transaction, not a signed message. It is exactly this, with nothing added:

```jsonc
{ "TransactionType": "AccountSet",
  "Account": "<address>",
  "Sequence": 0,                 // always in the past
  "Fee": "0",                    // below any minimum
  "LastLedgerSequence": 1,       // expired since the second ledger
  "SigningPubKey": "<publicKey>",
  "Memos": [ { "Memo": {
      "MemoType": "62796F772F7369676E2D696E",                       // "byow/sign-in"
      "MemoData": "<hex of the UTF-8 JSON statement>" } } ],
  "TxnSignature": "<signature>" }

// the statement
{ "origin": "https://site.example", "chain": "xrpl:0", "challenge": "<the site's nonce>", "iat": 1731326400 }
```

Each of the three locks alone makes the network refuse it (Appendix B). If a wallet rewrote all three, what
is left is an `AccountSet` that changes nothing.

Why a transaction: signing one is the single thing every XRPL wallet can do. Hardware wallets refuse to sign
arbitrary bytes, and several software wallets have no message signing at all. The same verifier also covers
regular keys, and the format can carry multi-signatures.

- **The wallet writes `origin`.** It is the origin the wallet saw asking (section 6). A site never supplies
  it, so a proof cannot be harvested by one site for use at another.
- A sign-in transaction is minted by `xrpl_connect` and by nothing else. `xrpl_signTransaction` MUST refuse
  (`bad_params`) a transaction carrying a `byow/sign-in` memo, so a site cannot ask a wallet to sign a
  statement naming another origin.
- `iat` is the wallet's clock, in unix seconds.

A verifier (`verifySignIn`) MUST check that the blob is in canonical form, has exactly these fields and the
three locks, carries exactly one memo of that type, names the origin and chain the **verifier** expects and
the nonce it issued, is no older than its limit (default 10 minutes), and verifies against `SigningPubKey`.
`Flags` MAY be absent, `0` or `0x80000000`.

That proves someone holding that key signed in. Whether the key may act for the account is the ledger's to
say: the key is the account's master key and the master key is not disabled, or it is the account's regular
key (`keyMayActFor`, one `account_info` lookup). A site guarding anything of value MUST do the lookup.

An account the validated ledger does not hold (`actNotFound`) has never been funded, or was deleted. It has no
regular key and no disabled master, so only its master key can speak for it: the proof is enough when the key
derives to the address (`keyMayActForAccount` with no AccountRoot). This is what lets a brand-new wallet sign in
before it holds any XRP. A lookup that failed or timed out is not an answer, and a site MUST NOT treat it as
"not found".

### 5.3 `xrpl_signTransaction`

```ts
params: { chain: string, tx_json: object, account?: string, submit?: boolean /* default true */ }
result: { tx_blob: string, hash: string, submitted: boolean, engine_result?: string }
```

**Who sets which field.**

- **The wallet fills only what is absent**, and only from this list: `Account`, `Sequence`, `Fee`,
  `LastLedgerSequence`, `NetworkID`, `SigningPubKey`, `TxnSignature`. It MUST set a `LastLedgerSequence` if
  the site sent none. It MAY add `Flags` as `0` or `0x80000000` when the site sent none. It adds nothing
  else: `SourceTag`, `Memos` and every other field are the site's, and absent stays absent.
- **The wallet never alters what the site supplied.** It signs it as given, or refuses.
- **The wallet may refuse anything** by its own policy, with `unsupported_tx`.
- The signature is always the wallet's: a request that sets `SigningPubKey`, `TxnSignature` or `Signers`
  MUST be refused `bad_params`.

**Naming the account.** A site names the account to sign as with `account`, or with `tx_json.Account`; if it
gives both they MUST match. A wallet whose account is a different one answers `wrong_account`.

**Privacy [review].** A wallet MUST NOT reveal its address, or whether it is funded, to a site the user has
not approved. So the account check happens **after** approval (the review SHOULD warn that the site asked
for a different account), `wrong_account` carries no address, and failures to prepare a transaction are a
generic `internal`.

**Addresses.** Every address a transaction names MUST pass the full classic-address checksum before the
user sees anything **[review]**. Shape alone lets a wallet show a transaction, get approval, and then fail
to sign it.

**`submit`.** With `submit` true (the default) the wallet SHOULD hand the signed transaction to the network.
`submitted` says whether it did, and `engine_result` is the network's first answer, as advice. **Neither is
an outcome.** The signed transaction always comes back, submitting the same blob again is harmless, and only
the validated ledger says whether it landed. A wallet that cannot submit answers `submitted: false`, and
the site submits.

**The site checks the answer** (`checkSignedTx`): the blob is canonical, the signature verifies, every field
the site sent is present and unchanged (compared in serialized form), nothing was added outside the fill
list, a `LastLedgerSequence` is present, and the hash is recomputed and equals `hash`. `Flags` are compared
with `0x80000000` ignored and absent equal to `0`. The reference SDK does this in the page when the site
registers the checking profile (`xrplVerified`); a server that counts a payment checks it again
(section 14).

### 5.4 A wallet's policy: the reference kit's **[built]**

This subsection describes the reference kit's defaults. It is one wallet's policy and binds nobody else.

**Render it or refuse it.** If the wallet cannot show the user a field's meaning, it refuses the transaction
`unsupported_tx` rather than show an Approve button over a blob.

| Type | Fields the default renderer accepts |
|---|---|
| `Payment` | `Account?`, `Destination`, `Amount` (drops string, or `{currency, issuer, value}`), `DestinationTag?`, `SourceTag?`, `InvoiceID?`, `Flags?` only as `0` |
| `TrustSet` | `Account?`, `LimitAmount {currency, issuer, value}`, `SourceTag?`, `Flags` exactly `131072` (`tfSetNoRipple`) |

So by default: no partial or cross-currency payments, and no fee or sequence chosen by the site. A
`TrustSet` without `tfSetNoRipple` is refused, not fixed: the wallet does not add the flag, it asks the site
to send it. For issued amounts the issuer is always shown. A 40-hex currency code is shown as text only when
every byte is a letter or digit; otherwise raw hex with a warning. A token whose code is `XRP` in any case
is flagged. The kit's manifest declares `transactions: { xrpl: ["Payment", "TrustSet"] }`; a wallet that
supplies its own renderer declares its own list.

**The network adapter is untrusted [review].** It may supply only `Fee`, `Sequence`, `LastLedgerSequence`,
the ledger index it read them at, and optionally `NetworkID`. The kit copies those by name, requires each to
be a uint32, requires `ledgerIndex < LastLedgerSequence <= ledgerIndex + 1000`, and refuses
(`unsupported_tx`) a fee over a ceiling (default 100,000 drops, 0.1 XRP) whoever chose it.

### 5.5 Other families

**EVM [sketch].** Chains `eip155:<chainId>`. Methods are the EIP-1193 names verbatim (`eth_requestAccounts`,
`personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`) with `params` as an object wrapping the
standard arguments, so existing libraries need only a thin adapter. Ownership proof is SIWE (ERC-4361); the
wallet MUST refuse a SIWE message whose `domain` is not the asking origin's host. Error mapping per
section 3.

**Adding a family.** Pick the CAIP-2 namespace; define method names, params, results, the proof, and what is
verified. Implement `Profile { family, methods, validateParams, preflight?, parseResult }` for the site SDK
and a handler map for the wallet kit. A profile MUST NOT weaken any rule in sections 6 to 13.

---

## 6. Who is asking

A wallet shows the user who is asking on every approval. What it can honestly show depends on the carrier.

| Proof | Carriers | What the wallet knows |
|---|---|---|
| `browser` | window, page | The browser stamped this origin on the message. A page cannot forge it. |
| `delivery` | link | This origin is where the answer will be **delivered**. Whoever made the link chose it. It says where the answer goes, not which page the user is looking at. |
| `none` | link with no return path | Nothing vouches for anyone. |

A wallet MUST show the origin verbatim and prominently. For `delivery` it SHOULD say that the answer goes
there. For `none` it MUST say the site is unknown.

The same origin is what the wallet writes into a sign-in proof (5.2). A site learns which carrier answered
(`WalletInfo.carrier`), because sign-in over a link is weaker than over a window or a page (8.7).

---

## 7. Window carrier **[built, measured]**

The wallet is a web page at any https origin (or `http://localhost` while developing).

```
site page ──window.open(walletUrl)──▶ wallet popup (any origin)
          ◀──── byow_ready ──────────  announces supported versions
          ───── byow_info ──────────▶  who are you, what can you do
          ◀──── manifest ───────────
          ───── request ────────────▶  [wallet shows origin + decoded request, user approves]
          ◀──── response ───────────  result or error
```

### 7.1 Opening the wallet

- The wallet URL MUST be `https:`, or `http:` with host exactly `localhost`, `127.0.0.1` or `[::1]` (SDKs
  allow this by default for development and let an integrator turn it off). `*.localhost` names are not
  accepted. It MUST NOT contain a username or password. (`https://trusted.example@evil.example/` has a
  username and a real host of `evil.example`.) `javascript:`, `data:` and `file:` URLs MUST be refused.
- `window.open` MUST be called synchronously inside the user's click. Any `await` before it and browsers
  block the popup. So a site MUST fetch anything the request needs (nonces, invoices) **before** the click.
- The site SHOULD give the window a random name and reuse it. `window.open` on an existing named window is a
  navigation, which browsers allow without a fresh gesture. This lets a site chain approve then pay.

### 7.2 Opener isolation **[measured]**

A wallet URL is arbitrary, so the window it opens in must not be able to steer the site's own tab. A popup
opened directly can navigate its opener: `opener.location = "https://phish.example"` replaces the site's tab.

A site SHOULD therefore open the wallet **from a hidden same-origin `about:blank` iframe**, so that
`popup.opener` is that iframe and not the site's window. The iframe needs no script of its own: the site
calls `iframe.contentWindow.open(...)`. Measured: the click's permission to open a window reaches a
same-origin iframe in all three engines below, including one created inside the click handler itself. An SDK
SHOULD still create the iframe at page load: it costs nothing, and unmeasured engines may differ.

| Engine | Popup opened directly | Popup opened from the iframe |
|---|---|---|
| Chromium 151 | site tab hijacked | **contained**: `opener.location` and `opener.top.location` both throw `SecurityError` |
| WebKit 26.5 | site tab hijacked | **contained** |
| Firefox 153 | site tab hijacked | **not contained**: `opener.location` throws, but `opener.top.location = ...` navigates the site's tab |

An SDK MUST report the isolation level it achieved: `contained`, `top-reachable` (iframe used, engine still
lets the popup reach `top`) or `none`. **[review]** `contained` is *assumed from the engine family* (user
agent), not tested at runtime: it is measured only on the versions in Appendix A, and a WebView, Electron or
a future version may differ. A site MAY refuse to proceed unless the level is `contained`. On
`top-reachable` engines the complete fix is the link carrier through a return URL (8.5), which has no opener
**[measured]** (Appendix A, variant D).

Because the popup's opener is the iframe, two things follow that both sides MUST handle:

- The site's script runs in the top window, so requests arrive at the wallet with `event.source` equal to the
  opener's **parent/top**, not the opener. A wallet MUST accept requests whose source is its opener or an
  ancestor of its opener.
- A wallet may answer `event.source` (the top window) or `window.opener` (the iframe). A site MUST accept
  replies on either window, gated identically (source is the popup, origin is the pinned one).

### 7.3 Handshake

1. The wallet document, on load, posts `byow_ready` to `window.opener` with target origin `"*"`. It carries
   no data beyond the version list, which is why `*` is acceptable. The wallet SHOULD repeat it every
   ~300 ms (up to ~8 s) until it receives its first request.
2. The site accepts the first `byow_ready` whose `event.source` is the popup, **pins `event.origin`** as the
   wallet's identity, and ignores `byow_ready` after that. An `event.origin` of `"null"` (opaque) MUST be
   refused, since it identifies nothing.
3. The site picks the highest protocol version both support, compared numerically (`0.10` is higher than
   `0.9`). If none, it MUST stop and report `unsupported_version` without bothering the user.
4. The site sends `byow_info` and validates the manifest strictly (section 4).
5. The site checks that the manifest lists the method and chain it needs, and that `transactions` does not
   rule the request out. If it fails, the site MUST stop before sending the real request, and SHOULD close
   the popup.
6. The site sends the real request.

### 7.4 Origin pinning

**Wallet side.** The wallet MUST accept requests only from its opener or an ancestor of its opener (7.2).
It MUST lock to the `event.origin` of the first request it accepts (a well-formed request, or a malformed one
it will answer `bad_request`; a message with no usable `id` MUST NOT lock anything **[review]**), and MUST
silently ignore any later message from a different origin even if it comes from the same window (the opener
may navigate). It MUST address every reply to the locked origin. It MUST NOT use `"*"` for anything except
`byow_ready`.

**Site side.** After pinning, the site MUST ignore any message whose source is not the popup or whose origin
is not the pinned one. If the popup's origin differs from the origin of the URL the user gave (the wallet
redirected), the site MUST refuse by default (`origin_mismatch`), because a redirect is how a lookalike
wallet would replace the one the user meant. A site MAY opt in to redirects and MUST then show the final
origin.

If the site is itself framed by a cross-origin page, `opener.top` is that embedder, which the wallet also
accepts (7.2). Whoever speaks first locks the document, so an embedder can make the wallet ignore the real
site (denial of service only). The wallet shows the origin that is actually asking, so the user is not misled.

### 7.5 One UI request per document

A document MUST handle at most one request that shows UI (anything other than `byow_info`). Further UI
requests get `busy`. A refusal that needs no UI (an unknown method, a bad chain) is given in preference to
`busy`. After a success, a `user_rejected` or an `internal`, the document is spent. Refusals
(`bad_request`, `bad_params`, `unsupported_*`, `wrong_account`, `expired`) do not spend it, so a site can
retry.

A successful wallet window SHOULD stay open for a short linger (~30 s) so a follow-up request can navigate it
instead of opening a new popup. A user rejection SHOULD close it within ~300 ms: that is the user's own hand.

### 7.6 Headers

- **Wallet page**: MUST NOT send `Cross-Origin-Opener-Policy: same-origin`, which severs `window.opener`.
  SHOULD send a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`) and
  `Referrer-Policy: no-referrer`. The rule covers every response on the way to the page: a front door
  (section 10) that redirects to the wallet MUST NOT send `same-origin` on the redirect either, which a
  host that sets the header site-wide will do unless the path is excepted.
- **Site page**: MUST NOT send `Cross-Origin-Opener-Policy: same-origin`. `same-origin-allow-popups` works. A
  site SHOULD ship a strict CSP; `frame-src 'none'` does not block the `about:blank` isolating iframe
  **[measured: e2e runs under `default-src 'none'`]**.

### 7.7 Timing

Handshake timeout default 20 s (popup open to `byow_ready`). Request timeout default 5 min (a human is
deciding). On handshake timeout the site SHOULD name the usual causes: COOP on the site, a URL that is not a
BYOW wallet, or a closed window. If the popup is closed while a UI request is pending, the site SHOULD report
`user_rejected`: the user closed it. Timeouts and blocked popups MUST NOT be reported as `user_rejected`.
**[review]** When a site gives up on a request (timeout, invalid response, refusal) it MUST close the wallet
window: otherwise a user who approves later signs something the site has already reported as failed, and a
retry could pay twice.

---

## 8. Link carrier **[built]**

The return-URL shape (8.5) is **[measured]**: it runs end to end in Chromium, WebKit and Firefox
(`test/e2e`, Appendix A). The mailbox shape (8.3) is tested in-process (`test/link-carrier.test.ts`,
`test/link.test.ts`, `test/mailbox.test.ts`) and has **not yet run between two devices**.

A request is a URL. That reaches every wallet that is not a web page, and every browser that has no popups,
and it has no `window.opener` to defend.

### 8.1 The link

A link is the text `byow:` followed by parameters joined with `&`, each `name=value` with the value
percent-encoded. It stands alone, or it sits in the fragment of any https URL:

```
byow:v=0.2&c=https%3A%2F%2Fsite.example%2Fbyow%2FXy3...&k=3q2-7w...&e=1731327000
https://wallet.example/.well-known/byow#byow:v=0.2&q=eyJqc29ucnBjIjoi...&r=https%3A%2F%2Fsite.example%2Freturn
```

| Param | Meaning |
|---|---|
| `v` | Protocol version. Required. A wallet MUST refuse a version it does not speak. |
| `q` | The request itself: base64url (RFC 4648 §5, no padding) of its JSON |
| `c` | A mailbox URL (8.3). The request is fetched from it and the answer posted to it. |
| `k` | A single-use 32-byte key, base64url. Required with `c`. Everything on `c` is sealed with it (8.4). |
| `a` | An answer on its way back: base64url of the response's JSON (8.5) |
| `r` | A return URL: where the user goes after answering. With no `c`, the answer rides in its fragment. |
| `e` | Unix seconds after which the request MUST NOT be answered |

Exactly one of `q`, `c` and `a` is present. `c` and `r` MUST be https (or http on localhost), with no
credentials and no fragment. A parameter MUST NOT appear twice. Unknown parameters are ignored. A link longer
than 64 KiB MUST NOT be processed.

A link in a URL's fragment never reaches that URL's server. A wallet that is a page MUST remove the link
from its address bar and history before doing anything else.

A QR SHOULD hold an https URL on the site's own page with the link in its fragment, so a plain camera scan
lands somewhere useful. When the site knows the wallet, it carries the link in the wallet's front door
(section 10). The bare `byow:` form is for a same-device button.

### 8.2 One-shot

A link carries one request and gets at most one answer. There are no sessions and no key exchange. There is
no `byow_info` either: a site learns that a wallet cannot do something from its error.

Three shapes cover every case:

| Shape | Params | For |
|---|---|---|
| Another device | `c` + `k` | A phone wallet scanning a desktop site's QR; any wallet that is not a web page |
| Same device, no server | `q` + `r` | A browser with no popups; Firefox (7.2); a wallet app on the same phone |
| No return path | `q` alone | An invoice or a payment link. The wallet submits, and the site watches the ledger. |

### 8.3 The mailbox

A mailbox is where a request and its answer meet when they travel between devices. It is four routes:

| Route | Who | Answers |
|---|---|---|
| `PUT {c}/request` body `{"box":"..."}` | site | `201`; `409` if the id is taken |
| `GET {c}/request` | wallet | `200 {"box":"..."}`; `404` |
| `POST {c}/response` body `{"box":"..."}` | wallet | `204`; `404`; `409` if already answered |
| `GET {c}/response?wait=<seconds>` | site | `200 {"box":"..."}`; `204` not yet; `404` |

`{c}` is the mailbox's base URL followed by `/` and an id the site chose: 22 to 64 characters of
`[A-Za-z0-9_-]`, random. The mailbox MUST allow cross-origin requests, MUST hold a channel for a bounded
time (default 10 minutes), and MUST accept one answer per channel. It holds boxes it cannot read.

**The link names its own mailbox.** So there is no shared relay, no project ID, and no operator sitting
between every site and every wallet. A site hosts the mailbox (`byow/mailbox` is a reference: about 150
lines, no dependencies) or names anyone else's, and pays for its own traffic.

### 8.4 Sealing

Everything a mailbox holds is sealed with the link's key: AES-256-GCM, a random 12-byte nonce, and the
additional data `byow/request` or `byow/response`. A box is base64url(nonce ‖ ciphertext ‖ tag) of the
message's JSON.

The key never leaves the link, so the mailbox cannot read a request or forge an answer. Binding each box to
its direction stops a mailbox handing a request back as its own answer. A key is used for one request and
one answer.

### 8.5 The return URL

With `q` and `r` there is no server at all:

1. The site opens the wallet's URL with the link in its fragment, in a new tab with `noopener`.
2. The wallet answers by navigating that tab to `r` with an answer link in its fragment:
   `https://site.example/return#byow:v=0.2&a=...`.
3. The site's return page (same origin as the site) hands the answer to the tab that asked, over
   `BroadcastChannel`, and removes it from its own address bar.

Anyone can link to a return page, so **an answer is never trusted for having arrived**. The site accepts it
only if its `id` is the one it sent, and what it says is still verified by signature like any other answer.

A wallet that is a page MUST refuse (`site_not_allowed`) a link whose return URL is on a different origin
than the page that sent the user (`document.referrer`), when the browser supplies one. A page that sends
users to sign for some other origin is the shape of a phishing link. An absent referrer (an app, a QR, a
pasted link) proves nothing either way.

### 8.6 Who is asking, and expiry

The asker is the origin the answer is **delivered** to: the origin of `c`, else of `r`, else nobody
(section 6). A site that hosts the mailbox on its own origin, even as a rewrite to someone else's server,
appears to the wallet under its own origin.

A wallet MUST NOT answer a link past its `e`. It answers `expired` without asking the user. A site SHOULD
always set `e`, and treats the request as failed only after it: a request approved late is otherwise signed,
and possibly submitted, after the site reported failure. The ledger stays the source of truth either way.

### 8.7 What a link cannot do

**A phishing page can relay a real site's QR.** The attacker opens the real site, and shows its QR to the
victim on a lookalike page. The wallet shows the real site's origin, correctly, and the victim approves a
sign-in for the attacker's session. This is true of every cross-device QR login, and no protocol fixes it.

So sign-in over a link is as strong as any QR login and no stronger, while sign-in over the window and page
carriers resists phishing: the browser stamps the origin of the page the user is actually on. An SDK MUST
tell the site which carrier answered, so a site can ask for more before anything sensitive.

---

## 9. Page carrier **[built]**

Tested in-process (`test/page-carrier.test.ts`). **Not yet run in a real extension.**

A wallet with code in the site's own page announces itself there. Two DOM events on `window`, the pattern
Ethereum settled on in EIP-6963:

| Event | Direction | Carries |
|---|---|---|
| `byow:announce` | wallet → page | `detail = { id, info: { name, icon? }, versions, request }` |
| `byow:discover` | page → wallets | nothing: "announce yourselves again" |

- A wallet dispatches `byow:announce` when it loads and again on every `byow:discover`. `detail` MUST be
  frozen. `id` is unique per page load.
- `request(message)` takes one JSON-RPC message and resolves with the response: the same messages as every
  other carrier. The site calls `byow_info` first, as on the window carrier.
- **Nobody claims a global.** Two wallets in one browser never fight over a name on `window`.
- The asker is the page's origin, read by the **wallet's own** code. An extension MUST NOT run its handlers
  in the page's world, which the page controls: the injected `request` relays to the extension's own world,
  where the origin is read.
- A site treats everything `request` returns as untrusted, exactly like a message from a popup, and SHOULD
  give `byow_info` a short timeout of its own (the reference SDK: 10 s).

Such a wallet has no origin to pin. What stands in for one is that the user installed it. A site lists it
under the name it claims, as a wallet in this browser.

---

## 10. Finding a wallet **[built unless marked]**

There is no registry a site must consult, and an SDK ships no wallets (1.1). A site learns the wallet from
the user or from the browser:

- **Announced**: wallets in this browser (section 9).
- **Named**: the user types or pastes a wallet's address. A full URL is opened exactly as given, query
  string and all: a wallet on a shared host cannot serve its origin's root, so the exact URL always has to
  work. A bare domain (`wallet.example`) means that domain's **front door**,
  `https://wallet.example/.well-known/byow`.
- **Remembered**: `{url, claimed name, lastUsed}` in the site's own `localStorage`.
- **Scanned**: a link any wallet can read (section 8).
- **`?byow_wallet=<url or domain>`**: published by a wallet as "open this site with me". It **prefills**
  the field. It MUST NOT open anything: a link is not a gesture, and a phishing link can carry it too.

A site MAY add suggestions of its own: a list of wallets is a list of URLs, and choosing one is the site's
endorsement. A wallet the site did not choose MUST be labelled by its origin, never by its claimed name and
icon alone.

**The front door as one address [sketch].** A native app can claim `/.well-known/byow` on its domain as a
universal link. One address would then open the website wallet on a desktop and the app on a phone, with the
link in its fragment either way. Unproven on iOS and Android.

EIP-6963-style announcement cannot reach a wallet that is a website: the event is dispatched in the page's
own window, and a popup or a cross-origin frame cannot announce into it.

---

## 11. Wallet requirements **[kit-enforced where marked]**

Every wallet MUST:

| # | Requirement | Kit |
|---|---|---|
| W1 | Validate the message, method, chain and params, and refuse before any UI | core |
| W2 | Never answer a UI request without the user acting | handlers must `await` the user |
| W3 | Handle one UI request at a time; answer others `busy` | core |
| W4 | Show who is asking, verbatim and prominently, at the strength the carrier proves (section 6) | context carries it; the wallet's UI must render it |
| W5 | Sign what the site sent or refuse; never alter it; fill only the listed fields (5.3) | XRPL handlers |
| W6 | Write the origin into a sign-in proof itself, and refuse to sign one through `xrpl_signTransaction` (5.2) | XRPL handlers |
| W7 | Never put an exception message on the wire; send a generic `internal` | core |
| W8 | Set site-supplied and wallet-derived strings as text, never HTML, under a strict CSP | docs only |
| W9 | Reveal nothing about its account before the user approves (5.3) | XRPL handlers |

A wallet on the **window** carrier MUST also:

| # | Requirement | Kit |
|---|---|---|
| W10 | Not send `COOP: same-origin` on the wallet page (7.6) | docs only |
| W11 | Post `byow_ready` on load | yes |
| W12 | Accept requests only from its opener or the opener's ancestors; lock to the first origin; ignore all other origins silently (7.4) | yes |
| W13 | Address every reply to the locked origin; never `"*"` except `byow_ready` | yes |
| W14 | Allow one UI request per document (7.5); close itself after a rejection (~300 ms) and after a linger on success | yes |

A wallet on the **link** carrier MUST also:

| # | Requirement | Kit |
|---|---|---|
| W15 | Refuse a link past its expiry, and one whose version it does not speak (8.1, 8.6) | yes |
| W16 | Refuse a link whose return URL is on another origin than the page that sent the user (8.5) | yes |
| W17 | Remove a link from its address bar and history before handling it | yes |

A wallet on the **page** carrier MUST also:

| # | Requirement | Kit |
|---|---|---|
| W18 | Announce a frozen `detail`, and claim no global | yes |
| W19 | Run its handlers outside the page's world, and read the origin there (section 9) | docs only |

A wallet's key custody (passkey-derived, hardware, enclave, imported seed) is out of scope. The reference kit
takes a `signer` whose only job is to sign a transaction.

## 12. Site requirements

A site MUST (and its SDK SHOULD make these automatic):

| # | Requirement | SDK |
|---|---|---|
| S1 | Send nothing a registered profile has not validated, and use no result one has not parsed | yes |
| S2 | Parse every wallet message strictly; sanitise every wallet string; render wallet strings as text | yes |
| S3 | Verify sign-in proofs against the origin and nonce **it** holds, server-side for anything that grants a session (14) | `verifySignIn` |
| S4 | Check a signed transaction against what it asked for (5.3), and treat the ledger, not the wallet, as the truth for payments (14) | `checkSignedTx`, `checkSignedPayment` |
| S5 | Report only a real user refusal as a user "no" (3) | yes |
| S6 | Show a wallet's origin as its identity and its `name` as a labelled claim, smaller | docs; SDK returns both |
| S7 | Ship no built-in list of wallets (1.1) | yes |
| S8 | Treat `?byow_wallet=` as prefill only (10) | yes |
| S9 | Store only a URL and a claimed name for remembered wallets, on the site's own origin; drop tampered entries | yes |

On the **window** carrier, also:

| # | Requirement | SDK |
|---|---|---|
| S10 | Validate the wallet URL (7.1) | yes |
| S11 | Open the wallet synchronously in a click; prefetch nonces and invoices | docs; SDK opens sync |
| S12 | Isolate the opener and report the level (7.2); optionally require `contained` | yes |
| S13 | Pin the wallet origin from `byow_ready`; refuse a redirect by default (7.4) | yes |
| S14 | Not send `COOP: same-origin` on pages that open wallets | docs |
| S15 | Close the wallet window when it gives up on a request (7.7) | yes |

On the **link** carrier, also:

| # | Requirement | SDK |
|---|---|---|
| S16 | Use a fresh id, key and mailbox channel for every request, and set an expiry | yes |
| S17 | Accept an answer only if it answers the request that was sent (8.5) | yes |
| S18 | Know that sign-in over a link can be relayed (8.7), and ask for more where it matters | `WalletInfo.carrier` |

---

## 13. Text hygiene

Everything a wallet sends is displayed by someone else's page. A site and a wallet MUST strip, from any
foreign string before displaying it, and MUST cap its length: Unicode categories Cc, Cf (zero-width, bidi
embeddings and isolates, soft hyphen, BOM, tag characters), Co, Cs, Cn, Zl and Zp; every space other than
U+0020 (including NBSP and U+2000-200A); and the characters Unicode files under letters or symbols but that
render blank or invisible: U+034F, U+115F, U+1160, U+17B4, U+17B5, U+180B-180F, U+2800, U+3164,
U+FE00-FE0F, U+FFA0, U+FFFC and U+E0100-E01EF **[review: the first draft's block-list missed these, so a
name of `U+3164 U+3164` displayed as a blank wallet]**. After stripping, an empty name is rejected. IDN hosts
are displayed in the `URL.origin` form (punycode), so a Cyrillic look-alike origin looks different.

---

## 14. What the server does **[built]**

This is the entire server-side obligation of a site that accepts strangers' wallets. It involves no wallet
names and no list.

**Login**

1. Before the click, `POST /challenge` returns a random nonce (>= 128 bits, `[A-Za-z0-9_-]`), stored with a
   short expiry.
2. The client calls `xrpl_connect({ chain, challenge })`, then posts `{ proof, challenge }` to `/login`.
3. The server deletes the nonce (single use, even on failure) and checks
   `verifySignIn(proof, { origin: <the origin you serve>, chain, challenge })`. The origin and the nonce are
   the server's own values, never the request's. A site served on several origins (an apex and its `www`)
   passes the list of its own: a proof for any of them is a proof for this site.
4. If the account matters (it holds value, or grants access), the server looks the account up on a
   validated ledger and checks `keyMayActForAccount(address, publicKey, accountRoot)`, with `null` only
   when the ledger answered that the account does not exist (5.2).
5. Success sets the session for the address in the proof. The wallet's name, icon and claims played no part.

A site whose requests travel through a mailbox on another host expects that mailbox's origin in the proof
(8.6).

**Payment**

1. The server issues an invoice (destination, amount, tag) and returns the transaction fields.
2. The client calls `xrpl_signTransaction` and posts `tx_blob`.
3. The server runs `checkSignedPayment(tx_blob, { account, destination, amount, destinationTag, ... })`: the
   signature verifies, the payment is from the logged-in account, and it is exactly the invoice (no
   `Paths`/`SendMax`/`DeliverMin`, no `tfPartialPayment`, a `LastLedgerSequence` present, a usable `Fee`
   under a cap, and the blob in **canonical form**, so the hash is the one the ledger will use **[review]**).
   Hex currency codes are compared case-insensitively; 3-character codes are not.
4. The server **submits the blob itself** (it is harmless if the wallet already did) and treats the
   validated ledger as truth. An invoice MUST be single-use and bound to the transaction (by `DestinationTag`
   or `InvoiceID`): the same signed blob would otherwise satisfy any invoice that expects no tag **[review]**.

A wallet that lies about what it signed fails step 3. A wallet that signed with a key that may not act for
the account produces a transaction the ledger refuses.

Source tags: a site that stamps a source tag on user-signed transactions includes `SourceTag` in the
request. A wallet does not add one of its own (5.3).

---

## 15. Conformance **[built for the window carrier]**

`byow-check <wallet-url>` runs a wallet in a real browser (Chromium, WebKit or Firefox) against a
raw-protocol harness that does not use this repo's site SDK, and prints a pass/fail report, optionally as
JSON.

| Level | Needs | Checks |
|---|---|---|
| **L0** handshake and messages | nothing | `byow_ready`; valid `byow_info`; **offers `xrpl_connect` and a chain** (a wallet without it fails L0 instead of silently skipping L1); unknown method; malformed with id; request with no id is ignored; positional-array params refused; 300 KB message not processed; non-JSON-RPC junk ignored. After each, the wallet must still answer. |
| **L1** safety before any UI | nothing | clean manifest text; **origin lock** (a second origin loaded into the very iframe that opened the wallet gets no reply); unsupported chain and bad params refused before UI; a valid `xrpl_connect` is **not** auto-approved; **a valid `xrpl_signTransaction` is not signed without the user**; second UI request gets `busy`; a transaction that sets `TxnSignature` refused; a transaction carrying a sign-in memo refused |
| **L2** interactive | `--approve <css>` and `--reject <css>` | reject yields `user_rejected`; approve returns an address and a sign-in proof that verifies for the harness origin and challenge |

Exit code is 1 if any L0 or L1 check fails. A report is **advisory**: a wallet can serve a report it does not
deserve. A site that wants assurance runs the checker itself or keeps an allow-list.

**Not yet checked:** the link and page carriers. **Not machine-checkable:** that the approval screen tells
the truth, how keys are stored, whether replies avoid `"*"` (the harness cannot observe a leak it is not the
recipient of), whether error text leaks, and whether a wallet fills only what it may. Those need review. The
wallet kit exists to make them the default instead of an audit item.

Reference results: the toy wallet passes every check on Chromium, WebKit and Firefox. A deliberately naive
wallet (replies to `event.source` with `"*"`, no origin lock, auto-approves, trusts params) fails.

---

## 16. Threat model

| Threat | Answer |
|---|---|
| Wallet lies about its address | Sign-in proof verified against the site's own origin and nonce (14) |
| Wallet claims it paid | The site treats only the validated ledger as truth (14) |
| Wallet signs something other than what was asked | `checkSignedTx`: every field unchanged, nothing added (5.3) |
| Wallet signs for a different account | `checkSignedTx` / `checkSignedPayment` check `Account`; the ledger refuses a key that may not act for it |
| Wallet adds its own tag or memo to the user's transaction | Only the listed fields may be filled (5.3); anything else fails the check |
| Wallet impersonates a famous one by name or icon | Identity is the origin; name is a labelled claim, smaller; icon restricted to small data-URI images |
| Malicious wallet script-injects the site | Everything parsed strictly; strings sanitised; rendered as text; strict CSP |
| **Hostile wallet URL steers the site's tab** (`opener.location`) | Isolating iframe (7.2). Contained in Chromium and WebKit; **not in Firefox**, where the link carrier (8.5) has no opener at all |
| Wallet redirects to a look-alike origin | `origin_mismatch` by default (7.4) |
| Look-alike (IDN) origin | Origin shown as punycode |
| Credentials in the URL | `https://a@b/` refused (7.1) |
| Sign-in proof replayed across sites or time | The wallet writes the origin; the site's nonce is single use; the proof ages out |
| Site asks a wallet to sign a sign-in statement for another origin | `xrpl_signTransaction` refuses a sign-in memo (5.2) |
| Sign-in proof submitted as a transaction | It cannot apply: three independent locks (Appendix B) |
| Site abuses the wallet | Per-request user approval, the asker always shown, no standing permission |
| Site sets an absurd fee | A wallet may refuse any field; the reference kit refuses a site-set fee and caps any fee |
| A second origin hijacks an open wallet window | Wallet origin-lock (7.4); tested by `origin-lock` |
| A page sends users to a wallet to sign for another origin | Referrer rule (8.5) |
| **A phishing page relays a real site's QR** | Not solved, by anyone (8.7). The carrier is reported so the site can require more |
| Mailbox reads or alters a request | Sealed with a key the mailbox never sees (8.4) |
| Mailbox hands the request back as the answer | Boxes are bound to their direction (8.4) |
| Someone links to the site's return page with a forged answer | Accepted only for the request id the site sent, then verified by signature (8.5) |
| A request is approved after the site gave up | The site closes the wallet window (7.7); a link carries an expiry (8.6) |
| Popup spam | One UI request per document; browsers rate-limit popups without a gesture |
| Blind signing by a careless wallet | Kit default: render it or refuse it. Remaining risk: wallets that write their own handlers |
| A page rewrites an extension wallet's code | Handlers run outside the page's world (section 9) |
| Sybil accounts | Wallets are free. Not new, and not solved here |

---

## 17. Versioning

`byow` versions are `"major.minor"`. In 0.x any minor may break. A wallet states the versions it speaks in
`byow_ready`, in `byow:announce` and in its manifest, and the site picks the highest in common. A link
states its version in `v`. Unknown params and unknown link parameters MUST be ignored; a transaction is
never "partly understood": it is signed as sent or refused. New methods and chain families do not change the
version (1.1, rule 9). Experimental methods SHOULD be prefixed `x_`.

At 1.0 the wire freezes: message shapes, error codes, method names, the link grammar, the sign-in
transaction.

## 18. Designed, not built **[sketch]**

- **`inbox`.** A wallet returns an `inbox` URL when it connects. The site posts the next request link there
  and the wallet notifies its user through its own service. A wallet with no backend omits it and the user
  scans again. This is what lets a phone wallet keep push notifications without a central push service.
- **A site endpoint for programs.** A fixed place on the site where an agent asks for a sign-in challenge
  and posts the proof back without rendering a page. The agent talks to the site over TLS, so there is no QR
  to relay: the strongest sign-in in the design.
- **Vouching for an agent.** A person's signed statement that an agent may sign in for them until a date.
  It fits the sign-in transaction's format. Not designed.
- **A bridge to wallets that will not adopt BYOW.** The SDK accepts xrpl-connect's `WalletAdapter` objects
  as wallets, so a site that switches keeps Xaman, Crossmark, GemWallet and Ledger.
- **Multi-signing and Batch co-signing.** Each is a new method (1.1, rule 9), one link per signer.
- **The EVM profile** (5.5).

## 19. Open questions

1. **Real Safari, mobile browsers, in-app browsers.** Playwright's WebKit is not Safari. Nothing here has
   been measured on a phone, and nothing has travelled between two devices.
2. **Does a real Ledger sign the sign-in transaction?** A device may refuse a zero fee or sequence. The
   expiry lock alone is refused by the network (Appendix B), so the template can shed locks if it must.
3. **A universal link on `/.well-known/byow`** (section 10).
4. **Same-tab return.** On a phone the wallet may replace the site's tab instead of opening beside it. The
   return page then has no other tab to hand the answer to and must resume from stored state. Not built.
5. **Checker levels for the link and page carriers** (section 15).
6. **The `xrpl` namespace** is still a draft at Chain Agnostic Namespaces.
7. **The name.** `byow` was unregistered on npm on 2026-11-11. The `byow:` scheme is unchecked.

---

## Appendix A: opener isolation, measured

Script: `experiments/opener/run.mjs` (Playwright 1.62.0, headless, loopback origins on three ports; real
clicks, so real user activation). A site opens an arbitrary-URL "wallet" that runs `opener.location = phish`
and, 300 ms later, `opener.top.location = phish`.

| Engine (version) | A: direct `window.open` | B: from same-origin `about:blank` iframe |
|---|---|---|
| Chromium 151.0.7922.34 | popup opened; **tab navigated to phish** (both attempts succeeded) | popup opened; both attempts `SecurityError`; tab untouched |
| WebKit 26.5 | **navigated** | both `SecurityError`; untouched |
| Firefox 153.0 | **navigated** | `opener.location` `SecurityError`; **`opener.top.location` succeeded: tab navigated** |

Variant B popups opened without being blocked in all three engines, i.e. activation reached the iframe.
Variant C (the iframe is created inside the click handler, then opens the popup) also opened without being
blocked in all three, so a pre-existing iframe is a precaution and not a requirement. The e2e suite re-runs
this as a control (isolation off: the hijack must succeed, so the test is not vacuous) and as the property
(isolation on: it must not, skipped on Firefox where it is a known gap).

**Variant D, measured 2026-11-11** (`test/e2e/byow.e2e.ts`, same engines): the wallet is opened by link, in a
new tab with `noopener`, as the link carrier does (8.5). `window.opener` is null in all three engines, and the
same hostile page that hijacks variant A leaves the site's tab untouched, **Firefox included**. Sign-in and
payment through the return URL complete in all three.

Two further results from building the prototype, both fixed in this repo and pinned by tests:

1. A wallet that checks `event.source === window.opener` rejects every request from an isolated site, because
   the site's top-level script sends them. The check must accept the opener's ancestors (7.2).
2. A wallet that replies to `event.source` replies to the top window, but an SDK listening only on the iframe
   never hears it. The SDK listens on both (7.2). `examples/naive-wallet` is exactly this wallet.

## Appendix B: the sign-in transaction, measured

XRPL testnet, 2026-11-11, xrpl.js 5.3.0, a faucet-funded account. An empty `AccountSet` carrying a
`byow/sign-in` memo was signed and submitted in four variants.

| Variant | Signs | Signature verifies | Network's answer | Applied |
|---|---|---|---|---|
| All three locks (the sign-in transaction) | yes | yes | `tefPAST_SEQ` | no |
| Only `Sequence: 0` | yes | yes | `tefPAST_SEQ` | no |
| Only `LastLedgerSequence: 1` | yes | yes | `tefMAX_LEDGER` | no |
| Only `Fee: "0"` | yes | yes | `telINSUF_FEE_P` | no |

The account's sequence was the same before and after. Not measured: mainnet, devnet, and any hardware
wallet.

## Appendix C: XRPLClaw, concretely

XRPLClaw has Google-sign-in users with no wallet who cannot pay. With BYOW the integration is one button:

- *Before the click*: `POST /challenge`, and `POST /invoice` (destination, RLUSD amount, destination tag, the
  registered source tag).
- *Click 1*: `xrpl_connect({ chain: "xrpl:0", challenge })`. The server verifies the proof; the user is now
  bound to an XRPL account with no password and no wallet-specific code.
- *Click 2*: `xrpl_signTransaction` with the invoice's `Payment`. The server runs `checkSignedPayment`,
  submits, and its existing watcher confirms on-ledger, which stays the source of truth.

Nothing in that list mentions a wallet. A website wallet, a phone wallet scanning a QR, an extension, a
hardware-wallet page, or a wallet someone vibe-coded last night would all work.
`examples/demo-dapp` is this flow running against `examples/toy-wallet`.

## Appendix D: test vectors

For checking an implementation in another language byte for byte. `test/vectors.test.ts` keeps these true.

**The sign-in transaction.** Statement: origin `https://site.example`, chain `xrpl:1`, challenge
`nonce_0123456789abcdef`, `iat` `1731326400`. The JSON statement is serialized with its keys in that order
and no whitespace. Both seeds are published examples and hold nothing.

| | ed25519 | secp256k1 |
|---|---|---|
| Seed | `sEdTM1uX8pu2do5XvTnutH6HsouMaM2` | `snoPBrXtMeMyMHUVTgbuqAfg1SUTb` |
| Address | `rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL` | `rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh` |
| Public key | `EDA57EBBCB502C2009EFE17229E8DC865DCCB192C52D7888D624DC9EBADDB815F0` | `0330E7FC9D56BB25D6893BA3F317AE5BCF33B3291BD63DB32654A313222F7FD020` |

Signed blob, ed25519:

```
1200032400000000201B000000016840000000000000007321EDA57EBBCB502C2009EFE17229E8DC865DCCB192C52D7888D624DC9EBADDB815F0744082F9524BE35BCB5A0A51B6B3B9480112A04859BB2E1BA6A7171D95F317D9E05A96FE50DBE558878D70DD0CE90E980704AEAC236EA140D6EA80604FACC812F9098114A6070B8A1822E3322676A99F0C804EE2D15B8270F9EA7C0C62796F772F7369676E2D696E7D687B226F726967696E223A2268747470733A2F2F736974652E6578616D706C65222C22636861696E223A227872706C3A31222C226368616C6C656E6765223A226E6F6E63655F30313233343536373839616263646566222C22696174223A313733313332363430307DE1F1
```

Signed blob, secp256k1:

```
1200032400000000201B0000000168400000000000000073210330E7FC9D56BB25D6893BA3F317AE5BCF33B3291BD63DB32654A313222F7FD02074473045022100F7F7023D1D48A0DEC6B210DFBCF7B3BA47870DFC8F481064727CD13C3784C31702205A10648C254A61FF1E6E9ED49E500718C961F1C251D991CCBB727392845FEB028114B5F762798A53D543A014CAF8B297CFF8F2F937E8F9EA7C0C62796F772F7369676E2D696E7D687B226F726967696E223A2268747470733A2F2F736974652E6578616D706C65222C22636861696E223A227872706C3A31222C226368616C6C656E6765223A226E6F6E63655F30313233343536373839616263646566222C22696174223A313733313332363430307DE1F1
```

A verifier does not need the statement's key order: it parses the bytes that were signed.

**A sealed box** (8.4). Key: the 32 bytes `00` to `1f`. Nonce: the 12 bytes `a0` to `ab`. Direction:
`request`, so the additional data is the ASCII text `byow/request`. Message, serialized exactly as shown:

```
{"jsonrpc":"2.0","id":"vector","method":"byow_info","params":{}}
```

Box:

```
oKGio6SlpqeoqaqrnToWXiqlcM8BR73xNVTw_FyOMHSwjWAa-W1S6Q2JWSO_EzOXwEZxB33-fad-JeqXIXRkZECgewwgM3h8ngv4zfpSLPsUImuMhp4vpPu_5cI
```
