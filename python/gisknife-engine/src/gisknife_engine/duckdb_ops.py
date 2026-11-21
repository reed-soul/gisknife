from __future__ import annotations

import csv
import re
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import duckdb
import geopandas as gpd
from shapely import wkb as shapely_wkb

from .vector_ops import summarize_gdf, write_vector_smart

def current_overture_release() -> str:
    url = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/?list-type=2&delimiter=%2F&prefix=release%2F'
    with urllib.request.urlopen(url, timeout=15) as response:
        root = ET.fromstring(response.read(256_000))
    versions = [prefix.text.split('/')[1] for prefix in root.findall('.//{*}CommonPrefixes/{*}Prefix')
                if prefix.text and re.fullmatch(r'release/\d{4}-\d{2}-\d{2}\.\d+/', prefix.text)]
    if not versions:
        raise ValueError('Overture has no identifiable release')
    return max(versions, key=lambda version: (version[:10], int(version.split('.')[1])))

OVERTURE_LAYER_MAP = {
    "roads": ("transportation", "segment"),
    "buildings": ("buildings", "building"),
    "pois": ("places", "place"),
    "water": ("base", "water"),
    "landuse": ("base", "land_use"),
}


def _open_spatial_duckdb(load_httpfs: bool = False) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(database=":memory:")
    con.execute("INSTALL spatial; LOAD spatial;")
    try:
        con.execute("SET geometry_always_xy = true;")
    except Exception:
        pass
    if load_httpfs:
        con.execute("INSTALL httpfs; LOAD httpfs;")
        con.execute("SET s3_region='us-west-2';")
    return con


def run_spatial_sql(sql: str, output_path: str | None = None, result_crs: str | None = None) -> dict[str, Any]:
    needs_http = any(p in sql.lower() for p in ("http://", "https://", "s3://"))
    con = _open_spatial_duckdb(load_httpfs=needs_http)
    try:
        rel = con.sql(sql)
        col_names = rel.columns
        col_types = [str(t).upper() for t in rel.types]

        geom_cols = [
            name for name, typ in zip(col_names, col_types) if "GEOMETRY" in typ or "WKB_BLOB" in typ
        ]

        if geom_cols:
            geom_col = geom_cols[0]
            other_cols = [c for c in col_names if c != geom_col]
            select_parts = [f'"{c}"' for c in other_cols] + [f'ST_AsWKB("{geom_col}") AS __gisknife_wkb']
            wrapped = f"SELECT {', '.join(select_parts)} FROM ({sql.rstrip(';')}) AS __sub"
            rows = con.execute(wrapped).fetchall()
            out_cols = other_cols
            records: list[dict[str, Any]] = []
            geoms = []
            for row in rows:
                rec = {col: val for col, val in zip(out_cols, row[:-1])}
                raw_wkb = row[-1]
                geoms.append(shapely_wkb.loads(bytes(raw_wkb)) if raw_wkb is not None else None)
                records.append(rec)

            declared_type = str(rel.types[col_names.index(geom_col)])
            tagged = re.fullmatch(r"GEOMETRY\('([^']+)'\)", declared_type, flags=re.I)
            crs = tagged.group(1) if tagged else result_crs
            if not crs and output_path:
                raise ValueError('SQL geometry has no CRS. Supply --result-crs to label its existing coordinates.')
            gdf = gpd.GeoDataFrame(records, geometry=geoms, crs=crs)
            written = write_vector_smart(gdf, output_path) if output_path else None
            return summarize_gdf(
                gdf,
                command="sql",
                output_path=written,
                extra={"rowCount": len(gdf)},
            )

        rows = rel.fetchall()
        dict_rows = [{col: val for col, val in zip(col_names, row)} for row in rows]
        written: str | None = None
        if output_path:
            out_p = Path(output_path).expanduser().resolve()
            out_p.parent.mkdir(parents=True, exist_ok=True)
            with out_p.open("w", encoding="utf-8", newline="") as fp:
                writer = csv.DictWriter(fp, fieldnames=col_names)
                writer.writeheader()
                writer.writerows(dict_rows)
            written = str(out_p)

        return {
            "ok": True,
            "status": "completed",
            "command": "sql",
            "engine": "python-uvx",
            "outputPath": written,
            "rowCount": len(dict_rows),
            "columns": col_names,
            "sampleRows": dict_rows[:20],
            "warnings": [],
        }
    finally:
        con.close()


def fetch_overture_bbox(
    bbox: list[float],
    layers: list[str],
    output_path: str,
    release: str | None = None,
    limit_per_layer: int = 50000,
) -> dict[str, Any]:
    if len(bbox) != 4:
        raise ValueError("bbox must be [minLon, minLat, maxLon, maxLat]")
    min_lon, min_lat, max_lon, max_lat = bbox
    if not (-180 <= min_lon < max_lon <= 180 and -90 <= min_lat < max_lat <= 90):
        raise ValueError('Invalid WGS84 bounding box')
    release = release or current_overture_release()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.\d+', release):
        raise ValueError('Invalid Overture release identifier')
    target_layers = (
        list(OVERTURE_LAYER_MAP) if not layers or "all" in layers else layers
    )

    con = _open_spatial_duckdb(load_httpfs=True)
    frames: list[gpd.GeoDataFrame] = []
    try:
        for layer in target_layers:
            mapping = OVERTURE_LAYER_MAP.get(layer)
            if not mapping:
                raise ValueError(f'Unknown Overture layer: {layer}')
            theme, o_type = mapping
            s3_url = f"s3://overturemaps-us-west-2/release/{release}/theme={theme}/type={o_type}/*"
            sql = f"""
                SELECT
                    id,
                    '{layer}' AS gisknife_layer,
                    COALESCE(names.primary, '') AS name,
                    ST_AsWKB(geometry) AS __gisknife_wkb
                FROM read_parquet('{s3_url}', filename=true, hive_partitioning=1)
                WHERE bbox.xmin <= {max_lon}
                  AND bbox.xmax >= {min_lon}
                  AND bbox.ymin <= {max_lat}
                  AND bbox.ymax >= {min_lat}
                LIMIT {int(limit_per_layer) + 1}
            """
            rows = con.execute(sql).fetchall()
            if len(rows) > limit_per_layer:
                raise ValueError(f'{layer} exceeds {limit_per_layer} features. Request a smaller bounding box.')
            if not rows:
                continue
            records = [{"id": r[0], "layer": r[1], "name": r[2]} for r in rows]
            geoms = [shapely_wkb.loads(bytes(r[3])) for r in rows]
            frames.append(gpd.GeoDataFrame(records, geometry=geoms, crs="EPSG:4326"))
    finally:
        con.close()

    combined = (
        gpd.GeoDataFrame(
            gpd.pd.concat(frames, ignore_index=True),  # type: ignore[attr-defined]
            crs="EPSG:4326",
        )
        if frames
        else gpd.GeoDataFrame({"id": [], "layer": [], "name": []}, geometry=[], crs="EPSG:4326")
    )
    target = Path(output_path).expanduser().resolve()
    if target.suffix.lower() not in ('.parquet', '.geoparquet', '.json', '.geojson'):
        raise ValueError('Overture output must be GeoJSON or GeoParquet')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as directory:
        staged = Path(directory) / target.name
        write_vector_smart(combined, str(staged))
        staged.replace(target)
    written = str(target)
    return summarize_gdf(
        combined,
        command="fetch overture",
        output_path=written,
        extra={"source": f"overture-maps-s3:{release}"},
    )
