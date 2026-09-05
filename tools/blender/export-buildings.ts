/** Export the runtime building constructors as editable mesh data, without a DOM. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BufferGeometry } from 'three';
import { Rng } from '../../src/core/rng';
import { DetailBuilder, FacadeBuilder, SurfaceBuilder } from '../../src/world/city/builders';
import { BUILDERS, DISTRICTS, PARLIAMENT } from '../../src/world/city/districts';
import { buildBuilding } from '../../src/world/city/facades';
import { buildBuildersHouse, buildParliament, type LandmarkSink } from '../../src/world/city/landmarks';

const round = (n: number) => Math.round(n * 1e6) / 1e6;
function mesh(id: string, geometry: BufferGeometry, origin: number[]) {
  const attributes = Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) => [name, {
    itemSize: attribute.itemSize,
    values: Array.from(attribute.array, (value, i) => round(value - (name === 'position' ? origin[i % 3] : 0))),
  }]));
  const result = { id, attributes, index: geometry.index ? Array.from(geometry.index.array) : undefined };
  geometry.dispose();
  return result;
}

function builders() {
  const facade = new FacadeBuilder();
  const detail = new DetailBuilder();
  const surface = new SurfaceBuilder();
  const sink: LandmarkSink = { facade: () => facade, detail: () => detail, surf: () => surface };
  return { facade, detail, surface, sink };
}
function parts(b: ReturnType<typeof builders>, origin: number[]) {
  return [mesh('facade', b.facade.build(), origin), mesh('detail', b.detail.build(), origin),
    mesh('surface', b.surface.build(), origin)].filter((p) => p.attributes.position.values.length);
}

const bloc = builders();
const site = { cx: 0, cz: 0, w: 46, d: 13, rot: 0, fx: 0, fz: -1, heroDist: 0 };
const blocResult = buildBuilding(site, DISTRICTS.cartier, new Rng('blender-cartier-workshop'),
  bloc.facade, bloc.detail, { levels: 9 });
const house = builders();
const houseResult = buildBuildersHouse(house.sink, new Rng('blender-builders-workshop'));
const parliament = builders();
const parliamentResult = buildParliament(parliament.sink, new Rng('blender-parliament-workshop'));
const assets = [
  { id: 'socialist-bloc', label: 'Bloc de locuințe — cartier', origin: [0, 0, 0],
    source: 'src/world/city/facades.ts: buildBuilding with DISTRICTS.cartier',
    parameters: { site, levels: 9, seed: 'blender-cartier-workshop' },
    runtime: blocResult, parts: parts(bloc, [0, 0, 0]) },
  { id: 'builders-house', label: 'Casa Builderilor', origin: [BUILDERS.x, 0, BUILDERS.z],
    source: 'src/world/city/landmarks.ts: buildBuildersHouse',
    parameters: { seed: 'blender-builders-workshop' },
    runtime: houseResult, parts: parts(house, [BUILDERS.x, 0, BUILDERS.z]) },
  { id: 'parliament', label: 'Palatul Parlamentului', origin: [PARLIAMENT.x, 0, PARLIAMENT.z],
    source: 'src/world/city/landmarks.ts: buildParliament',
    parameters: { seed: 'blender-parliament-workshop' },
    runtime: parliamentResult, parts: parts(parliament, [PARLIAMENT.x, 0, PARLIAMENT.z]) },
];
const out = resolve('tools/blender/input/buildings.json');
mkdirSync(resolve('tools/blender/input'), { recursive: true });
writeFileSync(out, JSON.stringify({ version: 1, units: 'metres', up: 'Y',
  contract: 'Unmodified runtime constructor geometry; deterministic workshop seeds, not an exported city save.', assets }));
console.log(`Exported ${assets.length} buildings / ${assets.reduce((n, a) => n + a.parts.length, 0)} parts to ${out}`);
