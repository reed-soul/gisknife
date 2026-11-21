import { buildMcpAppBridgeScript } from '../protocol.js'

export function getCrsDisambiguatorAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>gisknife CRS Confirmation</title>
  <style>
    body { margin: 0; padding: 16px; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    .card { border: 1px solid #334155; border-radius: 10px; padding: 14px; background: #1e293b; }
    .warn { color: #fbbf24; font-weight: 600; margin-bottom: 8px; }
    .actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    button { border: 1px solid #475569; background: #0f172a; color: #f8fafc; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    button.primary { background: #10b981; border-color: #34d399; color: #052e16; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <div class="warn" id="headline">CGCS2000 CRS / Axis Check</div>
    <p id="detail" style="font-size:13px;color:#cbd5e1;line-height:1.5;">
      Verify whether Easting carries a 2-digit zone prefix (e.g., EPSG:4526 = 385xxxxx vs EPSG:4547 = 5xxxxx) and whether X/Y axes follow GIS (East, North) or surveying (North, East).
    </p>
    <div class="actions">
      <button id="useSuggested" class="primary">Use Suggested CRS / Auto-Fix</button>
      <button id="swapAxes">Swap X/Y Axes</button>
      <button id="keepDeclared">Keep Declared CRS</button>
    </div>
  </div>
  <script>${buildMcpAppBridgeScript()}</script>
  <script>
    let state = {};
    const suggestion = document.getElementById('useSuggested');
    suggestion.disabled = true;
    window.gisknifeMcpHost.initialize().catch(() => {});
    window.gisknifeMcpHost.onNotification((msg) => {
      if (msg.method === 'ui/notifications/tool-result' && msg.params) {
        const result = msg.params.structuredContent || {};
        const warning = result.warnings?.find(item => item.details?.suggestedCrs);
        state = { declaredCrs: result.declaredCrs, suggestedCrs: warning?.details?.suggestedCrs };
        suggestion.disabled = !state.suggestedCrs;
        document.getElementById('detail').textContent = result.warnings?.map(item => item.message).join(' ') || 'No correction suggested.';
      }
    });
    document.getElementById('useSuggested').onclick = () =>
      window.gisknifeMcpHost.sendMessage('Confirmed: re-run CRS transform with auto-fix (' + state.suggestedCrs + ').');
    document.getElementById('swapAxes').onclick = () =>
      window.gisknifeMcpHost.sendMessage('Confirmed: swap input X/Y axes and re-run CRS transform.');
    document.getElementById('keepDeclared').onclick = () =>
      window.gisknifeMcpHost.sendMessage('Confirmed: keep declared CRS ' + state.declaredCrs + '.');
  </script>
</body>
</html>`
}
