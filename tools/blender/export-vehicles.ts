/** Export runtime vehicle parts without a DOM or a browser. Run with Bun. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BufferGeometry } from 'three';
import { MODELS } from '../../src/vehicles/models';
import { wheelGeometry } from '../../src/vehicles/wheels';

const round = (n: number) => Math.round(n * 1e6) / 1e6;
function mesh(id: string, geometry: BufferGeometry, kind: string, offset = [0, 0, 0]) {
  const attribute = (name: string) => Array.from(geometry.getAttribute(name).array, round);
  return { id, kind, offset, position: attribute('position'), normal: attribute('normal'),
    color: attribute('color'), surface: attribute('aMat'), uv: attribute('uv'),
    lightA: attribute('aLightA'), lightB: attribute('aLightB'),
    index: geometry.index ? Array.from(geometry.index.array) : undefined };
}

const requested = process.argv.slice(2);
const ids = requested.length ? requested : Object.keys(MODELS);
const assets = ids.flatMap((id) => {
  const model = MODELS[id];
  if (!model) throw new Error(`Unknown vehicle model: ${id}`);
  return (id === 'dacia1300' ? [false, true] : [false]).map((hero) => {
    const build = model.build(0, hero);
    const spec = model.spec;
    const parts = [mesh('shell', build.shell, 'shell'), mesh('glass', build.glass, 'glass')];
    for (const door of build.doors ?? []) {
      parts.push(mesh(`${door.id}.shell`, door.shell, 'door', door.hinge.toArray()));
      parts.push(mesh(`${door.id}.glass`, door.glass, 'glass', door.hinge.toArray()));
    }
    for (const [axle, z] of [spec.frontAxleZ, spec.rearAxleZ, ...spec.extraAxles ?? []].entries()) {
      for (const side of spec.twoWheeled ? [1] as const : [-1, 1] as const) {
        parts.push(mesh(`wheel.${axle}.${side > 0 ? 'left' : 'right'}`,
          wheelGeometry(spec.wheelStyle, spec.wheelRadius, spec.tyreWidth, side), 'wheel',
          [spec.twoWheeled ? 0 : side * spec.trackHalf, spec.wheelRadius - spec.rideHeight, z]));
      }
    }
    return { id: id + (hero ? '.hero' : ''), label: model.label, hero, spec, parts,
      doors: (build.doors ?? []).map((door) => ({ id: door.id, side: door.side,
        hinge: door.hinge.toArray(), angle: door.maxAngle, seat: door.seat.toArray(), board: door.board.toArray() })),
      anchors: { headlights: build.anchors.headlights.map((p) => p.toArray()),
        taillights: build.anchors.taillights.map((p) => p.toArray()),
        exhaust: build.anchors.exhaust.map((p) => p.toArray()) } };
  });
});
const out = resolve('tools/blender/input/vehicles.json');
mkdirSync(resolve('tools/blender/input'), { recursive: true });
writeFileSync(out, JSON.stringify({ version: 1, units: 'metres', up: 'Y', assets }));
console.log(`Exported ${assets.length} vehicles / ${assets.reduce((n, a) => n + a.parts.length, 0)} editable parts to ${out}`);
