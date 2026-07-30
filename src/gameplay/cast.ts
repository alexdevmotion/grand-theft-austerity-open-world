/**
 * THE STORY CAST, STANDING IN THE WORLD.
 *
 * Nicușor LAN and Alex Need-Aid have finished, photo-fitted heads and finished
 * wardrobes (`CAST_APPEARANCES`, `src/characters/`); nothing had ever placed
 * them. This does.
 *
 * WHY NOT `PedService`
 *   The crowd is a *stream*: `PedSystem.spawn` gives you an ambient pedestrian
 *   that immediately routes itself off down the pavement and is despawned the
 *   moment you drive 220 m away (src/ai/peds.ts, `stream()`). A story
 *   character has to be exactly where the mission says it is, every time you
 *   come back, wearing the appearance the story gave it. So the cast runs on
 *   the same public rig (`CharacterFactory`) but on its own budget.
 *
 * COST CONTROL
 *   Actors are built lazily inside `BUILD_RADIUS` and released outside
 *   `DROP_RADIUS`, so at most a handful of the nine ever exist at once. The
 *   skinned update is skipped entirely past `ANIM_RADIUS` — they still stand
 *   there, they just stop being animated at 60 Hz.
 */

import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { Rng } from '../core/rng';
import { Services, type CityService } from '../core/services';
import {
  CAST_APPEARANCES,
  CharacterFactory,
  rollAppearance,
  type Appearance,
  type CharacterActor,
} from '../characters';

/** Build an actor once the player is this close. */
const BUILD_RADIUS = 170;
/** Release it again out here (hysteresis so a kerbside pass does not thrash). */
const DROP_RADIUS = 240;
/** Past this the skeleton stops being solved every frame. */
const ANIM_RADIUS = 95;
/** Head-tracking range. */
const LOOK_RADIUS = 14;

export type CastRole = 'nicusor' | 'ally' | 'builder';

export interface CastMemberSpec {
  id: string;
  /** Romanian display name, used by subtitles and prompts. */
  name: string;
  role: CastRole;
  x: number;
  z: number;
  /** Facing, radians. */
  yaw: number;
  /** Dance at the afterparty. */
  parties?: boolean;
}

interface CastMember extends CastMemberSpec {
  actor: CharacterActor | null;
  /** Ground height, resolved once the city can answer. */
  y: number;
  /** Per-member idle phase so nine people do not breathe in lockstep. */
  phase: number;
  /** Small idle drift, metres. */
  driftX: number;
  driftZ: number;
  dancing: boolean;
}

const _v = new THREE.Vector3();
const _look = new THREE.Vector3();

export class CastDirector {
  private ctx!: GameContext;
  private city: CityService | null = null;
  private factory!: CharacterFactory;
  private members: CastMember[] = [];
  private byId = new Map<string, CastMember>();
  private rng = new Rng('cast-constructorilor');
  private appearanceCache = new Map<string, Appearance>();
  private _built = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.city = ctx.tryGet(Services.City) ?? null;
    this.factory = CharacterFactory.of(ctx);
  }

  /** How many actors are currently instantiated — the harness checks this. */
  get builtCount(): number {
    return this._built;
  }

  get all(): ReadonlyArray<{ id: string; name: string; x: number; z: number; built: boolean }> {
    return this.members.map((m) => ({ id: m.id, name: m.name, x: m.x, z: m.z, built: m.actor !== null }));
  }

  add(spec: CastMemberSpec): void {
    if (this.byId.has(spec.id)) return;
    const m: CastMember = {
      ...spec,
      actor: null,
      y: this.groundAt(spec.x, spec.z),
      phase: this.rng.range(0, Math.PI * 2),
      driftX: 0,
      driftZ: 0,
      dancing: false,
    };
    this.members.push(m);
    this.byId.set(m.id, m);
  }

  position(id: string): THREE.Vector3 | null {
    const m = this.byId.get(id);
    return m ? new THREE.Vector3(m.x, m.y, m.z) : null;
  }

  /** Start (or stop) the afterparty. */
  setParty(on: boolean): void {
    for (const m of this.members) {
      if (m.parties) m.dancing = on;
    }
  }

  /** Move a cast member — the finale walks the forecourt builders inside. */
  moveTo(id: string, x: number, z: number, yaw?: number): void {
    const m = this.byId.get(id);
    if (!m) return;
    m.x = x;
    m.z = z;
    m.y = this.groundAt(x, z);
    if (yaw !== undefined) m.yaw = yaw;
  }

  /* ---------------------------------------------------------------- */

  private groundAt(x: number, z: number): number {
    const g = this.city?.spatial.groundHeight(x, z) ?? 0;
    return g > -1e5 ? g : 0;
  }

  private appearanceFor(m: CastMember): Appearance {
    const key = m.role === 'builder' ? `builder:${m.id}` : m.role;
    let a = this.appearanceCache.get(key);
    if (a) return a;
    if (m.role === 'builder') {
      a = rollAppearance(this.rng.fork(m.id), 'builder');
    } else {
      a = CAST_APPEARANCES[m.role];
    }
    this.appearanceCache.set(key, a);
    return a;
  }

  private build(m: CastMember): void {
    if (m.actor) return;
    const a = this.appearanceFor(m);
    const actor = this.factory.create(a, { seed: Rng.hash(m.id) & 0xffff, castShadow: true });
    actor.object.name = `cast:${m.id}`;
    actor.setTransform(_v.set(m.x, m.y, m.z), m.yaw);
    this.ctx.scene.add(actor.object);
    m.actor = actor;
    this._built++;
  }

  private release(m: CastMember): void {
    if (!m.actor) return;
    m.actor.object.removeFromParent();
    m.actor.dispose();
    m.actor = null;
    this._built--;
  }

  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    const player = ctx.tryGet(Services.Player);
    if (!player) return;
    const p = player.position;
    const t = ctx.time.elapsed;

    for (const m of this.members) {
      const dx = m.x - p.x;
      const dz = m.z - p.z;
      const d2 = dx * dx + dz * dz;

      if (!m.actor) {
        if (d2 < BUILD_RADIUS * BUILD_RADIUS) this.build(m);
        else continue;
      } else if (d2 > DROP_RADIUS * DROP_RADIUS) {
        this.release(m);
        continue;
      }

      const actor = m.actor!;
      const near = d2 < ANIM_RADIUS * ANIM_RADIUS;
      if (actor.visible !== near) actor.setVisible(near);
      if (!near) continue;

      let yaw = m.yaw;
      let speed = 0;
      let state: 'idle' | 'walk' = 'idle';

      if (m.dancing) {
        // No dance clip exists, so the afterparty is a tight two-step: a small
        // circular shuffle with the body swinging through it. On the rig this
        // reads as celebration, which is what the beat needs.
        const w = t * 2.3 + m.phase;
        m.driftX = Math.sin(w) * 0.55;
        m.driftZ = Math.cos(w * 0.8) * 0.45;
        yaw = m.yaw + Math.sin(w * 0.5) * 1.25;
        speed = 1.35;
        state = 'walk';
      } else {
        // Weight shift: a standing person is never perfectly still.
        m.driftX = Math.sin(t * 0.45 + m.phase) * 0.045;
        m.driftZ = Math.cos(t * 0.37 + m.phase) * 0.04;
        if (d2 < LOOK_RADIUS * LOOK_RADIUS) {
          // Turn to face whoever just walked up.
          const want = Math.atan2(p.x - m.x, p.z - m.z);
          yaw = dampAngle(m.yaw, want, 2.2, dt);
          m.yaw = yaw;
        }
      }

      actor.setTransform(_v.set(m.x + m.driftX, m.y, m.z + m.driftZ), yaw);
      actor.drive({ state, speed, grounded: true, moveForward: state === 'walk' ? 1 : 0 });
      if (d2 < LOOK_RADIUS * LOOK_RADIUS) {
        actor.lookAt(_look.set(p.x, p.y + 1.6, p.z), 0.85);
      } else {
        actor.lookAt(null);
      }
      actor.update(dt, ctx);
    }
  }

  dispose(): void {
    for (const m of this.members) this.release(m);
    this.members.length = 0;
    this.byId.clear();
  }
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}
