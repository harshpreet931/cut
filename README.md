# cut.

An editor that can't write. It can only cut.

Paste a post. A blue pencil marks what every line is doing (backstory, bait, humblebrag, filler), finds the one line that matters, and cuts the rest. Every word left was already yours.

<!-- demo.mp4 goes here -->

## Try it in your browser

The hosted page needs no install. The sample posts come with Laya's answers already saved, so they work
anywhere, phones included. For your own text, Laya runs inside the page with WebGPU: a one-time 534 MB
download that your browser keeps for next time. Nothing you type is sent anywhere. It needs a browser with
WebGPU (recent Chrome or Edge on a computer); without it, your own text gets a rough guess from plain rules.

## Run it locally

Faster, and works in any browser. You need [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/harshpreet931/cut
cd cut
uv run cut
```

That opens `http://127.0.0.1:4321`. The first run downloads Laya (843 MB); the sample posts work while it loads. It runs on your machine: Apple Silicon, a CUDA GPU or plain CPU. Nothing you paste leaves it.

Options: `uv run cut --port 8000 --no-open`. Set `CUT_DEVICE=cpu` (or `cuda`, `mps`) to pick where Laya runs.

## How it works

- **Laya reads.** [Laya](https://huggingface.co/convaiinnovations/laya) is an open 421M-parameter decision model. It doesn't generate text; it picks from options you give it and returns calibrated probabilities. For each line, `cut` asks one question: *what job does this line do in the post?* The options are news, backstory, bait, humblebrag or filler. A 9-line post takes about 0.3 s on an M4 Pro.
- **Code cuts.** The line Laya rates most likely to be the news is kept, plus any line within 0.08 of it. Everything else is struck. Inside kept lines, plain rules remove throat-clearing ("I'm humbled and honored to share that"), filler words, emoji and hashtags. Some things, like "circle back", are flagged but not cut, because deleting them would break the sentence.
- **You overrule.** Click any note in the margin to keep a line (*stet*) or cut it anyway.

Lines that code can judge on its own, like hashtags, "Agree?" and one-word dramatic pauses, never reach the model.

**In the browser**, the same model runs through [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/):
Laya converted to ONNX with 8-bit weights ([`scripts/shrink_browser_model.py`](scripts/shrink_browser_model.py)),
loaded by a vendored copy of [laya-ts](https://github.com/NandhaKishorM/laya/tree/main/laya-ts)
(see [`cut/web/vendor/laya/NOTICE.md`](cut/web/vendor/laya/NOTICE.md)). All lines of a post go through
in one pass: about 0.8 s for 9 lines on an M4 Pro. On the samples it gives the same label as the server on
every line.

## How well does it work?

On the 7 sample posts, the line Laya ranks highest is the point in 6. The seventh is an email where it picks "the deadline is Friday" over the request, and the 0.08 rule keeps both. That is a small, hand-made set, so expect misses on your own writing; the margin notes are there so you can correct them.

To re-judge the samples after changing them or the question in `cut/web/question.json`:

```sh
uv run python scripts/precompute.py
```

## Deploying the static site

`cut/web` is plain files with no build step. Deploy that folder anywhere static (it's on Vercel). With no
`/api` next to it, the page switches to running Laya in the browser.

## Credits

Built on [Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations (Apache-2.0). Made by [Harshpreet Singh](https://harshpreet.com).
