// Reference signer and network adapter built on xrpl.js. Optional peer dependency: `xrpl`.
// seedSigner keeps a family seed in memory and is for demos and tests. A real wallet decides its own
// key story (passkey-derived, hardware, secure enclave) and implements XrplSigner itself.

import { Client, Wallet, type SubmittableTransaction } from "xrpl";
import { ByowError } from "../protocol.js";
import type { FillFields, XrplNetwork, XrplSigner } from "./wallet.js";

export function seedSigner(seed: string, chains: string[] = ["xrpl:1"]): XrplSigner {
  const w = Wallet.fromSeed(seed);
  return {
    chains,
    getAccount: async () => ({ address: w.classicAddress, publicKey: w.publicKey }),
    // Signs exactly what it is given, the sign-in transaction (Sequence 0, Fee "0") included.
    signTx: async (tx) => {
      const s = w.sign(tx as unknown as SubmittableTransaction);
      return { tx_blob: s.tx_blob, hash: s.hash };
    },
  };
}

export const DEFAULT_SERVERS: Record<string, string> = {
  "xrpl:0": "wss://xrplcluster.com",
  "xrpl:1": "wss://s.altnet.rippletest.net:51233",
  "xrpl:2": "wss://s.devnet.rippletest.net:51233",
};

/** xrpl.js-backed network. LastLedgerSequence gets a generous window (the kit caps it at 1000) because a human approves in between. */
export function xrplJsNetwork(servers: Record<string, string> = DEFAULT_SERVERS, lastLedgerWindow = 200): XrplNetwork {
  const connect = async (chain: string) => {
    const url = servers[chain];
    if (!url) throw new ByowError("unsupported_chain", `No server configured for ${chain}.`);
    const c = new Client(url);
    await c.connect();
    return c;
  };
  return {
    async fill(chain, address): Promise<FillFields> {
      const c = await connect(chain);
      try {
        const [info, fee] = await Promise.all([c.request({ command: "account_info", account: address, ledger_index: "current" }), c.request({ command: "fee" })]);
        return {
          Fee: fee.result.drops.open_ledger_fee,
          Sequence: info.result.account_data.Sequence,
          LastLedgerSequence: fee.result.ledger_current_index + lastLedgerWindow,
          ledgerIndex: fee.result.ledger_current_index,
        };
      } finally {
        await c.disconnect();
      }
    },
    // One submit, no waiting for validation: the site reads the ledger for the outcome.
    async submit(chain, blob) {
      const c = await connect(chain);
      try {
        const r = await c.submit(blob);
        const engineResult = r.result.engine_result;
        return { accepted: r.result.accepted ?? /^(tes|ter)/.test(engineResult), engineResult };
      } finally {
        await c.disconnect();
      }
    },
  };
}
