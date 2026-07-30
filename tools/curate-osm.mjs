#!/usr/bin/env node
/**
 * Curate the raw OSM pull down to a set the game should actually build.
 *
 * The brief is "some buildings and bits and pieces and the overall vibe, don't
 * go crazy" — this is NOT a 1:1 clone of Bucharest. Reproducing 6,855
 * footprints would bury the game's own art direction under a survey, cost a
 * fortune in draw calls, and leave no room for the authored landmarks the
 * story needs (Builders House, the broadcast plaza).
 *
 * What survives, in priority order:
 *   1. every NAMED building        — the ones a Bucharest local would recognise
 *   2. every LARGE footprint       — the monumental blocks that carry the axis
 *   3. buildings FRONTING a square — so the squares read as squares
 *   4. a sparse sample of the rest — street-wall texture, thinned by district
 *
 * Roads, trams, parks and squares are kept whole: they are the *layout*, they
 * are cheap, and they are most of what makes a city feel like a real place.
 *
 *   node tools/curate-osm.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'src/content/bucharest.json';
const OUT = 'src/content/bucharest.json';

/** Roughly how many buildings we want to end up with. */
const TARGET = 1100;
/** Footprint area (m^2) at or above which a building is kept regardless. */
const BIG_AREA = 1800;
/** Distance (m) from a square centre that counts as "fronting" it. */
const SQUARE_RADIUS = 130;

const d = JSON.parse(readFileSync(SRC, 'utf8'));
const before = d.buildings.length;

/** Shoelace area of a closed ring, in m^2 (coords are already metres). */
function area(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

function centroid(ring) {
  let x = 0, z = 0;
  for (const [px, pz] of ring) { x += px; z += pz; }
  return [x / ring.length, z / ring.length];
}

// Square anchors — both mapped squares and the ones the story cares about.
const anchors = [
  ...d.squares.map((s) => (s.ring ? centroid(s.ring) : [s.x, s.z])),
];

const nearSquare = ([x, z]) =>
  anchors.some(([ax, az]) => Math.hypot(x - ax, z - az) < SQUARE_RADIUS);

/** Deterministic hash so the sample is stable across runs. */
function hash(ring) {
  let h = 2166136261;
  const [x, z] = centroid(ring);
  const s = `${x.toFixed(1)},${z.toFixed(1)}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * OSM names most Bucharest apartment blocks by their block number — "Bl. 119",
 * "Bloc P36", "Sc. 2". Those are not landmarks; counting them as named floods
 * the keep-list (784 of 6,855) and buries the buildings a local would actually
 * recognise. They fall through to the sampled tier instead.
 */
const BLOCK_NUMBER = /^(bl\.?|bloc|sc\.?|scara|tronson)\s*[\dA-Z]*$/i;
const isLandmarkName = (n) => !!n && !BLOCK_NUMBER.test(n.trim());

const scored = d.buildings.map((b) => {
  const a = area(b.ring);
  const c = centroid(b.ring);
  return {
    b, a, c,
    named: isLandmarkName(b.name),
    big: a >= BIG_AREA, square: nearSquare(c), r: hash(b.ring),
  };
});

const keep = [];
const rest = [];
for (const s of scored) {
  // Degenerate slivers and sheds add nothing but draw calls.
  if (s.a < 45) continue;
  if (s.named || s.big || s.square) keep.push(s);
  else rest.push(s);
}

// Fill the remainder with a deterministic sample, largest-first-weighted so the
// street wall keeps its bigger blocks rather than a random scatter of sheds.
rest.sort((p, q) => (q.a * 0.6 + q.r * 400) - (p.a * 0.6 + p.r * 400));
const room = Math.max(0, TARGET - keep.length);
keep.push(...rest.slice(0, room));

d.buildings = keep.map((s) => s.b);
d.counts.buildings = d.buildings.length;
d.curation = {
  rawBuildings: before,
  kept: d.buildings.length,
  named: keep.filter((s) => s.named).length,
  large: keep.filter((s) => s.big && !s.named).length,
  fronting: keep.filter((s) => s.square && !s.named && !s.big).length,
  sampled: Math.min(room, rest.length),
  note: 'Selective: landmarks, monumental blocks and square frontages in full; the rest sampled for street-wall texture. Roads/trams/parks/squares kept whole.',
};

writeFileSync(OUT, JSON.stringify(d));
console.log(`buildings ${before} -> ${d.buildings.length}`);
console.log(`  named ${d.curation.named} · large ${d.curation.large} · fronting ${d.curation.fronting} · sampled ${d.curation.sampled}`);
console.log(`roads ${d.counts.roads} · trams ${d.counts.trams} · parks ${d.counts.parks} · squares ${d.counts.squares}`);
