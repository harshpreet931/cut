// Holds Laya for the whole extension. Requests queue up because ONNX Runtime sessions don't take
// overlapping runs. The listener is registered before anything is awaited, so the first message
// from the background can't arrive while nobody is listening.
globalThis.LAYA_ORT_URL = chrome.runtime.getURL("ort/ort.webgpu.bundle.min.mjs");

// Chrome lists anything an extension logs as an error on chrome://extensions. This checkpoint's known,
// harmless calibration warning (cut ranks by probability) would otherwise sit there looking like a bug.
const warn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).startsWith("laya: this checkpoint ships invalid temperatures")) return;
  warn(...args);
};
const layaReady = import("./lib/browser-laya.js");

let agent = null;
let loading = null;
let error = null;
let queue = Promise.resolve();

function load() {
  loading ??= (async () => {
    const laya = await layaReady;
    const question = await (await fetch("lib/question.json")).json();
    agent = await laya.loadLaya((f) => chrome.runtime.sendMessage({ type: "progress", f }).catch(() => {}));
    error = null;
    return { laya, question };
  })().catch((e) => {
    error = String(e?.message ?? e);
    loading = null;
    throw e;
  });
  return loading;
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "status") {
    send({ loaded: Boolean(agent), loading: Boolean(loading) && !agent, error, webgpu: "gpu" in navigator });
    return;
  }
  if (msg.type === "load") {
    load().then(
      () => send({ ok: true }),
      (e) => send({ error: String(e?.message ?? e) }),
    );
    return true;
  }
  if (msg.type === "judge") {
    queue = queue.then(async () => {
      try {
        const { laya, question } = await load();
        const t = performance.now();
        const probs = await laya.judgeLines(agent, question, msg.post, msg.lines);
        send({ probs, ms: Math.round(performance.now() - t) });
      } catch (e) {
        send({ error: String(e?.message ?? e) });
      }
    });
    return true;
  }
});
