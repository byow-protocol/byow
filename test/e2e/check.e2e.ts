// byow-check must be able to FAIL. These tests run it against a good wallet on every engine and against
// a deliberately naive one, and pin exactly which checks the naive wallet is caught on.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildExamples, freePort, killServers, root, spawnServer } from "./harness.js";

let toy = "";
let naive = "";

beforeAll(async () => {
  buildExamples();
  const [a, b] = [await freePort(), await freePort()];
  toy = `http://localhost:${a}/?mock=1`;
  naive = `http://localhost:${b}/`;
  await spawnServer(["examples/static-server.mjs", "examples/toy-wallet", String(a)], `http://localhost:${a}/`);
  await spawnServer(["examples/static-server.mjs", "examples/naive-wallet", String(b)], naive);
});
afterAll(killServers);

function run(url: string, extra: string[]): { code: number | null; results: { id: string; status: string; level: number }[] } {
  const out = path.join(os.tmpdir(), `byow-check-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(process.execPath, [path.join(root, "check/cli.mjs"), url, "--json", out, ...extra], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const results = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")).results : [];
  return { code: r.status, results };
}

describe("byow-check", () => {
  for (const engine of ["chromium", "webkit", "firefox"]) {
    it(`passes the toy wallet at L0, L1 and L2 on ${engine}`, () => {
      const { code, results } = run(toy, ["--approve", "#approve", "--reject", "#reject", "--browser", engine]);
      expect(results.filter((r) => r.status !== "pass").map((r) => `${r.id}:${r.status}`)).toEqual([]);
      expect(results.length).toBeGreaterThanOrEqual(21);
      expect(code).toBe(0);
    });
  }

  it("fails a naive wallet on the checks that protect users", () => {
    const { code, results } = run(naive, []);
    const failed = new Set(results.filter((r) => r.status === "fail").map((r) => r.id));
    const mustFail = [
      "origin-lock", "no-auto-approve", "one-ui-request-per-document", "unsupported-chain-before-ui", "bad-params-before-ui", "chain-outside-manifest",
      "unknown-method", "malformed-with-id", "malformed-no-id", "positional-params", "oversize", "ignores-non-byow",
      "no-auto-sign", "signature-field-refused", "sign-in-memo-refused",
    ];
    for (const id of mustFail) {
      expect(failed, id).toContain(id);
    }
    expect(code).toBe(1);
  });
});
