import { buildMcpAppBridgeScript } from '../protocol.js'

export function getPickerAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>gisknife MCP Area Picker</title>
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
  <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <style>
    * { box-sizing: border-box; }
    body, html { margin: 0; padding: 0; height: 480px; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    .bar { height: 46px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid #1e293b; }
    #map { width: 100%; height: 392px; }
    .foot { height: 42px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; font-size: 12px; border-top: 1px solid #1e293b; color: #94a3b8; }
    button { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
    button.primary { background: #10b981; border-color: #34d399; color: #052e16; font-weight: 700; }
  </style>
</head>
<body>
  <div class="bar">
    <strong>gisknife Area Picker (MCP App)</strong>
    <div style="display:flex;gap:6px;">
      <button id="clear">Clear</button>
      <button id="send" class="primary">Send BBox to Agent</button>
    </div>
  </div>
  <div id="map"></div>
  <div class="foot">
    <span id="status">Click two corners on map to draw BBox</span>
    <span id="coords">—</span>
  </div>
  <script>${buildMcpAppBridgeScript()}</script>
  <script>
    let first = null;
    let bbox = null;
    const status = document.getElementById('status');
    const coords = document.getElementById('coords');
    const map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
      },
      center: [-122.15, 37.42],
      zoom: 10
    });

    map.on('load', () => {
      map.addSource('box', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'box-fill', type: 'fill', source: 'box', paint: { 'fill-color': '#10b981', 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'box-line', type: 'line', source: 'box', paint: { 'line-color': '#34d399', 'line-width': 2 } });
      window.gisknifeMcpHost.initialize().catch(() => {});
    });

    window.gisknifeMcpHost.onNotification((msg) => {
      if (msg.method === 'ui/notifications/tool-input' && msg.params && msg.params.bbox) {
        const bb = msg.params.bbox;
        map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 30 });
      }
    });

    map.on('click', (e) => {
      const pt = [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))];
      if (!first) {
        first = pt;
        status.textContent = 'Click opposite corner';
      } else {
        bbox = [Math.min(first[0], pt[0]), Math.min(first[1], pt[1]), Math.max(first[0], pt[0]), Math.max(first[1], pt[1])];
        first = null;
        coords.textContent = JSON.stringify(bbox);
        status.textContent = 'BBox selected';
        map.getSource('box').setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]]
            }
          }]
        });
      }
    });

    document.getElementById('clear').onclick = () => {
      first = null; bbox = null; coords.textContent = '—';
      if (map.getSource('box')) map.getSource('box').setData({ type: 'FeatureCollection', features: [] });
    };

    document.getElementById('send').onclick = async () => {
      if (!bbox) return;
      await window.gisknifeMcpHost.sendMessage('Selected BBox: ' + JSON.stringify(bbox)).catch(() => {});
      status.textContent = 'Sent BBox to host agent';
    };
  </script>
</body>
</html>`
}
