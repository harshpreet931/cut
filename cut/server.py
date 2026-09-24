"""cut. runs locally: serves the page and the /api/judge endpoint on one port."""
import argparse
import json
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .judge import MODEL_ID, Judge

WEB = Path(__file__).parent / "web"
judge = Judge()


@asynccontextmanager
async def lifespan(_: FastAPI):
    samples = json.loads((WEB / "samples.json").read_text())
    judge.load_in_background(preheat=[s["text"] for s in samples])
    yield


app = FastAPI(title="cut.", lifespan=lifespan)


class JudgeIn(BaseModel):
    post: str = Field(max_length=8000)
    lines: list[str] = Field(min_length=1, max_length=60)


@app.get("/api/status")
def status():
    return {"state": judge.state, "error": judge.error, "device": judge.device, "model": MODEL_ID}


@app.post("/api/judge")
def run_judge(body: JudgeIn):
    if judge.state == "loading":
        raise HTTPException(503, "Laya is still loading.")
    if judge.state == "error":
        raise HTTPException(500, f"Laya failed to load: {judge.error}")
    return judge.run(body.post, body.lines)


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


def main():
    p = argparse.ArgumentParser(prog="cut", description="An editor that can't write. It can only cut.")
    p.add_argument("--port", type=int, default=4321)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    args = p.parse_args()

    import uvicorn

    url = f"http://{args.host}:{args.port}"
    print(f"cut. is running at {url}")
    print("The first run downloads Laya (843 MB). The page works on the sample posts while it loads.")
    if not args.no_open:
        threading.Timer(1.2, webbrowser.open, (url,)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
