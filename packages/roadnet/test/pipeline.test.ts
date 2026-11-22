import { describe, expect, it } from 'vitest'
import {
  buildRoadnetFromOsmXml,
  probeRoadnetWasmNode,
} from '../src/node/index.js'
import type { Connection } from '../src/core/types.js'

const CROSS_INTERSECTION_SIGNAL_OSM = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="22.5000" lon="114.0000"/>
  <node id="2" lat="22.5000" lon="114.0010">
    <tag k="highway" v="traffic_signals"/>
  </node>
  <node id="3" lat="22.5000" lon="114.0020"/>
  <node id="4" lat="22.5010" lon="114.0010"/>
  <node id="5" lat="22.4990" lon="114.0010"/>
  <way id="100">
    <nd ref="1"/>
    <nd ref="2"/>
    <nd ref="3"/>
    <tag k="highway" v="primary"/>
    <tag k="name" v="WestEast Ave"/>
  </way>
  <way id="200">
    <nd ref="5"/>
    <nd ref="2"/>
    <nd ref="4"/>
    <tag k="highway" v="secondary"/>
    <tag k="name" v="SouthNorth Rd"/>
  </way>
</osm>`

interface SnapshotJunction {
  junctionId: string
  type: string
  nodeIds: string[]
  connections: Connection[]
  signalPlanId?: string | null
}

interface SnapshotLink {
  linkId: string
  fromNodeId: string
  toNodeId: string
  attributes?: Record<string, string>
}

interface Snapshot {
  links: SnapshotLink[]
  junctions: SnapshotJunction[]
}

describe('roadnet-core WASM Node pipeline', () => {
  it('probes bundled wasm32 & memory64 artifacts with SHA-256 manifest', () => {
    const probe = probeRoadnetWasmNode()
    expect(probe.available).toBe(true)
    expect(probe.coreVersion).toBe('0.1.0')
    expect(probe.variants).toContain('wasm32')
    expect(probe.variants).toContain('memory64')
  })

  it('splits crossing ways during rebuild_topology when no explicit node is shared', async () => {
    const crossingXml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="22.5000" lon="114.0000"/>
  <node id="2" lat="22.5000" lon="114.0020"/>
  <node id="3" lat="22.4990" lon="114.0010"/>
  <node id="4" lat="22.5010" lon="114.0010"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="primary"/><tag k="oneway" v="yes"/>
  </way>
  <way id="20">
    <nd ref="3"/><nd ref="4"/>
    <tag k="highway" v="secondary"/><tag k="oneway" v="yes"/>
  </way>
</osm>`

    const built = await buildRoadnetFromOsmXml(crossingXml, {
      projectId: 'cross-split',
      fillet: false,
      synthesizeSignals: false,
      applyRestrictions: false,
    })
    try {
      expect(built.summary.links).toBeGreaterThanOrEqual(4)
      expect(built.summary.junctions).toBeGreaterThanOrEqual(1)
    } finally {
      await built.session.dispose()
    }
  })

  it('builds a traffic_light junction with synthesized 2-phase signal plan and zero S01/S06 findings', async () => {
    const built = await buildRoadnetFromOsmXml(CROSS_INTERSECTION_SIGNAL_OSM, {
      projectId: 'signal-4way',
      fillet: false,
    })
    try {
      expect(built.signalsReport.signalizedJunctions).toBe(1)
      expect(built.signalsReport.synthesizedPlans).toBe(1)

      const s01OrS06 = built.findings.filter((f) => f.ruleId === 'S01' || f.ruleId === 'S06')
      expect(s01OrS06).toEqual([])

      const plain = await built.session.core.exportPlainXml()
      expect(plain.nod).toContain('type="traffic_light"')
      expect(plain.tll).toContain('<tlLogic')
      expect(plain.tll).toContain('<phase duration="30"')
      expect(plain.tll).toContain('<phase duration="3"')
    } finally {
      await built.session.dispose()
    }
  })

  it('enforces no_left_turn restriction (West -> North blocked, straight & right remain)', async () => {
    const xmlWithNoLeft = CROSS_INTERSECTION_SIGNAL_OSM.replace(
      '</osm>',
      `  <relation id="501">
    <member type="way" ref="100" role="from"/>
    <member type="node" ref="2" role="via"/>
    <member type="way" ref="200" role="to"/>
    <tag k="type" v="restriction"/>
    <tag k="restriction" v="no_left_turn"/>
  </relation>
</osm>`,
    )

    const built = await buildRoadnetFromOsmXml(xmlWithNoLeft, {
      projectId: 'restriction-no-left',
      fillet: false,
    })
    try {
      expect(built.restrictionsReport.appliedRestrictions).toBe(1)
      expect(built.restrictionsReport.removedConnections).toBeGreaterThan(0)
      expect(built.findings.filter((f) => f.ruleId === 'S06')).toEqual([])

      const snap = JSON.parse(await built.session.core.projectJson()) as Snapshot
      const linkById = new Map(snap.links.map((l) => [l.linkId, l]))
      const center = snap.junctions.find((j) => j.nodeIds.includes('2'))
      expect(center).toBeDefined()

      // Approach from West (node 1 -> node 2, osmWayId=100) must NOT connect to node 4 (North, osmWayId=200)
      const fromWestConns = center!.connections.filter((c) => {
        const from = linkById.get(c.fromLinkId)
        return from?.fromNodeId === '1' && from?.toNodeId === '2'
      })
      expect(fromWestConns.some((c) => linkById.get(c.toLinkId)?.toNodeId === '4')).toBe(false)
      // Straight to node 3 (East) still exists
      expect(fromWestConns.some((c) => linkById.get(c.toLinkId)?.toNodeId === '3')).toBe(true)
    } finally {
      await built.session.dispose()
    }
  })

  it('enforces only_straight_on mandatory restriction (keeps straight, removes left/right)', async () => {
    const xmlWithOnlyStraight = CROSS_INTERSECTION_SIGNAL_OSM.replace(
      '</osm>',
      `  <relation id="502">
    <member type="way" ref="100" role="from"/>
    <member type="node" ref="2" role="via"/>
    <member type="way" ref="100" role="to"/>
    <tag k="type" v="restriction"/>
    <tag k="restriction" v="only_straight_on"/>
  </relation>
</osm>`,
    )

    const built = await buildRoadnetFromOsmXml(xmlWithOnlyStraight, {
      projectId: 'restriction-only-straight',
      fillet: false,
    })
    try {
      expect(built.restrictionsReport.appliedRestrictions).toBe(1)
      const snap = JSON.parse(await built.session.core.projectJson()) as Snapshot
      const linkById = new Map(snap.links.map((l) => [l.linkId, l]))
      const center = snap.junctions.find((j) => j.nodeIds.includes('2'))!

      const fromWestConns = center.connections.filter((c) => {
        const from = linkById.get(c.fromLinkId)
        return from?.fromNodeId === '1' && from?.toNodeId === '2'
      })
      expect(fromWestConns.length).toBeGreaterThan(0)
      expect(fromWestConns.every((c) => linkById.get(c.toLinkId)?.attributes?.osmWayId === '100')).toBe(true)
    } finally {
      await built.session.dispose()
    }
  })

  it('blocks unconfirmed destructive command and executes after preview + confirmPreview', async () => {
    const built = await buildRoadnetFromOsmXml(CROSS_INTERSECTION_SIGNAL_OSM, {
      projectId: 'destructive-guard',
      fillet: false,
    })
    try {
      const snap = JSON.parse(await built.session.core.projectJson()) as Snapshot
      const targetLink = snap.links[0].linkId

      await expect(
        built.session.bus.execute({ command: 'delete_link', linkIds: [targetLink], withReverse: false }),
      ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })

      const preview = await built.session.bus.preview(
        { command: 'delete_link', linkIds: [targetLink], withReverse: false },
        'user',
      )
      built.session.bus.confirmPreview(preview.previewRef)
      const res = await built.session.bus.execute(
        { command: 'delete_link', linkIds: [targetLink], withReverse: false },
        { previewRef: preview.previewRef },
      )
      expect(res.revision).toBeGreaterThan(0)
    } finally {
      await built.session.dispose()
    }
  })
})
