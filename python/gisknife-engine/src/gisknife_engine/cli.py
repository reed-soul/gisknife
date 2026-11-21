from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import traceback
from typing import Any

from .duckdb_ops import fetch_overture_bbox, run_spatial_sql
from .raster_ops import has_rasterio, inspect_raster
from .vector_ops import analyze_vector, convert_vector, qa_vector, reproject_vector


def get_capabilities() -> dict[str, Any]:
    return {
        "ok": True,
        "engine": "python-uvx",
        "pythonVersion": sys.version.split()[0],
        "capabilities": {
            "duckdb": importlib.util.find_spec("duckdb") is not None,
            "geopandas": importlib.util.find_spec("geopandas") is not None,
            "pyogrio": importlib.util.find_spec("pyogrio") is not None,
            "pyproj": importlib.util.find_spec("pyproj") is not None,
            "shapely": importlib.util.find_spec("shapely") is not None,
            "rasterio": has_rasterio(),
            "libpysal": importlib.util.find_spec("libpysal") is not None,
        },
    }


def dispatch_rpc(req: dict[str, Any]) -> dict[str, Any]:
    op = req.get("op")
    params = req.get("params") or {}
    if params.get('outputPath'):
        target = Path(params['outputPath']).expanduser()
        for key in ('inputPath', 'secondInputPath'):
            if params.get(key) and target.exists() and target.samefile(Path(params[key]).expanduser()):
                raise ValueError('Output would overwrite an input file')

    if op == "capabilities":
        return get_capabilities()
    if op == "convert":
        return convert_vector(
            input_path=params["inputPath"],
            output_path=params["outputPath"],
            target_crs=params.get("targetCrs"),
        )
    if op == "reproject":
        return reproject_vector(
            input_path=params["inputPath"],
            output_path=params["outputPath"],
            to_crs=params.get("toCrs", "EPSG:4326"),
            from_crs=params.get("fromCrs"),
        )
    if op == "qa":
        return qa_vector(
            input_path=params["inputPath"],
            output_path=params.get("outputPath"),
            fix=bool(params.get("fix", False)),
        )
    if op == "analyze":
        return analyze_vector(
            op=params["analysisOp"],
            input_path=params["inputPath"],
            output_path=params.get("outputPath"),
            second_input_path=params.get("secondInputPath"),
            distance_meters=float(params.get("distanceMeters", 500.0)),
            tolerance=float(params.get("tolerance", 0.0005)),
            dissolve_by=params.get("dissolveBy"),
        )
    if op == "sql":
        return run_spatial_sql(
            sql=params["sql"],
            output_path=params.get("outputPath"),
            result_crs=params.get('resultCrs'),
        )
    if op == "overture_fetch":
        return fetch_overture_bbox(
            bbox=params["bbox"],
            layers=params.get("layers", ["roads", "buildings"]),
            output_path=params["outputPath"],
            release=params.get('release'),
        )
    if op == "raster_inspect":
        return inspect_raster(input_path=params["inputPath"])

    raise ValueError(f"Unknown gisknife-engine RPC op: {op}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gisknife-engine")
    parser.add_argument("--capabilities", action="store_true", help="Print engine capabilities JSON")
    parser.add_argument("--rpc", action="store_true", help="Read JSON RPC request from stdin")
    args = parser.parse_args(argv)

    if args.capabilities:
        print(json.dumps(get_capabilities()))
        return 0

    if args.rpc:
        try:
            raw = sys.stdin.read()
            req = json.loads(raw)
            res = dispatch_rpc(req)
            print(json.dumps(res, ensure_ascii=False))
            return 0
        except Exception as exc:
            err_payload = {
                "ok": False,
                "status": "error",
                "engine": "python-uvx",
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }
            print(json.dumps(err_payload, ensure_ascii=False))
            return 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
