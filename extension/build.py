"""Assemble the Chrome extension in extension/dist.

It combines extension/src with the site's shared code (the cut rules, pencil strokes, question and the
vendored laya-ts runtime), ONNX Runtime Web and the fonts. Chrome extensions can't load code from a CDN,
so ONNX Runtime is bundled; downloads are cached in extension/.cache.

    python3 extension/build.py          # then load extension/dist at chrome://extensions ("Load unpacked")
    python3 extension/build.py --zip    # also writes extension/cut-extension.zip for the Chrome Web Store
"""
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT.parent / "cut" / "web"
DIST = ROOT / "dist"
CACHE = ROOT / ".cache"

ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/"
ORT_FILES = ["ort.webgpu.bundle.min.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]  # the bundle loads this wasm
SHARED = ["plan.js", "pencil.js", "browser-laya.js", "question.json"]
FONTS = {
    "ReenieBeanie.woff2": "Reenie+Beanie",
    "CourierPrime-Regular.woff2": "Courier+Prime:wght@400",
    "CourierPrime-Bold.woff2": "Courier+Prime:wght@700",
}
CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def fetch(url: str, headers: dict | None = None) -> bytes:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {})) as res:
            return res.read()
    except urllib.error.URLError as e:
        # python.org builds on macOS ship without root certificates; curl uses the system's.
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
        args = ["curl", "-fsSL", url] + [a for k, v in (headers or {}).items() for a in ("-H", f"{k}: {v}")]
        return subprocess.run(args, check=True, capture_output=True).stdout


def get(url: str, dest: Path) -> Path:
    if not dest.exists():
        print(f"downloading {url}")
        dest.write_bytes(fetch(url))
    return dest


def font_url(family: str) -> str:
    """The latin woff2 file Google Fonts serves to Chrome for this family."""
    css = fetch(f"https://fonts.googleapis.com/css2?family={family}", {"User-Agent": CHROME_UA}).decode()
    block = css.split("/* latin */")[-1]
    return re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)


def main() -> None:
    CACHE.mkdir(exist_ok=True)
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(ROOT / "src", DIST)

    lib = DIST / "lib"
    lib.mkdir()
    for name in SHARED:
        shutil.copy(WEB / name, lib / name)
    shutil.copytree(WEB / "vendor", lib / "vendor")

    (DIST / "ort").mkdir()
    for name in ORT_FILES:
        shutil.copy(get(ORT + name, CACHE / name), DIST / "ort" / name)

    (DIST / "fonts").mkdir()
    for name, family in FONTS.items():
        cached = CACHE / name
        if not cached.exists():
            get(font_url(family), cached)
        shutil.copy(cached, DIST / "fonts" / name)

    size = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"built {DIST} ({size / 1e6:.1f} MB). Load it unpacked at chrome://extensions.")

    if "--zip" in sys.argv:
        out = ROOT / "cut-extension.zip"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(DIST.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(DIST))
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
