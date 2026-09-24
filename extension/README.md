# cut. for LinkedIn and X

A Chrome extension that reads long posts as you scroll and cuts them down to their point, live, in the
feed. Same model and rules as [the site](https://cut-neon.vercel.app): Laya says what job each line does,
code strikes everything that isn't the point, and nothing is rewritten.

- **Cut the feed:** each long post is struck through and collapses to its point as it scrolls into view.
  The footer shows the grade the post earned and the word count before and after. *stet* shows every line
  again; *original* puts the post back exactly as the site drew it.
- **Mark it:** pencil notes on every line (backstory, bait, humblebrag, dramatic pause…) and a *cut it*
  button.
- **Off.**

## Install

```sh
python3 extension/build.py
```

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `extension/dist`.
A welcome page opens: download Laya there (534 MB, once; it stays in the extension's cache).

Until Laya is downloaded, posts only get the marks plain rules can make (hashtags, "Agree?", emoji, filler
words).

## How it works

- **One copy of the model.** Laya runs in an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
  a hidden extension page with WebGPU, shared by every tab. It closes after ten idle minutes to give the
  memory back and reloads from the cache in a few seconds.
- **Bundled runtime.** Chrome extensions can't load code from a CDN, so ONNX Runtime Web ships inside the
  extension (`build.py` downloads it). The model weights are data, fetched from
  [Hugging Face](https://huggingface.co/harshpreet931/cut-laya-onnx) in parallel chunks.
- **Its own layer.** The site's post text is hidden, never edited. The extension draws its own copy in a
  shadow root, in the site's font, so the page's styles and ours can't interfere.
- **Only what you look at.** A post is read once a third of it is on screen, top-most first, and posts
  under 30 words are left alone. Results are cached for the page's lifetime.

## Privacy

Everything runs on your computer. Post text goes from the page to the extension's own model and nowhere
else; there are no analytics. Permissions: `offscreen` (to run the model), `storage` (your mode and the
running word count), `alarms` (the idle timer). It only runs on linkedin.com, x.com and twitter.com.

## Limits

- The post selectors follow LinkedIn's and X's markup as of September 2026. It was tested on mock feeds
  built from that markup, not on logged-in sessions, and either site can change it.
- On X, long posts behind **Show more** are skipped: the rest of the text isn't on the page yet, and
  cutting half a post would be wrong.
- It needs WebGPU (Chrome or Edge on a computer). Without it, ONNX Runtime falls back to the CPU and
  reading is much slower.

## Chrome Web Store

`python3 extension/build.py --zip` writes `extension/cut-extension.zip`. The listing needs a justification
for each permission (above) and a privacy note saying no data is collected.
