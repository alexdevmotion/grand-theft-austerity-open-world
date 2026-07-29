/**
 * THE BRIDGE ONTO THE REAL RIG.
 *
 * Bodies, wardrobe, skinning, LOD and ragdoll all belong to the characters
 * agent (`src/characters/`). This module owns only the crowd-specific parts
 * that a locomotion controller has no reason to know about:
 *
 *   - mapping a ped's behaviour onto `Drive` + `LocomotionState`
 *   - the idle upper-body layer — phones, cigarettes, conversation gestures,
 *     hands on a vendor's counter — written straight onto the arm bones after
 *     the animation controller has posed the skeleton
 *   - shadow-casting and look-at budgets, so 120 skinned actors stay inside
 *     the frame budget
 *
 * Nothing here reaches into character internals beyond the published `Rig`
 * bone table, which `src/characters/index.ts` exports on purpose.
 */

import * as THREE from 'three';
import type { GameContext } from '../../core/engine';
import type { LocomotionState } from '../../core/services';
import { BI, type CharacterActor } from '../../characters';
import type { Ped } from './crowd';
import type { PoseState } from './rig';

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/** Idle poses that take over the arms entirely. */
const ARM_POSES = new Set<PoseState>([
  'phone', 'smoke', 'talk', 'gesture', 'shop', 'vendor', 'wave', 'flinch', 'lean',
]);

export function locomotionFor(p: Ped): LocomotionState {
  switch (p.pose) {
    case 'down': return p.health > 0 ? 'ragdoll' : 'die';
    case 'sit': return 'sit';
    case 'panic': return 'sprint';
    case 'sprint': return 'sprint';
    case 'jog': return 'jog';
    case 'walk': return 'walk';
    default: return p.speed > 0.3 ? 'walk' : 'idle';
  }
}

/**
 * Drive one actor from one ped. Returns the distance to the camera so the
 * caller can budget.
 */
export function driveActor(
  actor: CharacterActor,
  p: Ped,
  dt: number,
  ctx: GameContext,
  distance: number,
  shadowRadius: number,
  time: number,
): void {
  // A car has just hit this person: hand off to the rig's own ragdoll and
  // never touch the transform again — the sim owns it from here.
  if (p.ragdollPending) {
    actor.ragdoll(p.ragdollPending);
    p.ragdollPending = null;
    p.ragdolled = true;
  }
  if (p.ragdolled) {
    actor.mesh.castShadow = distance < shadowRadius;
    actor.update(dt, ctx);
    p.position.copy(actor.position);
    return;
  }

  actor.setTransform(p.position, p.yaw);
  actor.drive({
    state: locomotionFor(p),
    speed: p.speed,
    grounded: p.mode !== 'down',
    turnRate: p.turnRate,
  });

  // Shadow casting is the single most expensive thing a skinned mesh does at
  // three degrees of sun elevation: four cascades, a 30 m shadow each.
  const wantShadow = distance < shadowRadius;
  if (actor.mesh.castShadow !== wantShadow) actor.mesh.castShadow = wantShadow;
  actor.footIk = distance < 18;

  actor.update(dt, ctx);

  // Head tracking is additive inside the controller and cheap.
  if (p.lookTarget) actor.lookAt(p.lookTarget, p.lookWeight);
  else actor.lookAt(null, 0);

  if (distance < 60 && p.mode !== 'down' && ARM_POSES.has(p.pose)) {
    applyIdleLayer(actor, p, time);
  }
}

/**
 * Overwrite the arm bones for standing behaviours. The controller's gait has
 * already run; for someone standing still its arm swing is near zero, so
 * replacing the arms outright is stable and costs four quaternions.
 */
function applyIdleLayer(actor: CharacterActor, p: Ped, t: number): void {
  const b = actor.rig.bones;
  const seed = p.seed;
  const s = (x: number) => Math.sin(x);

  // Angles are: shoulder pitch (negative lifts the hand forward/up), elbow
  // flex, and an outward flare on the shoulder roll.
  let shoL = 0.06;
  let shoR = 0.06;
  let elbL = 0.18;
  let elbR = 0.18;
  let flareL = 0.06;
  let flareR = 0.06;
  let headPitch = 0;

  switch (p.pose) {
    case 'phone': {
      const right = seed % 2 === 0;
      const lift = 1.42 + 0.05 * s(t * 0.6 + seed);
      if (right) {
        shoR = -0.42; elbR = lift; flareR = -0.30;
      } else {
        shoL = -0.42; elbL = lift; flareL = -0.30;
      }
      headPitch = 0.34;
      break;
    }
    case 'smoke': {
      const c = (t * 0.26 + seed * 0.137) % 1;
      const l = c < 0.34 ? smooth(c / 0.34) : c < 0.5 ? 1 : 1 - smooth((c - 0.5) / 0.28);
      const k = Math.max(0, Math.min(1, l));
      shoR = -0.10 - k * 0.34;
      elbR = 0.30 + k * 1.62;
      flareR = 0.16 - k * 0.30;
      elbL = 0.26;
      headPitch = k * 0.08;
      break;
    }
    case 'talk':
    case 'gesture': {
      const g = p.gesture;
      const a = s(t * 2.05 + seed) * 0.5 + 0.5;
      const c = s(t * 1.32 + seed * 2.7) * 0.5 + 0.5;
      shoR = -0.14 - a * 0.34 * g;
      elbR = 0.60 + a * 0.95 * g;
      flareR = 0.20 + c * 0.28 * g;
      shoL = -0.06 - c * 0.22 * g;
      elbL = 0.48 + c * 0.66 * g;
      flareL = 0.16 + a * 0.20 * g;
      break;
    }
    case 'shop':
      shoL = -0.24; shoR = -0.24; elbL = 1.05; elbR = 1.05; flareL = -0.12; flareR = -0.12;
      headPitch = 0.10;
      break;
    case 'vendor':
      shoL = -0.52; shoR = -0.52; elbL = 0.98; elbR = 0.98; flareL = 0.22; flareR = 0.22;
      break;
    case 'lean':
      shoL = 0.10; shoR = -0.05; elbL = 0.24; elbR = 0.52; flareL = 0.30;
      break;
    case 'wave':
      shoR = -1.42 - 0.10 * s(t * 6.6 + seed);
      elbR = 0.72 + 0.40 * s(t * 6.6 + seed);
      flareR = 0.52;
      break;
    case 'flinch':
      shoL = -0.86; shoR = -0.86; elbL = 1.55; elbR = 1.55; flareL = 0.40; flareR = 0.40;
      headPitch = -0.14;
      break;
    default:
      return;
  }

  setArm(b[BI.upperArmL], b[BI.forearmL], shoL, elbL, -flareL);
  setArm(b[BI.upperArmR], b[BI.forearmR], shoR, elbR, flareR);
  if (headPitch !== 0) {
    const head = b[BI.head];
    _e.set(headPitch, 0, 0, 'XYZ');
    _q.setFromEuler(_e);
    head.quaternion.multiply(_q);
  }
}

function setArm(
  upper: THREE.Bone,
  fore: THREE.Bone,
  pitch: number,
  elbow: number,
  roll: number,
): void {
  if (!upper || !fore) return;
  _e.set(pitch, 0, roll, 'XYZ');
  upper.quaternion.setFromEuler(_e);
  _e.set(elbow, 0, 0, 'XYZ');
  fore.quaternion.setFromEuler(_e);
}

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
