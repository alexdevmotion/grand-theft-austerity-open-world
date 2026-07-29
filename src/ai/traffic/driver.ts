/**
 * The driving controller every AI vehicle in the game shares — ambient traffic
 * and Ministry pursuit units alike.
 *
 * It owns three things and nothing else:
 *
 *   1. STEERING. A Stanley-style controller: correct the heading error to the
 *      path, plus a cross-track term that decays with speed, damped by the
 *      vehicle's own measured yaw rate. Lookahead grows with speed so the line
 *      through a junction is smooth instead of a sequence of corrections.
 *   2. SPEED. A target speed is assembled by the caller from the road, the
 *      corner ahead, the car in front and the traffic light; this turns that
 *      single number into throttle and brake with a believable stopping
 *      distance rather than an on/off pedal.
 *   3. UNSTICKING. Anything with wheels eventually gets wedged on a kerb; a
 *      driver that keeps flooring it into a wall is worse than no driver.
 *
 * It deliberately knows nothing about routes, lanes or crime.
 */

import * as THREE from 'three';
import type { VehicleClass, VehicleHandle } from '../../core/services';

/** VehicleHandle plus the presentation hooks the vehicle system exposes. */
export type ControllableVehicle = VehicleHandle & {
  setSiren?(on: boolean): void;
  setIndicator?(i: -1 | 0 | 1 | 2): void;
  setHeadlights?(level: number): void;
};

export interface DriverTuning {
  /** Matches the vehicle system's steering limit closely enough to normalise. */
  maxSteerRad: number;
  /** Comfortable deceleration, m/s². Used to plan stopping distances. */
  brake: number;
  /** Emergency deceleration. */
  hardBrake: number;
  /** Desired time gap to the vehicle in front, seconds. */
  headway: number;
  /** Standstill gap, metres. */
  minGap: number;
  /** Lateral acceleration the driver is willing to pull through a corner. */
  latAccel: number;
  /** Steering aggression multiplier. */
  steerGain: number;
}

const BASE: DriverTuning = {
  maxSteerRad: 0.56, brake: 4.4, hardBrake: 8.2, headway: 1.35,
  minGap: 2.6, latAccel: 3.4, steerGain: 1.0,
};

export const DRIVER_TUNING: Record<VehicleClass, DriverTuning> = {
  dacia: { ...BASE, maxSteerRad: 0.62, brake: 3.8, hardBrake: 7.0, latAccel: 3.0 },
  sedan: { ...BASE },
  hatch: { ...BASE, maxSteerRad: 0.58 },
  van: { ...BASE, brake: 3.8, hardBrake: 6.8, latAccel: 2.6, minGap: 3.0, steerGain: 0.9 },
  truck: { ...BASE, maxSteerRad: 0.5, brake: 3.0, hardBrake: 5.4, latAccel: 2.0, minGap: 4.2, headway: 1.7, steerGain: 0.8 },
  bus: { ...BASE, maxSteerRad: 0.42, brake: 3.0, hardBrake: 5.2, latAccel: 1.9, minGap: 4.6, headway: 1.7, steerGain: 0.75 },
  police: { ...BASE, maxSteerRad: 0.56, brake: 6.0, hardBrake: 10.5, headway: 0.7, minGap: 2.0, latAccel: 5.2, steerGain: 1.25 },
  tram: { ...BASE, maxSteerRad: 0.06, brake: 2.2, hardBrake: 3.6, latAccel: 1.2, minGap: 6.0, headway: 2.2, steerGain: 3.2 },
  scooter: { ...BASE, maxSteerRad: 0.7, brake: 3.0, hardBrake: 5.0, latAccel: 2.4, minGap: 1.2 },
};

const _fwd = new THREE.Vector3();

export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Speed a vehicle may carry into a corner of angle `theta` over `radius`. */
export function cornerSpeed(tuning: DriverTuning, theta: number, radius: number): number {
  if (theta < 0.12) return Infinity;
  const r = Math.max(3.5, radius / Math.max(0.25, theta));
  return Math.sqrt(tuning.latAccel * r);
}

/** Speed we may be doing now to arrive at `limit` after `distance` metres. */
export function approachSpeed(limit: number, distance: number, decel: number): number {
  if (distance <= 0) return limit;
  return Math.sqrt(Math.max(0, limit * limit + 2 * decel * distance));
}

export class Driver {
  readonly tuning: DriverTuning;

  /** Measured heading and yaw rate — the handle exposes neither. */
  heading = 0;
  yawRate = 0;
  private prevHeading = 0;
  private headingInit = false;

  /** Seconds spent trying and failing to move. */
  stuckTime = 0;
  /** Seconds left of the reverse-out manoeuvre. */
  private reversing = 0;
  private reverseSteer = 0;

  /** Smoothed control output, so nothing snaps between frames. */
  private steerOut = 0;
  private throttleOut = 0;

  constructor(readonly vehicle: ControllableVehicle) {
    this.tuning = DRIVER_TUNING[vehicle.kind] ?? BASE;
  }

  /** Refresh heading / yaw rate. Call once per fixed step before anything else. */
  sense(dt: number): void {
    _fwd.set(0, 0, 1).applyQuaternion(this.vehicle.rotation);
    const h = Math.atan2(_fwd.x, _fwd.z);
    if (!this.headingInit) {
      this.prevHeading = h;
      this.headingInit = true;
    }
    this.yawRate = wrapAngle(h - this.prevHeading) / Math.max(1e-4, dt);
    this.prevHeading = h;
    this.heading = h;
  }

  get forwardX(): number { return Math.sin(this.heading); }
  get forwardZ(): number { return Math.cos(this.heading); }

  /**
   * Drive toward `target`, aiming to be doing `targetSpeed` when we get there.
   * `pathHeading` is the direction of the road at the target — supplying it
   * makes the car settle into the lane instead of weaving across it.
   */
  drive(
    dt: number,
    targetX: number,
    targetZ: number,
    targetSpeed: number,
    pathHeading: number | null,
    opts?: { crossTrack?: number; emergency?: boolean; allowReverse?: boolean },
  ): void {
    const v = this.vehicle;
    const speed = v.speed;
    const absSpeed = Math.abs(speed);

    /* ---- unsticking ---- */
    const wantsToMove = targetSpeed > 1.0;
    if (wantsToMove && absSpeed < 0.55) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2.2);

    if (this.reversing > 0) {
      this.reversing -= dt;
      v.setControls(-0.85, this.reverseSteer, false);
      return;
    }
    if (this.stuckTime > 2.6 && (opts?.allowReverse ?? true)) {
      this.stuckTime = 0;
      this.reversing = 1.15;
      // Reverse away from whichever side we are jammed against.
      const dx = targetX - v.position.x;
      const dz = targetZ - v.position.z;
      const lat = dx * this.forwardZ - dz * this.forwardX;
      this.reverseSteer = lat > 0 ? 0.9 : -0.9;
      return;
    }

    /* ---- steering ---- */
    const dx = targetX - v.position.x;
    const dz = targetZ - v.position.z;
    const dist = Math.hypot(dx, dz);
    let err: number;
    if (dist < 0.4) {
      err = pathHeading !== null ? wrapAngle(pathHeading - this.heading) : 0;
    } else {
      err = wrapAngle(Math.atan2(dx, dz) - this.heading);
      if (pathHeading !== null) {
        // Blend the bearing to the point with the road's own direction: pure
        // bearing chasing overshoots and leaves the car sawing at the lane.
        const along = wrapAngle(pathHeading - this.heading);
        const blend = THREE.MathUtils.clamp(dist / 26, 0.25, 0.7);
        err = err * (1 - blend) + along * blend;
      }
    }
    if (opts?.crossTrack !== undefined) {
      // Stanley cross-track term: strong when crawling, gentle at speed.
      err += Math.atan2(-opts.crossTrack * 1.15, Math.max(2.5, absSpeed));
    }

    const limit = this.tuning.maxSteerRad / (1 + absSpeed * 0.052);
    let steer = (err * this.tuning.steerGain - this.yawRate * 0.16) / Math.max(0.05, limit);
    steer = THREE.MathUtils.clamp(steer, -1, 1);
    // Reversing inverts the geometry.
    if (speed < -0.4) steer = -steer;
    this.steerOut += (steer - this.steerOut) * Math.min(1, dt * 16);

    /* ---- speed ---- */
    let throttle: number;
    let handbrake = false;
    const want = Math.max(0, targetSpeed);
    if (want < 0.3) {
      if (speed > 0.75) throttle = opts?.emergency ? -1 : -0.75;
      else if (speed < -0.4) throttle = 0.35;
      else throttle = 0;
    } else {
      const err2 = want - speed;
      if (err2 > 0.35) throttle = THREE.MathUtils.clamp(err2 / 4.5, 0.14, 1);
      else if (err2 < -0.5) throttle = THREE.MathUtils.clamp(err2 / (opts?.emergency ? 1.8 : 4.0), -1, -0.08);
      else throttle = 0.07;
      // A hard corner while already too fast wants brake and steering, not
      // throttle: trail-braking is what keeps AI cars off the kerbs.
      if (Math.abs(this.steerOut) > 0.75 && speed > want * 1.1) throttle = Math.min(throttle, -0.2);
    }
    this.throttleOut += (throttle - this.throttleOut) * Math.min(1, dt * 14);
    if (throttle <= -0.98 && absSpeed > 12 && opts?.emergency) handbrake = false;

    v.setControls(this.throttleOut, this.steerOut, handbrake);
  }

  /** Full stop where we are — used at stop lines and when pulled over. */
  halt(dt: number): void {
    const v = this.vehicle;
    const speed = v.speed;
    if (speed > 0.7) {
      this.throttleOut += (-1 - this.throttleOut) * Math.min(1, dt * 18);
      v.setControls(this.throttleOut, this.steerOut * 0.5, false);
    } else {
      this.throttleOut = 0;
      v.setControls(0, 0, false);
    }
    this.stuckTime = 0;
  }
}
