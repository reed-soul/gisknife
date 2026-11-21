# gisknife-engine

Python engine for the `gisknife` CLI: DuckDB Spatial, GeoPandas, Pyogrio, PyProj and Shapely. Supports vector conversion, topology checks, spatial SQL and bounding-box extraction from Overture. Optional `rasterio` provides GeoTIFF metadata inspection, not raster conversion. The CLI uses a pinned engine version through `uv`; direct users can run `gisknife-engine --capabilities`. Requires Python 3.11–3.13; candidate testing used 3.12.
