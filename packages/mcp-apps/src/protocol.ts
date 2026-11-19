export const MCP_APP_EXTENSION = 'io.modelcontextprotocol/ui'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

export interface McpAppResourceDescriptor {
  uri: string
  name: string
  title: string
  description: string
  mimeType: typeof MCP_APP_MIME_TYPE
}

export const MCP_APP_URIS = {
  picker: 'ui://gisknife/picker',
  preview: 'ui://gisknife/preview',
  crsDisambiguator: 'ui://gisknife/crs-disambiguator',
} as const

/**
 * Minimal framework-agnostic guest JSON-RPC postMessage bridge compliant with
 * MCP Apps (`io.modelcontextprotocol/ui`) for sandboxed iframe hosts.
 */
export function buildMcpAppBridgeScript(): string {
  return `
  (function () {
    let nextId = 1;
    const pending = new Map();
    const listeners = [];

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP host error'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });

    function request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params: params || {} }, '*');
      });
    }

    function notify(method, params) {
      window.parent.postMessage({ jsonrpc: '2.0', method, params: params || {} }, '*');
    }

    window.gisknifeMcpHost = {
      initialize: () => request('ui/initialize', {
        appInfo: { name: 'gisknife-mcp-app', version: '0.1.0' },
        protocolVersion: '2026-01-26'
      }),
      callTool: (name, args) => request('tools/call', { name, arguments: args || {} }),
      sendMessage: (text) => request('ui/message', { role: 'user', content: [{ type: 'text', text }] }),
      onNotification: (fn) => listeners.push(fn),
      notifySizeChanged: (height) => notify('ui/notifications/size-changed', { height })
    };
  })();
  `
}
