"""Convert the trained YOLOv8-seg weights into a browser-ready ONNX model.

Step 1 (any env with torch + ultralytics, e.g. pcaso-obb):
    python tools/export_model.py export
Step 2 (any env with onnx + onnxconverter-common + onnxruntime):
    python tools/export_model.py fp16

Outputs model/yolo-seg.onnx (fp16 weights, float32 input/output, < 100 MB so it fits in a
GitHub repo) and model/meta.json (class names, input size).

The model input is fixed at 544x960 (H x W), which fits a 16:9 frame scaled by 0.5 with
2 px of padding top and bottom. That's ~40% less compute than the 960x960 square.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
WEIGHTS = HERE.parent / "segmentation" / "result" / "yolov8m_seg" / "weights" / "best.pt"
FP32 = HERE / "model" / "yolo-seg.fp32.onnx"
OUT = HERE / "model" / "yolo-seg.onnx"
META = HERE / "model" / "meta.json"
H, W = 544, 960


def export():
    import torch
    from ultralytics import YOLO
    from ultralytics.nn.modules import Detect

    yolo = YOLO(str(WEIGHTS))
    model = yolo.model.float().eval().fuse()
    for m in model.modules():
        if isinstance(m, Detect):  # Segment subclasses Detect
            m.dynamic, m.export, m.format = False, True, "onnx"
    im = torch.zeros(1, 3, H, W)
    kw = {}
    if "dynamo" in torch.onnx.export.__code__.co_varnames:
        kw["dynamo"] = False  # newer torch defaults to the dynamo exporter; use the classic one
    with torch.no_grad():
        model(im)  # dry run builds anchors
        torch.onnx.export(model, im, str(FP32), opset_version=17, do_constant_folding=True,
                          input_names=["images"], output_names=["output0", "output1"], **kw)
    names = {int(k): v for k, v in yolo.names.items()}
    META.write_text(json.dumps({"input": [H, W], "names": names, "nm": 32,
                                "source": str(WEIGHTS.relative_to(HERE.parent.parent))}, indent=2))
    print("wrote", FP32, FP32.stat().st_size / 1e6, "MB")


def fp16():
    import onnx
    from onnxconverter_common import float16

    m = onnx.load(str(FP32))
    m16 = float16.convert_float_to_float16(m, keep_io_types=True)
    onnx.save(m16, str(OUT))
    print("wrote", OUT, OUT.stat().st_size / 1e6, "MB")


if __name__ == "__main__":
    {"export": export, "fp16": fp16}[sys.argv[1]]()
