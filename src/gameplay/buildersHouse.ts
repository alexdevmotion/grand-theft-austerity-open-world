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
 * STATUS: `buildBuildersHouse` now pushes the ground-floor wall boxes itself,
 * which is the fix this file has always asked for. `carveLobbyDoorway` is
 * therefore a FALLBACK — `BuildersHouseSystem` probes the shell first and only
 * operates on it when the probe says the door is shut. When the city stops
 * shipping single-cuboid towers for good, the carve can be deleted and only the
 * probe kept.
 *
 * THE PROBE IS THE POINT. The carve matched the tower collider by centre and
 * half-extents within 0.75 m; when that match failed it printed a `console.warn`
 * nobody read and Act IV's climax silently became a wall. `probeDoorway` does
 * not trust anyone's return value: it fires real rays through the opening at
 * knee, chest and head height, measures the widest continuously clear band, and
 * checks there is floor under your feet on the far side. The result is asserted
 * at the end of init and published in `__GTA_STORY__.state().doorway`.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { CG, GROUP, probeGroups, type PhysicsWorld } from '../physics/physics';
import { Services, type BuildersHouseService, type DoorwayReport } from '../core/services';
import {
  DOORWAY,
  LOBBY,
  LOBBY_DOOR_INSIDE,
  LOBBY_DOOR_OUTSIDE,
  TOWER,
  TOWER_SOUTH_Z,
} from '../content/places';

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

/* ------------------------------------------------------------------ */
/* The assertion                                                       */
/* ------------------------------------------------------------------ */

/** Heights above the lobby floor a walking player occupies. */
const PROBE_HEIGHTS = [0.45, 1.0, 1.65];
/** Lateral sample spacing across the opening. */
const PROBE_STEP = 0.1;
/** How far either side of the doorway centreline to look. */
const PROBE_HALF = DOORWAY.width / 2 + 0.4;
/**
 * Clear width a player needs. The character capsule is 0.32 m radius, so 0.64 m
 * of body plus enough margin that the controller's depenetration does not fight
 * the reveal on every step through.
 */
const MIN_CLEAR_WIDTH = 0.95;

export interface DoorwayProbe {
  passable: boolean;
  reason: string;
  /** Widest continuously clear band through the opening, metres. */
  clearWidth: number;
  /** World X of the middle of that band — where to aim a player. */
  clearCentreX: number;
}

/**
 * Can a player actually get from the forecourt to the reception desk?
 *
 * Rays from just outside the door to just inside it, sampled every 10 cm across
 * the opening at knee, chest and head height, then the WIDEST CONTINUOUSLY
 * CLEAR BAND is measured. It is deliberately not "are all lanes clear": a real
 * entrance has a centre mullion, and a 3.4 m opening split into two 1.45 m
 * halves is perfectly walkable. What is not walkable is an opening whose widest
 * gap is narrower than the player — and that is the failure this catches, the
 * one that used to ship as a silent `console.warn`.
 *
 * Plus a downward ray on the inside, because a doorway you fall through is not
 * a doorway either.
 */
export function probeDoorway(phys: PhysicsWorld): DoorwayProbe {
  const fail = (reason: string): DoorwayProbe => ({ passable: false, reason, clearWidth: 0, clearCentreX: DOORWAY.x });
  if (!phys.world) return fail('no physics world');

  const from = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, 1);
  const span = LOBBY_DOOR_INSIDE.z - LOBBY_DOOR_OUTSIDE.z; // ~6.2 m through the reveal
  const solid = probeGroups(CG.STATIC);

  const samples = Math.floor((PROBE_HALF * 2) / PROBE_STEP) + 1;
  let best = 0;
  let bestEnd = -1;
  let run = 0;

  for (let i = 0; i < samples; i++) {
    const x = DOORWAY.x - PROBE_HALF + i * PROBE_STEP;
    let clear = true;
    for (const h of PROBE_HEIGHTS) {
      from.set(x, LOBBY.floorY + h, LOBBY_DOOR_OUTSIDE.z);
      if (phys.raycast(from, dir, span, solid)) {
        clear = false;
        break;
      }
    }
    if (clear) {
      run++;
      if (run > best) {
        best = run;
        bestEnd = i;
      }
    } else {
      run = 0;
    }
  }

  const clearWidth = best > 0 ? (best - 1) * PROBE_STEP : 0;
  const clearCentreX = best > 0
    ? DOORWAY.x - PROBE_HALF + (bestEnd - (best - 1) / 2) * PROBE_STEP
    : DOORWAY.x;

  if (clearWidth < MIN_CLEAR_WIDTH) {
    return {
      passable: false,
      reason: `widest clear gap is ${clearWidth.toFixed(2)} m, needs ${MIN_CLEAR_WIDTH} m`,
      clearWidth,
      clearCentreX,
    };
  }

  from.set(clearCentreX, LOBBY.floorY + 2.0, LOBBY_DOOR_INSIDE.z);
  const floor = phys.raycast(from, new THREE.Vector3(0, -1, 0), 4.0, probeGroups(CG.STATIC | CG.TERRAIN));
  if (!floor) {
    return { passable: false, reason: 'no floor collider inside the lobby', clearWidth, clearCentreX };
  }

  return {
    passable: true,
    reason: `${clearWidth.toFixed(2)} m clear at x ${clearCentreX.toFixed(2)}`,
    clearWidth,
    clearCentreX,
  };
}

/* ------------------------------------------------------------------ */
/* The system                                                          */
/* ------------------------------------------------------------------ */

/**
 * Builders House as a registered system: it guarantees you can walk in, and it
 * answers `Services.BuildersHouse`.
 *
 * It used to be a field on `MissionSystem`, constructed and ticked by hand
 * because `game.ts` was closed. It is a system now; missions ask the seam for
 * it like everything else.
 *
 * IT NO LONGER DRESSES THE ROOM. `src/world/interiors/lobby.ts` builds the
 * Builders House lobby properly — both states, real fittings, a streamed light
 * pool — and `InteriorSystem` owns switching it to `liberated`. The stopgap
 * `LobbyInterior` below built a *second* room in the same 30x24 volume: two
 * floors, two ceilings, two sets of walls z-fighting each other. So liberation
 * is forwarded to the interiors service and this system keeps the one job the
 * interiors system cannot do — proving the door is open.
 */
export class BuildersHouseSystem implements System, BuildersHouseService {
  readonly name = 'buildersHouse';
  /** After physics (5), the city (20) and the interiors (25); before missions. */
  readonly order = 218;

  private ctx!: GameContext;
  private phys: PhysicsWorld | null = null;
  private report: DoorwayReport = {
    carved: false,
    passable: false,
    reason: 'not initialised',
    added: 0,
  };
  /** The init-time probe is provisional; this is the one that is believed. */
  private confirmed = false;
  private sealGroup!: THREE.Group;
  private sealColliders: Array<import('@dimforge/rapier3d-compat').Collider> = [];
  private _sealed = true;

  get doorway(): DoorwayReport {
    return this.report;
  }
  get sealed(): boolean {
    return this._sealed;
  }
  get liberated(): boolean {
    return this.ctx?.tryGet(Services.Interiors)?.liberated ?? false;
  }

  seal(): void {
    this._sealed = true;
    if (this.sealGroup) this.sealGroup.visible = true;
    this.ensureSealCollider();
    this.ctx?.tryGet(Services.Interiors)?.seal();
  }

  unseal(): void {
    this._sealed = false;
    if (this.sealGroup) this.sealGroup.visible = false;
    const world = this.phys?.world;
    if (world) {
      for (const collider of this.sealColliders) world.removeCollider(collider, false);
    }
    this.sealColliders.length = 0;
  }

  private ensureSealCollider(): void {
    const phys = this.phys;
    if (!phys?.world || this.sealColliders.length > 0) return;
    this.sealColliders.push(phys.addStaticBox(
      new THREE.Vector3(2.35, 1.5, 0.12),
      new THREE.Vector3(DOORWAY.x, 1.6, TOWER_SOUTH_Z - 0.72),
      undefined,
      GROUP.prop,
    ));
  }

  liberate(): void {
    this.unseal();
    this.ctx?.tryGet(Services.Interiors)?.liberate();
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.BuildersHouse, this);

    // The city owns the permanent tower; gameplay owns the temporary Ministry
    // closure because Act IV removes it. Keeping this as a real scene group,
    // rather than baking it into the city's merged buffers, lets the breach
    // visibly change the same entrance the opening shot establishes.
    this.sealGroup = createSealedEntrance();
    ctx.scene.add(this.sealGroup);

    const phys = ctx.tryGet(Services.Physics) ?? null;
    this.phys = phys;
    if (!phys) {
      this.report = { carved: false, passable: false, reason: 'physics not registered', added: 0 };
      this.confirmed = true;
      this.assert();
      return;
    }

    // The crossed planks are a real closure, not scenery the player can walk
    // through. PROP membership keeps this temporary collider out of the
    // structural doorway probe while still blocking players and vehicles; the
    // Act IV barricade objective removes it through unseal().
    this.ensureSealCollider();

    // Look, but do not operate. See `check()`.
    const probe = probeDoorway(phys);
    this.report = {
      carved: probe.passable,
      passable: probe.passable,
      added: 0,
      reason: `provisional (init) — ${probe.reason}`,
    };
  }

  /**
   * ASK BEFORE OPERATING. `buildBuildersHouse` now pushes the ground-floor wall
   * boxes itself — the fix this file always asked for — so the runtime carve is
   * a fallback, not a step. Running it unconditionally would find no single
   * tower cuboid, report "not found", and make a working doorway look broken.
   */
  private check(): void {
    const phys = this.phys;
    if (!phys) return;

    const probe = probeDoorway(phys);
    if (probe.passable) {
      this.report = { carved: true, passable: true, added: 0, reason: `open — ${probe.reason}` };
      return;
    }

    const carve = carveLobbyDoorway(phys);
    const after = probeDoorway(phys);
    this.report = {
      carved: carve.carved,
      passable: after.passable,
      added: carve.added,
      reason: carve.carved
        ? `carved at runtime — ${after.reason}`
        : `shell is shut and the carve could not open it: ${carve.reason} (${probe.reason})`,
    };
  }

  /**
   * HARD ASSERTION. Act IV ends inside this room; if the door is shut the
   * campaign cannot be finished and every other symptom is subtle. So this is
   * loud, and `?strict=1` turns it into a boot failure for CI and the harness.
   */
  private assert(): void {
    if (this.report.passable) return;
    const msg =
      `[buildersHouse] DOORWAY NOT PASSABLE — Act IV cannot be completed. ${this.report.reason}. ` +
      `Fix at source: the ground-floor south wall of buildBuildersHouse ` +
      `(src/world/city/landmarks.ts) must leave a gap at least ` +
      `${MIN_CLEAR_WIDTH} m wide and ${DOORWAY.height} m tall at x ≈ ${DOORWAY.x}.`;
    console.error(msg);
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('strict') === '1') {
      throw new Error(msg);
    }
  }

  /**
   * WHY THE ANSWER IS NOT SETTLED AT INIT — MEASURED, NOT ASSUMED.
   *
   * At init the horizontal sweep through the door already reads
   * `#####..............#####..............#####` — two 1.3 m clear bands
   * either side of the entrance mullion, i.e. a perfectly walkable doorway that
   * `buildBuildersHouse` builds correctly. What is missing at that moment is the
   * lobby FLOOR: `InteriorSystem` streams its shells by camera distance, so the
   * floor collider does not exist until the room is near. An init-time verdict
   * is therefore provisional in both directions — it can cry wolf over geometry
   * that has not arrived, and it can pass over a hole not yet filled in.
   *
   * So the verdict that is believed, asserted, and acted on with the runtime
   * carve is the one taken the first time the player is close enough for it to
   * matter. One extra probe per session, then never again.
   */
  private static readonly CONFIRM_RADIUS = 140;
  /** Re-probe this often while inside the radius. */
  private static readonly CONFIRM_INTERVAL = 0.5;
  /**
   * How long the room gets to finish arriving before the verdict is final.
   * `InteriorSystem` streams its shells over several frames, so probing on the
   * first frame inside the radius reliably reports "no floor" for a floor that
   * lands a moment later — which is a false alarm on the loudest error in the
   * game. It only cries wolf if the room is still not there after this.
   */
  private static readonly CONFIRM_GRACE = 8;

  private nearTime = 0;
  private probeClock = 0;

  update(dt: number, ctx: GameContext): void {
    if (this.confirmed) return;
    const p = ctx.tryGet(Services.Player)?.position;
    if (!p) return;
    if (Math.hypot(p.x - TOWER.cx, p.z - TOWER.cz) > BuildersHouseSystem.CONFIRM_RADIUS) return;

    this.nearTime += dt;
    this.probeClock += dt;
    if (this.probeClock < BuildersHouseSystem.CONFIRM_INTERVAL) return;
    this.probeClock = 0;

    const phys = this.phys;
    if (!phys) return;
    const probe = probeDoorway(phys);
    if (probe.passable) {
      this.report = { carved: true, passable: true, added: 0, reason: `open — ${probe.reason}` };
      this.confirmed = true;
      return;
    }
    this.report = {
      ...this.report,
      passable: false,
      reason: `waiting for the room — ${probe.reason}`,
    };
    if (this.nearTime < BuildersHouseSystem.CONFIRM_GRACE) return;

    // Out of patience: try the runtime carve, then settle the verdict.
    this.confirmed = true;
    this.check();
    this.assert();
  }

  dispose(): void {
    this.sealGroup?.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.sealGroup?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) {
        const map = (mat as THREE.MeshStandardMaterial).map;
        if (map) textures.add(map);
        materials.add(mat);
      }
    });
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    // Physics is disposed before this system, so its world owns collider
    // cleanup during engine teardown. Clear only our now-stale handles.
    this.sealColliders.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* The visible opening-state closure                                  */
/* ------------------------------------------------------------------ */

/**
 * Recreate the closure language from the menu/reference frame at the actual
 * playable door: crowd-control rails, striped Ministry tape, crossed timber,
 * an evacuation seal and a warning beacon. The system adds its temporary
 * gameplay collider separately, outside the structural doorway probe, so this
 * pure visual builder stays deterministic for tests.
 */
export function createSealedEntrance(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'builders-house:ministry-seal';
  root.userData.storyState = 'sealed';

  const metal = new THREE.MeshStandardMaterial({
    color: 0x4a4752, roughness: 0.64, metalness: 0.72,
  });
  const foot = new THREE.MeshStandardMaterial({
    color: 0x25202e, roughness: 0.78, metalness: 0.52,
  });
  const wood = new THREE.MeshStandardMaterial({
    color: 0x765035, roughness: 0.9, metalness: 0.02,
  });
  const red = new THREE.MeshStandardMaterial({
    color: 0xc51f35, roughness: 0.5, metalness: 0.02,
  });
  const white = new THREE.MeshStandardMaterial({
    color: 0xe8dfd4, roughness: 0.86, metalness: 0.01,
  });
  const paper = ministrySealMaterial();
  const beacon = new THREE.MeshStandardMaterial({
    color: 0xff304f, emissive: 0xff1539, emissiveIntensity: 3.2,
    roughness: 0.28, metalness: 0.15,
  });

  const box = (
    name: string,
    x: number, y: number, z: number,
    sx: number, sy: number, sz: number,
    material: THREE.Material,
    rz = 0,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    m.name = name;
    m.position.set(x, y, z);
    m.rotation.z = rz;
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };

  // Two staggered barriers turn the steps into a visible checkpoint rather
  // than one thin line that disappears edge-on from the starting camera.
  for (const [row, z] of [0, 1].map((row) => [row, TOWER_SOUTH_Z - 4.15 - row * 1.35] as const)) {
    const offset = row === 0 ? -2.7 : 2.7;
    for (const side of [-1, 1]) {
      const cx = DOORWAY.x + offset + side * 2.25;
      box('seal:barrier-rail', cx, 1.18, z, 4.4, 0.1, 0.12, metal);
      box('seal:barrier-rail', cx, 0.72, z, 4.4, 0.08, 0.1, metal);
      for (const dx of [-2.0, 0, 2.0]) {
        box('seal:barrier-post', cx + dx, 0.78, z, 0.09, 1.5, 0.09, metal);
      }
      box('seal:barrier-foot', cx - 1.75, 0.08, z, 0.7, 0.1, 0.5, foot);
      box('seal:barrier-foot', cx + 1.75, 0.08, z, 0.7, 0.1, 0.5, foot);
    }
  }

  // Cross-brace the doorway itself. These read as timber even when the sign is
  // occluded by Ilie or an NPC.
  const doorZ = TOWER_SOUTH_Z - 0.72;
  box('seal:door-plank', DOORWAY.x, 1.55, doorZ, 4.5, 0.28, 0.16, wood, 0.46);
  box('seal:door-plank', DOORWAY.x, 1.55, doorZ - 0.03, 4.5, 0.28, 0.16, wood, -0.46);
  box('seal:door-plank', DOORWAY.x, 2.7, doorZ, 3.3, 0.22, 0.15, wood, 0.07);

  // Red-and-white tape is layered as alternating short segments so it remains
  // striped without a texture and catches the low orange sun as geometry.
  const tape = (z: number, y: number, width: number, phase = 0): void => {
    const n = Math.ceil(width / 0.58);
    for (let i = 0; i < n; i++) {
      const sx = Math.min(0.54, width - i * 0.58);
      if (sx <= 0) break;
      const mat = (i + phase) % 2 === 0 ? red : white;
      box('seal:hazard-tape', DOORWAY.x - width / 2 + i * 0.58 + sx / 2, y, z, sx, 0.1, 0.035, mat);
    }
  };
  tape(TOWER_SOUTH_Z - 0.9, 1.95, 5.4);
  tape(TOWER_SOUTH_Z - 4.22, 1.42, 13.8, 1);

  const notice = box(
    'seal:evacuation-order', DOORWAY.x, 1.92, doorZ - 0.14,
    1.45, 1.85, 0.06, paper,
  );
  notice.userData.copy = 'MINISTERUL DE-ACCELERĂRII NAȚIONALE · IMOBIL SIGILAT · ORDIN DE EVACUARE';

  // A small emergency lamp makes the seal legible in the night preset too.
  box('seal:warning-beacon', DOORWAY.x, 3.55, doorZ - 0.2, 0.34, 0.22, 0.22, beacon);

  return root;
}

function ministrySealMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xe8dfd4,
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  if (typeof document === 'undefined') return mat;

  const canvas = document.createElement('canvas');
  if (typeof canvas.getContext !== 'function') return mat;
  canvas.width = 512;
  canvas.height = 640;
  const c = canvas.getContext('2d');
  if (!c) return mat;
  c.fillStyle = '#e8dfd4';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#b71931';
  c.fillRect(0, 0, canvas.width, 112);
  c.fillStyle = '#fff7eb';
  c.font = '700 27px sans-serif';
  c.textAlign = 'center';
  c.fillText('MINISTERUL', 256, 48);
  c.fillText('DE-ACCELERĂRII NAȚIONALE', 256, 84);
  c.fillStyle = '#211625';
  c.font = '900 50px sans-serif';
  c.fillText('IMOBIL', 256, 230);
  c.fillText('SIGILAT', 256, 292);
  c.strokeStyle = '#b71931';
  c.lineWidth = 12;
  c.strokeRect(38, 145, 436, 198);
  c.font = '700 26px sans-serif';
  c.fillText('ORDIN DE EVACUARE', 256, 405);
  c.font = '22px sans-serif';
  c.fillText('ACCESUL INTERZIS', 256, 452);
  c.fillText('PRIN DECIZIE PREZIDENȚIALĂ', 256, 490);
  c.strokeStyle = '#34233a';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(90, 560);
  c.lineTo(422, 560);
  c.stroke();
  c.font = 'italic 19px sans-serif';
  c.fillText('semnat astăzi, executat ieri', 256, 600);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  mat.map = texture;
  mat.color.set(0xffffff);
  return mat;
}

/** True when `p` is inside the lobby volume. */
export function insideLobby(x: number, z: number): boolean {
  return (
    Math.abs(x - LOBBY.cx) < LOBBY.hx + 0.6 &&
    Math.abs(z - LOBBY.cz) < LOBBY.hz + 0.6
  );
}

/* ------------------------------------------------------------------ */
/* WHAT USED TO BE HERE                                                */
/*                                                                     */
/* `LobbyInterior` — a stopgap that built walls, a ceiling, upended    */
/* chairs, litter, a closure notice, pendant strips, a tricolour and   */
/* three point lights into the Builders House volume, because nothing  */
/* else did. Something else does now: `src/world/interiors/lobby.ts`   */
/* builds the same room in both states with a real fitout kit and a    */
/* streamed light pool, and `InteriorSystem` owns the sealed ->        */
/* liberated switch. Keeping both meant two rooms in one volume,       */
/* z-fighting, and doubled draw calls for the finale. Deleted rather   */
/* than left behind a flag: two owners of one room is the bug.         */
/* ------------------------------------------------------------------ */
