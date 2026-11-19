import { buildMcpAppBridgeScript } from '../protocol.js'

export function getPreviewAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>gisknife MCP Layer Preview</title>
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
  <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <style>
    body, html { margin: 0; padding: 0; height: 460px; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    .bar { height: 42px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid #1e293b; font-size: 13px; }
    #map { width: 100%; height: 418px; }
  </style>
</head>
<body>
  <div class="bar">
    <strong>gisknife Layer QA Preview</strong>
    <span id="meta">Waiting for tool result...</span>
  </div>
  <div id="map"></div>
  <script>${buildMcpAppBridgeScript()}</script>
  <script>
    const map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
      },
      center: [113.95, 22.55],
      zoom: 9
    });

    map.on('load', () => {
      map.addSource('qa', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'qa-fill', type: 'fill', source: 'qa', paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.28 } });
      map.addLayer({ id: 'qa-line', type: 'line', source: 'qa', paint: { 'line-color': '#38bdf8', 'line-width': 2 } });
      window.gisknifeMcpHost.initialize().catch(() => {});
    });

    window.gisknifeMcpHost.onNotification((msg) => {
      if (msg.method === 'ui/notifications/tool-result' && msg.params) {
        const p = msg.params;
        if (p.bbox && p.bbox.length === 4) {
          document.getElementById('meta').textContent = (p.featureCount || 0) + ' features · ' + (p.crs || 'EPSG:4326');
          map.fitBounds([[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]], { padding: 30 });
        }
        if (p.geojson && map.getSource('qa')) {
          map.getSource('qa').setData(p.geojson);
        }
      }
    });
  </script>
</body>
</html>`
}
