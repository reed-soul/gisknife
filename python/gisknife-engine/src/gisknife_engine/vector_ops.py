from __future__ import annotations

import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import geopandas as gpd
import pyogrio
import shapely
from shapely.validation import explain_validity, make_valid

DRIVER_MAP = {
    ".geojson": "GeoJSON",
    ".json": "GeoJSON",
    ".gpkg": "GPKG",
    ".fgb": "FlatGeobuf",
    ".kml": "KML",
    ".dxf": "DXF",
}


def read_vector_smart(input_path: str) -> gpd.GeoDataFrame:
    path = Path(input_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {path}")

    ext = path.suffix.lower()
    if ext in (".parquet", ".geoparquet"):
        return gpd.read_parquet(path)

    target = f"/vsizip/{path}" if ext == ".zip" else str(path)

    if ext in (".shp", ".zip"):
        for encoding in ("UTF-8", "GB18030", "GBK", "LATIN1"):
            try:
                gdf = gpd.read_file(target, engine="pyogrio", encoding=encoding)
                return gdf
            except Exception:
                continue
        return gpd.read_file(target, engine="pyogrio")

    return gpd.read_file(target, engine="pyogrio")


def write_vector_smart(gdf: gpd.GeoDataFrame, output_path: str) -> str:
    path = Path(output_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix.lower()

    if ext in (".parquet", ".geoparquet"):
        gdf.to_parquet(path, index=False)
        return str(path)

    if ext == ".zip":
        with tempfile.TemporaryDirectory(prefix="gk-shp-") as tmpdir:
            stem = path.stem or "export"
            shp_path = Path(tmpdir) / f"{stem}.shp"
            pyogrio.write_dataframe(gdf, shp_path, driver="ESRI Shapefile", encoding="UTF-8")
            cpg_path = Path(tmpdir) / f"{stem}.cpg"
            cpg_path.write_text("UTF-8", encoding="utf-8")
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for member in Path(tmpdir).iterdir():
                    if member.is_file():
                        zf.write(member, arcname=member.name)
        return str(path)

    if ext == ".shp":
        pyogrio.write_dataframe(gdf, path, driver="ESRI Shapefile", encoding="UTF-8")
        path.with_suffix(".cpg").write_text("UTF-8", encoding="utf-8")
        return str(path)

    driver = DRIVER_MAP.get(ext)
    if driver:
        pyogrio.write_dataframe(gdf, path, driver=driver)
        return str(path)

    pyogrio.write_dataframe(gdf, path)
    return str(path)


def summarize_gdf(
    gdf: gpd.GeoDataFrame,
    command: str,
    output_path: str | None = None,
    warnings: list[dict[str, Any]] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    crs_str = str(gdf.crs) if gdf.crs else "unknown"
    geom_types = sorted({str(t) for t in gdf.geometry.geom_type.dropna().unique()}) if len(gdf) else []
    non_empty = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()] if len(gdf) else gdf
    bbox = [round(float(v), 7) for v in non_empty.total_bounds.tolist()] if len(non_empty) else None
    sample_props = [c for c in gdf.columns if c != gdf.geometry.name][:20]

    envelope: dict[str, Any] = {
        "ok": True,
        "status": "completed",
        "command": command,
        "engine": "python-uvx",
        "crs": crs_str,
        "featureCount": int(len(gdf)),
        "geometryTypes": geom_types,
        "sampleProperties": sample_props,
        "warnings": warnings or [],
    }
    if output_path:
        envelope["outputPath"] = str(Path(output_path).resolve())
    if bbox:
        envelope["bbox"] = bbox
    if extra:
        envelope.update(extra)
    return envelope


def convert_vector(
    input_path: str,
    output_path: str,
    target_crs: str | None = None,
) -> dict[str, Any]:
    gdf = read_vector_smart(input_path)
    if target_crs:
        if gdf.crs is None:
            raise ValueError("Input vector has no CRS defined; pass --from before reprojecting.")
        gdf = gdf.to_crs(target_crs)
    written = write_vector_smart(gdf, output_path)
    return summarize_gdf(gdf, command="convert", output_path=written)


def reproject_vector(
    input_path: str,
    output_path: str,
    to_crs: str = "EPSG:4326",
    from_crs: str | None = None,
) -> dict[str, Any]:
    gdf = read_vector_smart(input_path)
    if from_crs:
        gdf = gdf.set_crs(from_crs, allow_override=True)
    if gdf.crs is None:
        raise ValueError("Source CRS is undefined. Provide from_crs explicitly.")
    gdf = gdf.to_crs(to_crs)
    written = write_vector_smart(gdf, output_path)
    return summarize_gdf(gdf, command="reproject", output_path=written)


def qa_vector(
    input_path: str,
    output_path: str | None = None,
    fix: bool = False,
) -> dict[str, Any]:
    gdf = read_vector_smart(input_path)
    issues: list[dict[str, Any]] = []
    geom_col = gdf.geometry.name

    for idx, geom in enumerate(gdf[geom_col]):
        if geom is None or geom.is_empty:
            issues.append(
                {"featureIndex": idx, "code": "NULL_OR_EMPTY", "message": f"Feature #{idx} is null or empty"}
            )
        elif not shapely.is_valid(geom):
            issues.append(
                {
                    "featureIndex": idx,
                    "code": "INVALID_GEOMETRY",
                    "message": f"Feature #{idx}: {explain_validity(geom)}",
                }
            )

    written: str | None = None
    if fix:
        fixed_geoms = [
            make_valid(g) if (g is not None and not g.is_empty and not shapely.is_valid(g)) else g
            for g in gdf[geom_col]
        ]
        gdf = gdf.copy()
        gdf[geom_col] = fixed_geoms
        gdf = gdf[gdf[geom_col].notna() & ~gdf[geom_col].is_empty].reset_index(drop=True)
        if output_path:
            written = write_vector_smart(gdf, output_path)

    return summarize_gdf(
        gdf,
        command="qa",
        output_path=written,
        extra={
            "qa": {
                "featureCount": int(len(gdf)),
                "issueCount": len(issues),
                "issues": issues[:100],
                "fixed": bool(fix),
            }
        },
    )


def analyze_vector(
    op: str,
    input_path: str,
    output_path: str | None = None,
    second_input_path: str | None = None,
    distance_meters: float = 500.0,
    tolerance: float = 0.0005,
    dissolve_by: str | None = None,
) -> dict[str, Any]:
    gdf = read_vector_smart(input_path)
    warnings: list[dict[str, Any]] = []
    orig_crs = gdf.crs

    if op == "buffer":
        if orig_crs is None:
            raise ValueError("Buffer requires a known CRS.")
        if orig_crs.is_geographic:
            utm = gdf.estimate_utm_crs()
            warnings.append(
                {
                    "code": "AUTO_PROJECTED_METRIC",
                    "message": f"Projected geographic layer to {utm} for accurate {distance_meters}m buffer, then projected back to {orig_crs}.",
                }
            )
            projected = gdf.to_crs(utm)
            projected[projected.geometry.name] = projected.geometry.buffer(distance_meters)
            out_gdf = projected.to_crs(orig_crs)
        else:
            out_gdf = gdf.copy()
            out_gdf[out_gdf.geometry.name] = out_gdf.geometry.buffer(distance_meters)
    elif op == "simplify":
        out_gdf = gdf.copy()
        out_gdf[out_gdf.geometry.name] = out_gdf.geometry.simplify(tolerance, preserve_topology=True)
    elif op == "dissolve":
        out_gdf = gdf.dissolve(by=dissolve_by, as_index=False)
    elif op == "measure":
        if orig_crs is None or orig_crs.is_geographic:
            utm = gdf.estimate_utm_crs() if orig_crs else "EPSG:3857"
            metric = gdf.to_crs(utm) if orig_crs else gdf
        else:
            metric = gdf
        areas = metric.geometry.area
        lengths = metric.geometry.length
        return summarize_gdf(
            gdf,
            command="analyze measure",
            extra={
                "measure": {
                    "featureCount": int(len(gdf)),
                    "totalAreaSqMeters": round(float(areas.sum()), 2),
                    "totalAreaSqKm": round(float(areas.sum() / 1_000_000.0), 4),
                    "totalLengthMeters": round(float(lengths.sum()), 2),
                    "totalLengthKm": round(float(lengths.sum() / 1_000.0), 4),
                }
            },
        )
    elif op in ("clip", "intersect", "union", "difference", "spatial-join"):
        if not second_input_path:
            raise ValueError(f"Operation '{op}' requires second_input_path.")
        other = read_vector_smart(second_input_path)
        if gdf.crs and other.crs and gdf.crs != other.crs:
            other = other.to_crs(gdf.crs)
        if op == "clip":
            out_gdf = gpd.clip(gdf, other)
        elif op == "intersect":
            out_gdf = gpd.overlay(gdf, other, how="intersection")
        elif op == "union":
            out_gdf = gpd.overlay(gdf, other, how="union")
        elif op == "difference":
            out_gdf = gpd.overlay(gdf, other, how="difference")
        else:
            out_gdf = gpd.sjoin(gdf, other, how="inner", predicate="intersects")
    else:
        raise ValueError(f"Unsupported Python vector analysis op: {op}")

    written = write_vector_smart(out_gdf, output_path) if output_path else None
    return summarize_gdf(out_gdf, command=f"analyze {op}", output_path=written, warnings=warnings)
