from __future__ import annotations

from typing import Any


def has_rasterio() -> bool:
    try:
        import rasterio  # noqa: F401

        return True
    except ImportError:
        return False


def inspect_raster(input_path: str) -> dict[str, Any]:
    try:
        import rasterio
    except ImportError as exc:
        raise RuntimeError(
            "GeoTIFF raster support requires the optional raster extra: "
            "uv tool install 'gisknife-engine[raster]' or uv sync --extra raster"
        ) from exc

    with rasterio.open(input_path) as src:
        bounds = [float(src.bounds.left), float(src.bounds.bottom), float(src.bounds.right), float(src.bounds.top)]
        return {
            "ok": True,
            "status": "completed",
            "command": "raster inspect",
            "engine": "python-uvx",
            "outputPath": input_path,
            "crs": str(src.crs) if src.crs else "unknown",
            "width": int(src.width),
            "height": int(src.height),
            "bandCount": int(src.count),
            "dtypes": list(src.dtypes),
            "nodata": src.nodata,
            "bbox": bounds,
            "driver": src.driver,
            "warnings": [],
        }
