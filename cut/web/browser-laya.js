// Laya in the browser: the same model and question as the Python server, run with ONNX Runtime Web
// (WebGPU for the encoder). Used when the page is served statically, with no /api to call.
import { Agent, QTYPES, toInternal } from "./vendor/laya/agent.js";
import { buildQuestionPrefix, collateItems, sequenceWithState, serializeState, softmax, tempBucket } from "./vendor/laya/common.js";
import { setFetchProgress } from "./vendor/laya/providers.js";

// 8-bit weights, half-precision embeddings; conversion steps are in scripts/shrink_browser_model.py.
const DEFAULT_MODEL = "https://huggingface.co/harshpreet931/cut-laya-onnx/resolve/main";
export const MODEL_BYTES = 533_506_262;
// ?model=<url or path> points at another copy of the files (e.g. a local folder while developing).
// Absolute, because laya-ts reads anything that isn't a URL as a Hugging Face repo id.
export const MODEL_URL = new URL(new URLSearchParams(location.search).get("model") || DEFAULT_MODEL, location.href).href.replace(/\/+$/, "");

const CACHE = "laya-ts";

export const canRun = () => "gpu" in navigator;

// True when an earlier visit already stored the model, so loading needs no download.
export async function isCached() {
  try {
    const cache = await caches.open(CACHE);
    return Boolean(await cache.match(`${MODEL_URL}/encoder.onnx`));
  } catch {
    return false;
  }
}

let loading = null;

// onProgress(fraction) while downloading. Resolves to an Agent; repeated calls share one load.
export function loadLaya(onProgress = () => {}) {
  if (loading) return loading;
  const done = new Map();
  setFetchProgress((url, got) => {
    done.set(url, got);
    const sum = [...done.values()].reduce((a, b) => a + b, 0);
    onProgress(Math.min(1, sum / MODEL_BYTES));
  });
  loading = Agent.load(MODEL_URL).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

// Every line in one encoder pass and one head pass (laya-ts on its own runs them one at a time).
// Returns one { news, story, bait, brag, filler } per line, the shape the server returns.
export async function judgeLines(agent, question, post, lines) {
  const q = toInternal(question);
  const qtype = QTYPES[q.t];
  const prefix = buildQuestionPrefix(agent.tok, q, agent.maxLen, agent.headMaxLen);
  const items = lines.map((line) => {
    const state = `POST:\n${post}\n\nSENTENCE: ${line}`;
    const ids = agent.tok.encode(serializeState(state).split(agent.tok.maskToken).join(" "));
    const { ids: seq, markers } = sequenceWithState(prefix, ids, agent.tok.sepId, agent.maxLen, false);
    return { ids: seq, markers, qtype };
  });
  const batch = collateItems([items], agent.tok.padId);
  const { lastHidden } = await agent.provider.runEncoder(batch);
  const { logits } = await agent.provider.runHead(lastHidden, batch);
  const keys = Object.keys(q.crit);
  return items.map((it, r) => {
    const k = it.markers.length;
    const scale = agent.temperatureByOptions[tempBucket(qtype, k)] ?? agent.temperature[qtype] ?? 1;
    const p = softmax(logits[r].slice(0, k).map((v) => v / scale));
    return Object.fromEntries(keys.map((key, i) => [key, Math.round(p[i] * 1e4) / 1e4]));
  });
}
