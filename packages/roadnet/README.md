# `@gisknife/roadnet`

Shared road network domain engine, OSM traffic-network parser (with `highway=traffic_signals` & `type=restriction` support), and self-hosted `roadnet-core` WASM runner for Node.js & Browser.

共享交通路网域引擎：支持 OSM 信号灯（`highway=traffic_signals`）与禁转/强制转向关系（`type=restriction`）解析、自托管 `roadnet-core` WASM 执行器，以及 SUMO plain XML / GeoJSON 无头流水线，可同时运行于 Node.js CLI/MCP 与浏览器工作台（如 GIS Toolbox `/tools/roadnet`）。

## Installation / 安装

```bash
pnpm add @gisknife/roadnet
```

## Subpath Exports / 子路径入口

| Entry | Target | Description / 说明 |
|---|---|---|
| `@gisknife/roadnet` | Pure TS domain & OSM engine | 域模型、CommandBus、拓扑编辑/拼接工具、OSM 信号灯与转向限制解析、SUMO/GeoJSON 构建器（零 Node/DOM 依赖） |
| `@gisknife/roadnet/node` | Node.js pipeline | `node` 环境 WASM 加载与 OSM → `.roadnet.json` / SUMO plain XML / GeoJSON 无头流水线 |
| `@gisknife/roadnet/browser` | Browser client & persistence | 浏览器 WASM Client、OPFS WAL + IndexedDB 恢复存储、Worker Host |
| `@gisknife/roadnet/wasm/*` | Static WASM & glue assets | 自托管 `roadnet-core` WASM 二进制与 JS 胶水文件（`roadnet_core_bg.wasm` 等，共约 6.1 MB） |

## Usage / 用法示例

### Node.js（无头构建 & 校验）

```ts
import { runOsmToRoadnetPipeline } from '@gisknife/roadnet/node'

const result = await runOsmToRoadnetPipeline(osmXml, {
  projectId: 'palo-alto',
  fillet: true,
})

console.log(result.signalsReport.synthesizedPlans)
console.log(result.restrictionsReport.appliedRestrictions)
```

### Browser / 浏览器工作台

静态站点构建时，需将 `node_modules/@gisknife/roadnet/wasm/roadnet-core/` 复制或软链到公开静态目录（例如 `/wasm/roadnet-core/`），并通过 `@gisknife/roadnet/browser` 中的 `createRoadnetCoreClient` 初始化：

```ts
import { createRoadnetCoreClient } from '@gisknife/roadnet/browser'

const client = createRoadnetCoreClient({
  assetBaseUrl: '/wasm/roadnet-core',
})
```

## Static Asset Sizing / 静态资源体积说明

`wasm/roadnet-core/` 内包含常规 32 位与 `mem64` 两个构建产物，总计约 6.1 MB，单文件最大约 4.3 MB，满足静态托管平台（如 Vercel / Cloudflare Pages 单文件 25 MiB 限制）的直接分发要求。
