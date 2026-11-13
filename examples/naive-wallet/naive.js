window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || !m.method) return;
  const reply = (r) => e.source.postMessage({ jsonrpc: "2.0", id: m.id, ...r }, "*");
  const p = m.params || {};
  if (m.method === "byow_info")
    return reply({ result: { name: "Naive", chains: ["xrpl:1"], methods: ["byow_info", "xrpl_connect", "xrpl_signTransaction"], versions: ["0.2"] } });
  if (m.method === "xrpl_connect")
    return reply({ result: { address: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", publicKey: "ED" + "00".repeat(32), chain: p.chain } });
  if (m.method === "xrpl_signTransaction") return reply({ result: { tx_blob: "12", hash: "00".repeat(32), submitted: false } });
  reply({ error: { code: -1, message: "unknown method " + m.method } });
});
opener.postMessage({ jsonrpc: "2.0", method: "byow_ready", params: { versions: ["0.2"] } }, "*");
