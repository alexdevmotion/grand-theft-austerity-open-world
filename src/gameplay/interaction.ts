/**
 * THE INTERACTION SYSTEM — world-space things you can press E on.
 *
 * There was none. Everything the campaign and the side activities do on foot
 * goes through here: talking to Nicușor, lifting the community server, taking
 * the Recorder's drive, breaching the barricade, opening the lobby door,
 * starting a courier run, photographing a Georgescu billboard.
 *
 * WHAT AN INTERACTABLE IS
 *   a world position, a radius, a Romanian label, and a callback. Optionally
 *   it demands you be on foot, that you be looking at it, and that nothing
 *   solid stands between your eyes and it.
 *
 * WHAT IT LOOKS LIKE
 *   a violet ground ring with a bobbing diamond above it, drawn on top of the
 *   world so it can be found from across a plaza, plus a keycap prompt at the
 *   bottom of the screen once you are close enough to press it.
 *
 * ONE REGISTRY, REACHED THROUGH THE SEAM
 *   It is registered in `src/game.ts` at order 216 and published as
 *   `Services.Interaction`. It used to be constructed by `MissionSystem` and
 *   handed to the activity system through a module-level `sharedInteraction()`
 *   singleton, because `game.ts` was frozen — a second, undocumented seam
 *   running alongside the registry that `services.ts` exists to be. That is
 *   gone: consumers call `ctx.tryGet(Services.Interaction)` like everything
 *   else. It must stay a singleton *instance* (two registries would fight over
 *   the same `interact` press) and the registry is what enforces that now.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { CG, probeGroups, type PhysicsWorld } from '../physics/physics';
import type { PlayerService, VehicleClass } from '../core/services';
import { t } from '../core/i18n';
import { Services, type InteractableKind, type InteractableSpec, type InteractionService } from '../core/services';
import { hintKeys } from '../core/keyHints';
import {
  EXIT_PROMPT_SPEED,
  PERSON_PROMPT_RANGE,
  VEHICLE_PROMPT_RANGE,
  contextPrompt,
  type ContextPromptView,
} from './contextPrompt';

export type { InteractableKind, InteractableSpec } from '../core/services';

interface Interactable extends InteractableSpec {
  radius: number;
  kind: InteractableKind;
  onFoot: boolean;
  inVehicle: boolean;
  facing: number;
  requireLos: boolean;
  auto: boolean;
  silent: boolean;
  color: number;
  marker: THREE.Object3D | null;
  enabled: boolean;
}

const KIND_COLOR: Record<InteractableKind, number> = {
  story: 0xff3d7f,
  activity: 0x7b3fd4,
  world: 0x4ad6c4,
};

/**
 * ONE-FRAME CLAIM ON THE `interact` ACTION.
 *
 * E and F are bound to `interact` (src/core/input.ts) and `PlayerSystem`
 * already spends that press getting into a nearby car. Standing at the
 * community server with the Dacia parked behind you, both would fire. There is
 * no "consume" on `Input`, so this tiny shared flag is the arbitration: the
 * interaction system raises it while it has a focused target, and the player
 * checks it before boarding. It is a module-level constant rather than a
 * service because both readers live in `src/gameplay/`.
 */
const claim = { active: false, frame: -1 };

/** How long the keycap lingers after the thing that justified it goes away. */
const PROMPT_HOLD_SECONDS = 0.4;

/** True when the interaction system owns this frame's `interact` press. */
export function interactionClaimed(): boolean {
  return claim.active;
}

/* ------------------------------------------------------------------ */

const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class InteractionSystem implements System, InteractionService {
  readonly name = 'interaction';
  /** Ahead of missions (220) and activities (230): both fill the registry in
   *  their own `init`, so this one has to exist first. */
  readonly order = 216;

  private ctx!: GameContext;
  private phys: PhysicsWorld | null = null;
  private list: Interactable[] = [];
  private byId = new Map<string, Interactable>();
  private root = new THREE.Group();

  private focus: Interactable | null = null;
  private promptEl: HTMLDivElement | null = null;
  private lastPromptId = '';
  /** What is on the prompt right now — a registry focus or a world offer. */
  private context: ContextPromptView | null = null;
  /** Seconds with nothing to offer, so the prompt does not strobe in a crowd. */
  private emptyFor = 0;

  /** Shared marker geometry — one ring, one diamond, one beam for everything. */
  private ringGeo!: THREE.RingGeometry;
  private gemGeo!: THREE.OctahedronGeometry;
  private beamGeo!: THREE.CylinderGeometry;
  private matCache = new Map<number, { ring: THREE.Material; gem: THREE.Material; beam: THREE.Material }>();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Interaction, this);
    this.phys = ctx.tryGet(Services.Physics) ?? null;
    this.root.name = 'interactables';
    this.root.matrixAutoUpdate = true;
    ctx.scene.add(this.root);

    this.ringGeo = new THREE.RingGeometry(0.78, 1.05, 28, 1);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.gemGeo = new THREE.OctahedronGeometry(0.28, 0);
    this.beamGeo = new THREE.CylinderGeometry(0.34, 0.5, 2.6, 12, 1, true);
    this.beamGeo.translate(0, 1.3, 0);

    this.buildPrompt();
  }

  /* ---------------------------------------------------------------- */
  /* registry                                                          */
  /* ---------------------------------------------------------------- */

  add(spec: InteractableSpec): void {
    this.remove(spec.id);
    const kind = spec.kind ?? 'story';
    const it: Interactable = {
      ...spec,
      kind,
      radius: spec.radius ?? 3.4,
      onFoot: spec.onFoot ?? true,
      inVehicle: spec.inVehicle ?? false,
      facing: spec.facing ?? 0.15,
      requireLos: spec.requireLos ?? true,
      auto: spec.auto ?? false,
      silent: spec.silent ?? false,
      color: spec.color ?? KIND_COLOR[kind],
      position: spec.position.clone(),
      marker: null,
      enabled: true,
    };
    if (!it.silent) it.marker = this.buildMarker(it);
    this.list.push(it);
    this.byId.set(it.id, it);
  }

  remove(id: string): void {
    const it = this.byId.get(id);
    if (!it) return;
    this.byId.delete(id);
    const i = this.list.indexOf(it);
    if (i >= 0) this.list.splice(i, 1);
    if (it.marker) {
      this.root.remove(it.marker);
      it.marker = null;
    }
    if (this.focus === it) this.setFocus(null);
  }

  /** Drop every interactable whose id starts with `prefix`. */
  removeByPrefix(prefix: string): void {
    for (const it of this.list.slice()) {
      if (it.id.startsWith(prefix)) this.remove(it.id);
    }
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  setEnabled(id: string, on: boolean): void {
    const it = this.byId.get(id);
    if (!it) return;
    it.enabled = on;
    if (it.marker) it.marker.visible = on;
  }

  moveTo(id: string, p: THREE.Vector3): void {
    const it = this.byId.get(id);
    if (!it) return;
    it.position.copy(p);
    it.marker?.position.copy(p);
  }

  get count(): number {
    return this.list.length;
  }

  /** Ids currently registered — the debug harness reads this. */
  ids(): string[] {
    return this.list.map((i) => i.id);
  }

  /** The label the player would see right now, or '' for none. */
  get focusLabel(): string {
    return this.focus ? this.focus.label : '';
  }
  get focusId(): string {
    return this.focus ? this.focus.id : '';
  }

  /** The keycap prompt on screen right now, registry or world. Debug/tests. */
  get promptLabel(): string {
    return this.context ? this.context.label : '';
  }

  /** Fire an interactable directly — used by the debug harness and by tests. */
  trigger(id: string): boolean {
    const it = this.byId.get(id);
    if (!it || !it.enabled) return false;
    this.fire(it);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    const player = ctx.tryGet(Services.Player);
    if (!player) {
      this.setFocus(null);
      claim.active = false;
      this.offerPrompt(null, dt);
      return;
    }
    if (this.list.length === 0) {
      // No registry entries, but a parked Dacia is still worth a keycap.
      this.setFocus(null);
      claim.active = false;
      this.offerPrompt(this.readContext(ctx, player), dt);
      return;
    }

    const onFoot = player.isOnFoot;
    const pos = player.position;
    ctx.camera.getWorldDirection(_fwd);
    _eye.set(pos.x, pos.y + 1.55, pos.z);

    let best: Interactable | null = null;
    let bestScore = Infinity;

    for (const it of this.list) {
      if (!it.enabled) continue;
      if (it.onFoot && !onFoot) continue;
      if (it.inVehicle && onFoot) continue;

      _to.subVectors(it.position, pos);
      const dy = Math.abs(_to.y);
      _to.y = 0;
      const d = _to.length();
      // A marker one storey above or below you is not "here", however close it
      // is on the map.
      if (d > it.radius || dy > 4.5) continue;

      if (it.auto) {
        this.fire(it);
        return;
      }

      _to.divideScalar(Math.max(1e-4, d));
      const facing = _to.x * _fwd.x + _to.z * _fwd.z;
      if (facing < it.facing && d > 1.4) continue;

      if (it.requireLos && this.blocked(it)) continue;

      // Prefer whatever you are most squarely looking at, then whatever is
      // nearest: the score is distance discounted by how head-on it is.
      const score = d * (1.6 - Math.max(0, facing) * 0.6);
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }

    this.setFocus(best);
    claim.active = best !== null;
    claim.frame = ctx.time.frame;

    // A registered interactable owns both the prompt and the press; the world's
    // own offers only speak when the registry is quiet.
    this.offerPrompt(
      best
        ? { id: `it:${best.id}`, keys: hintKeys('interact'), label: best.label, color: best.color }
        : this.readContext(ctx, player),
      dt,
    );

    if (best && ctx.input.actionPressed('interact')) this.fire(best);

    this.animateMarkers(dt, ctx, pos);
  }

  private blocked(it: Interactable): boolean {
    const phys = this.phys;
    if (!phys) return false;
    _tmp.set(it.position.x, it.position.y + 1.0, it.position.z).sub(_eye);
    const dist = _tmp.length();
    if (dist < 0.4) return false;
    _tmp.divideScalar(dist);
    const hit = phys.raycast(_eye, _tmp, dist - 0.35, probeGroups(CG.STATIC));
    return hit !== null && hit.distance < dist - 0.4;
  }

  private fire(it: Interactable): void {
    this.ctx.events.emit('player:interact', { targetId: it.id });
    this.ctx.events.emit('audio:oneShot', { id: 'interact', position: it.position.clone(), volume: 0.7 });
    it.onTrigger(this.ctx);
  }

  /* ---------------------------------------------------------------- */
  /* presentation                                                      */
  /* ---------------------------------------------------------------- */

  private setFocus(it: Interactable | null): void {
    this.focus = it;
  }

  /* ---------------------------------------------------------------- */
  /* What the world offers where you stand                             */
  /* ---------------------------------------------------------------- */

  /**
   * The car you could get into, the car you could step out of, the person in
   * front of you. Measured here, decided in `contextPrompt()`.
   */
  private readContext(ctx: GameContext, player: PlayerService): ContextPromptView | null {
    const onFoot = player.isOnFoot;
    const seated = player.inVehicle;

    let nearVehicle: VehicleClass | null = null;
    if (onFoot) {
      const v = ctx.tryGet(Services.Vehicles)?.nearestEnterable(player.position, VEHICLE_PROMPT_RANGE);
      if (v && !v.isWrecked) nearVehicle = v.kind;
    }

    return contextPrompt({
      nearVehicle,
      seatedStopped: !!seated && Math.abs(seated.speed) < EXIT_PROMPT_SPEED,
      nearPerson: onFoot && nearVehicle === null && this.personInReach(ctx, player),
    });
  }

  /** A living ped within arm's reach and roughly in front of the camera. */
  private personInReach(ctx: GameContext, player: PlayerService): boolean {
    const peds = ctx.tryGet(Services.Peds);
    if (!peds) return false;
    ctx.camera.getWorldDirection(_fwd);
    const pos = player.position;
    const r2 = PERSON_PROMPT_RANGE * PERSON_PROMPT_RANGE;
    for (const ped of peds.all) {
      if (!ped.isAlive) continue;
      const dx = ped.position.x - pos.x;
      const dz = ped.position.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 < 1e-4) continue;
      if (Math.abs(ped.position.y - pos.y) > 2.5) continue;
      const inv = 1 / Math.sqrt(d2);
      if (dx * inv * _fwd.x + dz * inv * _fwd.z > 0.35) return true;
    }
    return false;
  }

  /**
   * The one prompt widget, shared by the registry and the world.
   *
   * Losing the offer does NOT hide it immediately. Walking through a crowd, a
   * ped drifts in and out of the melee arc several times a second, and a prompt
   * that strobed with it read as a bug. A new offer still takes over at once —
   * only the disappearance waits.
   */
  private offerPrompt(view: ContextPromptView | null, dt: number): void {
    this.context = view;
    if (!view) {
      this.emptyFor += dt;
      if (this.lastPromptId && this.emptyFor >= PROMPT_HOLD_SECONDS) this.paintPrompt(null);
      return;
    }
    this.emptyFor = 0;
    this.paintPrompt(view);
  }

  private paintPrompt(view: ContextPromptView | null): void {
    const el = this.promptEl;
    if (!el) return;
    const id = view ? view.id : '';
    if (id === this.lastPromptId) return;
    this.lastPromptId = id;
    if (!view) {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(6px)';
      return;
    }
    el.innerHTML =
      `${view.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}<span>${escapeHtml(t(view.label))}</span>`;
    el.style.borderColor = `#${view.color.toString(16).padStart(6, '0')}`;
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
  }

  private buildPrompt(): void {
    const host = document.getElementById('ui-root');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'gta-prompt';
    el.style.cssText =
      'position:absolute;left:50%;bottom:150px;transform:translateX(-50%) translateY(6px);' +
      'display:flex;align-items:center;gap:10px;padding:8px 16px 8px 10px;' +
      'background:rgba(14,7,24,.86);border:1px solid #ff3d7f;border-radius:3px;' +
      'font:600 15px/1 Inter,system-ui,sans-serif;color:#f4eaff;letter-spacing:.02em;' +
      'opacity:0;transition:opacity .16s,transform .16s;pointer-events:none;' +
      'text-shadow:0 1px 4px #000;box-shadow:0 6px 26px rgba(0,0,0,.55);z-index:5;';
    const style = document.createElement('style');
    style.textContent =
      '.gta-prompt kbd{display:inline-flex;align-items:center;justify-content:center;' +
      'min-width:26px;height:26px;padding:0 6px;border-radius:3px;background:#f4eaff;' +
      'color:#160a22;font:800 14px/1 Inter,system-ui,sans-serif;box-shadow:0 2px 0 #8e79a8;}';
    host.appendChild(style);
    host.appendChild(el);
    this.promptEl = el;
  }

  private materials(color: number): { ring: THREE.Material; gem: THREE.Material; beam: THREE.Material } {
    let m = this.matCache.get(color);
    if (m) return m;
    const c = new THREE.Color(color).convertSRGBToLinear();
    m = {
      ring: new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false,
      }),
      gem: new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false, toneMapped: false,
      }),
      beam: new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      }),
    };
    this.matCache.set(color, m);
    return m;
  }

  private buildMarker(it: Interactable): THREE.Object3D {
    const mats = this.materials(it.color);
    const g = new THREE.Group();
    g.name = `marker:${it.id}`;

    const ring = new THREE.Mesh(this.ringGeo, mats.ring);
    ring.position.y = 0.06;
    ring.renderOrder = 3;
    g.add(ring);

    const beam = new THREE.Mesh(this.beamGeo, mats.beam);
    beam.renderOrder = 3;
    g.add(beam);

    const gem = new THREE.Mesh(this.gemGeo, mats.gem);
    gem.position.y = 1.85;
    gem.renderOrder = 999;
    gem.name = 'gem';
    g.add(gem);

    g.position.copy(it.position);
    this.root.add(g);
    return g;
  }

  /** Bob and spin the diamonds, and hide markers nobody can see. */
  private animateMarkers(dt: number, ctx: GameContext, playerPos: THREE.Vector3): void {
    const t = ctx.time.elapsed;
    void dt;
    for (const it of this.list) {
      const m = it.marker;
      if (!m) continue;
      const d2 = (m.position.x - playerPos.x) ** 2 + (m.position.z - playerPos.z) ** 2;
      const near = d2 < 140 * 140;
      if (m.visible !== (near && it.enabled)) m.visible = near && it.enabled;
      if (!near || !it.enabled) continue;
      const gem = m.getObjectByName('gem');
      if (gem) {
        gem.rotation.y = t * 1.5;
        gem.position.y = 1.85 + Math.sin(t * 2.4 + m.position.x) * 0.13;
        const focused = this.focus === it;
        gem.scale.setScalar(focused ? 1.35 : 1);
      }
    }
  }

  dispose(): void {
    for (const it of this.list.slice()) this.remove(it.id);
    this.root.removeFromParent();
    this.ringGeo?.dispose();
    this.gemGeo?.dispose();
    this.beamGeo?.dispose();
    for (const m of this.matCache.values()) {
      m.ring.dispose();
      m.gem.dispose();
      m.beam.dispose();
    }
    this.matCache.clear();
    this.promptEl?.remove();
    this.context = null;
    claim.active = false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}
