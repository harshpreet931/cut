// Code decides what gets cut; Laya only says what job each line does. Nothing here adds a word.

// When a second line scores this close to the best one, keep both (e.g. an email's deadline and its ask).
const CLOSE_CALL = 0.08;
// Below this, no non-news role clearly fits a line, so it gets "close call" instead of a shaky label.
const CLOSE_CALL_ROLE = 0.2;

const ROLE_LABEL = { story: "backstory", bait: "bait", brag: "humblebrag", filler: "filler" };

// Whole lines that code can judge without a model. First match wins.
const LINE_RULES = [
  [/^(?:\s*#[\p{L}\p{N}_]+[\s,]*)+$/u, "hashtags"],
  [/^(?:hi|hey|hello|dear|good (?:morning|afternoon|evening))\b[^.!?]{0,40}[,!]?$/i, "greeting"],
  [/^(?:thanks|thank you|cheers|best|regards|warmly|many thanks)\b[^.?]{0,20}[.!]*$/i, "sign-off"],
  [/\bagree\s*\?|\brepost\b|\breshare\b|\bcomments?\b|\bdrop (?:it|them|a|your)\b|\bwho else\b|what'?s your take|what do you think|\bthoughts\s*\?|let me know|\bfollow (?:me|for)\b|tag someone|share (?:this|if)|♻️|👇/iu, "bait"],
  [/^here'?s (?:what|how|why)\b.{0,30}$|🧵|\ba thread\b|^the result\??$|^read on\b|^let me explain\b/iu, "teaser"],
  [/let that sink in|hope this (?:e-?mail|message|note) finds you well|at the end of the day|rejection is (?:just )?redirection|the end is (?:actually )?(?:just )?the beginning|in today'?s fast[- ]paced/i, "cliché"],
];

// Phrases inside a line. `cut` phrases are deleted from kept lines; the rest are only flagged.
const PHRASES = [
  { kind: "throat-clearing", cut: true, re: /^(?:I'?m|I am|we'?re|we are)\s+(?:so\s+|very\s+|beyond\s+|incredibly\s+|truly\s+)?(?:humbled|honou?red|thrilled|excited|delighted|proud|pleased|happy|grateful)(?:\s+(?:and|&)\s+(?:humbled|honou?red|thrilled|excited|delighted|proud|pleased|happy|grateful))?\s+to\s+(?:announce|share|say|tell you)(?:\s+that)?[,:]?\s*/gi },
  { kind: "throat-clearing", cut: true, re: /^(?:so|honestly|look|listen|okay|ok)[,:]\s+/gi },
  { kind: "throat-clearing", cut: true, re: /\bhere'?s the thing:\s*/gi },
  { kind: "passive-aggressive", cut: true, re: /\bper my last (?:e-?mail|message|note)[,:]?\s*/gi },
  { kind: "apology", cut: true, re: /\bsorry to (?:bother|bug|pester) you[,.]?\s*(?:but\s+)?/gi },
  { kind: "cliché", cut: true, re: /\bin today'?s fast[- ]paced(?:\s+[\p{L}-]+)?\s+(?:world|landscape|environment|economy),?\s*/giu },
  { kind: "filler", cut: true, re: /\b(?<!\bnot\s)(?:just|really|truly|literally|actually|basically|honestly|simply|quickly|very|incredibly|super)\b\s*/gi },
  { kind: "hedge", cut: true, re: /\b(?:perhaps|possibly|arguably|I think|I feel like|sort of|kind of|in a sense),?\s*/gi },
  { kind: "hedge", cut: false, re: /\b(?:maybe|might|could possibly)\b/gi },
  { kind: "cliché", cut: false, re: /\b(?:circle back|touch base|move the needle|game[- ]changer|low[- ]hanging fruit|synergy|leverage|deep dive|think outside the box|drive alignment)\b/gi },
  { kind: "emoji", cut: true, re: /\s*\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*️?/gu },
  { kind: "hashtag", cut: true, re: /\s*#[\p{L}\p{N}_]+/gu },
];

export function wordCount(s) {
  return (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’%$.,-]*/gu) || []).length;
}

export function lineRule(text) {
  const t = text.trim();
  for (const [re, label] of LINE_RULES) if (re.test(t)) return label;
  if (wordCount(t) <= 3) return "dramatic pause";
  return null;
}

// Every phrase match in a line, with the visible span (mark) and the span to delete (cut, with its spacing).
export function phraseMarks(text) {
  const found = [];
  for (const { kind, cut, re } of PHRASES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const lead = m[0].length - m[0].trimStart().length;
      const trail = m[0].length - m[0].trimEnd().length;
      const start = m.index, end = m.index + m[0].length;
      if (end - start - lead - trail <= 0) continue;
      found.push({ kind, cut, start, end, markStart: start + lead, markEnd: end - trail });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && f.start < last.end) continue;
    if (f.cut && f.kind === "filler" && breaksArticle(text, f)) f.cut = false;
    out.push(f);
  }
  return out;
}

// Deleting "very" from "a very important" would leave "a important"; flag it instead of cutting it.
function breaksArticle(text, f) {
  const before = text.slice(0, f.start).match(/\b(an?)\s*$/i);
  const after = text.slice(f.end).match(/^\s*(\p{L})/u);
  if (!before || !after) return false;
  const vowel = /[aeiou]/i.test(after[1]);
  return before[1].toLowerCase() === "a" ? vowel : !vowel;
}

export function applyCuts(text, phrases) {
  let out = text;
  for (const p of [...phrases].reverse()) if (p.cut) out = out.slice(0, p.start) + out.slice(p.end);
  out = out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^[\s,;:—–-]+/, "")
    .replace(/[\s,;:—–-]+$/, "")
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function bestOtherRole(p) {
  let role = "filler", v = -1;
  for (const k of Object.keys(ROLE_LABEL)) if (p[k] > v) (role = k), (v = p[k]);
  return [role, v];
}

// Without Laya: a rough stand-in so the page still works. Favors long lines with numbers or names.
// Marked `guess`, so the page never presents it as Laya's reading.
export function guessProbs(text) {
  const words = wordCount(text);
  const digits = /\d/.test(text) ? 0.15 : 0;
  const names = /\s[A-Z][a-z]+/.test(text.slice(1)) ? 0.1 : 0;
  const news = Math.min(0.9, 0.2 + words / 60 + digits + names);
  return { news, story: (1 - news) / 2, bait: 0, brag: 0, filler: (1 - news) / 2, guess: true };
}

export function grade(fluff) {
  return fluff < 0.2 ? "A" : fluff < 0.4 ? "B" : fluff < 0.6 ? "C" : fluff < 0.8 ? "D" : "F";
}

/**
 * lines: string[]; probs: (object|null)[] aligned to lines; stet: Map(trimmed line -> "keep" | "cut").
 * Returns one item per line plus totals. Lines without a model answer yet have `pending: true`.
 */
export function makePlan(lines, probs, stet = new Map()) {
  const items = lines.map((text, i) => {
    const key = text.trim();
    if (!key) return { i, text, empty: true };
    return { i, text, key, rule: lineRule(text), p: probs[i] || null, phrases: phraseMarks(text) };
  });

  const candidates = items.filter((it) => !it.empty && !it.rule && it.p);
  const auto = new Set();
  if (candidates.length) {
    const top = candidates.reduce((a, b) => (b.p.news > a.p.news ? b : a));
    for (const c of candidates) if (c === top || c.p.news >= top.p.news - CLOSE_CALL) auto.add(c.i);
  }

  let before = 0, after = 0;
  for (const it of items) {
    if (it.empty) continue;
    const override = stet.get(it.key);
    it.keep = override ? override === "keep" : auto.has(it.i);
    it.pending = !it.rule && !it.p && !override;
    if (it.keep) {
      it.label = !auto.has(it.i) ? "stet" : it.p?.guess ? "best guess" : "the point";
      it.conf = it.p ? it.p.news : 1;
    } else if (override === "cut") {
      it.label = "cut";
      it.conf = 1;
    } else if (it.rule) {
      it.label = it.rule;
      it.conf = 1;
    } else if (it.p?.guess) {
      it.label = null; // a guess has no opinion on what a line is doing
    } else if (it.p) {
      const [role, v] = bestOtherRole(it.p);
      // Laya has no strong second opinion, so the line nearly made the cut. Say so rather than guess.
      it.label = v < CLOSE_CALL_ROLE ? "close call" : ROLE_LABEL[role];
      it.conf = v < CLOSE_CALL_ROLE ? it.p.news : v;
    }
    it.result = it.keep ? applyCuts(it.text, it.phrases) : "";
    before += wordCount(it.text);
    after += wordCount(it.result);
  }

  const ready = items.some((it) => it.keep);
  const fluff = before ? 1 - after / before : 0;
  return { items, before, after, fluff, ready, grade: ready ? grade(fluff) : null };
}
