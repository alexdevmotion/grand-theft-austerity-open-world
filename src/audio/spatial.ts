/**
 * 3D SPATIALISATION.
 *
 * A pooled `PannerNode ─▶ occlusion lowpass ─▶ gain` chain, plus the camera
 * listener binding. Nothing here allocates during play: slots are created once
 * and recycled, and occlusion raycasts are budgeted to a handful per frame and
 * round-robined across the live slots.
 *
 * WebAudio's own Doppler was removed from the spec, so anything that needs it
 * (the siren) does it explicitly — see sirenModel.ts.
 */

import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/physics';
import { approach, clamp } from './dsp';

const OCCLUDED_HZ = 620;
const CLEAR_HZ = 21000;
/** Raycasts per frame across all live spatial slots. */
const OCCLUSION_RAY_BUDGET = 4;

export interface SlotOptions {
  refDistance?: number;
  rolloff?: number;
  maxDistance?: number;
  /** Skip occlusion raycasts for this slot (UI stings, the player's own car). */
  noOcclusion?: boolean;
}

export class SpatialSlot {
  readonly panner: PannerNode;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  /** Whatever is currently feeding the slot. */
  source: AudioNode | null = null;
  active = false;
  noOcclusion = false;
  /** Smoothed occlusion 0 (clear) .. 1 (fully behind geometry). */
  occlusion = 0;
  targetOcclusion = 0;
  readonly position = new THREE.Vector3();
  /** Set when a pooled one-shot should auto-release. */
  releaseAt = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 6;
    this.panner.rolloffFactor = 1.15;
    this.panner.maxDistance = 320;
    this.panner.coneInnerAngle = 360;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = CLEAR_HZ;
    this.filter.Q.value = 0.5;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.panner.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(destination);
  }

  configure(o: SlotOptions): void {
    this.panner.refDistance = o.refDistance ?? 6;
    this.panner.rolloffFactor = o.rolloff ?? 1.15;
    this.panner.maxDistance = o.maxDistance ?? 320;
    this.noOcclusion = !!o.noOcclusion;
  }

  setPosition(p: THREE.Vector3, ctx: AudioContext): void {
    this.position.copy(p);
    const t = ctx.currentTime;
    // setTargetAtTime avoids zipper noise on fast-moving sources.
    if (this.panner.positionX) {
      this.panner.positionX.setTargetAtTime(p.x, t, 0.012);
      this.panner.positionY.setTargetAtTime(p.y, t, 0.012);
      this.panner.positionZ.setTargetAtTime(p.z, t, 0.012);
    } else {
      (this.panner as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(p.x, p.y, p.z);
    }
  }

  /** Snap position without smoothing — for a brand-new one-shot. */
  jumpTo(p: THREE.Vector3, ctx: AudioContext): void {
    this.position.copy(p);
    const t = ctx.currentTime;
    if (this.panner.positionX) {
      this.panner.positionX.cancelScheduledValues(t);
      this.panner.positionX.setValueAtTime(p.x, t);
      this.panner.positionY.cancelScheduledValues(t);
      this.panner.positionY.setValueAtTime(p.y, t);
      this.panner.positionZ.cancelScheduledValues(t);
      this.panner.positionZ.setValueAtTime(p.z, t);
    } else {
      (this.panner as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(p.x, p.y, p.z);
    }
  }

  applyOcclusion(dt: number, ctx: AudioContext): void {
    if (this.noOcclusion) return;
    this.occlusion = approach(this.occlusion, this.targetOcclusion, 6, dt);
    const hz = CLEAR_HZ * Math.pow(OCCLUDED_HZ / CLEAR_HZ, clamp(this.occlusion, 0, 1));
    this.filter.frequency.setTargetAtTime(hz, ctx.currentTime, 0.05);
  }

  release(ctx: AudioContext, fade = 0.02): void {
    this.gain.gain.cancelScheduledValues(ctx.currentTime);
    this.gain.gain.setTargetAtTime(0, ctx.currentTime, fade);
    this.active = false;
    this.source = null;
    this.occlusion = 0;
    this.targetOcclusion = 0;
    this.filter.frequency.setTargetAtTime(CLEAR_HZ, ctx.currentTime, 0.03);
  }
}

export class SlotPool {
  private slots: SpatialSlot[] = [];
  private cursor = 0;

  constructor(
    private ctx: AudioContext,
    private destination: AudioNode,
    private capacity: number,
  ) {
    for (let i = 0; i < capacity; i++) this.slots.push(new SpatialSlot(ctx, destination));
  }

  get all(): ReadonlyArray<SpatialSlot> {
    return this.slots;
  }

  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.active) n++;
    return n;
  }

  /** Take a free slot, or steal the oldest active one. */
  acquire(o?: SlotOptions): SpatialSlot {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[(this.cursor + i) % this.slots.length];
      if (!s.active) {
        this.cursor = (this.cursor + i + 1) % this.slots.length;
        s.active = true;
        if (o) s.configure(o);
        return s;
      }
    }
    // Everything is busy: steal round-robin.
    const s = this.slots[this.cursor];
    this.cursor = (this.cursor + 1) % this.slots.length;
    s.release(this.ctx, 0.005);
    s.active = true;
    if (o) s.configure(o);
    return s;
  }

  /** Auto-release slots whose scheduled end has passed. */
  reap(now: number): void {
    for (const s of this.slots) {
      if (s.active && s.releaseAt > 0 && now >= s.releaseAt) {
        s.releaseAt = 0;
        s.release(this.ctx);
      }
    }
  }

  releaseAll(): void {
    for (const s of this.slots) if (s.active) s.release(this.ctx);
  }
}

/* ------------------------------------------------------------------ */
/* Listener + occlusion service                                        */
/* ------------------------------------------------------------------ */

const _pos = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class Spatialiser {
  /** Listener world position, updated each frame. */
  readonly listenerPosition = new THREE.Vector3();
  /** Listener world velocity, m/s — used for the Doppler maths. */
  readonly listenerVelocity = new THREE.Vector3();

  private listener: THREE.Object3D | null = null;
  private hasPrev = false;
  private rayCursor = 0;
  private tracked: SpatialSlot[] = [];

  constructor(private ctx: AudioContext) {}

  bind(obj: THREE.Object3D): void {
    this.listener = obj;
    this.hasPrev = false;
  }

  /** Register a slot for the round-robin occlusion sweep. */
  track(slot: SpatialSlot): void {
    if (!this.tracked.includes(slot)) this.tracked.push(slot);
  }

  untrack(slot: SpatialSlot): void {
    const i = this.tracked.indexOf(slot);
    if (i >= 0) this.tracked.splice(i, 1);
  }

  /** Diagnostics: how many tracked slots the occlusion filter is closing. */
  get occlusionStats(): { tracked: number; active: number; occluded: number; max: number } {
    let active = 0, occluded = 0, max = 0;
    for (const s of this.tracked) {
      if (!s.active || s.noOcclusion) continue;
      active++;
      if (s.occlusion > 0.15) occluded++;
      if (s.occlusion > max) max = s.occlusion;
    }
    return { tracked: this.tracked.length, active, occluded, max: Math.round(max * 1000) / 1000 };
  }

  update(dt: number, physics: PhysicsWorld | undefined): void {
    if (this.listener) {
      this.listener.getWorldPosition(_pos);
      if (this.hasPrev && dt > 1e-4) {
        this.listenerVelocity.subVectors(_pos, _prev).divideScalar(dt);
        // Clamp: a teleport must not produce a 900 m/s Doppler shift.
        if (this.listenerVelocity.lengthSq() > 90000) this.listenerVelocity.set(0, 0, 0);
      }
      _prev.copy(_pos);
      this.hasPrev = true;
      this.listenerPosition.copy(_pos);

      const l = this.ctx.listener;
      this.listener.getWorldDirection(_fwd);
      _up.set(0, 1, 0).applyQuaternion(this.listener.getWorldQuaternion(_q));
      const t = this.ctx.currentTime;
      if (l.positionX) {
        l.positionX.setTargetAtTime(_pos.x, t, 0.012);
        l.positionY.setTargetAtTime(_pos.y, t, 0.012);
        l.positionZ.setTargetAtTime(_pos.z, t, 0.012);
        l.forwardX.setTargetAtTime(_fwd.x, t, 0.012);
        l.forwardY.setTargetAtTime(_fwd.y, t, 0.012);
        l.forwardZ.setTargetAtTime(_fwd.z, t, 0.012);
        l.upX.setTargetAtTime(_up.x, t, 0.05);
        l.upY.setTargetAtTime(_up.y, t, 0.05);
        l.upZ.setTargetAtTime(_up.z, t, 0.05);
      } else {
        const legacy = l as unknown as {
          setPosition(x: number, y: number, z: number): void;
          setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
        };
        legacy.setPosition(_pos.x, _pos.y, _pos.z);
        legacy.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
      }
    }

    this.sweepOcclusion(physics);
    for (const s of this.tracked) if (s.active) s.applyOcclusion(dt, this.ctx);
  }

  /**
   * Fire at most OCCLUSION_RAY_BUDGET rays per frame, walking the tracked list.
   * Anything not visited this frame keeps its previous target and simply keeps
   * smoothing toward it, which is inaudible at 4 rays / 60 Hz over ~24 slots.
   */
  private sweepOcclusion(physics: PhysicsWorld | undefined): void {
    if (!physics || this.tracked.length === 0) return;
    let fired = 0;
    for (let i = 0; i < this.tracked.length && fired < OCCLUSION_RAY_BUDGET; i++) {
      const s = this.tracked[(this.rayCursor + i) % this.tracked.length];
      if (!s.active || s.noOcclusion) continue;
      fired++;
      _dir.subVectors(s.position, this.listenerPosition);
      const dist = _dir.length();
      if (dist < 2.5 || dist > 160) {
        s.targetOcclusion = 0;
        continue;
      }
      _dir.divideScalar(dist);
      const hit = physics.raycast(this.listenerPosition, _dir, dist - 1.2, undefined);
      s.targetOcclusion = hit ? clamp(1 - hit.distance / dist, 0.35, 1) : 0;
    }
    this.rayCursor = (this.rayCursor + fired + 1) % Math.max(1, this.tracked.length);
  }
}

const _q = new THREE.Quaternion();
