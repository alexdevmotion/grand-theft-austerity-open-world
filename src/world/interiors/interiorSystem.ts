/** ENTERABLE INTERIORS.
 *
 *  The shells, their colliders and their floors are built with the city, in
 *  `src/world/city/landmarks.ts` — they have to be, because a wall you can
 *  walk through for the first three seconds of the level is not a wall. This
 *  system owns everything else:
 *
 *    FITOUT     the furniture, dressing and screens of each room, built into
 *               one merged geometry per interior and one draw call.
 *    STREAMING  a room's geometry is built the first time the camera comes
 *               within its radius and hidden again when it leaves, so the six
 *               interiors cost nothing while you are driving past them.
 *    LIGHT      a FIXED pool of point lights that re-homes onto the nearest
 *               fittings of whichever room you are in. Fixed, because a
 *               varying light count re-links every shader in the scene — the
 *               bug that cost the vehicle team a week (see
 *               `src/vehicles/lights.ts`).
 *    STATE      the Builders House lobby is sealed until Act IV liberates it;
 *               the broadcast studio is the regime's until Act III takes it.
 *               Both rebuild their room when the story flips them.
 *
 *  OWNER: interiors agent.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../../core/engine';
import { Rng } from '../../core/rng';
import { Services, type ServiceKey } from '../../core/services';
import { GROUP, type PhysicsWorld } from '../../physics/physics';
import { DetailBuilder } from '../city/builders';
import { BLOCKERS, INTERIORS, INTERIOR_BY_ID } from './defs';
import { createInteriorMaterial, type InteriorMaterial } from './interiorMaterial';
import {
  doorCentre, doorInside, doorNormal, doorOutside, entryAnchor, innerHalf, type ShellSpec,
} from './shell';
import type { LightAnchor } from './kit';
import { fitLobby, type LobbyState } from './lobby';
import { fitRecorder } from './recorder';
import { fitStudio, takeoverConsole, type StudioState } from './studio';
import { fitBar, fitBlockHall, fitShop } from './ambient';

/* ------------------------------------------------------------------ */
/* Service contract                                                    */
/* ------------------------------------------------------------------ */

/**
 * What other systems are allowed to know about interiors.
 *
 * REQUEST TO THE ARCHITECTURE OWNER: move this key and interface into
 * `src/core/services.ts` as `Services.Interiors`. Until then it is published
 * here and on `window.__GTA_INTERIORS__`, and `src/gameplay/missions.ts` can
 * reach it with `ctx.tryGet(InteriorsServiceKey)`.
 */
export interface InteriorsService {
  /** Act IV: lights, tricolour, the room the afterparty happens in. */
  liberate(): void;
  /** Restore the pre-finale Builders House interior for an earlier save. */
  seal(): void;
  /** Act III: every screen in the studio flips to the builders' broadcast. */
  hijack(): void;
  /** True when (x, z) is inside a named interior's clear volume. */
  isInside(id: string, x: number, z: number): boolean;
  /** Which interior the point is in, or null. */
  interiorAt(x: number, z: number): string | null;
  /** A standing spot just inside a doorway. */
  doorwayInside(id: string): { x: number; y: number; z: number } | null;
  readonly liberated: boolean;
  readonly hijacked: boolean;
}

export const InteriorsServiceKey: ServiceKey<InteriorsService> = { id: 'interiors' };

/* ------------------------------------------------------------------ */

type Fitout = (b: DetailBuilder, s: ShellSpec, rng: Rng, state: string) => LightAnchor[];

const FITOUT: Record<string, Fitout> = {
  buildersLobby: (b, s, r, st) => fitLobby(b, s, r, st as LobbyState),
  recorderNewsroom: (b, s, r) => fitRecorder(b, s, r),
  broadcastStudio: (b, s, r, st) => fitStudio(b, s, r, st as StudioState),
  cornerShop: (b, s, r) => fitShop(b, s, r),
  buildersBar: (b, s, r) => fitBar(b, s, r),
  blockHall: (b, s, r) => fitBlockHall(b, s, r),
};

const INITIAL_STATE: Record<string, string> = {
  buildersLobby: 'sealed',
  broadcastStudio: 'regime',
};

/**
 * PER-STATE AMBIENT FILL, overriding `ShellSpec.fill`.
 *
 * `fill` is one number per room, which is right while a room is one thing. The
 * Builders House lobby is two: a dead 28 x 22 m hall lit by two work lamps,
 * and the same hall with every pendant, every string light and a PA rig
 * running. Six shared point lights cannot express that difference — at the
 * far end of the room they are all out of range either way — so the party's
 * bounce is carried by the fill, the way the studio already carries its own.
 *
 * The playtest's "mostly black lobby" with the music playing was this number
 * being 1 in both states.
 */
const STATE_FILL: Record<string, Record<string, number>> = {
  buildersLobby: { sealed: 0.85, liberated: 4.8 },
};

function fillFor(spec: ShellSpec, state: string): number {
  return STATE_FILL[spec.id]?.[state] ?? spec.fill ?? 1;
}

/** Real point lights alive at once, across every interior. */
const LIGHT_POOL = 6;
/** How often the pool re-homes, seconds. */
const REHOME_INTERVAL = 0.2;

interface Instance {
  spec: ShellSpec;
  /** Own material instance, so `ShellSpec.fill` can differ per room. */
  mat: InteriorMaterial;
  state: string;
  mesh: THREE.Mesh | null;
  anchors: LightAnchor[];
  triangles: number;
  /** Camera is inside the stream radius. */
  near: boolean;
  /** Rebuild requested (state change). */
  dirty: boolean;
}

export class InteriorSystem implements System, InteriorsService {
  readonly name = 'interiors';
  readonly order = 25;

  private ctx!: GameContext;
  private root = new THREE.Group();
  private lights: THREE.PointLight[] = [];
  private instances: Instance[] = [];
  private byId = new Map<string, Instance>();
  private rehome = 0;
  private legacyCheck = 0;
  private _liberated = false;
  private _hijacked = false;
  private readonly cam = new THREE.Vector3();

  get liberated(): boolean {
    return this._liberated;
  }

  get hijacked(): boolean {
    return this._hijacked;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(InteriorsServiceKey, this);

    this.root.name = 'interiors';
    ctx.scene.add(this.root);

    for (let i = 0; i < LIGHT_POOL; i++) {
      // Created up front and never added or removed: the scene's light count
      // is part of every shader's program key.
      const l = new THREE.PointLight(0xffffff, 0, 12, 2);
      l.castShadow = false;
      l.name = `interior-light-${i}`;
      this.root.add(l);
      this.lights.push(l);
    }

    for (const spec of INTERIORS) {
      const mat = createInteriorMaterial();
      const state0 = INITIAL_STATE[spec.id] ?? '';
      mat.setFill(fillFor(spec, state0));
      const inst: Instance = {
        spec,
        mat,
        state: state0,
        mesh: null,
        anchors: [],
        triangles: 0,
        near: false,
        dirty: false,
      };
      this.instances.push(inst);
      this.byId.set(spec.id, inst);
    }

    this.addFurnitureColliders(ctx);

    ctx.events.on('mission:complete', (e) => {
      if (e.id === 'act4_giftshop') this.liberate();
    });
    ctx.events.on('broadcast:hijacked', () => this.hijack());

    this.installDebugHook();
    console.info(`[interiors] ${this.instances.length} enterable rooms registered`);
  }

  /* ---------------------------------------------------------------- */
  /* Streaming                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * STREAMING RUNS IN `lateUpdate`, NOT `update`.
   *
   * Two reasons, both learned the hard way:
   *   — `Engine.frame` skips `update` for every system below order 400 while
   *     the game is PAUSED, and the pause menu, the photo mode and the bust
   *     sequence all pause. Streamed in `update`, an interior you are standing
   *     in loses its lights the moment you open the menu, and the room you
   *     walk toward never arrives.
   *   — `lateUpdate` runs after the camera system has finalised the camera, so
   *     the distance test is against the frame that is about to be rendered
   *     rather than the previous one.
   */
  lateUpdate(dt: number, ctx: GameContext): void {
    ctx.camera.getWorldPosition(this.cam);

    let built = 0;
    for (const inst of this.instances) {
      const s = inst.spec;
      const dx = this.cam.x - s.cx;
      const dz = this.cam.z - s.cz;
      const d2 = dx * dx + dz * dz;
      const r = s.streamRadius;
      // Hysteresis, so standing on the boundary does not thrash the build.
      inst.near = d2 < (inst.near ? (r + 12) * (r + 12) : r * r);

      // One build per frame at most: six rooms arriving together is a hitch.
      if (inst.near && (!inst.mesh || inst.dirty) && built === 0) {
        this.buildInterior(inst);
        built++;
      }
      if (inst.mesh) inst.mesh.visible = inst.near;
    }

    this.rehome -= dt;
    if (this.rehome <= 0) {
      this.rehome = REHOME_INTERVAL;
      this.assignLights();
    }

    // TEMPORARY BRIDGE — see the interiors report. `src/gameplay/missions.ts`
    // still builds its own `LobbyInterior` at runtime, which lands 0.5 m
    // inside this one and z-fights its ceiling. Hide it until that file drops
    // the hack.
    this.legacyCheck -= dt;
    if (this.legacyCheck <= 0) {
      this.legacyCheck = 2;
      const legacy = ctx.scene.getObjectByName('buildersHouseLobby');
      if (legacy && legacy.visible) {
        legacy.visible = false;
        console.warn(
          '[interiors] hid the runtime-built lobby from gameplay/missions.ts — ' +
          'LobbyInterior and carveLobbyDoorway are both replaced by the shell in ' +
          'world/city/landmarks.ts',
        );
      }
    }
  }

  private buildInterior(inst: Instance): void {
    const t0 = performance.now();
    if (inst.mesh) {
      inst.mesh.geometry.dispose();
      this.root.remove(inst.mesh);
      inst.mesh = null;
    }
    const fit = FITOUT[inst.spec.id];
    if (!fit) return;
    inst.mat.setFill(fillFor(inst.spec, inst.state));
    const b = new DetailBuilder();
    const rng = new Rng(`interior:${inst.spec.id}:${inst.state}`);
    inst.anchors = fit(b, inst.spec, rng, inst.state);
    const geo = b.build();
    const mesh = new THREE.Mesh(geo, inst.mat);
    mesh.name = `interior-${inst.spec.id}`;
    /*
     * THE ROOM IS ITS OWN SUNSHADE — THIS IS WHAT SEALS AN INTERIOR.
     *
     * The city's facade extrusion has no lid: a shell is four walls and a
     * parapet, open to the sky from directly above. At 19:30 the sun sits at
     * three degrees and nothing gets in, which is why this was invisible for
     * so long; wind the clock to the middle of the day and the sun drops
     * straight down into every interior in the game. The playtest caught it in
     * the broadcast studio as "a hard-edged white sun shaft cutting diagonally
     * across the floor" — that shaft is the shadow edge of the wall the light
     * came over.
     *
     * With the fitout casting, the ceiling slab and the four inner wall faces
     * drawn by `drawShellRoom` are real occluders, so the only sun in the room
     * is the sun that comes through the door — which is a shaft you WANT.
     *
     * The cost is bounded by the streaming: only rooms inside their own
     * `streamRadius` are visible, and three.js skips invisible objects in the
     * shadow pass. Two rooms at 5k triangles each is nothing against a
     * 1.9 M-triangle frame.
     */
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    inst.mesh = mesh;
    inst.triangles = b.triangles;
    inst.dirty = false;
    console.info(
      `[interiors] built ${inst.spec.id}${inst.state ? ` (${inst.state})` : ''}: ` +
      `${inst.triangles} tris, ${inst.anchors.length} light anchors, ` +
      `${(performance.now() - t0).toFixed(1)} ms`,
    );
  }

  /**
   * Home the pool onto the nearest anchors of the rooms that are streamed in.
   *
   * Anchors are scored by distance discounted by priority, so a studio key
   * light beats a desk lamp that happens to be a metre closer — otherwise
   * walking past a desk turns the room's key light off.
   */
  private assignLights(): void {
    const picked: Array<{ a: LightAnchor; score: number }> = [];
    for (const inst of this.instances) {
      if (!inst.near || !inst.mesh) continue;
      for (const a of inst.anchors) {
        const dx = a.x - this.cam.x;
        const dy = a.y - this.cam.y;
        const dz = a.z - this.cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        // Out of reach of its own falloff: it would contribute nothing.
        if (d2 > (a.distance + 14) * (a.distance + 14)) continue;
        const score = d2 / (a.priority ?? 1);
        if (picked.length < LIGHT_POOL) {
          picked.push({ a, score });
          continue;
        }
        let worst = 0;
        for (let k = 1; k < picked.length; k++) if (picked[k].score > picked[worst].score) worst = k;
        if (score < picked[worst].score) picked[worst] = { a, score };
      }
    }
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const p = picked[i];
      if (!p) {
        l.intensity = 0;
        continue;
      }
      l.position.set(p.a.x, p.a.y, p.a.z);
      l.color.setHex(p.a.color);
      l.distance = p.a.distance;
      l.intensity = p.a.intensity;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Colliders for the big furniture                                   */
  /* ---------------------------------------------------------------- */

  /**
   * The shell is collided by the city; this adds the handful of pieces you
   * would otherwise walk through — counters, the reception desk, the gallery
   * platform, the shop's fridge run.
   *
   * Authored in `defs.ts` as offsets from the room centre (optionally as a
   * fraction of the room's own half-extents) so they follow the room if it
   * moves. Anything smaller than a counter is deliberately NOT collided: a
   * chair you walk through is invisible, a chair that wedges the player into a
   * corner is a bug report.
   */
  private addFurnitureColliders(ctx: GameContext): void {
    const phys = ctx.tryGet(Services.Physics) as PhysicsWorld | undefined;
    if (!phys) return;
    let n = 0;
    for (const spec of INTERIORS) {
      const list = BLOCKERS[spec.id];
      if (!list) continue;
      const { hx, hz } = innerHalf(spec);
      for (const bl of list) {
        const cx = spec.cx + (bl.ax ?? 0) * hx + (bl.dx ?? 0);
        const cz = spec.cz + (bl.az ?? 0) * hz + (bl.dz ?? 0);
        phys.addStaticBox(
          new THREE.Vector3(bl.hx, bl.h / 2, bl.hz),
          new THREE.Vector3(cx, spec.floorY + bl.h / 2, cz),
          undefined,
          GROUP.staticWorld,
        );
        n++;
      }
    }
    console.info(`[interiors] ${n} furniture colliders`);
  }

  /* ---------------------------------------------------------------- */
  /* InteriorsService                                                  */
  /* ---------------------------------------------------------------- */

  liberate(): void {
    if (this._liberated) return;
    this._liberated = true;
    this.setState('buildersLobby', 'liberated');
  }

  seal(): void {
    if (!this._liberated) return;
    this._liberated = false;
    this.setState('buildersLobby', 'sealed');
  }

  hijack(): void {
    if (this._hijacked) return;
    this._hijacked = true;
    this.setState('broadcastStudio', 'hijacked');
  }

  setState(id: string, state: string): void {
    const inst = this.byId.get(id);
    if (!inst || inst.state === state) return;
    inst.state = state;
    inst.dirty = true;
    // Rebuild on the spot when it is on screen; these are story beats.
    if (inst.near) this.buildInterior(inst);
  }

  isInside(id: string, x: number, z: number): boolean {
    const s = INTERIOR_BY_ID.get(id);
    if (!s) return false;
    const { hx, hz } = innerHalf(s);
    return Math.abs(x - s.cx) < hx + 0.4 && Math.abs(z - s.cz) < hz + 0.4;
  }

  interiorAt(x: number, z: number): string | null {
    for (const s of INTERIORS) {
      const { hx, hz } = innerHalf(s);
      if (Math.abs(x - s.cx) < hx + 0.4 && Math.abs(z - s.cz) < hz + 0.4) return s.id;
    }
    return null;
  }

  doorwayInside(id: string): { x: number; y: number; z: number } | null {
    const s = INTERIOR_BY_ID.get(id);
    if (!s) return null;
    const p = doorInside(s, 2.6);
    return { x: p.x, y: s.floorY + 0.06, z: p.z };
  }

  /**
   * Where a player who has just come through the door should STAND, and which
   * way he should be looking. Not the same question as `doorwayInside` — see
   * `entryAnchor` in shell.ts for why two and a half metres is not enough.
   */
  entrySpot(id: string): { x: number; y: number; z: number; yaw: number } | null {
    const s = INTERIOR_BY_ID.get(id);
    if (!s) return null;
    const a = entryAnchor(s);
    return { x: a.x, y: s.floorY + 0.06, z: a.z, yaw: a.yaw };
  }

  /* ---------------------------------------------------------------- */
  /* Automation hook                                                   */
  /* ---------------------------------------------------------------- */

  private installDebugHook(): void {
    const api = {
      list: () => this.instances.map((i) => ({
        id: i.spec.id,
        name: i.spec.name,
        centre: [i.spec.cx, i.spec.floorY, i.spec.cz] as [number, number, number],
        inside: this.doorwayInside(i.spec.id),
        entry: this.entrySpot(i.spec.id),
        state: i.state,
        built: !!i.mesh,
        near: i.near,
        triangles: i.triangles,
      })),
      stats: () => ({
        rooms: this.instances.length,
        built: this.instances.filter((i) => i.mesh).length,
        visible: this.instances.filter((i) => i.mesh?.visible).length,
        triangles: this.instances.reduce((a, i) => a + (i.mesh?.visible ? i.triangles : 0), 0),
        litLights: this.lights.filter((l) => l.intensity > 0).length,
      }),
      /**
       * Teleport the player through the door of `id`, standing where a person
       * who had just walked in would stand and facing the way he would face.
       */
      enter: (id: string) => {
        const p = this.entrySpot(id);
        if (!p) return null;
        this.ctx.tryGet(Services.Player)?.teleport(new THREE.Vector3(p.x, p.y + 0.9, p.z), p.yaw);
        return p;
      },
      /**
       * Frame the room FROM INSIDE, derived from the room's own extents —
       * never a hardcoded camera position, which goes stale the moment a
       * layout moves.
       */
      view: (id: string, opts?: { azimuthDeg?: number; height?: number; back?: number; fov?: number }) => {
        const s = INTERIOR_BY_ID.get(id);
        if (!s) return null;
        const { hx, hz } = innerHalf(s);
        const az = THREE.MathUtils.degToRad(opts?.azimuthDeg ?? 0);
        const back = opts?.back ?? 0.86;
        const px = s.cx + Math.sin(az) * hx * back;
        const pz = s.cz + Math.cos(az) * hz * back;
        const py = s.floorY + (opts?.height ?? 1.65);
        const dbg = (window as unknown as {
          __GTA_DEBUG__?: {
            setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov?: number): void;
          };
        }).__GTA_DEBUG__;
        dbg?.setCamera(px, py, pz, s.cx, s.floorY + 1.4, s.cz, opts?.fov ?? 62);
        return { pos: [px, py, pz], target: [s.cx, s.floorY + 1.4, s.cz] };
      },
      /** Frame a doorway from the street, at eye height, looking in. */
      viewDoor: (id: string, opts?: { distance?: number; height?: number; fov?: number; side?: number }) => {
        const s = INTERIOR_BY_ID.get(id);
        if (!s) return null;
        const out = doorOutside(s, opts?.distance ?? 9);
        const n = doorNormal(s.door);
        const side = opts?.side ?? 0.35;
        const px = out.x + -n.z * (opts?.distance ?? 9) * side;
        const pz = out.z + n.x * (opts?.distance ?? 9) * side;
        const py = s.floorY + (opts?.height ?? 1.7);
        const c = doorCentre(s);
        const dbg = (window as unknown as {
          __GTA_DEBUG__?: {
            setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov?: number): void;
          };
        }).__GTA_DEBUG__;
        dbg?.setCamera(px, py, pz, c.x, s.floorY + 1.5, c.z, opts?.fov ?? 55);
        return { pos: [px, py, pz], target: [c.x, s.floorY + 1.5, c.z] };
      },
      liberate: () => this.liberate(),
      hijack: () => this.hijack(),
      setState: (id: string, state: string) => this.setState(id, state),
      /** Where the studio's takeover console stands, for the story agent. */
      console: () => {
        const s = INTERIOR_BY_ID.get('broadcastStudio');
        return s ? takeoverConsole(s) : null;
      },
    };
    (window as unknown as { __GTA_INTERIORS__: unknown }).__GTA_INTERIORS__ = api;
  }

  dispose(): void {
    for (const inst of this.instances) {
      inst.mesh?.geometry.dispose();
      inst.mat.dispose();
    }
    this.root.clear();
    this.root.removeFromParent();
  }
}
