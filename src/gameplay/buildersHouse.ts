/**
 * OPENING THE DOOR OF BUILDERS HOUSE.
 *
 * `docs/STORY.md`: "Physically enterable, not a facade. The exterior shell
 * blocks the player and the Dacia; one pedestrian doorway the car cannot
 * cross." The lobby geometry already exists — `buildLobby(hero, -46, 46, 30,
 * 24, 9.0, 1.4, rng)` in `src/world/city.ts` draws a real reception desk,
 * pendant lights and a magenta back wall — but the tower is registered as ONE
 * solid cuboid collider spanning y 0..82 over the whole 30x24 footprint
 * (`generateLandmarks`, src/world/city.ts:331), so that lobby was scenery seen
 * through glass. Act IV's climax is walking into it.
 *
 * `src/world/**` is frozen, so this does the subtraction from the gameplay
 * side, against the public `PhysicsWorld.world`: find the tower cuboid,
 * remove it, and put back the same volume as six boxes with a 3.4 m pedestrian
 * gap in the south wall. The visual geometry is untouched — a doorway-sized
 * hole in a curtain wall reads as a doorway — and the mass above the lobby
 * storey is replaced whole, so the tower still blocks everything it blocked
 * before at every height a car can reach.
 *
 * It also adds the lobby's floor, which never had a collider either: the
 * decorative floor plate sits at y 0.4 and the analytic ground under the tower
 * is 0, so without this the player stands shin-deep in his own reception.
 *
 * PREFERRED FIX (report, do not edit): do this in `buildBuildersHouse`
 * (src/world/city/landmarks.ts:125) by pushing the four wall boxes instead of
 * one tower box. Then this file can be deleted.
 */

import * as THREE from 'three';
import { GROUP, type PhysicsWorld } from '../physics/physics';
import { DOORWAY, LOBBY, TOWER, TOWER_SOUTH_Z } from '../content/places';

export interface CarveResult {
  carved: boolean;
  reason: string;
  /** Colliders this module created, for diagnostics. */
  added: number;
}

/** How close a collider's centre must be to be recognised as the tower. */
const MATCH_EPS = 0.75;

export function carveLobbyDoorway(phys: PhysicsWorld): CarveResult {
  const world = phys.world;
  if (!world) return { carved: false, reason: 'no physics world', added: 0 };

  const wantX = TOWER.cx;
  const wantZ = TOWER.cz;
  const wantY = TOWER.h / 2;
  const wantHx = TOWER.w / 2;
  const wantHz = TOWER.d / 2;

  let target: import('@dimforge/rapier3d-compat').Collider | null = null;
  world.forEachCollider((c) => {
    if (target) return;
    const t = c.translation();
    if (
      Math.abs(t.x - wantX) > MATCH_EPS ||
      Math.abs(t.z - wantZ) > MATCH_EPS ||
      Math.abs(t.y - wantY) > MATCH_EPS
    ) return;
    const he = (c as unknown as { halfExtents?: () => { x: number; y: number; z: number } }).halfExtents?.();
    if (!he) return;
    if (
      Math.abs(he.x - wantHx) > MATCH_EPS ||
      Math.abs(he.z - wantHz) > MATCH_EPS ||
      Math.abs(he.y - wantY) > MATCH_EPS
    ) return;
    target = c;
  });

  if (!target) {
    return { carved: false, reason: 'tower collider not found', added: 0 };
  }

  world.removeCollider(target, false);

  const groundH = TOWER.groundH;
  const hx = TOWER.w / 2;
  const hz = TOWER.d / 2;
  const wall = 1.2; // thickness of the replacement ground-floor walls
  let added = 0;

  const box = (cx: number, cy: number, cz: number, ex: number, ey: number, ez: number): void => {
    phys.addStaticBox(
      new THREE.Vector3(ex, ey, ez),
      new THREE.Vector3(cx, cy, cz),
      undefined,
      GROUP.staticWorld,
    );
    added++;
  };

  /* ---- everything above the lobby storey: one box, exactly as before ---- */
  const upperH = TOWER.h - groundH;
  box(TOWER.cx, groundH + upperH / 2, TOWER.cz, hx, upperH / 2, hz);

  /* ---- ground-floor shell: four walls, south one split by the doorway ---- */
  const halfG = groundH / 2;
  // North (back) wall.
  box(TOWER.cx, halfG, TOWER.cz + hz - wall / 2, hx, halfG, wall / 2);
  // East and west flanks.
  box(TOWER.cx + hx - wall / 2, halfG, TOWER.cz, wall / 2, halfG, hz - wall);
  box(TOWER.cx - hx + wall / 2, halfG, TOWER.cz, wall / 2, halfG, hz - wall);

  // South wall in two piers either side of the door, plus a lintel over it.
  const doorHalf = DOORWAY.width / 2;
  const pier = hx - doorHalf;
  if (pier > 0.2) {
    box(TOWER.cx - doorHalf - pier / 2, halfG, TOWER_SOUTH_Z + wall / 2, pier / 2, halfG, wall / 2);
    box(TOWER.cx + doorHalf + pier / 2, halfG, TOWER_SOUTH_Z + wall / 2, pier / 2, halfG, wall / 2);
  }
  const lintelH = groundH - DOORWAY.height;
  if (lintelH > 0.1) {
    box(
      TOWER.cx, DOORWAY.height + lintelH / 2, TOWER_SOUTH_Z + wall / 2,
      doorHalf, lintelH / 2, wall / 2,
    );
  }

  /* ---- the lobby floor plate, so the soles land on it ---- */
  phys.addStaticBox(
    new THREE.Vector3(hx - 0.2, LOBBY.floorY / 2 + 0.1, hz - 0.2),
    new THREE.Vector3(TOWER.cx, LOBBY.floorY / 2 - 0.1, TOWER.cz),
    undefined,
    GROUP.terrain,
  );
  added++;

  return { carved: true, reason: 'ok', added };
}

/** True when `p` is inside the lobby volume. */
export function insideLobby(x: number, z: number): boolean {
  return (
    Math.abs(x - LOBBY.cx) < LOBBY.hx + 0.6 &&
    Math.abs(z - LOBBY.cz) < LOBBY.hz + 0.6
  );
}

/* ------------------------------------------------------------------ */
/* Lobby dressing                                                      */
/* ------------------------------------------------------------------ */

/**
 * `buildLobby` draws a floor, a glowing back wall, a desk and pendant lights —
 * everything you need to look at a lobby from the plaza, and not enough to
 * stand in one: there are no side walls, no ceiling and no reason for the room
 * to feel neglected. This adds the parts a player *inside* the room needs, in
 * both of the states the story asks for.
 *
 *   sealed      dark, closure notices, upended chairs, scattered paper
 *   liberated   lights up, tricolour wash, the room the afterparty happens in
 */
export class LobbyInterior {
  readonly group = new THREE.Group();
  private lights: THREE.PointLight[] = [];
  private glowMats: THREE.MeshStandardMaterial[] = [];
  private sealMats: THREE.MeshStandardMaterial[] = [];
  private _liberated = false;
  private t = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'buildersHouseLobby';
    this.build();
    scene.add(this.group);
  }

  get liberated(): boolean {
    return this._liberated;
  }

  private mat(color: number, rough = 0.9, emissive = 0, metal = 0): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).convertSRGBToLinear(),
      roughness: rough,
      metalness: metal,
    });
    if (emissive > 0) {
      m.emissive = new THREE.Color(color).convertSRGBToLinear();
      m.emissiveIntensity = emissive;
    }
    return m;
  }

  private box(
    mat: THREE.Material,
    cx: number, cy: number, cz: number,
    ex: number, ey: number, ez: number,
    yaw = 0,
  ): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(ex, ey, ez), mat);
    m.position.set(cx, cy, cz);
    m.rotation.y = yaw;
    m.castShadow = false;
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  private build(): void {
    const cx = LOBBY.cx;
    const cz = LOBBY.cz;
    const hx = TOWER.w / 2 - 1.5;
    const hz = TOWER.d / 2 - 1.5;
    const h = LOBBY.ceilingY;

    const concrete = this.mat(0x2b2733, 0.94);
    const trim = this.mat(0x191622, 0.85, 0, 0.2);

    // Side and front walls, front split by the doorway.
    this.box(concrete, cx - hx, h / 2, cz, 0.3, h, hz * 2);
    this.box(concrete, cx + hx, h / 2, cz, 0.3, h, hz * 2);
    const doorHalf = DOORWAY.width / 2;
    const pier = hx - doorHalf;
    this.box(concrete, cx - doorHalf - pier / 2, h / 2, TOWER_SOUTH_Z + 0.9, pier, h, 0.3);
    this.box(concrete, cx + doorHalf + pier / 2, h / 2, TOWER_SOUTH_Z + 0.9, pier, h, 0.3);
    this.box(trim, cx, DOORWAY.height + (h - DOORWAY.height) / 2, TOWER_SOUTH_Z + 0.9,
      doorHalf * 2, h - DOORWAY.height, 0.34);
    // Ceiling.
    this.box(concrete, cx, h - 0.12, cz, hx * 2, 0.24, hz * 2);

    /* ---- neglect: the closed-down state ---- */
    const paper = this.mat(0xcfc7b4, 1);
    const wood = this.mat(0x5c4a38, 0.95);
    for (let i = 0; i < 9; i++) {
      const a = i * 2.399;
      this.box(paper, cx + Math.sin(a) * hx * 0.7, LOBBY.floorY + 0.01,
        cz + Math.cos(a * 1.7) * hz * 0.6, 0.28, 0.006, 0.4, a);
    }
    for (let i = 0; i < 4; i++) {
      const x = cx - hx * 0.55 + i * hx * 0.36;
      const z = cz - hz * 0.15 + (i % 2) * 1.7;
      // Chairs on their sides.
      this.box(wood, x, LOBBY.floorY + 0.22, z, 0.46, 0.44, 0.46, i * 0.7);
      this.box(wood, x + 0.24, LOBBY.floorY + 0.5, z, 0.06, 0.5, 0.44, i * 0.7);
    }

    // Ministry closure notice, taped inside the glass beside the door.
    const seal = this.mat(0xd9333a, 0.7, 0.9);
    this.sealMats.push(seal);
    this.box(seal, cx + doorHalf + 1.3, 2.2, TOWER_SOUTH_Z + 0.72, 1.5, 2.0, 0.05);
    this.box(this.mat(0xe8e2d6, 0.9), cx + doorHalf + 1.3, 2.2, TOWER_SOUTH_Z + 0.68, 1.2, 0.3, 0.05);

    /* ---- the lights that come on at liberation ---- */
    const glow = this.mat(0xffd8a8, 0.35, 0.0);
    this.glowMats.push(glow);
    for (let i = 0; i < 5; i++) {
      const x = cx - hx * 0.7 + (i / 4) * hx * 1.4;
      this.box(glow, x, h - 0.5, cz - hz * 0.2, 1.4, 0.14, 0.5);
    }
    // Tricolour banner over the reception, dark until the house is taken back.
    const bands = [0x0b2f9e, 0xfcd116, 0xce1126];
    for (let i = 0; i < 3; i++) {
      const m = this.mat(bands[i], 0.8, 0);
      this.glowMats.push(m);
      this.box(m, cx + (i - 1) * 1.5, 5.4, cz + hz - 0.5, 1.4, 3.2, 0.06);
    }

    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffd0a0, 0, 26, 2);
      l.position.set(cx + (i === 0 ? -6 : 6), h - 1.4, cz - 1);
      l.castShadow = false;
      this.group.add(l);
      this.lights.push(l);
    }
    // One dim working light so the sealed room is not pitch black.
    const dim = new THREE.PointLight(0x8a6cd0, 3.5, 22, 2);
    dim.position.set(cx, h - 2.2, cz + 2);
    this.group.add(dim);
    this.lights.push(dim);
  }

  liberate(): void {
    this._liberated = true;
    for (const m of this.glowMats) {
      m.emissive = m.color.clone();
      m.emissiveIntensity = 2.4;
    }
    for (const m of this.sealMats) m.visible = false;
    this.lights[0].intensity = 42;
    this.lights[1].intensity = 42;
    this.lights[2].color.set(0xff5aa0);
    this.lights[2].intensity = 16;
  }

  /** The afterparty lights breathe; before that nothing moves. */
  update(dt: number): void {
    if (!this._liberated) return;
    this.t += dt;
    const a = 34 + Math.sin(this.t * 3.1) * 10;
    const b = 34 + Math.sin(this.t * 2.3 + 1.7) * 10;
    this.lights[0].intensity = a;
    this.lights[1].intensity = b;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.group.removeFromParent();
  }
}
