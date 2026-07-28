/**
 * Third-person / vehicle chase camera with collision, spring smoothing and
 * speed-driven FOV.
 *
 * OWNER: camera/feel agent. Must deliver cinematic chase framing, look-behind,
 * aim over-the-shoulder, shake, cutscene focus and a photo mode.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { CG, PhysicsWorld, groups } from '../physics/physics';
import { Services, type CameraService } from '../core/services';

export class CameraSystem implements System, CameraService {
  readonly name = 'camera';
  readonly order = 300;

  private _mode: CameraService['mode'] = 'thirdPerson';
  private yaw = 0;
  private pitch = 0.14;
  private ctx!: GameContext;
  private phys!: PhysicsWorld;

  private currentPos = new THREE.Vector3();
  private currentLook = new THREE.Vector3();
  private shakeAmount = 0;
  private shakeTime = 0;
  private focusTimer = 0;
  private focusPoint = new THREE.Vector3();
  private baseFov = 58;
  private currentFov = 58;

  /** Per-mode rig. */
  private rigs = {
    thirdPerson: { distance: 4.4, height: 1.72, shoulder: 0.55, fov: 58 },
    vehicle: { distance: 8.2, height: 3.1, shoulder: 0, fov: 62 },
    aim: { distance: 1.9, height: 1.62, shoulder: 0.78, fov: 44 },
    cinematic: { distance: 7.0, height: 2.4, shoulder: 0, fov: 50 },
    photo: { distance: 5.0, height: 2.0, shoulder: 0, fov: 55 },
  };

  get mode(): CameraService['mode'] {
    return this._mode;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.get(Services.Physics);
    ctx.provide(Services.Camera, this);
    this.currentPos.copy(ctx.camera.position);

    ctx.canvas.addEventListener('click', () => ctx.input.requestPointerLock());
  }

  setMode(m: CameraService['mode']): void {
    this._mode = m;
  }

  shake(intensity: number, seconds: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, intensity);
    this.shakeTime = Math.max(this.shakeTime, seconds);
  }

  focusOn(p: THREE.Vector3, seconds: number): void {
    this.focusPoint.copy(p);
    this.focusTimer = seconds;
  }

  private _target = new THREE.Vector3();
  private _desired = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _tmp = new THREE.Vector3();

  update(dt: number, ctx: GameContext): void {
    const player = ctx.tryGet(Services.Player);
    if (!player) return;

    const input = ctx.input;
    this.yaw -= input.axes.lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.axes.lookY, -0.72, 1.05);

    const veh = player.inVehicle;
    const rig = this.rigs[this._mode];

    // Anchor point.
    if (veh) {
      this._target.copy(veh.position).add(this._tmp.set(0, 1.0, 0));
      // Auto-align behind the car when the player isn't actively looking.
      if (Math.abs(input.axes.lookX) < 0.0005) {
        const e = new THREE.Euler().setFromQuaternion(veh.rotation, 'YXZ');
        const behind = e.y + Math.PI;
        const speedFactor = THREE.MathUtils.clamp(Math.abs(veh.speed) / 12, 0, 1);
        this.yaw = dampAngle(this.yaw, behind, 2.6 * speedFactor, dt);
      }
    } else {
      this._target.copy(player.position).add(this._tmp.set(0, rig.height, 0));
    }

    // Tell the player which way "forward" is.
    player.character; // handle exists
    (ctx.get(Services.Player) as unknown as { desiredYaw: number }).desiredYaw = this.yaw;

    // Desired camera position on a sphere behind the anchor.
    const cosP = Math.cos(this.pitch);
    this._dir.set(
      Math.sin(this.yaw + Math.PI) * cosP,
      Math.sin(this.pitch),
      Math.cos(this.yaw + Math.PI) * cosP,
    );

    const speed = veh ? Math.abs(veh.speed) : 0;
    const distance = rig.distance + (veh ? THREE.MathUtils.clamp(speed * 0.10, 0, 3.2) : 0);

    this._desired.copy(this._target).addScaledVector(this._dir, distance);
    if (rig.shoulder) {
      this._tmp.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(rig.shoulder);
      this._desired.add(this._tmp);
      this._target.add(this._tmp);
    }

    // Collision: pull the camera in if a wall is between it and the anchor.
    const toCam = this._tmp.subVectors(this._desired, this._target);
    const dist = toCam.length();
    if (dist > 0.001) {
      toCam.divideScalar(dist);
      const hit = this.phys.raycast(
        this._target,
        toCam,
        dist + 0.4,
        groups(CG.SENSOR, CG.STATIC | CG.TERRAIN),
      );
      if (hit) this._desired.copy(this._target).addScaledVector(toCam, Math.max(0.9, hit.distance - 0.35));
    }

    // Spring follow — snappier in vehicles so the car never outruns the frame.
    const follow = veh ? 14 : 11;
    const k = 1 - Math.exp(-follow * dt);
    this.currentPos.lerp(this._desired, k);
    this.currentLook.lerp(this._target, 1 - Math.exp(-16 * dt));

    // Cutscene focus override.
    if (this.focusTimer > 0) {
      this.focusTimer -= dt;
      this.currentLook.lerp(this.focusPoint, 1 - Math.exp(-4 * dt));
    }

    ctx.camera.position.copy(this.currentPos);

    // Shake.
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const a = this.shakeAmount * Math.min(1, this.shakeTime * 3);
      ctx.camera.position.x += (Math.random() - 0.5) * a;
      ctx.camera.position.y += (Math.random() - 0.5) * a;
      ctx.camera.position.z += (Math.random() - 0.5) * a;
      if (this.shakeTime <= 0) this.shakeAmount = 0;
    }

    ctx.camera.lookAt(this.currentLook);

    // Speed FOV.
    const targetFov = rig.fov + (veh ? THREE.MathUtils.clamp(speed * 0.42, 0, 15) : 0);
    this.currentFov += (targetFov - this.currentFov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(ctx.camera.fov - this.currentFov) > 0.01) {
      ctx.camera.fov = this.currentFov;
      ctx.camera.updateProjectionMatrix();
    }
    void this.baseFov;
  }
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}
