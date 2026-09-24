"""Judge every sample post ahead of time so samples render instantly, even before Laya finishes loading.

Run after editing cut/web/samples.json or the questions in cut/judge.py:  uv run python scripts/precompute.py
Writes cut/web/judged.json and prints whether the top news line matches each sample's hand-labelled point.
"""
import json
import pathlib

from cut.judge import Judge

WEB = pathlib.Path(__file__).resolve().parent.parent / "cut" / "web"
samples = json.loads((WEB / "samples.json").read_text())

judge = Judge()
judge.load()
if judge.error:
    raise SystemExit(judge.error)

out, hits = {}, 0
for s in samples:
    lines = s["text"].split("\n")
    res = judge.run(s["text"], lines)
    out[s["id"]] = {k: res[k] for k in ("lines", "ms", "device", "model")}
    top = max(range(len(lines)), key=lambda i: res["lines"][i]["news"])
    hits += top in s["point"]
    print(f"{s['id']:<11} {'hit ' if top in s['point'] else 'miss'} top line {top}, expected {s['point']}, {res['ms']:.0f} ms")

(WEB / "judged.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(f"\ntop news line matched the expected point in {hits}/{len(samples)} samples")
