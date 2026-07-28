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
      giveVehicle: (kind = 'dacia') => {
        const p = ctx.tryGet(Services.Player);
        const v = ctx.tryGet(Services.Vehicles);
        if (!p || !v) return;
        if (p.inVehicle) p.exitVehicle();
        const pos = p.position.clone().add(new THREE.Vector3(3, 1, 0));
        const handle = v.spawn(kind as never, pos, 0, { faction: 'player' });
        p.enterVehicle(handle);
      },
      setInput: (i) => {
        Object.assign(this.synthetic, i);
      },
      clearInput: () => {
        this.synthetic = {};
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

  update(_dt: number, ctx: GameContext): void {
    this.framesRendered++;

    // Inject synthetic input for automated playtests.
    const s = this.synthetic;
    if (s.moveX !== undefined) ctx.input.axes.moveX = s.moveX;
    if (s.moveY !== undefined) ctx.input.axes.moveY = s.moveY;
    if (s.throttle !== undefined) ctx.input.axes.throttle = s.throttle;
    if (s.steer !== undefined) ctx.input.axes.steer = s.steer;

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
