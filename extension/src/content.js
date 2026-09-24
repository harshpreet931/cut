// cut. on LinkedIn and X. Finds long posts as they scroll into view, asks Laya (running inside the
// extension) what job each line does, and draws the edit in a layer of its own. The site's text is
// only hidden, never edited, so "original" always brings it back untouched.
(async () => {
  const SITES = [
    {
      host: /(^|\.)linkedin\.com$/,
      post: "div.feed-shared-update-v2, div[data-urn^='urn:li:activity'], div[data-id^='urn:li:activity']",
      text: ".update-components-text, .feed-shared-inline-show-more-text, .feed-shared-text",
    },
    {
      host: /(^|\.)(x|twitter)\.com$/,
      post: "article[data-testid='tweet']",
      text: "div[data-testid='tweetText']",
      // The rest of a long post isn't loaded until "Show more"; cutting half a post would be wrong.
      skip: "[data-testid='tweet-text-show-more-link']",
    },
  ];
  const site = SITES.find((s) => s.host.test(location.hostname));
  if (!site) return;

  const url = (p) => chrome.runtime.getURL(p);
  const [{ makePlan, oneSentencePerLine, wordCount }, pen, css] = await Promise.all([
    import(url("lib/plan.js")),
    import(url("lib/pencil.js")),
    fetch(url("content.css")).then((r) => r.text()),
  ]);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);

  const MIN_WORDS = 30; // shorter posts have nothing to cut
  const MIN_LINES = 3;
  const SVG = "http://www.w3.org/2000/svg";
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion.matches ? 0 : ms));

  let mode = (await chrome.storage.sync.get({ mode: "cut" })).mode; // off | mark | cut
  let modelMissing = false;
  const states = new Map(); // text element -> state
  const byPost = new WeakMap(); // post container -> state; the IntersectionObserver watches posts
  const cache = new Map(); // post text -> Laya's reading

  loadHandFont();

  // ---------- finding posts ----------

  function readText(el) {
    const raw = (el.innerText || "")
      .replace(/ /g, " ")
      .replace(/\bhashtag(?=#)/g, "") // LinkedIn reads "hashtag" before every tag to screen readers
      .replace(/(…|\.\.\.)\s*(see\s+)?more\s*$/i, ""); // LinkedIn's "…more" toggle
    return oneSentencePerLine(raw);
  }

  function scan() {
    // Feeds are endless: forget posts the site has removed, so their nodes can be freed.
    for (const [el, s] of states) {
      if (el.isConnected) continue;
      if (s.post) io.unobserve(s.post);
      states.delete(el);
    }
    for (const el of document.querySelectorAll(site.text)) {
      if (el.parentElement?.closest(site.text)) continue; // take the outermost text box (it holds "…more" too)
      const post = el.closest(site.post);
      if (!post || (site.skip && post.querySelector(site.skip))) continue;
      const sig = el.textContent;
      const old = states.get(el);
      if (old && old.sig === sig) continue;
      if (old) unmount(old); // the site reused this element for another post
      const text = readText(el);
      const lines = text.split("\n");
      const real = lines.filter((l) => l.trim());
      if (wordCount(text) < MIN_WORDS || real.length < MIN_LINES) {
        states.set(el, { el, sig, skip: true });
        continue;
      }
      const s = { el, post, sig, lines, real, probs: null, status: "new", visible: false, host: null, cut: false, stet: false, dismissed: false };
      states.set(el, s);
      byPost.set(post, s);
      io.observe(post);
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const s = byPost.get(e.target);
        if (!s) continue;
        s.visible = e.isIntersecting;
        if (!s.visible || mode === "off" || s.dismissed) continue;
        mount(s);
        if (s.status === "new" && !modelMissing) s.status = "queued";
        if (s.status === "done" && mode === "cut" && !s.cut && !s.stet) animateCut(s);
      }
      pump();
    },
    { threshold: 0.35 },
  );

  let scanTimer = 0;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  scan();

  // ---------- asking Laya ----------

  let busy = false;
  async function pump() {
    if (busy) return;
    // Top-most visible post first: the order you read in.
    const next = [...states.values()].find((s) => s.status === "queued" && s.visible);
    if (!next) return;
    busy = true;
    next.status = "judging";
    render(next);
    const key = next.real.join("\n");
    let res = cache.get(key);
    if (!res) {
      res = await chrome.runtime
        .sendMessage({ target: "background", type: "judge", post: key, lines: next.real })
        .catch((e) => ({ error: String(e?.message ?? e) }));
      if (res?.probs) cache.set(key, res);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    busy = false;
    if (res?.error === "not-downloaded") {
      modelMissing = true;
      for (const s of states.values()) if (s.status === "queued" || s.status === "judging") s.status = "new";
      for (const s of states.values()) if (s.host) render(s);
      return;
    }
    if (res?.probs) {
      next.probs = res.probs;
      next.status = "done";
      if (next.host && mode === "cut" && next.visible && !next.stet) animateCut(next);
      else if (next.host) render(next);
    } else {
      next.status = "error";
      next.error = res?.error;
      if (next.host) render(next);
    }
    pump();
  }

  // ---------- drawing ----------

  function mount(s) {
    if (s.host?.isConnected) return;
    s.host = document.createElement("cut-post");
    s.root = s.host.attachShadow({ mode: "open" });
    s.root.adoptedStyleSheets = [sheet];
    s.box = document.createElement("div");
    s.box.className = "cut";
    s.root.append(s.box);
    s.hiddenDisplay = s.el.style.display;
    s.el.style.display = "none";
    s.el.before(s.host);
    s.host.classList.toggle("dark", isDark());
    new ResizeObserver(() => s.marked && drawMarks(s, false)).observe(s.box);
    render(s);
  }

  function unmount(s) {
    if (!s.host) return;
    s.host.remove();
    s.host = null;
    s.el.style.display = s.hiddenDisplay ?? "";
  }

  function planFor(s) {
    let k = 0;
    const probs = s.lines.map((l) => (l.trim() && s.probs ? s.probs[k++] : null));
    return makePlan(s.lines, probs, new Map());
  }

  function render(s) {
    if (!s.host) return;
    s.plan = planFor(s);
    if (s.cut) showCut(s);
    else showMarks(s, false);
  }

  // Every line, with pencil notes after them and marks drawn over them.
  function showMarks(s, animate) {
    const { plan } = s;
    s.box.replaceChildren();
    s.rows = plan.items.map((it) => {
      const row = el("div", it.empty ? "row empty" : "row");
      const t = el("span", "t", it.empty ? "​" : it.text);
      row.append(t);
      if (it.label) {
        const note = el("span", `note${animate ? " write" : ""}`, it.label);
        note.style.setProperty("--o", (0.7 + 0.3 * Math.min(1, (it.conf ?? 1) / 0.5)).toFixed(2));
        row.append(note);
      }
      s.box.append(row);
      return row;
    });
    s.svg = document.createElementNS(SVG, "svg");
    s.svg.setAttribute("class", "ink");
    s.box.append(s.svg, foot(s));
    drawMarks(s, animate);
  }

  function foot(s) {
    const f = el("div", "foot");
    const { plan } = s;
    f.append(el("span", "brand", "cut."));
    if (plan.grade && s.probs) f.append(grade(plan.grade));
    if (s.status === "judging" || s.status === "queued") f.append(el("span", "msg", "Laya is reading…"));
    else if (modelMissing && !s.probs) f.append(el("span", "msg", "Download Laya from the cut. menu to cut posts."));
    else if (s.status === "error") f.append(el("span", "msg", "Laya couldn’t read this one."));
    else if (s.probs) f.append(el("span", "msg", `${plan.before} words, ${plan.after} of them the point.`));
    if (s.probs && plan.ready) f.append(button("cut it", "Strike everything but the point", () => ((s.stet = false), animateCut(s))));
    f.append(button("original", "Show the post as it was", () => ((s.dismissed = true), unmount(s))));
    return f;
  }

  async function animateCut(s) {
    if (s.animating || !s.host) return;
    s.animating = true;
    s.plan = planFor(s);
    const { plan } = s;
    if (!plan.ready) return void (s.animating = false);
    showMarks(s, true);
    await wait(450);
    // Strikes cascade down every line that isn't the point.
    let delay = 0;
    for (const it of plan.items) {
      if (it.empty || it.keep) continue;
      const frs = rects(s, it.i, 0, it.text.length);
      const r = pen.rng("cut" + it.key);
      for (const f of frs) {
        path(s, pen.strike(f.x1, f.x2, f.y, r), "mark", delay);
        delay += 70;
      }
      const last = frs.at(-1);
      if (last) path(s, pen.pigtail(last.x2 + 3, last.y, r), "mark soft", delay - 20);
    }
    await wait(delay + 350);
    const going = plan.items.filter((it) => it.empty || !it.keep).map((it) => s.rows[it.i]);
    s.svg.classList.add("gone");
    going.forEach((row) => row.classList.add("gone"));
    await wait(200);
    await Promise.all(
      going.map((row) => row.animate([{ height: `${row.offsetHeight}px` }, { height: "0px" }], { duration: reduceMotion.matches ? 0 : 320, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" }).finished),
    );
    s.cut = true;
    s.animating = false;
    showCut(s);
    chrome.runtime.sendMessage({ target: "background", type: "stat", words: plan.before - plan.after }).catch(() => {});
  }

  // Only the point, in the writer's own words.
  function showCut(s) {
    const { plan } = s;
    s.box.replaceChildren();
    s.rows = [];
    s.marked = false;
    for (const it of plan.items) if (it.keep) s.box.append(el("div", "row kept", it.result));
    const f = el("div", "foot");
    // The grade the post earned as written; the cut version would always be an A.
    f.append(el("span", "brand", "cut."), grade(plan.grade));
    const count = el("span", "msg");
    count.title = "Every word left was already in the post. Nothing was rewritten.";
    count.append(el("s", "", String(plan.before)), ` ${plan.after} words`);
    f.append(count);
    f.append(button("stet", "Show every line again (stet: let it stand)", () => ((s.cut = false), (s.stet = true), render(s))));
    f.append(button("original", "Show the post as it was", () => ((s.dismissed = true), unmount(s))));
    s.box.append(f);
  }

  function drawMarks(s, animate) {
    if (!s.svg || s.cut) return;
    s.svg.replaceChildren();
    s.delay = 0;
    const { plan } = s;
    const single = plan.items.filter((it) => !it.empty).length === 1;
    for (const it of plan.items) {
      if (it.empty) continue;
      const r = pen.rng(it.key);
      for (const ph of it.phrases) {
        const frs = rects(s, it.i, ph.markStart, ph.markEnd);
        if (!frs.length) continue;
        if (ph.cut) {
          frs.forEach((f) => path(s, pen.strike(f.x1, f.x2, f.y, r), "mark", animate ? next(s) : null));
          const last = frs.at(-1);
          path(s, pen.pigtail(last.x2 + 3, last.y, r), "mark soft", animate ? next(s) : null);
        } else {
          frs.forEach((f) => path(s, pen.wavy(f.x1, f.x2, f.bottom + 1, r), "mark soft", animate ? next(s) : null));
        }
      }
      if (it.keep && it.label === "the point" && !single) {
        rects(s, it.i, 0, it.text.length).forEach((f) => path(s, pen.underline(f.x1, f.x2, f.bottom + 2, r), "mark", animate ? next(s) : null));
      }
    }
    s.marked = true;
  }

  const next = (s) => (s.delay += 45);

  function path(s, d, cls, delay) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    p.setAttribute("pathLength", "1");
    p.setAttribute("class", delay === null ? cls : `${cls} draw`);
    if (delay !== null) p.style.animationDelay = `${delay}ms`;
    s.svg.append(p);
  }

  // Visual lines covered by characters [a, b) of a row, relative to the layer.
  function rects(s, i, a, b) {
    const node = s.rows[i]?.firstChild?.firstChild;
    if (!node) return [];
    const range = document.createRange();
    range.setStart(node, Math.min(a, node.length));
    range.setEnd(node, Math.min(b, node.length));
    const base = s.box.getBoundingClientRect();
    const out = [];
    for (const r of range.getClientRects()) {
      if (r.width < 0.5) continue;
      const top = r.top - base.top;
      const line = out.find((l) => Math.abs(l.top - top) < 4);
      if (line) Object.assign(line, { x1: Math.min(line.x1, r.left - base.left), x2: Math.max(line.x2, r.right - base.left), bottom: Math.max(line.bottom, r.bottom - base.top) });
      else out.push({ top, bottom: r.bottom - base.top, x1: r.left - base.left, x2: r.right - base.left });
    }
    return out.map((l) => ({ ...l, y: (l.top + l.bottom) / 2 + 0.5 }));
  }

  function grade(letter) {
    const g = el("span", "grade");
    g.append(el("span", "hand", letter));
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "ring");
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", pen.circle(14, 15, 13, 12, pen.rng("g" + letter)));
    p.setAttribute("class", "mark");
    svg.append(p);
    g.append(svg);
    return g;
  }

  function button(label, title, onClick) {
    const b = el("button", "", label);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // the post itself is a link on both sites
      onClick();
    });
    return b;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function isDark() {
    for (const node of [document.body, document.documentElement]) {
      const [r, g, b, a = 1] = (getComputedStyle(node).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
      if (a > 0 && r !== undefined) return r * 0.299 + g * 0.587 + b * 0.114 < 128;
    }
    return false;
  }

  // Loaded from bytes rather than a URL, so the site's font policy doesn't apply to it.
  async function loadHandFont() {
    try {
      const face = new FontFace("cut-hand", await (await fetch(url("fonts/ReenieBeanie.woff2"))).arrayBuffer());
      document.fonts.add(await face.load());
    } catch {
      // falls back to the system's cursive font
    }
  }

  // ---------- settings ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.mode) {
      mode = changes.mode.newValue;
      for (const s of states.values()) {
        if (s.skip) continue;
        if (mode === "off") unmount(s);
        else if (s.visible && !s.dismissed) {
          mount(s);
          s.cut = mode === "cut" && s.cut;
          render(s);
          if (mode === "cut" && s.status === "done" && !s.stet) animateCut(s);
        }
      }
    }
    if (area === "local" && changes.modelReady?.newValue) {
      modelMissing = false;
      for (const s of states.values()) if (s.status === "new" && s.visible) s.status = "queued";
      pump();
    }
  });
})();
