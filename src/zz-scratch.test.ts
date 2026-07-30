import { test, expect } from 'bun:test';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';

test('ground sweep categorised', async () => {
  const g = globalThis as any;
  g.location = { search: '?q=high', href: 'http://localhost/' };
  g.window = g;
  const { CitySystem } = await import('./world/city.ts');
  const { initRapier, PhysicsWorld, probeGroups, CG } = await import('./physics/physics.ts');
  const { Rng } = await import('./core/rng.ts');
  await initRapier();
  const scene = new THREE.Scene();
  const services = new Map<string, unknown>();
  const ctx: any = { scene, provide: (k: any, v: any) => services.set(k.id, v), get: (k: any) => services.get(k.id), tryGet: (k: any) => services.get(k.id) };
  const phys = new PhysicsWorld();
  await phys.init(ctx);
  const city = new CitySystem();
  city.init(ctx);
  phys.world.step();
  scene.updateMatrixWorld(true);
  const osm = (g.__GTA_CITY__ as any).osm();

  (THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
  (THREE.Mesh.prototype as any).raycast = acceleratedRaycast;
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { meshes.push(m); (m.geometry as any).computeBoundsTree(); } });

  const ray = new THREE.Raycaster();
  (ray as any).firstHitOnly = false;
  const DOWN = new THREE.Vector3(0, -1, 0);
  const spatial = city.spatial;
  const probe = (x: number, z: number, a: number) => {
    const hit = phys.raycast(new THREE.Vector3(x, a + 1.5, z), DOWN, 5, probeGroups(CG.STATIC | CG.TERRAIN));
    const rY = hit ? hit.point.y : NaN;
    ray.set(new THREE.Vector3(x, a + 1.5, z), DOWN); ray.far = 5;
    let vY = NaN;
    for (const h of ray.intersectObjects(meshes, true)) {
      const n = h.face?.normal; if (!n || Math.abs(n.y) < 0.5) continue;
      if (Number.isNaN(vY) || h.point.y > vY) vY = h.point.y;
    }
    return { rY, vY };
  };




  const localMap = (cx:number, cz:number, half=45, step=1.5) => {
    console.log(`=== map around (${cx},${cz})`);
    for (let z=cz-half; z<=cz+half; z+=step*1.6) {
      let row='';
      for (let x=cx-half; x<=cx+half; x+=step) {
        ray.set(new THREE.Vector3(x, 60, z), DOWN); ray.far = 200;
        const hs = ray.intersectObjects(meshes, true);
        const top = hs.length ? hs[0] : null;
        const y = top ? top.point.y : -99;
        row += !top ? ' ' : y > 3 ? 'B' : y > 0.1 ? 'p' : y > -0.05 ? 'r' : '.';
      }
      console.log(row);
    }
  };
  localMap(-46, 46);
  localMap(335.5, -548.5);
  expect(1).toBe(1);
});
