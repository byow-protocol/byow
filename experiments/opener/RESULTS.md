# Opener isolation, measured 2026-10-02

`node run.mjs [chromium|webkit|firefox]` (Playwright 1.62.0, headless, three loopback origins, real clicks).

A dapp opens an arbitrary-URL "wallet". The wallet runs `opener.location = phish`, then 300 ms later
`opener.top.location = phish`. We record whether the dapp's tab ended up on the phishing page.

- **A**: dapp calls `window.open` directly.
- **B**: dapp calls `window.open` from a hidden same-origin `about:blank` iframe that already existed at click time.
- **C**: as B, but the iframe is created inside the click handler.

| Engine | A | B | C |
|---|---|---|---|
| Chromium 151.0.7922.34 | popup opened, **tab hijacked** | opened, both attempts `SecurityError`, tab untouched | same as B |
| WebKit 26.5 | **hijacked** | contained | same as B |
| Firefox 153.0 | **hijacked** | `opener.location` blocked, **`opener.top.location` succeeded: hijacked** | same as B (hijacked) |

Conclusions:

1. A popup opened to a user-supplied URL can replace the site's tab in every engine. This is a hazard Clasp never
   faced, because its wallet URL is a constant.
2. Opening from a same-origin iframe contains it in Chromium and WebKit. It does not in Firefox.
3. The iframe does not need to exist before the click in any of the three engines.
4. Firefox needs a transport with no opener (SPEC section 14).

Not measured: real Safari on iOS or macOS (Playwright's WebKit is not Safari), Firefox on Android, in-app
browsers, headed mode.
