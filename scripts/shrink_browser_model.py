"""Build the model files the static site downloads: Laya with 8-bit weights and half-precision token
embeddings (534 MB instead of 1.7 GB). On the sample posts it gives the same top label as the full model
on every line, with probabilities within 0.03.

1. Export Laya to ONNX with the script from Laya's repo:
     git clone https://github.com/NandhaKishorM/laya
     uv run --with laya --with onnx --with onnxruntime --with onnxscript \\
       python laya/laya-ts/scripts/export_onnx.py --repo convaiinnovations/laya --out-dir ./onnx
2. Shrink it:
     uv run --with onnx --with onnxruntime python scripts/shrink_browser_model.py ./onnx ./browser-model
3. Upload browser-model/ to a Hugging Face model repo and point DEFAULT_MODEL in cut/web/browser-laya.js
   at it (update MODEL_BYTES there too).
"""
import shutil
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer

# 8-bit, not 4-bit: 4-bit weights changed the top label on 11 of the 57 sample lines.
QUANT = DefaultWeightOnlyQuantConfig(block_size=32, is_symmetric=True, bits=8)
EMBEDDINGS = "encoder.embeddings.tok_embeddings.weight"


def quantize(model: onnx.ModelProto) -> onnx.ModelProto:
    q = MatMulNBitsQuantizer(model, algo_config=QUANT)
    q.process()
    return q.model.model


def half_embeddings(model: onnx.ModelProto) -> None:
    """Store the token embedding table (50k x 1024) in fp16 and cast lookups back to fp32."""
    table = next(t for t in model.graph.initializer if t.name == EMBEDDINGS)
    table.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(table).astype(np.float16), table.name))
    for i, node in enumerate(model.graph.node):
        if node.op_type == "Gather" and node.input[0] == EMBEDDINGS:
            out = node.output[0]
            node.output[0] = out + "_f16"
            model.graph.node.insert(i + 1, helper.make_node("Cast", [out + "_f16"], [out], to=TensorProto.FLOAT))
            return
    raise SystemExit("token embedding lookup not found; did the export change?")


def main(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    encoder = quantize(onnx.load(src / "encoder.onnx"))
    half_embeddings(encoder)
    # Single files: laya-ts fetches encoder.onnx and head.onnx whole, without external data.
    onnx.save(encoder, dst / "encoder.onnx")
    onnx.save(quantize(onnx.load(src / "head.onnx")), dst / "head.onnx")
    for name in ("tokenizer.json", "rl_agent_config.json"):
        shutil.copy(src / name, dst / name)
    total = sum(f.stat().st_size for f in dst.iterdir() if f.is_file())
    print(f"wrote {dst} ({total:,} bytes; MODEL_BYTES in cut/web/browser-laya.js should match)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: shrink_browser_model.py <onnx export dir> <output dir>")
    main(Path(sys.argv[1]), Path(sys.argv[2]))
