import json
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import LineString, Point, Polygon

from gisknife_engine.cli import dispatch_rpc, get_capabilities


def test_capabilities_probe():
    caps = get_capabilities()
    assert caps["ok"] is True
    assert caps["capabilities"]["duckdb"] is True
    assert caps["capabilities"]["geopandas"] is True
    assert caps["capabilities"]["pyproj"] is True
    assert caps["capabilities"]["shapely"] is True


def test_us_survey_feet_are_not_metres(tmp_path):
    source = tmp_path / 'feet.gpkg'
    line = LineString([(1000000, 200000), (1001000, 200000)])
    gpd.GeoDataFrame(geometry=[line], crs=2263).to_file(source)
    params = {'analysisOp': 'measure', 'inputPath': str(source)}
    result = dispatch_rpc({'op': 'analyze', 'params': params})
    assert result['measure']['totalLengthMeters'] == pytest.approx(304.8, abs=0.01)
    target = tmp_path / 'buffer.gpkg'
    dispatch_rpc({'op': 'analyze', 'params': {**params, 'analysisOp': 'buffer', 'distanceMeters': 304.8, 'outputPath': str(target)}})
    assert gpd.read_file(target).total_bounds[0] == pytest.approx(999000, abs=0.01)
    sql_out = tmp_path / 'sql.gpkg'
    result = dispatch_rpc({'op': 'sql', 'params': {'sql': f"select geom from st_read('{source}')", 'outputPath': str(sql_out)}})
    assert gpd.read_file(sql_out).crs.to_epsg() == 2263
    assert result['featureCount'] == 1
    with pytest.raises(ValueError, match='no CRS'):
        dispatch_rpc({'op': 'sql', 'params': {'sql': 'select ST_Point(1000,2000) as geom', 'outputPath': str(sql_out)}})
    assert gpd.read_file(sql_out).crs.to_epsg() == 2263


def test_square_feet_and_unlabelled_input(tmp_path):
    square = Polygon([(1000000, 200000), (1001000, 200000), (1001000, 201000), (1000000, 201000)])
    source = tmp_path / 'square.gpkg'
    gpd.GeoDataFrame(geometry=[square], crs=2263).to_file(source)
    result = dispatch_rpc({'op': 'analyze', 'params': {'analysisOp': 'measure', 'inputPath': str(source)}})
    assert result['measure']['totalAreaSqMeters'] == pytest.approx((1000 * 1200 / 3937) ** 2, abs=0.01)
    unknown = tmp_path / 'unknown.parquet'
    gpd.GeoDataFrame(geometry=[square]).to_parquet(unknown)
    with pytest.raises(ValueError, match='known horizontal CRS'):
        dispatch_rpc({'op': 'analyze', 'params': {'analysisOp': 'measure', 'inputPath': str(unknown)}})


def test_gbk_shapefile_and_dxf_geometry(tmp_path):
    source = tmp_path / 'gbk.shp'
    points = gpd.GeoDataFrame({'name': ['南山']}, geometry=[Point(114, 22)], crs=4326)
    points.to_file(source, driver='ESRI Shapefile', encoding='GBK')
    out = tmp_path / 'recovered.geojson'
    dispatch_rpc({'op': 'convert', 'params': {'inputPath': str(source), 'outputPath': str(out)}})
    assert gpd.read_file(out).iloc[0]['name'] == '南山'
    cad = tmp_path / 'point.dxf'
    geometry_only = tmp_path / 'point.geojson'
    points[['geometry']].to_file(geometry_only)
    dispatch_rpc({'op': 'convert', 'params': {'inputPath': str(geometry_only), 'outputPath': str(cad)}})
    assert gpd.read_file(cad).geometry.iloc[0].equals(Point(114, 22))


def test_epsg4547_to_wgs84_and_heavy_formats_roundtrip(tmp_path: Path):
    gdf = gpd.GeoDataFrame(
        {"name": ["深圳南山测试点"], "code": [1]},
        geometry=[Point(500000.0, 2500000.0)],
        crs="EPSG:4547",
    )
    src_geojson = tmp_path / "pt_4547.geojson"
    gdf.to_file(src_geojson, driver="GeoJSON")

    # 1. Reproject EPSG:4547 -> EPSG:4326 and verify exact Lon ~ 114.0
    wgs_geojson = tmp_path / "pt_4326.geojson"
    reproj = dispatch_rpc(
        {
            "op": "reproject",
            "params": {
                "inputPath": str(src_geojson),
                "outputPath": str(wgs_geojson),
                "toCrs": "EPSG:4326",
            },
        }
    )
    assert reproj["ok"] is True
    assert abs(reproj["bbox"][0] - 114.0) < 1e-4
    assert 22.5 < reproj["bbox"][1] < 22.7

    # 2. Convert to GeoPackage, GeoParquet, and UTF-8 .zip Shapefile
    gpkg = tmp_path / "out.gpkg"
    pq = tmp_path / "out.parquet"
    shp_zip = tmp_path / "out_shp.zip"

    r_gpkg = dispatch_rpc({"op": "convert", "params": {"inputPath": str(wgs_geojson), "outputPath": str(gpkg)}})
    r_pq = dispatch_rpc({"op": "convert", "params": {"inputPath": str(gpkg), "outputPath": str(pq)}})
    r_zip = dispatch_rpc({"op": "convert", "params": {"inputPath": str(pq), "outputPath": str(shp_zip)}})

    assert r_gpkg["featureCount"] == 1
    assert r_pq["featureCount"] == 1
    assert r_zip["featureCount"] == 1
    assert shp_zip.exists()

    with zipfile.ZipFile(shp_zip) as zf:
        names = zf.namelist()
        assert any(n.endswith(".cpg") for n in names)
        assert any(n.endswith(".shp") for n in names)

    # Read back Chinese attribute cleanly from zip shapefile
    back_geojson = tmp_path / "back.geojson"
    r_back = dispatch_rpc({"op": "convert", "params": {"inputPath": str(shp_zip), "outputPath": str(back_geojson)}})
    assert r_back["featureCount"] == 1
    roundtripped = gpd.read_file(back_geojson)
    assert roundtripped.iloc[0]["name"] == "深圳南山测试点"


def test_duckdb_spatial_sql_and_qa_make_valid(tmp_path: Path):
    bowtie = Polygon([(0, 0), (0, 2), (2, 0), (2, 2), (0, 0)])
    dirty = gpd.GeoDataFrame({"name": ["bowtie"]}, geometry=[bowtie], crs="EPSG:4326")
    dirty_path = tmp_path / "dirty.geojson"
    dirty.to_file(dirty_path, driver="GeoJSON")

    fixed_path = tmp_path / "fixed.geojson"
    qa_res = dispatch_rpc(
        {"op": "qa", "params": {"inputPath": str(dirty_path), "outputPath": str(fixed_path), "fix": True}}
    )
    assert qa_res["qa"]["issueCount"] == 1
    assert qa_res["qa"]["fixed"] is True
    assert fixed_path.exists()

    sql_out = tmp_path / "sql_out.geojson"
    sql_res = dispatch_rpc(
        {
            "op": "sql",
            "params": {
                "sql": f"SELECT name, ST_Area_Spheroid(geom) AS area_m2, geom FROM ST_Read('{fixed_path}')",
                "outputPath": str(sql_out),
            },
        }
    )
    assert sql_res["ok"] is True
    assert sql_res["featureCount"] == 1
    assert sql_out.exists()


def test_metric_buffer_auto_projects_geographic_crs(tmp_path: Path):
    pt = gpd.GeoDataFrame({"name": ["station"]}, geometry=[Point(114.0, 22.55)], crs="EPSG:4326")
    in_path = tmp_path / "station.geojson"
    out_path = tmp_path / "station_500m.geojson"
    pt.to_file(in_path, driver="GeoJSON")

    buf_res = dispatch_rpc(
        {
            "op": "analyze",
            "params": {
                "analysisOp": "buffer",
                "inputPath": str(in_path),
                "outputPath": str(out_path),
                "distanceMeters": 500,
            },
        }
    )
    assert buf_res["ok"] is True
    assert buf_res["crs"] == "EPSG:4326"
    assert any(w["code"] == "AUTO_PROJECTED_METRIC" for w in buf_res["warnings"])
    assert buf_res["geometryTypes"] == ["Polygon"]
