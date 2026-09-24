// Routes work between the tabs and Laya. The model lives in one offscreen document (a hidden
// extension page with WebGPU), shared by every tab and closed again after ten idle minutes.
import { isCached } from "./lib/browser-laya.js";

const OFFSCREEN = "offscreen.html";
const IDLE_MINUTES = 10;
let creating = null;
let lastProgress = null;

async function hasOffscreen() {
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: ["WORKERS"],
      justification: "Runs the Laya model with ONNX Runtime on WebGPU to read posts.",
    })
    .finally(() => (creating = null));
  await creating;
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ ...msg, target: "offscreen" });

async function status() {
  const loaded = (await hasOffscreen()) ? await toOffscreen({ type: "status" }).catch(() => null) : null;
  return {
    cached: await isCached(),
    loaded: Boolean(loaded?.loaded),
    loading: Boolean(loaded?.loading),
    webgpu: loaded?.webgpu,
    error: loaded?.error ?? null,
    progress: lastProgress,
  };
}

function touch() {
  chrome.alarms.create("idle-close", { delayInMinutes: IDLE_MINUTES });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "idle-close" && (await hasOffscreen())) await chrome.offscreen.closeDocument();
});

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === "progress") {
    lastProgress = msg.f;
    return;
  }
  if (msg.target !== "background") return;
  (async () => {
    switch (msg.type) {
      case "status":
        return send(await status());
      case "load": {
        await ensureOffscreen();
        touch();
        const res = await toOffscreen({ type: "load" });
        if (res?.ok) await chrome.storage.local.set({ modelReady: true });
        return send(res);
      }
      case "judge": {
        // Never start the 534 MB download from a page; that only happens from the popup.
        if (!(await hasOffscreen()) && !(await isCached())) return send({ error: "not-downloaded" });
        await ensureOffscreen();
        touch();
        return send(await toOffscreen({ type: "judge", post: msg.post, lines: msg.lines }));
      }
      case "stat": {
        const { stats = { posts: 0, words: 0 } } = await chrome.storage.local.get("stats");
        stats.posts += 1;
        stats.words += msg.words;
        await chrome.storage.local.set({ stats });
        return send({ ok: true });
      }
    }
  })().catch((e) => send({ error: String(e?.message ?? e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: "popup.html?welcome=1" });
});
