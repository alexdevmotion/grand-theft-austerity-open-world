/**
 * City generation + road graph.
 *
 * OWNER: city agent. This baseline delivers a working, navigable grid with a
 * real road graph, district zoning, ground/collision, and placeholder massing.
 * The city agent must replace the massing with believable Bucharest
 * architecture (glass towers, communist blocks, old-town facades, the
 * Palace of Parliament axis), add pavements, kerbs, tram lines, street
 * furniture and facade detail — WITHOUT changing the CityService contract.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { Palette, WorldScale } from '../artDirection';
import {
  Services,
  type CityService,
  type DistrictKind,
  type Landmark,
  type RoadNode,
  type SpatialQuery,
} from '../core/services';
import { Rng, fbm2D } from '../core/rng';

const { blockSize, gridBlocks, roadWidth } = WorldScale;
const HALF = (gridBlocks * blockSize) / 2;

export class CitySystem implements System, CityService {
  readonly name = 'city';
  readonly order = 20;

  readonly roadNodes: RoadNode[] = [];
  readonly landmarks = new Map<string, Landmark>();
  readonly spatial: SpatialQuery;

  private nodeGrid = new Map<string, number>();
  private buildingBoxes: Array<{ x: number; z: number; hx: number; hz: number }> = [];
  private root = new THREE.Group();
  private rng = new Rng('bucuresti');
  private ctx!: GameContext;

  constructor() {
    const self = this;
    this.spatial = {
      snapToRoad(p, out) {
        const id = self.nearestNode(p);
        if (id < 0) return false;
        out.copy(self.roadNodes[id].position);
        return true;
      },
      groundHeight(x, z) {
        return Math.abs(x) > HALF || Math.abs(z) > HALF ? -Infinity : 0;
      },
      isBlocked(x, z) {
        for (const b of self.buildingBoxes) {
          if (Math.abs(x - b.x) < b.hx && Math.abs(z - b.z) < b.hz) return true;
        }
        return false;
      },
    };
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.City, this);
    this.root.name = 'city';
    ctx.scene.add(this.root);

    this.buildRoadGraph();
    this.buildGround();
    this.buildMassing();
    this.registerLandmarks();
  }

  /* ---------------- road graph ---------------- */

  private buildRoadGraph(): void {
    const n = gridBlocks + 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = -HALF + i * blockSize;
        const z = -HALF + j * blockSize;
        const id = this.roadNodes.length;
        // Every 4th street is a boulevard with more lanes.
        const boulevard = i % 4 === 0 || j % 4 === 0;
        this.roadNodes.push({
          id,
          position: new THREE.Vector3(x, 0, z),
          links: [],
          lanes: boulevard ? 3 : 2,
          isIntersection: true,
          hasTrafficLight: boulevard && (i % 4 === 0 && j % 4 === 0),
        });
        this.nodeGrid.set(`${i},${j}`, id);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const id = this.nodeGrid.get(`${i},${j}`)!;
        const right = this.nodeGrid.get(`${i + 1},${j}`);
        const down = this.nodeGrid.get(`${i},${j + 1}`);
        if (right !== undefined) {
          this.roadNodes[id].links.push(right);
          this.roadNodes[right].links.push(id);
        }
        if (down !== undefined) {
          this.roadNodes[id].links.push(down);
          this.roadNodes[down].links.push(id);
        }
      }
    }
  }

  /* ---------------- ground ---------------- */

  private buildGround(): void {
    const phys = this.findPhysics();
    const size = gridBlocks * blockSize + blockSize;

    const asphalt = new THREE.MeshStandardMaterial({
      color: Palette.asphaltWet,
      roughness: 0.22,
      metalness: 0.0,
      envMapIntensity: 1.4,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), asphalt);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.root.add(ground);

    if (phys) {
      phys.addStaticBox(
        new THREE.Vector3(size / 2, 0.5, size / 2),
        new THREE.Vector3(0, -0.5, 0),
        undefined,
        GROUP.terrain,
      );
    }

    // Pavement slabs inside each block, so roads read as roads.
    const pavementMat = new THREE.MeshStandardMaterial({
      color: Palette.sidewalkStone,
      roughness: 0.55,
      metalness: 0.0,
    });
    const inner = blockSize - roadWidth;
    const slab = new THREE.BoxGeometry(inner, 0.28, inner);
    const count = gridBlocks * gridBlocks;
    const im = new THREE.InstancedMesh(slab, pavementMat, count);
    im.receiveShadow = true;
    im.castShadow = false;
    const m = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < gridBlocks; i++) {
      for (let j = 0; j < gridBlocks; j++) {
        const x = -HALF + i * blockSize + blockSize / 2;
        const z = -HALF + j * blockSize + blockSize / 2;
        m.makeTranslation(x, 0.14, z);
        im.setMatrixAt(k++, m);
      }
    }
    im.instanceMatrix.needsUpdate = true;
    this.root.add(im);
  }

  /* ---------------- massing (placeholder) ---------------- */

  private buildMassing(): void {
    const phys = this.findPhysics();
    const rng = this.rng.fork('massing');

    const mats: Record<string, THREE.MeshStandardMaterial> = {
      glass: new THREE.MeshStandardMaterial({
        color: Palette.glassTint, roughness: 0.12, metalness: 0.85, envMapIntensity: 2.0,
      }),
      stone: new THREE.MeshStandardMaterial({ color: Palette.travertine, roughness: 0.72, metalness: 0.0 }),
      concrete: new THREE.MeshStandardMaterial({ color: Palette.concreteGrey, roughness: 0.88, metalness: 0.0 }),
    };

    const box = new THREE.BoxGeometry(1, 1, 1);
    const buckets: Record<string, THREE.Matrix4[]> = { glass: [], stone: [], concrete: [] };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();

    for (let i = 0; i < gridBlocks; i++) {
      for (let j = 0; j < gridBlocks; j++) {
        const cx = -HALF + i * blockSize + blockSize / 2;
        const cz = -HALF + j * blockSize + blockSize / 2;
        const district = this.districtAt(cx, cz);
        if (district === 'parc') continue;

        // Two to four buildings per block.
        const perBlock = rng.int(2, 5);
        for (let b = 0; b < perBlock; b++) {
          const usable = blockSize - roadWidth - 8;
          const w = rng.range(usable * 0.28, usable * 0.48);
          const d = rng.range(usable * 0.28, usable * 0.48);
          const h = this.heightFor(district, rng);
          const ox = rng.range(-usable / 2 + w / 2, usable / 2 - w / 2);
          const oz = rng.range(-usable / 2 + d / 2, usable / 2 - d / 2);
          const x = cx + ox;
          const z = cz + oz;

          const kind = district === 'glassCorporate' || district === 'guvern'
            ? (rng.bool(0.62) ? 'glass' : 'stone')
            : district === 'centruVechi'
              ? 'stone'
              : 'concrete';

          p.set(x, h / 2, z);
          s.set(w, h, d);
          m.compose(p, q, s);
          buckets[kind].push(m.clone());

          this.buildingBoxes.push({ x, z, hx: w / 2, hz: d / 2 });
          phys?.addStaticBox(new THREE.Vector3(w / 2, h / 2, d / 2), new THREE.Vector3(x, h / 2, z));
        }
      }
    }

    for (const [kind, list] of Object.entries(buckets)) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(box, mats[kind], list.length);
      im.castShadow = true;
      im.receiveShadow = true;
      list.forEach((mat, idx) => im.setMatrixAt(idx, mat));
      im.instanceMatrix.needsUpdate = true;
      im.name = `massing-${kind}`;
      this.root.add(im);
    }
  }

  private heightFor(d: DistrictKind, rng: Rng): number {
    switch (d) {
      case 'glassCorporate': return rng.range(45, 130);
      case 'guvern': return rng.range(28, 62);
      case 'bulevard': return rng.range(24, 44);
      case 'cartier': return rng.range(26, 38);
      case 'centruVechi': return rng.range(12, 22);
      case 'industrial': return rng.range(8, 18);
      default: return rng.range(10, 20);
    }
  }

  /* ---------------- landmarks ---------------- */

  private registerLandmarks(): void {
    const add = (id: string, name: string, x: number, z: number, radius: number) => {
      this.landmarks.set(id, { id, name, position: new THREE.Vector3(x, 0, z), radius });
    };
    add('buildersHouse', 'Builders House', -blockSize * 2, blockSize * 1.5, 40);
    add('palatulParlamentului', 'Palatul Parlamentului', -HALF * 0.72, -HALF * 0.62, 180);
    add('piataVictoriei', 'Piața Victoriei', blockSize * 3, -blockSize * 4, 90);
    add('broadcastPlaza', 'Piața Transmisiunii', blockSize * 5, blockSize * 2, 70);
    add('startupCourtyard', 'Curtea Startup', -blockSize * 4, -blockSize * 1, 45);
  }

  /* ---------------- CityService ---------------- */

  districtAt(x: number, z: number): DistrictKind {
    const nx = x / (HALF * 2);
    const nz = z / (HALF * 2);
    const r = Math.hypot(nx, nz);
    const n = fbm2D(nx * 6 + 11, nz * 6 - 4, 3, 4242);

    if (nx < -0.28 && nz < -0.18) return 'guvern';
    if (r < 0.13) return 'centruVechi';
    if (r < 0.30) return n > 0.55 ? 'glassCorporate' : 'bulevard';
    if (r < 0.44) return n > 0.62 ? 'parc' : 'bulevard';
    if (r < 0.72) return n > 0.68 ? 'parc' : 'cartier';
    return n > 0.5 ? 'industrial' : 'cartier';
  }

  randomRoadPoint(out: THREE.Vector3): void {
    const a = this.roadNodes[this.rng.int(0, this.roadNodes.length)];
    const b = this.roadNodes[a.links[this.rng.int(0, a.links.length)]] ?? a;
    out.lerpVectors(a.position, b.position, this.rng.next());
  }

  nearestNode(p: THREE.Vector3): number {
    const i = Math.round((p.x + HALF) / blockSize);
    const j = Math.round((p.z + HALF) / blockSize);
    const ci = Math.max(0, Math.min(gridBlocks, i));
    const cj = Math.max(0, Math.min(gridBlocks, j));
    return this.nodeGrid.get(`${ci},${cj}`) ?? -1;
  }

  findPath(fromNode: number, toNode: number): number[] {
    if (fromNode < 0 || toNode < 0 || fromNode === toNode) return [];
    const nodes = this.roadNodes;
    const open = new Set<number>([fromNode]);
    const cameFrom = new Map<number, number>();
    const g = new Map<number, number>([[fromNode, 0]]);
    const goal = nodes[toNode].position;
    const f = new Map<number, number>([[fromNode, nodes[fromNode].position.distanceTo(goal)]]);
    let guard = 0;

    while (open.size && guard++ < 20000) {
      let cur = -1;
      let best = Infinity;
      for (const id of open) {
        const v = f.get(id) ?? Infinity;
        if (v < best) { best = v; cur = id; }
      }
      if (cur === toNode) {
        const path = [cur];
        let c = cur;
        while (cameFrom.has(c)) { c = cameFrom.get(c)!; path.push(c); }
        return path.reverse();
      }
      open.delete(cur);
      for (const nb of nodes[cur].links) {
        const tentative = (g.get(cur) ?? Infinity) + nodes[cur].position.distanceTo(nodes[nb].position);
        if (tentative < (g.get(nb) ?? Infinity)) {
          cameFrom.set(nb, cur);
          g.set(nb, tentative);
          f.set(nb, tentative + nodes[nb].position.distanceTo(goal));
          open.add(nb);
        }
      }
    }
    return [];
  }

  private findPhysics(): PhysicsWorld | null {
    return this.ctx.tryGet(Services.Physics) ?? null;
  }

  dispose(): void {
    this.root.clear();
  }
}
