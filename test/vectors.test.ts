// The test vectors printed in SPEC Appendix D. They are there so an implementation in another language can
// check itself byte for byte; this file is what keeps the spec's copies true. If one of these fails, the wire
// changed: that is a decision, not a fix.

import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { open, seal } from "../src/link.js";
import { signInTransaction } from "../src/xrpl/profile.js";
import { verifySignIn } from "../src/xrpl/verify.js";

const STATEMENT = { origin: "https://site.example", chain: "xrpl:1", challenge: "nonce_0123456789abcdef", iat: 1731326400 };

// Both seeds are published examples (the XRPL docs' ed25519 seed, and the genesis passphrase's secp256k1 seed).
const SIGN_IN = [
  {
    key: "ed25519",
    seed: "sEdTM1uX8pu2do5XvTnutH6HsouMaM2",
    address: "rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL",
    publicKey: "EDA57EBBCB502C2009EFE17229E8DC865DCCB192C52D7888D624DC9EBADDB815F0",
    tx_blob:
      "1200032400000000201B000000016840000000000000007321EDA57EBBCB502C2009EFE17229E8DC865DCCB192C52D7888D624DC9EBADDB815F0744082F9524BE35BCB5A0A51B6B3B9480112A04859BB2E1BA6A7171D95F317D9E05A96FE50DBE558878D70DD0CE90E980704AEAC236EA140D6EA80604FACC812F9098114A6070B8A1822E3322676A99F0C804EE2D15B8270F9EA7C0C62796F772F7369676E2D696E7D687B226F726967696E223A2268747470733A2F2F736974652E6578616D706C65222C22636861696E223A227872706C3A31222C226368616C6C656E6765223A226E6F6E63655F30313233343536373839616263646566222C22696174223A313733313332363430307DE1F1",
  },
  {
    key: "secp256k1",
    seed: "snoPBrXtMeMyMHUVTgbuqAfg1SUTb",
    address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    publicKey: "0330E7FC9D56BB25D6893BA3F317AE5BCF33B3291BD63DB32654A313222F7FD020",
    tx_blob:
      "1200032400000000201B0000000168400000000000000073210330E7FC9D56BB25D6893BA3F317AE5BCF33B3291BD63DB32654A313222F7FD02074473045022100F7F7023D1D48A0DEC6B210DFBCF7B3BA47870DFC8F481064727CD13C3784C31702205A10648C254A61FF1E6E9ED49E500718C961F1C251D991CCBB727392845FEB028114B5F762798A53D543A014CAF8B297CFF8F2F937E8F9EA7C0C62796F772F7369676E2D696E7D687B226F726967696E223A2268747470733A2F2F736974652E6578616D706C65222C22636861696E223A227872706C3A31222C226368616C6C656E6765223A226E6F6E63655F30313233343536373839616263646566222C22696174223A313733313332363430307DE1F1",
  },
];

describe("SPEC Appendix D: the sign-in transaction", () => {
  for (const v of SIGN_IN) {
    it(`${v.key}: the statement signs to the published blob, and the blob verifies`, () => {
      const w = Wallet.fromSeed(v.seed);
      expect([w.classicAddress, w.publicKey]).toEqual([v.address, v.publicKey]);
      expect(w.sign(signInTransaction({ address: v.address, publicKey: v.publicKey }, STATEMENT) as never).tx_blob).toBe(v.tx_blob);
      const at = (STATEMENT.iat + 5) * 1000;
      expect(verifySignIn(v.tx_blob, { origin: STATEMENT.origin, chain: STATEMENT.chain, challenge: STATEMENT.challenge, now: at })).toEqual({ ok: true, address: v.address, publicKey: v.publicKey, masterKey: true, iat: STATEMENT.iat });
    });
  }
});

describe("SPEC Appendix D: a sealed box", () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i); // 00 01 .. 1f
  const nonce = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i); // a0 a1 .. ab
  const message = { jsonrpc: "2.0", id: "vector", method: "byow_info", params: {} };
  const box = "oKGio6SlpqeoqaqrnToWXiqlcM8BR73xNVTw_FyOMHSwjWAa-W1S6Q2JWSO_EzOXwEZxB33-fad-JeqXIXRkZECgewwgM3h8ngv4zfpSLPsUImuMhp4vpPu_5cI";

  it("a request seals to the published box, and the box opens", async () => {
    expect(await seal(key, "request", message, nonce)).toBe(box);
    expect(await open(key, "request", box)).toEqual(message);
    expect(await open(key, "response", box)).toBeUndefined(); // bound to its direction
  });
});
