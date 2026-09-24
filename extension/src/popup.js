const $ = (s) => document.querySelector(s);
const statusEl = $("#status"), bar = $("#bar"), fill = $("#fill"), download = $("#download");

if (new URLSearchParams(location.search).has("welcome")) {
  document.body.classList.add("page");
  $("#welcome").hidden = false;
}

const { mode } = await chrome.storage.sync.get({ mode: "cut" });
document.querySelector(`input[value="${mode}"]`).checked = true;
for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener("change", () => chrome.storage.sync.set({ mode: input.value }));
}

const bg = (type) => chrome.runtime.sendMessage({ target: "background", type });

function showProgress(f) {
  bar.hidden = false;
  fill.style.width = `${Math.round(f * 100)}%`;
  statusEl.textContent = f < 1 ? `Downloading Laya… ${Math.floor(f * 100)}%` : "Starting Laya…";
}

async function refresh() {
  const s = await bg("status");
  download.hidden = true;
  bar.hidden = true;
  if (s.loaded) statusEl.textContent = "Laya is running on this computer. Nothing you scroll past leaves it.";
  else if (s.loading) showProgress(s.progress ?? 0);
  else if (s.cached) statusEl.textContent = "Laya is downloaded. It starts when you open LinkedIn or X.";
  else {
    statusEl.textContent = "Laya reads the posts. It’s a one-time download that stays on this computer. Until then, only the simple marks show.";
    download.hidden = false;
  }
  if (s.error) statusEl.textContent = `Laya couldn’t start: ${s.error}`;
}

download.addEventListener("click", async () => {
  download.disabled = true;
  showProgress(0);
  const res = await bg("load");
  download.disabled = false;
  if (res?.error) statusEl.textContent = `The download stopped: ${res.error}. Try again.`;
  await refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") showProgress(msg.f);
});

const { stats } = await chrome.storage.local.get("stats");
if (stats?.posts) {
  $("#stats").textContent = `${stats.posts.toLocaleString()} ${stats.posts === 1 ? "post" : "posts"} cut, ${stats.words.toLocaleString()} words gone.`;
}

refresh();

// What the extension sees on the tab you opened the popup from.
if (!document.body.classList.contains("page")) {
  const pageEl = $("#page");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: "tab-status" });
    pageEl.textContent = s.long
      ? `This page: ${s.long} long ${s.long === 1 ? "post" : "posts"} found on ${s.site}, ${s.cut} cut${s.reading ? `, ${s.reading} being read` : ""}.`
      : `This page: cut. is running on ${s.site} but hasn’t found a long post yet. Scroll the feed; posts under 30 words are left alone.`;
    const details = $("#details");
    details.hidden = false;
    details.addEventListener("click", async () => {
      await navigator.clipboard.writeText(await chrome.tabs.sendMessage(tab.id, { type: "tab-outline" }));
      details.textContent = "Copied. It has the page’s structure, not its text.";
    });
  } catch {
    pageEl.textContent = "This page: cut. isn’t running here. It works on linkedin.com and x.com; if you’re on one of those, reload the tab.";
  }
  pageEl.hidden = false;
}
