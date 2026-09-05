import { expect, test } from 'bun:test';
import { MODELS } from './models';
import { GeoBuilder } from './builder';
import { UV } from './texture';
import { wheelGeometry } from './wheels';
import { lin, type CarDesign } from './carkit';
import * as THREE from 'three';

test('vehicle paint round-trips sRGB without a second gamma conversion', () => {
  expect(lin(0x808080).r).toBeCloseTo(0.2158605, 6);
  expect(lin(0x808080).getHex()).toBe(0x808080);
});

test('ARO has a low engine bay, a tall passenger roof and four usable doors', () => {
  const model = MODELS.aro24;
  const build = model.build(0, false);
  const position = build.shell.attributes.position;
  let bonnetTop = 0;
  let roofTop = 0;
  for (let i = 0; i < position.count; i++) {
    const height = position.getY(i) + model.spec.rideHeight;
    if (position.getZ(i) > 1.4) bonnetTop = Math.max(bonnetTop, height);
    if (position.getZ(i) < 0.5) roofTop = Math.max(roofTop, height);
  }
  expect(bonnetTop).toBeGreaterThan(1.20);
  expect(bonnetTop).toBeLessThan(1.40);
  expect(roofTop).toBeGreaterThan(1.90);
  expect(build.doors?.map((door) => door.id).sort()).toEqual([
    'frontLeft', 'frontRight', 'rearLeft', 'rearRight',
  ]);
  for (const door of build.doors ?? []) {
    expect(door.shell.attributes.position.count).toBeGreaterThan(100);
    expect(door.glass.attributes.position.count).toBeGreaterThan(0);
    expect(door.maxAngle).toBeGreaterThan(0.8);
  }
});

test('every complete vehicle including driver and all wheels stays below 30000 triangles', () => {
  const variants = Object.values(MODELS).map(model => ({ model, hero: false }));
  variants.push({ model: MODELS.dacia1300, hero: true });
  for (const { model, hero } of variants) {
    const build = model.build(0, hero);
    const spec = model.spec;
    const wheel = wheelGeometry(spec.wheelStyle, spec.wheelRadius, spec.tyreWidth);
    const wheelCount = (spec.twoWheeled ? 1 : 2) * (2 + (spec.extraAxles?.length ?? 0));
    const geometry = [build.shell, build.glass, ...build.doors?.flatMap((d) => [d.shell, d.glass]) ?? [],
      ...build.driver ? [build.driver] : []];
    const bodyTriangles = geometry.reduce((sum, geo) => sum + geo.getAttribute('position').count / 3, 0);
    expect(bodyTriangles + wheelCount * wheel.getAttribute('position').count / 3).toBeLessThan(30000);
    geometry.push(wheel);
    for (const geo of geometry) {
      const position = geo.attributes.position.array;
      expect(Array.from(position).every(Number.isFinite)).toBe(true);
    }
  }
});

test('fleet drivers, named doors and indicators use physical left at every heading', () => {
  const up = new THREE.Vector3(0, 1, 0);
  for (const [id, model] of Object.entries(MODELS)) {
    const build = model.build(0, false);
    if (build.driver && id !== 'scooter') {
      build.driver.computeBoundingBox();
      expect(build.driver.boundingBox!.getCenter(new THREE.Vector3()).x).toBeGreaterThan(0);
    }
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.73, -2.4]) {
      const rotation = new THREE.Quaternion().setFromAxisAngle(up, heading);
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
      const right = forward.clone().cross(up);
      for (const door of build.doors ?? []) {
        const direction = door.id.endsWith('Left') ? -1 : 1;
        for (const point of [door.seat, door.board, door.hinge]) {
          expect(point.clone().applyQuaternion(rotation).dot(right) * direction).toBeGreaterThan(0);
        }
      }
    }
    for (const geometry of [build.shell, ...build.doors?.map(d => d.shell) ?? []]) {
      const lights = geometry.getAttribute('aLightB');
      const positions = geometry.getAttribute('position');
      if (!lights) continue;
      for (let i = 0; i < lights.count; i++) {
        if (lights.getX(i) > 0) expect(positions.getX(i)).toBeGreaterThan(0);
        if (lights.getY(i) > 0) expect(positions.getX(i)).toBeLessThan(0);
      }
    }
  }
});

test('Dacia steering wheel and illuminated instrument pack are in front of the left seat', () => {
  const model = MODELS.dacia1300;
  const d = model.spec as CarDesign;
  const geometry = model.build(0, false).shell;
  const position = geometry.getAttribute('position');
  const lights = geometry.getAttribute('aLightB');
  const wheelY = d.belt - .10 - d.rideHeight;
  const wheelZ = d.wsBase - .46;
  let leftWheelVertices = 0, rightWheelVertices = 0, instruments = 0;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (Math.hypot(x - d.halfWidth * .42, y - wheelY, z - wheelZ) < .19) leftWheelVertices++;
    if (Math.hypot(x + d.halfWidth * .42, y - wheelY, z - wheelZ) < .19) rightWheelVertices++;
    if (lights.getZ(i) > 0) { expect(x).toBeGreaterThan(0); instruments++; }
  }
  expect(leftWheelVertices).toBeGreaterThan(300);
  expect(rightWheelVertices).toBeLessThan(30);
  expect(instruments).toBeGreaterThan(0);
});

test('Dacia greenhouse has transverse roof crown and real side-glass tumblehome', () => {
  const model = MODELS.dacia1300;
  const d = model.spec as CarDesign;
  const build = model.build(0, false);
  const p = build.shell.getAttribute('position');
  const midZ = (d.wsTop + d.rsTop) / 2;
  let crown = -Infinity, edge = -Infinity;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getZ(i) - midZ) > .07) continue;
    const h = p.getY(i) + d.rideHeight;
    if (Math.abs(p.getX(i)) < .05) crown = Math.max(crown, h);
    if (Math.abs(Math.abs(p.getX(i)) - d.hwTop) < .025) edge = Math.max(edge, h);
  }
  expect(crown - edge).toBeGreaterThan(.065);
  expect(d.hwTop / d.halfWidth).toBeLessThan(.84);
  for (const door of build.doors ?? []) {
    const pane = door.glass.getAttribute('position');
    let lowerX = 0, upperX = 0;
    for (let i = 0; i < pane.count; i++) {
      const h = pane.getY(i) + door.hinge.y + d.rideHeight;
      const x = Math.abs(pane.getX(i) + door.hinge.x);
      if (h < d.belt + .07) lowerX = Math.max(lowerX, x);
      if (h > d.height - .15) upperX = Math.max(upperX, x);
    }
    expect(lowerX - upperX).toBeGreaterThan(.09);
    const normals = door.glass.getAttribute('normal');
    let outward = 0;
    for (let i = 0; i < normals.count; i++) outward += normals.getX(i) * door.side;
    expect(outward / normals.count).toBeGreaterThan(.7);
  }
});

test('front tire is not hidden by a wheel-well disc or painted fender', () => {
  const model = MODELS.dacia1300;
  const d = model.spec as CarDesign;
  const build = model.build(0, false);
  const mesh = new THREE.Mesh(build.shell, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  for (const side of [-1, 1]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(side * 1.5, d.wheelRadius - d.rideHeight, d.frontAxleZ),
      new THREE.Vector3(-side, 0, 0));
    const first = ray.intersectObject(mesh)[0];
    expect(first).toBeDefined();
    expect(Math.abs(first.point.x)).toBeLessThan(d.trackHalf - d.tyreWidth * .5);
  }
  (mesh.material as THREE.Material).dispose();
});

test('the cabin has an open interior below the roof instead of a painted belt-height lid', () => {
  const model = MODELS.dacia1300;
  const d = model.spec as CarDesign;
  const mesh = new THREE.Mesh(model.build(0, false).shell, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, d.height - d.rideHeight - .2, -.2), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectObject(mesh)[0];
  expect(hit).toBeDefined();
  expect(hit.point.y + d.rideHeight).toBeLessThan(d.belt - .15);
  (mesh.material as THREE.Material).dispose();
});


test('rounded fittings keep their UVs inside the assigned atlas cell', () => {
  const builder = new GeoBuilder();
  builder.roundedBox(1.4, .075, .12, .032, null, { uv: UV.white });
  const geometry = builder.build();
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    expect(uv.getX(i)).toBeGreaterThanOrEqual(UV.white[0] - 1e-6);
    expect(uv.getX(i)).toBeLessThanOrEqual(UV.white[2] + 1e-6);
    expect(uv.getY(i)).toBeGreaterThanOrEqual(UV.white[1] - 1e-6);
    expect(uv.getY(i)).toBeLessThanOrEqual(UV.white[3] + 1e-6);
  }
  geometry.dispose();
});

test('roof cells and radial window rings share continuous UVs at welded positions', () => {
  const model = MODELS.dacia1300;
  const d = model.spec as CarDesign;
  const build = model.build(0, false);
  const continuous = (geometry: THREE.BufferGeometry, select: (i: number) => boolean) => {
    const p = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    const seen = new Map<string, [number, number]>();
    let matches = 0;
    for (let i = 0; i < p.count; i++) {
      if (!select(i)) continue;
      const key = [p.getX(i), p.getY(i), p.getZ(i)].map(v => Math.round(v * 1e5)).join(',');
      const old = seen.get(key);
      if (old) {
        expect(uv.getX(i)).toBeCloseTo(old[0], 5);
        expect(uv.getY(i)).toBeCloseTo(old[1], 5);
        matches++;
      } else seen.set(key, [uv.getX(i), uv.getY(i)]);
    }
    expect(matches).toBeGreaterThan(100);
  };
  const p = build.shell.getAttribute('position'), n = build.shell.getAttribute('normal');
  continuous(build.shell, i => p.getY(i) + d.rideHeight > d.height - .06 && n.getY(i) > .8 &&
    p.getZ(i) > d.rsTop + .1 && p.getZ(i) < d.wsTop - .1);
  continuous(build.glass, () => true);
  for (const door of build.doors ?? []) continuous(door.glass, () => true);
});


test('rounded window centre bands are triangle fans without zero-area faces', () => {
  for (const id of ['dacia1300', 'dacia1310', 'aro24']) {
    const build = MODELS[id].build(0, false);
    for (const geometry of [build.glass, ...build.doors?.map(d => d.glass) ?? []]) {
      const p = geometry.getAttribute('position');
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let i = 0; i < p.count; i += 3) {
        a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
        expect(b.sub(a).cross(c.sub(a)).lengthSq()).toBeGreaterThan(1e-15);
      }
    }
  }
});
