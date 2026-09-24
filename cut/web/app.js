import { makePlan, guessProbs } from "./plan.js";
import * as pen from "./pencil.js";
import * as browserLaya from "./browser-laya.js";

const REPO_URL = "https://github.com/harshpreet931/cut";
const JUDGE_DELAY = 550; // ms of quiet typing before Laya re-reads the post

const $ = (s) => document.querySelector(s);
const input = $("#input"), mirror = $("#mirror"), page = $("#page");
const ink = $("#ink"), overlay = $("#overlay");
const cutBtn = $("#cut"), copyBtn = $("#copy"), shareBtn = $("#share"), backBtn = $("#back"), loadBtn = $("#load");
const samplesSel = $("#samples"), statusEl = $("#status"), logEl = $("#log");
const countEl = $("#count"), gradeEl = $("#grade"), colophon = $("#colophon");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const SVG = "http://www.w3.org/2000/svg";
// Narrow margins (phones) show these instead, so a note stays on one line.
const SHORT_LABEL = { "dramatic pause": "pause", humblebrag: "brag" };

const state = {
  mode: "edit", // edit | cutting | done
  server: "unknown", // unknown | loading | ready | error | offline
  browser: "idle", // idle | unsupported | loading | ready | error: Laya in the page, used when there's no server
  agent: null,
  question: null,
  serverError: null,
  device: null,
  byLine: new Map(), // trimmed line -> Laya's role probabilities (kept while re-judging, so marks don't flicker)
  exactPost: null, // the post byLine was judged against
  last: null, // { n, ms, device, source }
  stet: new Map(), // trimmed line -> "keep" | "cut", set by clicking a margin note
  seen: new Set(), // marks already drawn once; they don't animate again
  plan: null,
  samples: [],
  judged: {},
};

const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion.matches ? 0 : ms));
const linesOf = (text) => text.split("\n");
const postOf = (text) => linesOf(text).map((l) => l.trim()).filter(Boolean).join("\n");

// ---------- plan ----------

const canJudge = () => state.server === "ready" || state.browser === "ready";

function currentPlan() {
  const guess = !canJudge() && (state.server === "offline" || state.server === "error");
  const lines = linesOf(input.value);
  const probs = lines.map((l) => {
    const t = l.trim();
    if (!t) return null;
    return state.byLine.get(t) ?? (guess ? guessProbs(t) : null);
  });
  return makePlan(lines, probs, state.stet);
}

// ---------- render ----------

function render() {
  const plan = currentPlan();
  state.plan = plan;
  renderMirror(plan.items.map((it) => it.text));
  const inkDone = drawMarks(plan);
  renderHead(plan, inkDone);
  renderLog(plan);
  cutBtn.disabled = !plan.ready || state.mode !== "edit";
}

function renderMirror(texts) {
  while (mirror.children.length > texts.length) mirror.lastChild.remove();
  texts.forEach((t, i) => {
    let row = mirror.children[i];
    if (!row) row = mirror.appendChild(Object.assign(document.createElement("div"), { className: "row" }));
    const shown = t || "​";
    if (row.textContent !== shown) row.textContent = shown;
  });
}

function renderHead(plan, gradeDelay = 0) {
  if (state.mode === "done") return;
  countEl.textContent = plan.before ? `${plan.before} ${plan.before === 1 ? "word" : "words"}` : "";
  setGrade(plan.grade, { delay: gradeDelay });
}

function setGrade(letter, { animate = true, delay = 0 } = {}) {
  if ((gradeEl.dataset.letter || "") === (letter || "")) return;
  gradeEl.dataset.letter = letter || "";
  gradeEl.replaceChildren();
  if (!letter) return;
  const span = Object.assign(document.createElement("span"), { textContent: letter, className: animate ? "write" : "" });
  span.style.animationDelay = `${delay}ms`;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  const size = gradeEl.clientWidth || 64;
  const path = strokePath(pen.circle(size / 2, size / 2 + 2, size / 2 - 3, size / 2 - 7, pen.rng("grade" + letter)), "mark");
  if (animate) {
    path.classList.add("draw");
    path.style.animationDelay = `${delay + 160}ms`;
    path.style.animationDuration = "520ms";
  }
  svg.append(path);
  gradeEl.append(span, svg);
  gradeEl.setAttribute("aria-label", `Grade ${letter}`);
}

function strokePath(d, cls) {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  p.setAttribute("pathLength", "1");
  p.setAttribute("class", cls);
  return p;
}

// Visual lines covered by characters [start, end) of a row, relative to the page.
function rectsFor(row, start, end) {
  const node = row?.firstChild;
  if (!node || node.nodeType !== 3) return [];
  const range = document.createRange();
  range.setStart(node, Math.min(start, node.length));
  range.setEnd(node, Math.min(end, node.length));
  const base = page.getBoundingClientRect();
  const lines = [];
  for (const r of range.getClientRects()) {
    if (r.width < 0.5) continue;
    const top = r.top - base.top, bottom = r.bottom - base.top, x1 = r.left - base.left, x2 = r.right - base.left;
    const l = lines.find((l) => Math.abs(l.top - top) < 6);
    if (l) Object.assign(l, { x1: Math.min(l.x1, x1), x2: Math.max(l.x2, x2), bottom: Math.max(l.bottom, bottom) });
    else lines.push({ top, bottom, x1, x2 });
  }
  return lines.map((l) => ({ ...l, y: (l.top + l.bottom) / 2 + 1 }));
}

function drawMarks(plan) {
  ink.replaceChildren();
  overlay.replaceChildren();
  const g = document.createElementNS(SVG, "g");
  ink.append(g);
  const rows = mirror.children;
  const lines = plan.items.filter((it) => !it.empty).length;
  const marginX = page.querySelector(".margin").offsetLeft + 6;
  let delay = 0; // strokes, one after another
  let noteDelay = 0; // margin notes, top to bottom

  const add = (key, d, cls = "mark") => {
    const p = strokePath(d, cls);
    if (!state.seen.has(key)) {
      p.classList.add("draw");
      p.style.animationDelay = `${delay}ms`;
      delay += 70;
      state.seen.add(key);
    }
    g.append(p);
    return p;
  };

  for (const it of plan.items) {
    if (it.empty) continue;
    const row = rows[it.i];
    const r = pen.rng(it.key);

    for (const ph of it.phrases) {
      const frs = rectsFor(row, ph.markStart, ph.markEnd);
      if (!frs.length) continue;
      const k = `${ph.kind}|${it.key}|${ph.markStart}`;
      if (ph.cut) {
        frs.forEach((f, n) => add(`${k}|${n}`, pen.strike(f.x1, f.x2, f.y, r)));
        const last = frs[frs.length - 1];
        add(`${k}|tail`, pen.pigtail(last.x2 + 3, last.y, r), "mark soft");
      } else {
        frs.forEach((f, n) => add(`${k}|${n}`, pen.wavy(f.x1, f.x2, f.bottom + 1, r), "mark soft"));
        const flag = document.createElement("span");
        flag.className = "flag";
        flag.textContent = ph.kind;
        flag.style.left = `${(frs[0].x1 + frs[0].x2) / 2}px`;
        flag.style.top = `${frs[0].top}px`;
        if (!state.seen.has(`${k}|flag`)) flag.classList.add("write"), state.seen.add(`${k}|flag`);
        overlay.append(flag);
      }
    }

    const whole = rectsFor(row, 0, it.text.length);
    if (!whole.length) continue;

    // With a single line, it is trivially the point; marking it would only cover the phrase marks.
    const isPoint = it.label === "the point" || it.label === "best guess";
    if (lines === 1 && isPoint) continue;
    if (it.keep && isPoint) {
      whole.forEach((f, n) => add(`pt|${it.key}|${n}`, pen.underline(f.x1, f.x2, f.bottom + 3, r)));
    }
    if (it.keep && it.label === "stet") {
      for (const [cx, cy] of whole.flatMap((f) => pen.dots(f.x1, f.x2, f.bottom + 4, r))) {
        const c = document.createElementNS(SVG, "circle");
        Object.entries({ cx, cy, r: 1.3, class: "dot" }).forEach(([a, v]) => c.setAttribute(a, v));
        g.append(c);
      }
    }
    if (!it.label) continue;
    const n = note(it, marginX, whole[0].y);
    if (n.classList.contains("write")) {
      n.style.animationDelay = `${noteDelay}ms`;
      noteDelay += 60;
    }
    overlay.append(n);
    if (it.label === "the point") {
      const w = n.offsetWidth;
      add(`ring|${it.key}`, pen.circle(marginX + w / 2, whole[0].y + 1, w / 2 + 10, 18, r), "mark soft");
    }
  }
  return Math.max(delay, noteDelay);
}

function note(it, x, y) {
  const b = document.createElement("button");
  b.className = "note";
  b.textContent = it.label;
  if (SHORT_LABEL[it.label]) b.dataset.short = SHORT_LABEL[it.label];
  b.style.left = `${x}px`;
  b.style.top = `${y}px`;
  // Ink weight follows confidence, floored so the faintest note still reads (3:1 at this size).
  b.style.setProperty("--o", (0.7 + 0.3 * Math.min(1, it.conf / 0.5)).toFixed(2));
  const key = `note|${it.label}|${it.key}`;
  if (!state.seen.has(key)) b.classList.add("write"), state.seen.add(key);
  const verb = it.keep ? "Cut this line instead" : "Keep this line (stet)";
  b.title = state.mode === "edit" ? verb : "";
  b.setAttribute("aria-label", `Line ${it.i + 1}: ${it.label}. ${state.mode === "edit" ? verb + "." : ""}`);
  b.disabled = state.mode !== "edit";
  b.addEventListener("click", () => toggleStet(it));
  return b;
}

function toggleStet(it) {
  if (state.mode !== "edit") return;
  if (state.stet.has(it.key)) state.stet.delete(it.key);
  else state.stet.set(it.key, it.keep ? "cut" : "keep");
  render();
}

function renderLog(plan) {
  const out = [];
  if (state.last) {
    const where = state.last.source === "saved" ? "saved with the sample" : `${state.last.device === "your browser" ? "in" : "on"} ${state.last.device}${state.last.cached ? ", from cache" : ""}`;
    out.push(`${state.last.n} lines judged in ${Math.round(state.last.ms)}\u00a0ms, ${where}`, "");
  }
  for (const it of plan.items) {
    if (it.empty) continue;
    const p = it.p
      ? ["news", "story", "bait", "brag", "filler"].map((k) => `${k} ${it.p[k].toFixed(2).slice(1)}`).join("  ")
      : it.rule ? "measured by code" : "waiting for Laya";
    out.push(`${String(it.i + 1).padStart(2)}  ${p.padEnd(52)}  ${it.label ?? ""}`);
  }
  logEl.textContent = out.join("\n") || "Paste something to see how Laya reads it.";
}

// ---------- Laya ----------

let judgeTimer, inflight;

function scheduleJudge() {
  clearTimeout(judgeTimer);
  const post = postOf(input.value);
  if (!post || post === state.exactPost || !canJudge()) return;
  judgeTimer = setTimeout(() => judgeNow(post), JUDGE_DELAY);
}

async function judgeNow(post) {
  if (state.server !== "ready") return judgeInBrowser(post);
  const lines = post.split("\n");
  inflight?.abort();
  inflight = new AbortController();
  setStatus(`Laya is reading ${lines.length} ${lines.length === 1 ? "line" : "lines"}…`);
  try {
    const res = await fetch("/api/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post, lines }),
      signal: inflight.signal,
    });
    const data = await res.json();
    if (res.status === 422) throw new Error("the post is too long for one pass. Keep it under 60 lines and 8,000 characters.");
    if (!res.ok) throw new Error(data.detail || res.statusText);
    if (post !== postOf(input.value)) return;
    lines.forEach((l, k) => state.byLine.set(l, data.lines[k]));
    state.exactPost = post;
    state.last = { n: lines.length, ms: data.ms, device: data.device, cached: data.cached };
    const n = `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
    setStatus(`Laya read ${n} in ${Math.round(data.ms)}\u00a0ms on ${data.device}.`);
    if (state.mode === "edit") render();
  } catch (e) {
    if (e.name !== "AbortError") setStatus(`Laya couldn’t read this: ${e.message}`);
  }
}

// ONNX Runtime sessions don't take overlapping runs, so browser reads queue up; stale ones are skipped.
let browserQueue = Promise.resolve();

function judgeInBrowser(post) {
  if (state.browser !== "ready") return;
  browserQueue = browserQueue.then(async () => {
    if (post !== postOf(input.value) || post === state.exactPost) return;
    const lines = post.split("\n");
    const n = `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
    setStatus(`Laya is reading ${n} in your browser…`);
    try {
      const t = performance.now();
      const probs = await browserLaya.judgeLines(state.agent, state.question, post, lines);
      const ms = performance.now() - t;
      if (post !== postOf(input.value)) return;
      lines.forEach((l, k) => state.byLine.set(l, probs[k]));
      state.exactPost = post;
      state.last = { n: lines.length, ms, device: "your browser" };
      setStatus(`Laya read ${n} in ${Math.round(ms)}\u00a0ms, right here in your browser.`);
      if (state.mode === "edit") render();
    } catch (e) {
      setStatus(`Laya couldn’t read this: ${e.message}`);
    }
  });
  return browserQueue;
}

// No server: samples use answers saved with them; your own text needs Laya running in the page.
async function initBrowser() {
  if (!browserLaya.canRun()) {
    state.browser = "unsupported";
    setStatus("Laya read the samples ahead of time. This browser can’t run it (no WebGPU), so your own text gets a rough guess. Try Chrome on a computer, or run cut locally.");
    return;
  }
  // Already downloaded on an earlier visit: load it from the cache without asking (and without
  // holding up the first render).
  if (await browserLaya.isCached()) return void startBrowser();
  state.browser = "idle";
  loadBtn.hidden = state.mode !== "edit";
  setStatus("Laya read the samples ahead of time. To read your own text, run it in your browser: a one-time 534\u00a0MB download that stays cached for next time.");
}

async function startBrowser() {
  state.browser = "loading";
  loadBtn.hidden = false;
  loadBtn.disabled = true;
  loadBtn.textContent = "Loading Laya…";
  setStatus("Loading Laya into this page. Nothing you type leaves your browser.");
  try {
    state.question ??= await (await fetch("question.json")).json();
    state.agent = await browserLaya.loadLaya((f) => {
      loadBtn.textContent = f < 1 ? `Downloading Laya… ${Math.floor(f * 100)}%` : "Starting Laya…";
    });
    state.browser = "ready";
    loadBtn.hidden = true;
    setStatus("Laya is running in your browser. Nothing you type leaves this page.");
    const post = postOf(input.value);
    if (post) (state.exactPost = null), judgeNow(post);
  } catch (e) {
    state.browser = "error";
    loadBtn.disabled = false;
    loadBtn.textContent = "Try loading Laya again";
    setStatus(`Laya couldn’t start in this browser (${e.message}). Your own text gets a rough guess.`);
  }
}

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error();
    const s = await res.json();
    state.server = s.state;
    state.device = s.device;
    state.serverError = s.error;
  } catch {
    state.server = "offline";
  }
  const messages = {
    loading: "Laya is loading. The first run downloads 843\u00a0MB; the sample posts work meanwhile.",
    ready: `Laya is ready on ${state.device}.`,
    error: `Laya failed to load (${state.serverError}). Marks come from code and a rough guess.`,
  };
  if (messages[state.server]) setStatus(messages[state.server]);
  if (state.server === "loading") setTimeout(pollStatus, 1500);
  if (state.server === "ready") scheduleJudge();
  if (state.server === "offline") await initBrowser();
  if (state.mode === "edit") render();
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ---------- the cut ----------

// Strikes go down the page one after another, like an editor working, then the page closes up.
const STRIKE_MS = 260, STRIKE_GAP = 70;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

function drawStroke(g, d, cls, delay, dur = STRIKE_MS) {
  const p = strokePath(d, `${cls} draw`);
  p.style.animationDelay = `${delay}ms`;
  p.style.animationDuration = `${dur}ms`;
  g.append(p);
  return p;
}

async function cutIt() {
  const plan = state.plan;
  if (!plan?.ready || state.mode !== "edit") return;
  state.mode = "cutting";
  document.body.dataset.mode = "cutting";
  cutBtn.disabled = true;
  overlay.querySelectorAll(".note").forEach((n) => (n.disabled = true));

  const rows = [...mirror.children];
  const g = ink.querySelector("g");
  let delay = 0;
  for (const it of plan.items) {
    if (it.empty || it.keep) continue;
    const frs = rectsFor(rows[it.i], 0, it.text.length);
    const r = pen.rng("cut" + it.key);
    for (const f of frs) {
      drawStroke(g, pen.strike(f.x1, f.x2, f.y, r), "mark", delay);
      delay += STRIKE_GAP;
    }
    const last = frs[frs.length - 1];
    if (last) drawStroke(g, pen.pigtail(last.x2 + 3, last.y, r), "mark soft", delay - 20, 180);
  }
  await wait(delay + STRIKE_MS + 380);

  // Exit: struck lines and every mark fade out, easing in.
  ink.classList.add("fade");
  overlay.classList.add("fade");
  const going = plan.items.filter((it) => it.empty || !it.keep).map((it) => rows[it.i]);
  going.forEach((row) => row.classList.add("gone"));
  await wait(200);

  await Promise.all(
    going.map((row) => {
      row.classList.add("collapsing");
      return row.animate([{ height: `${row.offsetHeight}px` }, { height: "0px", minHeight: "0px" }], {
        duration: reduceMotion.matches ? 0 : 380,
        easing: EASE_IN_OUT,
        fill: "forwards",
      }).finished;
    }),
  );

  showResult(plan);
}

async function showResult(plan) {
  state.mode = "done";
  document.body.dataset.mode = "done";
  const kept = plan.items.filter((it) => it.keep);

  // 1. Kept lines as they were, their small cuts struck. Fresh rows: the old ones hold their collapse animation.
  mirror.replaceChildren();
  renderMirror(kept.map((it) => it.text));
  ink.replaceChildren();
  overlay.replaceChildren();
  ink.classList.remove("fade");
  overlay.classList.remove("fade");
  let g = ink.appendChild(document.createElementNS(SVG, "g"));
  let delay = 0;
  kept.forEach((it, n) => {
    for (const ph of it.phrases.filter((p) => p.cut)) {
      const r = pen.rng(it.key + ph.markStart);
      for (const f of rectsFor(mirror.children[n], ph.markStart, ph.markEnd)) {
        drawStroke(g, pen.strike(f.x1, f.x2, f.y, r), "mark", delay);
        delay += STRIKE_GAP;
      }
    }
  });
  if (delay) await wait(delay + STRIKE_MS + 260);

  // 2. They close up and grow: the line that survived is the point of the page now.
  ink.replaceChildren();
  renderMirror(kept.map((it) => it.result));
  mirror.classList.add("final");
  await wait(440);

  // 3. Underline it.
  g = ink.appendChild(document.createElementNS(SVG, "g"));
  kept.forEach((it, n) => {
    const r = pen.rng("done" + it.key);
    rectsFor(mirror.children[n], 0, it.result.length).forEach((f, k) => drawStroke(g, pen.underline(f.x1, f.x2, f.bottom + 3, r), "mark", k * 90, 300));
  });
  await wait(260);

  // 4. Strike the old word count and pencil in the new one.
  countEl.replaceChildren();
  const was = Object.assign(document.createElement("span"), { className: "was", textContent: `${plan.before}` });
  const now = Object.assign(document.createElement("span"), { className: "now", textContent: `${plan.after}` });
  countEl.append(was, now, document.createTextNode(plan.after === 1 ? " word" : " words"));
  const s = was.appendChild(document.createElementNS(SVG, "svg"));
  s.setAttribute("aria-hidden", "true");
  drawStroke(s, pen.strike(0, was.offsetWidth, was.offsetHeight / 2 + 1, pen.rng("count")), "mark", 0, 220);
  now.classList.add("write");
  now.style.animationDelay = "200ms";
  countEl.setAttribute("aria-label", `${plan.before} words cut to ${plan.after}`);
  await wait(520);

  // 5. Regrade.
  setGrade("A");
  await wait(620);

  colophon.hidden = false;
  colophon.classList.add("write");
  [copyBtn, shareBtn, backBtn].forEach((b) => (b.hidden = false));
  cutBtn.hidden = true;
  loadBtn.hidden = true;
  state.result = { text: kept.map((it) => it.result).join("\n"), before: plan.before, after: plan.after, grade: plan.grade };
}

function backToDraft() {
  state.mode = "edit";
  document.body.dataset.mode = "edit";
  mirror.replaceChildren();
  // Snap back to the draft size: marks are measured right away, so this can't be a transition.
  mirror.style.transition = "none";
  mirror.classList.remove("final");
  void mirror.offsetWidth;
  mirror.style.transition = "";
  ink.classList.remove("fade");
  overlay.classList.remove("fade");
  colophon.hidden = true;
  colophon.classList.remove("write");
  [copyBtn, shareBtn, backBtn].forEach((b) => (b.hidden = true));
  cutBtn.hidden = false;
  loadBtn.hidden = !["idle", "loading", "error"].includes(state.browser) || state.server !== "offline";
  copyBtn.textContent = "Copy";
  gradeEl.dataset.letter = "";
  countEl.removeAttribute("aria-label");
  render();
  input.focus();
}

// ---------- input ----------

// Pasted paragraphs become one sentence per line, so each sentence can be judged and cut on its own.
function oneSentencePerLine(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/(?<=[.!?…]["”’)]?)\s+(?=["“‘(]?[\p{Lu}\d])/gu, "\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

input.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain");
  if (!text) return;
  e.preventDefault();
  const clean = oneSentencePerLine(text);
  // execCommand keeps the paste on the undo stack; setRangeText is the fallback.
  if (!document.execCommand("insertText", false, clean)) {
    input.setRangeText(clean, input.selectionStart, input.selectionEnd, "end");
    onEdit();
  }
  const post = postOf(input.value);
  if (canJudge() && post) clearTimeout(judgeTimer), judgeNow(post);
});

input.addEventListener("input", onEdit);

function onEdit() {
  samplesSel.value = "";
  render();
  scheduleJudge();
}

function loadSample(id) {
  const s = state.samples.find((s) => s.id === id);
  if (!s) return;
  if (state.mode !== "edit") backToDraft();
  input.value = s.text;
  state.stet.clear();
  // Saved answers draw the marks instantly; with Laya up, it still reads the post live to show its speed.
  const saved = state.judged[s.id];
  if (saved) {
    s.text.split("\n").forEach((l, k) => state.byLine.set(l.trim(), saved.lines[k]));
    state.last = { n: saved.lines.length, ms: saved.ms, device: saved.device, source: "saved" };
    if (!canJudge()) state.exactPost = postOf(s.text);
  }
  render();
  if (canJudge()) (state.exactPost = null), judgeNow(postOf(s.text));
}

samplesSel.addEventListener("change", () => loadSample(samplesSel.value));
cutBtn.addEventListener("click", cutIt);
loadBtn.addEventListener("click", startBrowser);
backBtn.addEventListener("click", backToDraft);

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.result.text);
  copyBtn.textContent = "Copied";
});

shareBtn.addEventListener("click", () => {
  const { before, after, grade } = state.result;
  const article = /^[AEF]/.test(grade) ? "an" : "a";
  const text = `My post went from ${before} words to ${after}. It got ${article} ${grade}.\n\nAn editor that can’t write. It can only cut:`;
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(REPO_URL)}`, "_blank", "noopener");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(), cutIt();
  if (e.key === "Escape" && state.mode === "done") backToDraft();
});

// Marks are positioned from text geometry, so redraw (without animating) when the layout changes.
// Only width matters: height changes on every keystroke, and redrawing then would cut animations short.
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (w === lastWidth) return;
  lastWidth = w;
  if (state.mode === "edit" && state.plan) drawMarks(state.plan);
}).observe(page);

// ---------- boot ----------

async function boot() {
  // The mat's printed ruler: one number per major grid line.
  $(".ruler").append(...Array.from({ length: 25 }, (_, i) => Object.assign(document.createElement("span"), { textContent: i })));
  const [samples, judged] = await Promise.all([fetch("samples.json").then((r) => r.json()), fetch("judged.json").then((r) => r.json()).catch(() => ({}))]);
  state.samples = samples;
  state.judged = judged;
  for (const s of samples) samplesSel.append(new Option(s.title, s.id));
  // Marks are placed from glyph geometry, so the fonts must be in before the first measurement.
  await Promise.all([document.fonts.load('17px "Courier Prime"'), document.fonts.load('28px "Reenie Beanie"')]).catch(() => {});
  await pollStatus();
  // Open on a marked-up sample so there's something to see; #blank starts with an empty sheet.
  const id = location.hash.slice(1) || samples[0].id;
  if (id === "blank") render(), input.focus();
  else loadSample(id), (samplesSel.value = id);
}

boot();
