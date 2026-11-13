// BYOW wallet kit. The protocol half of a wallet, so whoever (or whatever) writes the wallet only writes the
// interesting half: the signer and the review screen. One core, and a thin carrier for each way a request
// can arrive: a popup (window), the site's own page (page), a link (link).

export { ByowError } from "../protocol.js";
export { createWalletCore, type Asker, type CarrierKind, type Handler, type HandlerContext, type OriginProof, type Outcome, type WalletCore, type WalletCoreOptions, type WalletInfoInput } from "./core.js";
export { createWalletServer, type ServerStatus, type WalletServer, type WalletServerOptions } from "./window.js";
export { announceWallet, type AnnounceOptions, type Announcement } from "./page.js";
export { answerLink, answerLinkInPage, type AnswerLinkOptions, type LinkAnswer } from "./link.js";
