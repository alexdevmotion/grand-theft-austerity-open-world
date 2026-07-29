/**
 * Third-person / vehicle chase camera with collision, spring smoothing and
 * speed-driven FOV.
 *
 * OWNER: camera/feel agent. Must deliver cinematic chase framing, look-behind,
 * aim over-the-shoulder, shake, cutscene focus and a photo mode.
 *
 * THREE INVARIANTS THIS FILE IS RESPONSIBLE FOR
 * --------------------------------------------
 * 1. THE CAMERA IS NEVER BELOW THE GROUND. Every solve — spring, collision
 *    pull-in, shake — is followed by a hard floor clamp built from
 *    `CityService.spatial.groundHeight` AND a physics probe, so the clamp also
 *    holds on kerbs, ramps and anything the city adds later. The clamp is
 *    applied to the *spring state*, not only to the rendered position:
 *    clamping only the output lets the spring keep integrating underground and
 *    the camera snaps back through the floor the moment the obstruction ends.
 * 2. THE CAMERA IS NEVER INSIDE ITS SUBJECT. Collision pull-in is floored at a
 *    per-mode minimum radius, and a final "eject" step pushes the camera back
 *    out along the view axis if anything (a wall on both sides, a floor clamp
 *    that shortened the boom) left it inside the player's head or the car.
 * 3. THE RIG SITS BEHIND THE CAR. Camera position is `anchor - F * distance`
 *    with `F = (sin yaw, 0, cos yaw)`, and vehicle forward is also
 *    `(sin heading, 0, cos heading)`, so `yaw == heading` frames the car from
 *    behind. Adding PI rotates the rig to the far side and frames it head-on.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { CG, PhysicsWorld, probeGroups } from '../physics/physics';
import { Rng } from '../core/rng';
import { Services, type CameraService, type CityService } from '../core/services';

/** Metres of clearance kept between the camera and whatever is under it. */
const FLOOR_MARGIN = 0.42;
/** How far above the camera the downward probe starts. */
const FLOOR_PROBE_UP = 3.0;
const FLOOR_PROBE_LENGTH = 24.0;

export class CameraSystem implements System, CameraService {
  readonly name = 'camera';
  readonly order = 300;

  private _mode: CameraService['mode'] = 'thirdPerson';
  private yaw = 0;
  private pitch = 0.14;
  private ctx!: GameContext;
  private phys!: PhysicsWorld;
  private city: CityService | undefined;
  private shakeRng = new Rng('camera-shake');

  private currentPos = new THREE.Vector3();
  private currentLook = new THREE.Vector3();
  private shakeAmount = 0;
  private shakeTime = 0;
  private focusTimer = 0;
  private focusPoint = new THREE.Vector3();
  private currentFov = 58;

  /* ---- chase state (vehicle feel) ---- */
  /** Smoothed longitudinal acceleration, m/s². */
  private accel = 0;
  private lastSpeed = 0;
  /** Smoothed car yaw rate, rad/s. Drives the corner swing. */
  private yawRate = 0;
  private lastHeading = 0;
  private hasLastHeading = false;
  /** True while the rig has swung round to look over the bonnet in reverse. */
  private reversing = false;
  private reverseTimer = 0;
  /** Seconds left of "the player is looking around, do not auto-align". */
  private manualLook = 0;
  /** Extra boom length carried by the acceleration lag, metres. */
  private lagBoom = 0;
  /** Smoothed lateral corner swing, metres. */
  private swing = 0;

  /**
   * Per-mode rig.
   *
   * `minRadius` is the *comfortable* boom length: below it the rig starts
   * climbing rather than closing further, which is how a chase camera gets out
   * of an alley without ending up in the boot.
   * `hardMin` is the absolute floor — the radius at which the camera would be
   * inside the subject — and nothing is ever allowed to go under it.
   * `squeezeLift` is how far the rig climbs when squeezed all the way down.
   */
  private rigs = {
    thirdPerson: { distance: 4.4, height: 1.72, shoulder: 0.55, fov: 58, minRadius: 1.55, hardMin: 0.95, squeezeLift: 0.55 },
    vehicle: { distance: 6.6, height: 2.45, shoulder: 0, fov: 60, minRadius: 3.4, hardMin: 1.9, squeezeLift: 1.9 },
    aim: { distance: 1.9, height: 1.62, shoulder: 0.78, fov: 44, minRadius: 0.95, hardMin: 0.7, squeezeLift: 0.25 },
    cinematic: { distance: 7.0, height: 2.4, shoulder: 0, fov: 50, minRadius: 2.0, hardMin: 1.2, squeezeLift: 0.9 },
    photo: { distance: 5.0, height: 2.0, shoulder: 0, fov: 55, minRadius: 0.6, hardMin: 0.4, squeezeLift: 0.2 },
  };

  get mode(): CameraService['mode'] {
    return this._mode;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.get(Services.Physics);
    this.city = ctx.tryGet(Services.City);
    ctx.provide(Services.Camera, this);
    this.currentPos.copy(ctx.camera.position);

    // Never grab the pointer back while a menu is up — the pause screen has to
    // be usable with a visible cursor.
    //
    // The lock is requested straight off the canvas rather than through
    // `Input.requestPointerLock()` so the returned promise can be caught:
    // browsers reject it for ~1 s after Escape released the lock, and an
    // unhandled rejection is wired to the fatal-error overlay in main.ts.
    ctx.canvas.addEventListener('click', () => {
      if (ctx.time.paused) return;
      if (ctx.input.pointerLocked) return;
      const p = ctx.canvas.requestPointerLock() as unknown;
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => undefined);
      }
    });
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

  /** Point the boom orbits around and the collision ray fires from. */
  private _pivot = new THREE.Vector3();
  /** Point the camera looks at. Leads the pivot in a fast car. */
  private _target = new THREE.Vector3();
  private _desired = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _tmp = new THREE.Vector3();
  private _tmp2 = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _probe = new THREE.Vector3();
  private _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private static readonly DOWN = new THREE.Vector3(0, -1, 0);

  update(dt: number, ctx: GameContext): void {
    const player = ctx.tryGet(Services.Player);
    if (!player) return;
    if (this.city === undefined) this.city = ctx.tryGet(Services.City);

    const input = ctx.input;
    const lookX = input.axes.lookX;
    this.yaw -= lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.axes.lookY, -0.72, 1.05);

    const veh = player.inVehicle;
    const rig = this.rigs[this._mode];

    let distance = rig.distance;
    let height = rig.height;
    let fov = rig.fov;
    let speed = 0;

    if (veh) {
      speed = veh.speed;
      this.updateChase(dt, veh, Math.abs(lookX));

      const fast = Math.min(1, Math.abs(speed) / 26);
      // Pull back and rise with speed, and let acceleration stretch the boom
      // so the car visibly "runs away" from the camera when you floor it.
      distance = rig.distance + fast * 3.4 + this.lagBoom;
      height = rig.height + fast * 0.75;
      fov = rig.fov + fast * 17;

      // The boom orbits the car itself; the look point sits a little above the
      // roofline and leads at speed, so the frame reads into the corner
      // instead of staring at the boot lid.
      this._pivot.copy(veh.position);
      this._pivot.y += height;
      this._target.copy(veh.position);
      this._target.y += 1.05 + fast * 0.25;
      this._target.addScaledVector(this._fwd, THREE.MathUtils.clamp(speed * 0.09, -1.2, 2.6));
    } else {
      this.resetChase();
      this._pivot.copy(player.position).add(this._tmp.set(0, rig.height, 0));
      this._target.copy(this._pivot);
    }

    // Hold `lookBehind` to spin the rig 180° without losing the yaw you had.
    const behind = input.action('lookBehind') ? Math.PI : 0;

    // Tell the player which way "forward" is. (Look-behind must NOT steer the
    // character, so the raw yaw is published, not the flipped one.)
    (ctx.get(Services.Player) as unknown as { desiredYaw: number }).desiredYaw = this.yaw;

    // Desired camera position on a sphere behind the anchor.
    const orbit = this.yaw + behind;
    const cosP = Math.cos(this.pitch);
    this._dir.set(
      Math.sin(orbit + Math.PI) * cosP,
      Math.sin(this.pitch),
      Math.cos(orbit + Math.PI) * cosP,
    );

    this._desired.copy(this._pivot).addScaledVector(this._dir, distance);

    if (veh && this.swing !== 0) {
      // Swing wide in corners: slide the rig toward the outside of the turn.
      this._right.set(Math.cos(orbit), 0, -Math.sin(orbit));
      this._desired.addScaledVector(this._right, this.swing);
    }

    if (rig.shoulder) {
      this._tmp.set(Math.cos(orbit), 0, -Math.sin(orbit)).multiplyScalar(rig.shoulder);
      this._desired.add(this._tmp);
      this._target.add(this._tmp);
    }

    // Keep the *desired* point out of the floor before the spring ever sees it,
    // otherwise the spring chases an underground target every frame.
    this.clampToFloor(this._desired);

    // Collision: pull the camera in if a wall is between it and the pivot.
    const toCam = this._tmp.subVectors(this._desired, this._pivot);
    const dist = toCam.length();
    if (dist > 0.001) {
      toCam.divideScalar(dist);
      const hit = this.phys.raycast(
        this._pivot,
        toCam,
        dist + 0.4,
        probeGroups(CG.STATIC | CG.TERRAIN),
      );
      if (hit && !this.isThinObstacle(hit.distance, dist, toCam)) {
        const pulled = Math.max(rig.hardMin, hit.distance - 0.35);
        if (pulled < dist) {
          this._desired.copy(this._pivot).addScaledVector(toCam, pulled);
          // Squeezed shorter than the comfortable boom: climb instead of
          // burrowing. Clamping the boom at `minRadius` and stopping there is
          // what parks the camera inside a shopfront when a car noses into a
          // building — the wall is closer than the rig wants to be, so the
          // only way out is up and over.
          const span = Math.max(0.001, rig.minRadius - rig.hardMin);
          const squeeze = THREE.MathUtils.clamp((rig.minRadius - pulled) / span, 0, 1);
          if (squeeze > 0) {
            this._desired.y += squeeze * rig.squeezeLift;
            // The lift must not tunnel through a ceiling either.
            const liftLen = this._tmp2.subVectors(this._desired, this._pivot).length();
            this._tmp2.divideScalar(Math.max(1e-4, liftLen));
            const up = this.phys.raycast(
              this._pivot,
              this._tmp2,
              liftLen,
              probeGroups(CG.STATIC | CG.TERRAIN),
            );
            if (up) {
              this._desired.copy(this._pivot)
                .addScaledVector(this._tmp2, Math.max(rig.hardMin, up.distance - 0.25));
            }
          }
        }
      }
    }

    // Spring follow — snappier in vehicles so the car never outruns the frame.
    const follow = veh ? 12 + Math.min(1, Math.abs(speed) / 24) * 8 : 11;
    const k = 1 - Math.exp(-follow * dt);
    this.currentPos.lerp(this._desired, k);
    this.currentLook.lerp(this._target, 1 - Math.exp(-16 * dt));

    // Cutscene focus override.
    if (this.focusTimer > 0) {
      this.focusTimer -= dt;
      this.currentLook.lerp(this.focusPoint, 1 - Math.exp(-4 * dt));
    }

    // HARD FLOOR. Applied to the spring state so an obstruction that shortened
    // the boom cannot leave the camera integrating below the pavement.
    this.clampToFloor(this.currentPos);
    // ...and never inside the subject, whatever the clamp did to the boom.
    this.ejectFromSubject(this.currentPos, this._pivot, rig.hardMin);

    ctx.camera.position.copy(this.currentPos);

    // Shake (deterministic — Math.random() would desync regression captures).
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const a = this.shakeAmount * Math.min(1, this.shakeTime * 3);
      ctx.camera.position.x += (this.shakeRng.next() - 0.5) * a;
      ctx.camera.position.y += (this.shakeRng.next() - 0.5) * a;
      ctx.camera.position.z += (this.shakeRng.next() - 0.5) * a;
      if (this.shakeTime <= 0) this.shakeAmount = 0;
      // Shake must not be able to punch through the pavement either.
      this.clampToFloor(ctx.camera.position);
    }

    ctx.camera.lookAt(this.currentLook);

    // Speed FOV, with a kick under hard acceleration.
    const targetFov = fov + (veh ? THREE.MathUtils.clamp(this.accel * 0.35, -3, 5) : 0);
    this.currentFov += (targetFov - this.currentFov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(ctx.camera.fov - this.currentFov) > 0.01) {
      ctx.camera.fov = this.currentFov;
      ctx.camera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Chase feel                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Track the car and fold its motion into the rig: acceleration lag, corner
   * swing, reverse swing-around and the auto-align that keeps the camera
   * behind the car when the player is not looking around.
   */
  private updateChase(
    dt: number,
    veh: { rotation: THREE.Quaternion; speed: number },
    lookMag: number,
  ): void {
    this._euler.setFromQuaternion(veh.rotation);
    const heading = this._euler.y;
    this._fwd.set(Math.sin(heading), 0, Math.cos(heading));

    const speed = veh.speed;

    // Longitudinal acceleration, smoothed hard — raw dv/dt at 60 Hz is noise.
    const rawAccel = dt > 0 ? (speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = speed;
    this.accel += (THREE.MathUtils.clamp(rawAccel, -30, 30) - this.accel) * (1 - Math.exp(-6 * dt));

    // Car yaw rate, for the corner swing.
    if (this.hasLastHeading && dt > 0) {
      let d = heading - this.lastHeading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const raw = THREE.MathUtils.clamp(d / dt, -4, 4);
      this.yawRate += (raw - this.yawRate) * (1 - Math.exp(-8 * dt));
    }
    this.lastHeading = heading;
    this.hasLastHeading = true;

    const fast = Math.min(1, Math.abs(speed) / 26);

    // Acceleration lag: the boom stretches when you floor it, compresses under
    // braking. Damped so it reads as weight rather than as a zoom.
    const lagTarget = THREE.MathUtils.clamp(this.accel * 0.16, -1.1, 2.2);
    this.lagBoom += (lagTarget - this.lagBoom) * (1 - Math.exp(-3.5 * dt));

    // Corner swing: slide toward the outside of the turn, proportional to how
    // hard the car is actually rotating and how fast it is going.
    const swingTarget = THREE.MathUtils.clamp(-this.yawRate * (0.9 + fast * 2.6), -2.4, 2.4);
    this.swing += (swingTarget - this.swing) * (1 - Math.exp(-4 * dt));

    // Reverse: swing the rig round to the nose after a sustained reverse, so
    // the player is looking where the car is actually going. Hysteresis on
    // both the speed threshold and a dwell timer stops it flip-flopping at a
    // three-point turn.
    if (speed < -1.8) this.reverseTimer = Math.min(1.2, this.reverseTimer + dt);
    else if (speed > 0.4) this.reverseTimer = Math.max(0, this.reverseTimer - dt * 2.5);
    else this.reverseTimer = Math.max(0, this.reverseTimer - dt * 0.6);
    if (!this.reversing && this.reverseTimer > 0.75) this.reversing = true;
    else if (this.reversing && this.reverseTimer < 0.15) this.reversing = false;

    // Auto-align. A short grace window after the player stops moving the mouse
    // keeps the rig from yanking itself out of a look the player just chose.
    if (lookMag > 0.0005) this.manualLook = 0.9;
    else this.manualLook = Math.max(0, this.manualLook - dt);

    if (this.manualLook <= 0) {
      // Trail the turn slightly: the rig lags the car's rotation, which is what
      // reads on screen as the camera swinging wide through a corner.
      const trail = THREE.MathUtils.clamp(this.yawRate * 0.16, -0.35, 0.35) * fast;
      const target = heading + (this.reversing ? Math.PI : 0) - trail;
      // Stationary cars must not be re-framed; the rate scales with speed, and
      // the reverse swing-around gets its own (faster) constant.
      const lambda = this.reversing || this.reverseTimer > 0
        ? 2.4
        : 3.0 * Math.min(1, Math.abs(speed) / 10);
      if (lambda > 0.001) this.yaw = dampAngle(this.yaw, target, lambda, dt);
    }
  }

  private resetChase(): void {
    this.accel = 0;
    this.lastSpeed = 0;
    this.yawRate = 0;
    this.hasLastHeading = false;
    this.reversing = false;
    this.reverseTimer = 0;
    this.lagBoom = 0;
    this.swing = 0;
    this._fwd.set(0, 0, 1);
  }

  /* ------------------------------------------------------------------ */
  /* Floor / subject clamps                                              */
  /* ------------------------------------------------------------------ */

  /**
   * True when whatever the collision ray hit is too thin to be worth reacting
   * to — a lamp post, a bollard, a sign pole, a catenary mast.
   *
   * A ray-based boom cannot tell a street lamp from a building: it just sees
   * "something is in the way" and slams the camera up against it, which on a
   * lamp-lined boulevard means the frame is a close-up of a pole several times
   * a second. Measuring the obstruction by firing a second ray back down the
   * boom costs one extra cast, and only when there was a hit at all.
   */
  private isThinObstacle(nearDist: number, boomLen: number, dir: THREE.Vector3): boolean {
    this._probe.copy(this._pivot).addScaledVector(dir, boomLen);
    this._tmp2.copy(dir).negate();
    const back = this.phys.raycast(
      this._probe,
      this._tmp2,
      boomLen,
      probeGroups(CG.STATIC | CG.TERRAIN),
    );
    // No far surface => the camera is inside the solid. Definitely not thin.
    if (!back) return false;
    const thickness = boomLen - nearDist - back.distance;
    return thickness < 0.7;
  }

  /**
   * Raise `p` so it can never sit below the walkable surface underneath it.
   *
   * Two sources, whichever is higher:
   *  - `CityService.spatial.groundHeight`, which already returns the kerb top
   *    on a footway, so the camera clears raised pavements as well as tarmac;
   *  - a physics probe straight down from just above the camera, which catches
   *    anything the analytic query does not model (ramps, plinths, bridges).
   *
   * The probe starts *above* the camera on purpose: starting at the camera
   * would miss the floor entirely once the camera is already through it, which
   * is precisely the case we have to recover from.
   */
  private clampToFloor(p: THREE.Vector3): void {
    let floor = -Infinity;

    const g = this.city?.spatial.groundHeight(p.x, p.z);
    if (g !== undefined && Number.isFinite(g)) floor = g;

    this._probe.set(p.x, p.y + FLOOR_PROBE_UP, p.z);
    const hit = this.phys.raycast(
      this._probe,
      CameraSystem.DOWN,
      FLOOR_PROBE_LENGTH,
      probeGroups(CG.STATIC | CG.TERRAIN),
    );
    if (hit) {
      const surface = this._probe.y - hit.distance;
      // Only trust the probe when it found something at or below the camera's
      // own level plus the probe offset — a hit far above is a ceiling.
      if (surface > floor) floor = surface;
    }

    if (Number.isFinite(floor) && p.y < floor + FLOOR_MARGIN) p.y = floor + FLOOR_MARGIN;
  }

  /**
   * Push the camera back out along the view axis if it ended up closer to the
   * subject than `minRadius`. Without this the floor clamp can shorten the
   * boom until the camera is inside the player's own head, and a wall behind
   * the car can do the same in a tight alley.
   */
  private ejectFromSubject(p: THREE.Vector3, pivot: THREE.Vector3, minRadius: number): void {
    this._tmp.subVectors(p, pivot);
    const d = this._tmp.length();
    if (d >= minRadius) return;
    if (d < 1e-4) {
      // Degenerate: fall back to the rig's own backward axis.
      this._tmp.copy(this._dir);
    } else {
      this._tmp.divideScalar(d);
    }
    p.copy(pivot).addScaledVector(this._tmp, minRadius);
    this.clampToFloor(p);
  }
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}
