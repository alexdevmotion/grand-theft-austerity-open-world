#!/usr/bin/env node
/**
 * Pull real central-Bucharest geometry from OpenStreetMap into
 * `src/content/bucharest.json`, which the city generator consumes.
 *
 * WHY OSM RATHER THAN DOWNLOADED 3D MODELS
 *   OSM gives *data* — building footprints, storey counts, street centrelines
 *   with classification, squares and landmark polygons — not art. The game
 *   still generates every mesh itself, in its own style, so the result matches
 *   the rest of the city instead of looking like imported furniture. It also
 *   sidesteps the licence mess around scraped 3D models.
 *
 *   Licence: OpenStreetMap contributors, ODbL 1.0. Attribution is required and
 *   lives in docs/reference/ATTRIBUTION.md and the in-game credits.
 *
 * Coordinates are projected to metres on a local tangent plane centred on
 * Piața Universității, then handed to the generator in the game's own axes
 * (+X east, +Z south), so the layout is real but the scale is the game's.
 *
 *   node tools/fetch-osm.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * Mirrors, tried in order. A single combined query over this bbox reliably
 * 504s, so the fetch is split by feature type below and each part retried.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

/** Central Bucharest: Victoriei in the north to Unirii/Parliament in the south. */
const BBOX = { s: 44.4150, w: 26.0700, n: 44.4560, e: 26.1160 };
/** Origin of the local metric frame — Piața Universității. */
const ORIGIN = { lat: 44.4353, lon: 26.1025 };

const B = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;

/** Split by feature type — the combined query exceeds Overpass's time budget. */
/**
 * Buildings are fetched in a 3x3 tile grid. Asked for the whole bbox at once
 * Overpass answers 200 with an EMPTY element list rather than an error — the
 * result silently looks like "there are no buildings in Bucharest". Tiling
 * keeps each response inside its budget.
 */
const TILES = (() => {
  const n = 3, out = [];
  const dLat = (BBOX.n - BBOX.s) / n, dLon = (BBOX.e - BBOX.w) / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const s = BBOX.s + i * dLat, w = BBOX.w + j * dLon;
      out.push(`${s.toFixed(5)},${w.toFixed(5)},${(s + dLat).toFixed(5)},${(w + dLon).toFixed(5)}`);
    }
  }
  return out;
})();

const PARTS = [
  ...TILES.map((t, i) => ({
    name: `buildings ${i + 1}/${TILES.length}`,
    q: `[out:json][timeout:180];(way["building"](${t}););out body geom;`,
  })),
  { name: 'roads', q: `[out:json][timeout:180];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"](${B}););out body geom;` },
  { name: 'extras', q: `[out:json][timeout:180];(way["railway"="tram"](${B});way["leisure"="park"](${B});way["place"="square"](${B});node["place"="square"](${B}););out body geom;` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST one query, walking the mirror list and retrying on 429/504. */
async function overpass(q, label) {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'User-Agent': 'gta-austerity-research/1.0' },
          body: q,
        });
        if (res.ok) return (await res.json()).elements ?? [];
        lastErr = `${res.status} ${res.statusText}`;
        if (res.status !== 429 && res.status !== 504 && res.status !== 503) break;
      } catch (e) {
        lastErr = e.message;
      }
      await sleep(2000);
    }
    await sleep(4000 * (attempt + 1));
  }
  throw new Error(`${label}: ${lastErr}`);
}

const M_PER_DEG_LAT = 111132.0;
const mPerDegLon = (lat) => 111320.0 * Math.cos((lat * Math.PI) / 180);

/** lat/lon -> game metres. +X east, +Z south (three.js right-handed, y up). */
function project(lat, lon) {
  return {
    x: +((lon - ORIGIN.lon) * mPerDegLon(ORIGIN.lat)).toFixed(2),
    z: +(-(lat - ORIGIN.lat) * M_PER_DEG_LAT).toFixed(2),
  };
}

/** Storeys from OSM tags, with a sane fallback by building type. */
function storeys(tags) {
  const lv = parseFloat(tags['building:levels']);
  if (Number.isFinite(lv) && lv > 0) return Math.min(60, Math.round(lv));
  const h = parseFloat(tags.height);
  if (Number.isFinite(h) && h > 0) return Math.max(1, Math.round(h / 3.2));
  const b = tags.building;
  if (b === 'house' || b === 'detached' || b === 'garage') return 1;
  if (b === 'church' || b === 'cathedral') return 3;
  if (b === 'apartments' || b === 'residential') return 5;
  if (b === 'commercial' || b === 'retail' || b === 'office') return 6;
  return 4;
}

const ROAD_CLASS = {
  motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary',
  tertiary: 'tertiary', residential: 'residential', unclassified: 'residential',
  living_street: 'residential', pedestrian: 'pedestrian',
};

async function main() {
  const elements = [];
  for (const part of PARTS) {
    process.stdout.write(`querying ${part.name}… `);
    const els = await overpass(part.q, part.name);
    console.log(`${els.length}`);
    elements.push(...els);
    await sleep(1500); // be a good Overpass citizen
  }
  const raw = { elements };

  const buildings = [];
  const roads = [];
  const trams = [];
  const parks = [];
  const squares = [];

  for (const el of raw.elements) {
    const t = el.tags ?? {};
    const geom = el.geometry ?? (el.members ?? []).flatMap((m) => m.geometry ?? []);
    const pts = geom.filter(Boolean).map((g) => project(g.lat, g.lon));

    if (el.type === 'node' && t.place === 'square') {
      const p = project(el.lat, el.lon);
      squares.push({ name: t.name ?? '', ...p });
      continue;
    }
    if (pts.length < 2) continue;

    if (t.building) {
      if (pts.length < 4) continue;
      buildings.push({
        name: t.name ?? undefined,
        kind: t.building,
        levels: storeys(t),
        // Ring, closed. Rounded to decimetres — plenty for city massing.
        ring: pts.map((p) => [p.x, p.z]),
      });
    } else if (t.highway && ROAD_CLASS[t.highway]) {
      roads.push({
        name: t.name ?? undefined,
        cls: ROAD_CLASS[t.highway],
        lanes: parseInt(t.lanes, 10) || undefined,
        oneway: t.oneway === 'yes' || undefined,
        path: pts.map((p) => [p.x, p.z]),
      });
    } else if (t.railway === 'tram') {
      trams.push({ path: pts.map((p) => [p.x, p.z]) });
    } else if (t.leisure === 'park') {
      parks.push({ name: t.name ?? undefined, ring: pts.map((p) => [p.x, p.z]) });
    } else if (t.place === 'square') {
      squares.push({ name: t.name ?? '', ring: pts.map((p) => [p.x, p.z]) });
    }
  }

  const out = {
    attribution: '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
    origin: ORIGIN,
    bbox: BBOX,
    axes: '+X east, +Z south, metres',
    counts: {
      buildings: buildings.length, roads: roads.length,
      trams: trams.length, parks: parks.length, squares: squares.length,
    },
    buildings, roads, trams, parks, squares,
  };

  mkdirSync('src/content', { recursive: true });
  writeFileSync('src/content/bucharest.json', JSON.stringify(out));
  const named = buildings.filter((b) => b.name).length;
  console.log(
    `buildings ${buildings.length} (${named} named) · roads ${roads.length} · ` +
    `tram ${trams.length} · parks ${parks.length} · squares ${squares.length}`,
  );
  console.log('→ src/content/bucharest.json');
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
