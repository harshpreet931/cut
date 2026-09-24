"""Asks Laya what job each line of a post does. Laya only picks from the options below; it never writes."""
import hashlib
import json
import os
import threading
import time
import warnings
from collections import OrderedDict
from pathlib import Path

MODEL_ID = os.getenv("LAYA_MODEL", "convaiinnovations/laya")
DEVICE = os.getenv("CUT_DEVICE")  # cuda, mps or cpu; unset picks the best available

# One question per line, shared with the in-browser runtime (cut/web/question.json). The whole post
# rides along as context, so "I didn't." reads as a beat, not news.
QUESTIONS = {"role": json.loads((Path(__file__).parent / "web" / "question.json").read_text())}


def state_for(post: str, line: str) -> str:
    return f"POST:\n{post}\n\nSENTENCE: {line}"


class Judge:
    """Loads Laya in the background so the page is usable while the first-run download finishes."""

    def __init__(self):
        self.agent = None  # set once loading and warm-up finish; until then the page uses saved answers
        self._agent = None
        self.error = None
        self.device = None
        self._lock = threading.Lock()
        self._cache: "OrderedDict[str, dict]" = OrderedDict()

    @property
    def state(self) -> str:
        return "ready" if self.agent else "error" if self.error else "loading"

    def load(self, preheat: list[str] = ()):
        """Load Laya, then read each `preheat` post twice so its cached timing is the warm one."""
        try:
            import laya  # pulls in torch, so it stays out of import time

            with warnings.catch_warnings():
                # The checkpoint ships one out-of-range calibration temperature. cut ranks lines by
                # probability rather than reading them as calibrated confidence, so it doesn't matter here.
                warnings.filterwarnings("ignore", message="laya: this checkpoint ships invalid temperatures")
                agent = laya.load(MODEL_ID, device=DEVICE)
            self.device = str(agent.device)
            self._agent = agent
            # The first batch of a new shape pays for kernel compilation, notably on Apple GPUs.
            warm = "Warming up.\nThis line is only here to compile kernels.\nAgree?"
            for _ in range(2):
                self._infer(warm, warm.split("\n") * 3)
            for post in preheat:
                lines = post.split("\n")
                self._infer(post, lines)
                self._remember(post, lines, self._infer(post, lines))
            self.agent = agent
        except Exception as e:  # surfaced to the page through /api/status
            self.error = f"{type(e).__name__}: {e}"

    def load_in_background(self, preheat: list[str] = ()):
        threading.Thread(target=self.load, args=(preheat,), daemon=True).start()

    def run(self, post: str, lines: list[str]) -> dict:
        key = self._key(post, lines)
        if key in self._cache:
            self._cache.move_to_end(key)
            return {**self._cache[key], "cached": True}
        return self._remember(post, lines, self._infer(post, lines))

    def _infer(self, post: str, lines: list[str]) -> dict:
        with self._lock:
            t = time.perf_counter()
            res = self._agent.predict_batch([state_for(post, l) for l in lines], QUESTIONS)
            ms = (time.perf_counter() - t) * 1000
        return {
            "lines": [{k: round(v, 4) for k, v in r["answers"]["role"]["probabilities"].items()} for r in res],
            "ms": round(ms, 1),
            "device": self.device,
            "model": "laya-421m",
            "cached": False,
        }

    def _remember(self, post: str, lines: list[str], out: dict) -> dict:
        self._cache[self._key(post, lines)] = out
        if len(self._cache) > 500:
            self._cache.popitem(last=False)
        return out

    @staticmethod
    def _key(post: str, lines: list[str]) -> str:
        return hashlib.sha1((post + "\x00" + "\x01".join(lines)).encode()).hexdigest()
