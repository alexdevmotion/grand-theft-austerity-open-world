/** Debug overlay + the automation hooks the critic harness drives.
 *
 *  `window.__GTA_DEBUG__` is the stable contract for automated screenshots and
 *  playtests. Do not rename its methods without updating tools/shot.mjs. */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services } from '../core/services';

export interface DebugApi {
  /** Frames-per-second, smoothed. */
  fps(): number;
  /** Teleport the player (and any vehicle) to a world position. */
  teleport(x: number, y: number, z: number, headingDeg?: number): void;
  /** Move the camera to an explicit position/target for a framed screenshot. */
  setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov?: number): void;
  /** Release the scripted camera back to gameplay. */
  releaseCamera(): void;
  /** Spawn a vehicle in front of the player and put the player in it. */
  giveVehicle(kind?: string): void;
  /** Drive synthetic input for automated playtests. */
  setInput(i: Partial<{ moveX: number; moveY: number; throttle: number; steer: number; sprint: boolean; handbrake: boolean }>): void;
  clearInput(): void;
  /** Scene statistics used by critics to prove the world is not empty. */
  stats(): {
    fps: number; drawCalls: number; triangles: number; programs: number;
    vehicles: number; peds: number; traffic: number; stars: number;
    playerPos: [number, number, number]; inVehicle: boolean; quality: string;
    sceneObjects: number; loadedChunks: number;
  };
  /** Jump to a named landmark. */
  goTo(landmarkId: string): void;
  landmarks(): string[];
  /**
   * Frame a landmark from a position that is guaranteed to be OUTSIDE
   * geometry, by probing rings of candidate camera spots and keeping the one
   * with a clear line of sight. Returns the chosen camera position, or null if
   * the landmark is unknown. This is what the screenshot harness uses — never
   * hardcode camera coordinates, they go stale the moment the city changes.
   */
  frameLandmark(
    landmarkId: string,
    opts?: { distance?: number; height?: number; fov?: number; lookHeight?: number; azimuthDeg?: number },
  ): { pos: [number, number, number]; target: [number, number, number] } | null;
  /** Frame whatever the player is currently at, from a clear nearby spot. */
  frameHere(opts?: { distance?: number; height?: number; fov?: number }): { pos: [number, number, number]; target: [number, number, number] } | null;
  setWeather(preset: string): void;
  setTimeOfDay(hours: number): void;
  setQuality(q: 'low' | 'medium' | 'high' | 'ultra'): void;
  togglePhysicsDebug(): void;
  /** True once every system has finished init and a frame has rendered. */
  ready(): boolean;
}

export class DebugSystem implements System {
  readonly name = 'debug';
  /** Runs first so synthetic input lands before the player reads it. Its
   *  lateUpdate still runs after the camera system, since lateUpdate is a
   *  separate pass over all systems. */
  readonly order = 1;

  private ctx!: GameContext;
  private el!: HTMLDivElement;
  private visible = false;
  private scriptedCamera: { pos: THREE.Vector3; target: THREE.Vector3; fov: number } | null = null;
  private framesRendered = 0;

  /** Synthetic input applied on top of real input for automated playtests. */
  synthetic: Partial<{ moveX: number; moveY: number; throttle: number; steer: number; sprint: boolean; handbrake: boolean }> = {};

  init(ctx: GameContext): void {
    this.ctx = ctx;

    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:absolute;top:8px;left:10px;font:11px/1.5 ui-monospace,monospace;color:#9fe8b0;' +
      'background:rgba(6,3,12,.72);padding:8px 11px;white-space:pre;pointer-events:none;display:none;';
    document.getElementById('ui-root')!.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1' || (e.code === 'Backquote' && e.shiftKey)) {
        this.visible = !this.visible;
        this.el.style.display = this.visible ? '' : 'none';
      }
    });

    const api: DebugApi = {
      fps: () => ctx.tryGet(Services.Render)?.fps ?? 0,
      teleport: (x, y, z, headingDeg = 0) => {
        const p = ctx.tryGet(Services.Player);
        const heading = THREE.MathUtils.degToRad(headingDeg);
        if (p?.inVehicle) p.inVehicle.teleport(new THREE.Vector3(x, y, z), heading);
        else p?.teleport(new THREE.Vector3(x, y, z), heading);
      },
      setCamera: (px, py, pz, tx, ty, tz, fov = 50) => {
        this.scriptedCamera = {
          pos: new THREE.Vector3(px, py, pz),
          target: new THREE.Vector3(tx, ty, tz),
          fov,
        };
      },
      releaseCamera: () => {
        this.scriptedCamera = null;
      },
      /**
       * Spawn a vehicle and put the player in it.
       *
       * The car is placed ON the nearest road node and turned to face along a
       * road, rather than at a fixed offset with heading 0. A fixed offset
       * routinely dropped the car against a building or a barrier, so scripted
       * throttle produced a crawl and made automated driving tests read as a
       * broken vehicle when the vehicle was fine.
       */
      giveVehicle: (kind = 'dacia') => {
        const p = ctx.tryGet(Services.Player);
        const v = ctx.tryGet(Services.Vehicles);
        if (!p || !v) return;
        if (p.inVehicle) p.exitVehicle();

        const city = ctx.tryGet(Services.City);
        const pos = p.position.clone();
        let heading = 0;

        if (city) {
          const id = city.nearestNode(p.position);
          const node = id >= 0 ? city.roadNodes[id] : undefined;
          if (node) {
            const link = node.links.length ? city.roadNodes[node.links[0]] : undefined;
            if (link) {
              const dx = link.position.x - node.position.x;
              const dz = link.position.z - node.position.z;
              heading = Math.atan2(dx, dz);
              // Sit a little way along the link so the car starts on tarmac
              // rather than in the middle of the junction box.
              const len = Math.hypot(dx, dz) || 1;
              pos.set(
                node.position.x + (dx / len) * 6,
                node.position.y,
                node.position.z + (dz / len) * 6,
              );
            } else {
              pos.copy(node.position);
            }
          }
        }

        pos.y += 1;
        const handle = v.spawn(kind as never, pos, heading, { faction: 'player' });
        p.enterVehicle(handle);
      },
      setInput: (i) => {
        Object.assign(this.synthetic, i);
      },
      clearInput: () => {
        this.synthetic = {};
        ctx.input.forcedActions.clear();
        ctx.input.axes.moveX = ctx.input.axes.moveY = 0;
        ctx.input.axes.throttle = ctx.input.axes.steer = 0;
      },
      stats: () => {
        const info = ctx.renderer.info;
        const p = ctx.tryGet(Services.Player);
        return {
          fps: ctx.tryGet(Services.Render)?.fps ?? 0,
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          programs: info.programs?.length ?? 0,
          vehicles: ctx.tryGet(Services.Vehicles)?.all.length ?? 0,
          peds: ctx.tryGet(Services.Peds)?.all.length ?? 0,
          traffic: ctx.tryGet(Services.Traffic)?.activeCount ?? 0,
          stars: ctx.tryGet(Services.Wanted)?.stars ?? 0,
          playerPos: p ? [p.position.x, p.position.y, p.position.z] : [0, 0, 0],
          inVehicle: !!p?.inVehicle,
          quality: ctx.tryGet(Services.Render)?.quality ?? '?',
          sceneObjects: countObjects(ctx.scene),
          loadedChunks: ctx.tryGet(Services.Streaming)?.loadedChunks ?? 0,
        };
      },
      goTo: (id) => {
        const city = ctx.tryGet(Services.City);
        const lm = city?.landmarks.get(id);
        if (!lm) return;
        api.teleport(lm.position.x, lm.position.y + 2, lm.position.z);
      },
      landmarks: () => Array.from(ctx.tryGet(Services.City)?.landmarks.keys() ?? []),
      frameLandmark: (id, opts) => {
        const lm = ctx.tryGet(Services.City)?.landmarks.get(id);
        if (!lm) return null;
        const look = new THREE.Vector3(lm.position.x, lm.position.y + (opts?.lookHeight ?? 14), lm.position.z);
        return this.frameTarget(ctx, look, opts);
      },
      frameHere: (opts) => {
        const p = ctx.tryGet(Services.Player);
        if (!p) return null;
        const look = p.position.clone().setY(p.position.y + 1.5);
        return this.frameTarget(ctx, look, { ...opts, lookHeight: 0 });
      },
      setWeather: (preset) => ctx.tryGet(Services.Weather)?.set(preset as never, 0.1),
      setTimeOfDay: (h) => {
        const w = ctx.tryGet(Services.Weather);
        if (w) w.timeOfDay = h;
      },
      setQuality: (q) => ctx.tryGet(Services.Render)?.setQuality(q),
      togglePhysicsDebug: () => {
        const ph = ctx.tryGet(Services.Physics);
        if (ph) ph.debugEnabled = !ph.debugEnabled;
      },
      ready: () => this.framesRendered > 3,
    };

    (window as unknown as { __GTA_DEBUG__: DebugApi }).__GTA_DEBUG__ = api;
  }

  /**
   * Inject synthetic input for automated playtests.
   *
   * This MUST run in fixedUpdate, not update. The frame order is
   * `input.update()` → fixedUpdate×N → update → lateUpdate, and both the
   * player controller and the vehicle simulation read `input.axes` from
   * *fixedUpdate*. Writing the axes in `update()` therefore lands after every
   * consumer has already read them, and `input.update()` clears them again at
   * the top of the next frame — so scripted walking and driving silently did
   * nothing. DebugSystem.order is 1, ahead of the player (200) and the
   * vehicles (110), so writing here reaches both in the same step.
   */
  fixedUpdate(_dt: number, ctx: GameContext): void {
    const s = this.synthetic;
    if (s.moveX !== undefined) ctx.input.axes.moveX = s.moveX;
    if (s.moveY !== undefined) ctx.input.axes.moveY = s.moveY;
    if (s.throttle !== undefined) ctx.input.axes.throttle = s.throttle;
    if (s.steer !== undefined) ctx.input.axes.steer = s.steer;

    const forced = ctx.input.forcedActions;
    if (s.sprint !== undefined) {
      if (s.sprint) forced.add('sprint');
      else forced.delete('sprint');
    }
    if (s.handbrake !== undefined) {
      if (s.handbrake) forced.add('handbrake');
      else forced.delete('handbrake');
    }
  }

  update(_dt: number, ctx: GameContext): void {
    this.framesRendered++;
    void ctx;

    if (!this.visible) return;
    const st = (window as unknown as { __GTA_DEBUG__: DebugApi }).__GTA_DEBUG__.stats();
    this.el.textContent =
      `fps        ${st.fps.toFixed(1)}\n` +
      `draws/tris ${st.drawCalls} / ${(st.triangles / 1000).toFixed(0)}k\n` +
      `vehicles   ${st.vehicles}  traffic ${st.traffic}\n` +
      `peds       ${st.peds}\n` +
      `stars      ${st.stars}\n` +
      `pos        ${st.playerPos.map((v) => v.toFixed(1)).join(', ')}\n` +
      `quality    ${st.quality}${st.inVehicle ? '  [driving]' : ''}`;
  }

  /**
   * Probe candidate camera spots around `look` and keep the best one.
   *
   * "Best" = a spot that is not inside geometry AND has an unobstructed ray to
   * the target. We sweep azimuth (and fall back to shorter distances) because
   * a fixed offset lands inside a building the moment the city regenerates.
   */
  private frameTarget(
    ctx: GameContext,
    look: THREE.Vector3,
    opts?: { distance?: number; height?: number; fov?: number; azimuthDeg?: number; lookHeight?: number },
  ): { pos: [number, number, number]; target: [number, number, number] } | null {
    const phys = ctx.tryGet(Services.Physics);
    const distance = opts?.distance ?? 46;
    const height = opts?.height ?? 3.2;
    const fov = opts?.fov ?? 48;

    const candidate = new THREE.Vector3();
    const toTarget = new THREE.Vector3();
    let best: THREE.Vector3 | null = null;
    let bestClearance = -1;

    const startAz = opts?.azimuthDeg !== undefined ? THREE.MathUtils.degToRad(opts.azimuthDeg) : 0;
    const azSteps = opts?.azimuthDeg !== undefined ? 1 : 24;

    for (const distScale of [1, 0.72, 0.5, 1.4]) {
      for (let i = 0; i < azSteps; i++) {
        const az = startAz + (i / azSteps) * Math.PI * 2;
        const d = distance * distScale;
        candidate.set(look.x + Math.sin(az) * d, look.y * 0 + height, look.z + Math.cos(az) * d);

        // Reject spots buried in geometry: fire a short ray straight up.
        if (phys) {
          const up = phys.raycast(candidate, new THREE.Vector3(0, 1, 0), 60, undefined);
          // A hit immediately overhead is fine (a bridge); a hit at ~0 is not.
          if (up && up.distance < 0.6) continue;
        }

        toTarget.subVectors(look, candidate);
        const dist = toTarget.length();
        toTarget.divideScalar(dist);

        let clearance = dist;
        if (phys) {
          const hit = phys.raycast(candidate, toTarget, dist, undefined);
          // Allow hitting the landmark itself near the end of the ray.
          clearance = hit ? hit.distance : dist;
          if (clearance < dist * 0.82) continue;
        }
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = candidate.clone();
        }
      }
      if (best) break;
    }

    const pos = best ?? candidate.set(look.x + distance, height, look.z + distance).clone();
    this.scriptedCamera = { pos, target: look.clone(), fov };
    return {
      pos: [pos.x, pos.y, pos.z],
      target: [look.x, look.y, look.z],
    };
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    if (!this.scriptedCamera) return;
    ctx.camera.position.copy(this.scriptedCamera.pos);
    ctx.camera.lookAt(this.scriptedCamera.target);
    if (ctx.camera.fov !== this.scriptedCamera.fov) {
      ctx.camera.fov = this.scriptedCamera.fov;
      ctx.camera.updateProjectionMatrix();
    }
  }
}

function countObjects(root: THREE.Object3D): number {
  let n = 0;
  root.traverse(() => n++);
  return n;
}
