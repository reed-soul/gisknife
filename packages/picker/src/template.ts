export type PickerMode = 'bbox' | 'polygon' | 'file'

export interface PickerTemplateOptions {
  mode: PickerMode
  title?: string
  initialCenter?: [number, number]
  initialZoom?: number
  initialBbox?: [number, number, number, number]
}

export function renderPickerHtml(options: PickerTemplateOptions): string {
  const title = (options.title ?? 'gisknife Interactive Area & File Picker').replace(/</g, '&lt;')
  const center = options.initialCenter ?? [113.95, 22.55]
  const zoom = options.initialZoom ?? 10
  const initBbox = options.initialBbox ? JSON.stringify(options.initialBbox) : 'null'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
  <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <style>
    * { box-sizing: border-box; }
    body, html { margin: 0; padding: 0; height: 100%; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; }
    .header { height: 56px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; background: #0f172a; }
    .title { font-weight: 700; font-size: 15px; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
    button.active { background: #0284c7; border-color: #38bdf8; color: #fff; }
    button.primary { background: #10b981; border-color: #34d399; color: #052e16; font-weight: 700; }
    button.danger { background: #7f1d1d; border-color: #ef4444; color: #fecaca; }
    #map { position: absolute; inset: 56px 320px 32px 0; }
    .sidebar { position: absolute; top: 56px; right: 0; bottom: 32px; width: 320px; padding: 14px; background: #111827; border-left: 1px solid #1e293b; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
    .dropzone { border: 2px dashed #334155; border-radius: 10px; padding: 16px; text-align: center; font-size: 13px; color: #94a3b8; cursor: pointer; }
    .dropzone.drag { border-color: #38bdf8; color: #e0f2fe; background: #0c4a6e33; }
    pre { background: #020617; padding: 10px; border-radius: 8px; font-size: 12px; overflow: auto; max-height: 220px; border: 1px solid #1e293b; margin: 0; }
    .footer { position: absolute; left: 0; right: 0; bottom: 0; height: 32px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: #94a3b8; border-top: 1px solid #1e293b; }
  </style>
</head>
<body>
  <header class="header">
    <div class="title">${title}</div>
    <div class="toolbar">
      <button id="modeBbox" class="${options.mode === 'bbox' ? 'active' : ''}">Draw BBox</button>
      <button id="modePoly" class="${options.mode === 'polygon' ? 'active' : ''}">Draw Polygon</button>
      <button id="finishPoly" style="display:none;">Close Polygon</button>
      <button id="clearBtn">Clear</button>
      <button id="cancelBtn" class="danger">Cancel</button>
      <button id="confirmBtn" class="primary">Confirm Selection</button>
    </div>
  </header>
  <div id="map"></div>
  <aside class="sidebar">
    <div style="font-size:13px;color:#cbd5e1;line-height:1.5;">
      <strong>Instructions:</strong><br/>
      • <b>Draw BBox</b>: click two opposite corners on the map.<br/>
      • <b>Draw Polygon</b>: click vertices, then click <em>Close Polygon</em>.<br/>
      • <b>Drop File</b>: drop a local GeoJSON / CSV file below.
    </div>
    <div id="dropzone" class="dropzone">
      Drop GeoJSON / CSV here or click to browse
      <input id="fileInput" type="file" accept=".geojson,.json,.csv" style="display:none;" />
    </div>
    <div>
      <div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">Selection Preview</div>
      <pre id="preview">No selection yet.</pre>
    </div>
  </aside>
  <footer class="footer">
    <span id="status">Ready</span>
    <span>Local ephemeral server — selection never leaves your machine</span>
  </footer>
  <script>
    let mode = ${JSON.stringify(options.mode)};
    let firstCorner = null;
    let polyPoints = [];
    let selectedBbox = ${initBbox};
    let selectedGeometry = null;
    let uploadedFile = null;

    const previewEl = document.getElementById('preview');
    const statusEl = document.getElementById('status');
    const finishBtn = document.getElementById('finishPoly');

    const map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 }
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
      },
      center: ${JSON.stringify(center)},
      zoom: ${zoom}
    });

    function bboxToPoly(bb) {
      return {
        type: 'Polygon',
        coordinates: [[[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]]
      };
    }

    function updateOverlay() {
      const features = [];
      if (selectedGeometry) {
        features.push({ type: 'Feature', properties: {}, geometry: selectedGeometry });
      } else if (polyPoints.length >= 2) {
        features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: polyPoints } });
      }
      const fc = { type: 'FeatureCollection', features };
      if (map.getSource('pick')) {
        map.getSource('pick').setData(fc);
      }
      previewEl.textContent = JSON.stringify({ mode, bbox: selectedBbox, geometry: selectedGeometry, uploadedFile: uploadedFile ? { name: uploadedFile.name, bytes: uploadedFile.content.length } : null }, null, 2);
    }

    map.on('load', () => {
      map.addSource('pick', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'pick-fill', type: 'fill', source: 'pick', paint: { 'fill-color': '#10b981', 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'pick-line', type: 'line', source: 'pick', paint: { 'line-color': '#34d399', 'line-width': 2.5 } });
      if (selectedBbox) {
        selectedGeometry = bboxToPoly(selectedBbox);
        updateOverlay();
        map.fitBounds([[selectedBbox[0], selectedBbox[1]], [selectedBbox[2], selectedBbox[3]]], { padding: 40, duration: 0 });
      }
    });

    map.on('click', (e) => {
      const pt = [Number(e.lngLat.wrap().lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))];
      if (mode === 'bbox') {
        if (!firstCorner) {
          firstCorner = pt;
          selectedBbox = null;
          selectedGeometry = null;
          statusEl.textContent = 'Click opposite corner to finish BBox';
        } else {
          selectedBbox = [
            Math.min(firstCorner[0], pt[0]),
            Math.min(firstCorner[1], pt[1]),
            Math.max(firstCorner[0], pt[0]),
            Math.max(firstCorner[1], pt[1])
          ];
          selectedGeometry = bboxToPoly(selectedBbox);
          firstCorner = null;
          statusEl.textContent = 'BBox captured';
          updateOverlay();
        }
      } else if (mode === 'polygon') {
        polyPoints.push(pt);
        finishBtn.style.display = polyPoints.length >= 3 ? 'inline-block' : 'none';
        statusEl.textContent = 'Added vertex #' + polyPoints.length;
        updateOverlay();
      }
    });

    finishBtn.onclick = () => {
      if (polyPoints.length < 3) return;
      const ring = [...polyPoints, polyPoints[0]];
      selectedGeometry = { type: 'Polygon', coordinates: [ring] };
      const xs = ring.map(p => p[0]);
      const ys = ring.map(p => p[1]);
      selectedBbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      polyPoints = [];
      finishBtn.style.display = 'none';
      statusEl.textContent = 'Polygon closed';
      updateOverlay();
    };

    document.getElementById('modeBbox').onclick = () => {
      document.getElementById('clearBtn').click(); mode = 'bbox';
      document.getElementById('modeBbox').classList.add('active');
      document.getElementById('modePoly').classList.remove('active');
    };
    document.getElementById('modePoly').onclick = () => {
      document.getElementById('clearBtn').click(); mode = 'polygon';
      document.getElementById('modePoly').classList.add('active');
      document.getElementById('modeBbox').classList.remove('active');
    };
    document.getElementById('clearBtn').onclick = () => {
      firstCorner = null; polyPoints = []; selectedBbox = null; selectedGeometry = null; uploadedFile = null;
      finishBtn.style.display = 'none';
      updateOverlay();
      statusEl.textContent = 'Cleared';
    };

    const dz = document.getElementById('dropzone');
    const fi = document.getElementById('fileInput');
    dz.onclick = () => fi.click();
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
    dz.ondragleave = () => dz.classList.remove('drag');
    const handleFile = async (file) => {
      if (file.size > 8 * 1024 * 1024) { statusEl.textContent = 'Choose a file under 8 MiB or use the CLI.'; return; }
      const content = await file.text();
      document.getElementById('clearBtn').click(); mode = 'file';
      uploadedFile = { name: file.name, content };
      statusEl.textContent = 'Loaded local file: ' + file.name;
      if (file.name.endsWith('.json') || file.name.endsWith('.geojson')) {
        try {
          const parsed = JSON.parse(content);
          if (map.getSource('pick')) map.getSource('pick').setData(parsed);
        } catch {}
      }
      updateOverlay();
    };
    dz.ondrop = (e) => {
      e.preventDefault(); dz.classList.remove('drag');
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    };
    fi.onchange = () => { if (fi.files[0]) handleFile(fi.files[0]); };

    async function submitSelection(cancelled) {
      const payload = { cancelled, mode, bbox: selectedBbox, geometry: selectedGeometry, uploadedFile };
      try {
        const response = await fetch('/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!response.ok) { statusEl.textContent = 'Selection not accepted. Check the area or choose a smaller file.'; return; }
        document.body.textContent = (cancelled ? 'Selection cancelled.' : 'Selection sent to gisknife.') + ' You may close this tab.';
      } catch { statusEl.textContent = 'Picker is no longer available. Restart the command.'; }
    }
    document.getElementById('confirmBtn').onclick = () => submitSelection(false);
    document.getElementById('cancelBtn').onclick = () => submitSelection(true);
  </script>
</body>
</html>`
}
