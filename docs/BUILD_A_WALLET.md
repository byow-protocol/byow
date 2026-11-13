# Building a BYOW wallet with an AI agent

Give the agent this file, `SPEC.md`, and `examples/toy-wallet/`. The goal is a wallet that passes `byow-check`,
so the loop below ends on a number and not on the agent's opinion.

## Prompt

> Build a BYOW wallet as a static website. Use `createWalletServer` and `answerLinkInPage` from
> `src/wallet/index.ts` and `xrplHandlers` from `src/xrpl/wallet.ts`, exactly as `examples/toy-wallet` does.
> You write three things: a `signer` (where the key lives and how it unlocks; its only job is to sign a
> transaction), a `network`, and a `review` object (the approve screen). Do not write your own message
> handling: the kit owns it.
>
> Hard rules:
> 1. On every approve screen, show `origin` verbatim and large, above everything else. When `origin` is
>    null, say "Unknown site". When `originProof` is `"delivery"`, say the answer will be sent there.
> 2. Put every string you display in the DOM with `textContent`. Never `innerHTML`.
> 3. Serve with `Cross-Origin-Opener-Policy: unsafe-none` (never `same-origin`), a CSP of
>    `script-src 'self'; frame-ancestors 'none'; base-uri 'none'`, and `Referrer-Policy: no-referrer`.
> 4. Never log, send or store the seed anywhere except the key store you were told to use. Never ask a
>    user to paste a seed into a page that a site opened.
> 5. Sign what the site sent or refuse it. Never change a field to something you like better, and never add
>    a tag or a memo of your own.
> 6. Do not add transaction types the review screen cannot fully describe. If you add one, pass a `describe`
>    function and list the type in `transactions`.
>
> Then run `npm run check -- <your wallet URL> --approve <approve button selector> --reject <reject button selector>`
> and fix everything that fails. Report the final pass count. Do not edit `byow-check` to make it pass.

## The loop

```bash
npm run check -- "http://localhost:5174/" --approve '#approve' --reject '#reject'
```

Three levels. Exit code 0 means L0 and L1 pass. Run it with `--browser webkit` and `--browser firefox` too:
popup behaviour differs, and Safari is the strictest.

## Other kinds of wallet

The checker covers a wallet that is a website. The same core serves the other two carriers, and those are not
checked by a tool yet (SPEC 15):

- **A phone or desktop app, a script, an agent**: build the core with `createWalletCore` and call
  `answerLink(core, link)` with whatever the user scanned, tapped or pasted. It needs `fetch` and WebCrypto.
- **A browser extension**: call `announceWallet(core, { request, origin })` from the script injected into the
  page, with `request` relaying to the extension's own world. Do not run the core in the page's world: the
  page controls it (SPEC 9).

## What a passing report does not tell you

It does not tell you the approve screen is honest, that keys are stored well, or that replies avoid `"*"`. Read
SPEC section 15. For a wallet that will hold real money, a person reads the review screen code and the key code.
The kit exists so that is a short read.
