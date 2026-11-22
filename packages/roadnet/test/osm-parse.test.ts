import { describe, expect, it } from 'vitest'
import { parseOsmXml, RoadNetError } from '../src/index.js'

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">'

describe('parseOsmXml', () => {
  it('converts highway defaults, bidirectional split, oneway=-1, lanes, maxspeed, and bridge/tunnel/layer', async () => {
    const xml = `${HEADER}
  <node id="1" lat="22.5000" lon="114.0000"/>
  <node id="2" lat="22.5000" lon="114.0010"/>
  <node id="3" lat="22.5010" lon="114.0010"/>
  <node id="4" lat="22.5010" lon="114.0020"/>
  <way id="10">
    <nd ref="1"/>
    <nd ref="2"/>
    <tag k="highway" v="primary"/>
    <tag k="name" v="Main Ave"/>
    <tag k="lanes" v="4"/>
    <tag k="maxspeed" v="60"/>
    <tag k="bridge" v="yes"/>
    <tag k="layer" v="2"/>
  </way>
  <way id="11">
    <nd ref="2"/>
    <nd ref="3"/>
    <tag k="highway" v="residential"/>
    <tag k="oneway" v="-1"/>
    <tag k="maxspeed" v="30 mph"/>
    <tag k="tunnel" v="yes"/>
    <tag k="layer" v="-1"/>
  </way>
  <way id="12">
    <nd ref="3"/>
    <nd ref="4"/>
    <tag k="highway" v="secondary"/>
    <tag k="lanes:forward" v="3"/>
    <tag k="lanes:backward" v="1"/>
  </way>
</osm>`

    const parsed = await parseOsmXml(xml)
    // Way 10 (bidirectional = 2) + Way 11 (oneway = 1) + Way 12 (bidirectional = 2)
    expect(parsed.stats.edges).toBe(5)
    expect(parsed.stats.namedEdges).toBe(2)

    // Bidirectional way 10 -> forward "10" and backward "-10" with 2 lanes each at 60 km/h (16.67 m/s)
    expect(parsed.files.edg).toContain('<edge id="10" from="1" to="2" numLanes="2" name="Main Ave" type="highway.primary" priority="12" speed="16.67"')
    expect(parsed.files.edg).toContain('<edge id="-10" from="2" to="1" numLanes="2" name="Main Ave" type="highway.primary" priority="12" speed="16.67"')
    expect(parsed.files.edg).toContain('<param key="osmWayId" value="10"/>')
    expect(parsed.files.edg).toContain('<param key="bridge" value="yes"/>')
    expect(parsed.files.edg).toContain('<param key="osmLayer" value="2"/>')

    // oneway=-1 way 11 -> reversed endpoints from="3" to="2", 30 mph = 48.28 kph = 13.41 m/s
    expect(parsed.files.edg).toContain('<edge id="11" from="3" to="2" numLanes="1" type="highway.residential"')
    expect(parsed.files.edg).not.toContain('id="-11"')
    expect(parsed.files.edg).toContain('speed="13.41"')
    expect(parsed.files.edg).toContain('<param key="tunnel" value="yes"/>')
    expect(parsed.files.edg).toContain('<param key="osmLayer" value="-1"/>')

    // asymmetric lanes way 12 -> 3 forward, 1 backward
    expect(parsed.files.edg).toContain('<edge id="12" from="3" to="4" numLanes="3"')
    expect(parsed.files.edg).toContain('<edge id="-12" from="4" to="3" numLanes="1"')
  })

  it('rejects DOCTYPE/ENTITY declarations and safely skips CDATA blocks', async () => {
    await expect(
      parseOsmXml('<?xml version="1.0"?><!DOCTYPE osm [<!ENTITY xxe "bad">]><osm/>'),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const withCdata = `${HEADER}
  <![CDATA[<way id="999"><nd ref="1"/><nd ref="2"/><tag k="highway" v="motorway"/></way>]]>
  <node id="1" lat="22.5" lon="114.0"/>
  <node id="2" lat="22.501" lon="114.0"/>
  <way id="1">
    <nd ref="1"/>
    <nd ref="2"/>
    <tag k="highway" v="tertiary"/>
  </way>
</osm>`
    const parsed = await parseOsmXml(withCdata)
    expect(parsed.stats.edges).toBe(2)
    expect(parsed.files.edg).not.toContain('999')
  })

  it('splits ways at highway=traffic_signals and emits nod/tll traffic signal metadata', async () => {
    const xml = `${HEADER}
  <node id="1" lat="22.5000" lon="114.0000"/>
  <node id="20" lat="22.5000" lon="114.0010">
    <tag k="highway" v="traffic_signals"/>
    <tag k="traffic_signals:direction" v="forward"/>
  </node>
  <node id="3" lat="22.5000" lon="114.0020"/>
  <way id="100">
    <nd ref="1"/>
    <nd ref="20"/>
    <nd ref="3"/>
    <tag k="highway" v="secondary"/>
    <tag k="oneway" v="yes"/>
  </way>
</osm>`

    const parsed = await parseOsmXml(xml)
    expect(parsed.stats.edges).toBe(2)
    expect(parsed.stats.trafficSignals).toBe(1)
    expect(parsed.signals).toEqual([{ nodeId: '20', lon: 114.001, lat: 22.5, direction: 'forward' }])
    expect(parsed.files.edg).toContain('id="100#0" from="1" to="20"')
    expect(parsed.files.edg).toContain('id="100#1" from="20" to="3"')
    expect(parsed.files.nod).toContain('<node id="20" x="114.001" y="22.5" type="traffic_light" tl="20"/>')
    expect(parsed.files.tll).toContain('<tlLogic id="20" type="static" programID="0" offset="0">')
  })

  it('parses type=restriction relations, respects via splits, except=motorcar, and restriction:motorcar', async () => {
    const xml = `${HEADER}
  <node id="1" lat="22.5000" lon="114.0000"/>
  <node id="2" lat="22.5000" lon="114.0010"/>
  <node id="3" lat="22.5000" lon="114.0020"/>
  <node id="4" lat="22.5010" lon="114.0010"/>
  <node id="5" lat="22.4990" lon="114.0010"/>
  <way id="100">
    <nd ref="1"/>
    <nd ref="2"/>
    <nd ref="3"/>
    <tag k="highway" v="primary"/>
  </way>
  <way id="200">
    <nd ref="5"/>
    <nd ref="2"/>
    <nd ref="4"/>
    <tag k="highway" v="secondary"/>
  </way>
  <relation id="9001">
    <member type="way" ref="100" role="from"/>
    <member type="node" ref="2" role="via"/>
    <member type="way" ref="200" role="to"/>
    <tag k="type" v="restriction"/>
    <tag k="restriction" v="no_left_turn"/>
  </relation>
  <relation id="9002">
    <member type="way" ref="200" role="from"/>
    <member type="node" ref="2" role="via"/>
    <member type="way" ref="100" role="to"/>
    <tag k="type" v="restriction:motorcar"/>
    <tag k="restriction:motorcar" v="only_straight_on"/>
  </relation>
  <relation id="9003">
    <member type="way" ref="100" role="from"/>
    <member type="node" ref="2" role="via"/>
    <member type="way" ref="200" role="to"/>
    <tag k="type" v="restriction"/>
    <tag k="restriction" v="no_right_turn"/>
    <tag k="except" v="bicycle;motorcar"/>
  </relation>
</osm>`

    const parsed = await parseOsmXml(xml)
    expect(parsed.stats.turnRestrictions).toBe(2)
    expect(parsed.restrictions.map((r) => r.relationId)).toEqual(['9001', '9002'])

    const r1 = parsed.restrictions[0]
    expect(r1).toMatchObject({
      relationId: '9001',
      restriction: 'no_left_turn',
      kind: 'prohibitory',
      fromWayId: '100',
      toWayId: '200',
      viaNodeId: '2',
    })
    expect(r1.fromEdgeIds).toContain('100#0')
    expect(r1.toEdgeIds).toContain('200#1')
    expect(parsed.files.con).toContain('<prohibition prohibitor="100#0->200#1"')

    const r2 = parsed.restrictions[1]
    expect(r2).toMatchObject({
      relationId: '9002',
      restriction: 'only_straight_on',
      kind: 'mandatory',
    })
    // mandatory only_* does not emit <prohibition> element in con.xml
    expect(parsed.files.con).not.toContain('9002')
  })

  it('produces empty network for non-drivable footways and throws NO_ROADS_FOUND when no ways exist', async () => {
    const footwayOnly = `${HEADER}
  <node id="1" lat="22.5" lon="114.0"/>
  <node id="2" lat="22.501" lon="114.0"/>
  <way id="1">
    <nd ref="1"/>
    <nd ref="2"/>
    <tag k="highway" v="footway"/>
  </way>
</osm>`

    const footwayParsed = await parseOsmXml(footwayOnly)
    expect(footwayParsed.stats.edges).toBe(0)

    try {
      await parseOsmXml(`${HEADER}</osm>`)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(RoadNetError)
      expect((err as RoadNetError).code).toBe('NO_ROADS_FOUND')
    }
  })
})
