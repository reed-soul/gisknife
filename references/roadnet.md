# Roadnet Build, Edit, Validate & SUMO/GIS Export Reference

The `gisknife roadnet` command group and MCP `gis_roadnet_*` tools embed the WASM `roadnet-core` topological road-network engine together with an upgraded OSM parser supporting traffic signals and turn restrictions.

---

## 1. Supported Subcommands & MCP Tools

| Task | CLI | MCP Tool |
|---|---|---|
| Fetch OSM roads, signals & restrictions (Beta, `<= 300 km²`) | `gisknife roadnet fetch` | `gis_roadnet_fetch` |
| Build from local `.osm` / `.xml` or SUMO plain XML | `gisknife roadnet build <input>` | `gis_roadnet_build` |
| Validate findings & export precheck (`S01`-`S06`) | `gisknife roadnet validate <project>` | _(handled via build/export)_ |
| Batch commands, filtered edits & corner filleting | `gisknife roadnet batch <project>` | `gis_roadnet_command` |
| Export to SUMO plain XML, GeoJSON, or GPKG/SHP/FGB/DXF | `gisknife roadnet export <project>` | `gis_roadnet_export` |

---

## 2. OSM Traffic Signals & Turn Restrictions Semantics

- **Traffic Signals (`highway=traffic_signals`)**:
  - OSM ways passing through signalized nodes are automatically split so the signal node becomes a junction boundary.
  - Emits `type="traffic_light" tl="<id>"` in `.nod.xml` and initial `<tlLogic>` stubs in `.tll.xml`.
  - Unless `--no-signals` / `synthesizeSignals: false` is set, the headless pipeline aligns `sync_signal_phases` and synthesizes a valid two-phase fixed-time plan (`Axis-EW` / `Axis-NS`, green + yellow + all-red clearance matching connection slot count) with zero `S01` or `S06` findings.
- **Turn Restrictions (`type=restriction`, `restriction:motorcar`, `restriction:motor_vehicle`)**:
  - Parses prohibitory (`no_left_turn`, `no_right_turn`, `no_u_turn`, `no_straight_on`, `no_entry`, `no_exit`) and mandatory (`only_left_turn`, `only_right_turn`, `only_straight_on`, `only_u_turn`) relations; ignores time-conditional `@` values and relations with `except=motorcar|motor_vehicle`.
  - Splits ways at `via` nodes, preserves `osmWayId` in edge `<param>` attributes, emits `<prohibition>` elements in `.con.xml` for prohibitory turns, and removes restricted connections after `generate_connections` (before signal synthesis so signal slot counts stay valid).

---

## 3. Destructive Command Guardrail & Compact Envelopes

- `RoadNetCommandBus` blocks destructive commands (`rebuild_topology`, `delete_link`, `split_junction`, `join_junction`, `merge_links`, `set_lane_count`, `delete_lane`, `snap_endpoint`, etc.) unless explicitly approved.
- In CLI (`gisknife roadnet batch`), destructive commands return `status: "confirmation_required"` with preview targets unless `--confirm-destructive` is passed (use `--dry-run` first to inspect deltas).
- In MCP (`gis_roadnet_command`), destructive commands return `status: "confirmation_required"` with affected object refs unless `confirmed: true` is supplied after reviewing the preview.
- Outputs (`.roadnet.json`, `.nod.xml`/`.edg.xml`/`.con.xml`/`.tll.xml`, `.geojson`, or converted GIS files) are written to disk; tool responses return compact JSON summaries plus ODbL 1.0 attribution metadata when OSM data is used.

---

## 4. Examples

```bash
# Fetch OSM road network by bbox and write project + SUMO plain XML + GeoJSON
gisknife roadnet fetch --bbox "114.04,22.53,114.07,22.55" \
  -o ./futian.roadnet.json --plain-dir ./sumo_plain --geojson ./futian_links.geojson --layer links

# Build from a local .osm extract (optionally clip to polygon GeoJSON)
gisknife roadnet build ./extract.osm --polygon ./aoi.geojson -o ./aoi.roadnet.json

# Validate a roadnet project or SUMO plain XML directory
gisknife roadnet validate ./aoi.roadnet.json

# Preview a batch edit, then apply filtered attributes or destructive link removal
gisknife roadnet batch ./aoi.roadnet.json --filter '{"all":[{"field":"roadClass","op":"EQ","value":"highway.residential"}]}' \
  --patch '{"speedKph":30}' -o ./aoi_slow.roadnet.json
gisknife roadnet batch ./aoi.roadnet.json --command '{"command":"delete_link","linkIds":["-100"]}' --dry-run
gisknife roadnet batch ./aoi.roadnet.json --command '{"command":"delete_link","linkIds":["-100"]}' --confirm-destructive -o ./aoi_pruned.roadnet.json

# Export & convert links to EPSG:4547 GeoPackage (requires uv Python engine for reprojection/heavy formats)
gisknife roadnet export ./aoi.roadnet.json --plain-dir ./sumo_out --convert ./roads_4547.gpkg --to-crs EPSG:4547
```
