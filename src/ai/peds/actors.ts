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
 *
 * THESE ANGLES ARE DELTAS FROM THE BIND POSE, and they were being written as
 * whole local rotations. See `setArm`. They are also in the RIG's sign
 * convention, not the imposter solver's, which is the other half of the same
 * bug — the numbers here were ported from `peds/rig.ts`, where +z is forward
 * and a positive shoulder angle lifts the hand, and dropped into a rig where
 * a positive shoulder angle already lifts the hand and every lateral channel
 * mirrors. So:
 *
 *   pitch  +ve swings the hand FORWARD and up (rig.ts: local +X -> tip +Z)
 *   elbow  +ve is flexion
 *   flare  +ve abducts — the elbow moves AWAY from the ribs — on both sides;
 *          `setArm` applies the mirror.
 *
 * Poses also carry the pedestrian's own posture (`GaitStyle`), so two people
 * on the phone are not the same statue holding the same phone.
 */
function applyIdleLayer(actor: CharacterActor, p: Ped, t: number): void {
  const rig = actor.rig;
  const b = rig.bones;
  const seed = p.seed;
  const s = (x: number) => Math.sin(x);
  const style = actor.anim.style;

  // Angles are: shoulder pitch (positive lifts the hand forward/up), elbow
  // flex, and an outward flare on the shoulder roll.
  let shoL = -0.06;
  let shoR = -0.06;
  let elbL = 0.18;
  let elbR = 0.18;
  let flareL = 0.02;
  let flareR = 0.02;
  let headPitch = 0;

  switch (p.pose) {
    case 'phone': {
      const right = seed % 2 === 0;
      const lift = 1.42 + 0.05 * s(t * 0.6 + seed);
      if (right) {
        shoR = 0.42; elbR = lift; flareR = -0.30;
      } else {
        shoL = 0.42; elbL = lift; flareL = -0.30;
      }
      headPitch = 0.34;
      break;
    }
    case 'smoke': {
      const c = (t * 0.26 + seed * 0.137) % 1;
      const l = c < 0.34 ? smooth(c / 0.34) : c < 0.5 ? 1 : 1 - smooth((c - 0.5) / 0.28);
      const k = Math.max(0, Math.min(1, l));
      shoR = 0.10 + k * 0.34;
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
      shoR = 0.14 + a * 0.34 * g;
      elbR = 0.60 + a * 0.95 * g;
      flareR = 0.20 + c * 0.28 * g;
      shoL = 0.06 + c * 0.22 * g;
      elbL = 0.48 + c * 0.66 * g;
      flareL = 0.16 + a * 0.20 * g;
      break;
    }
    case 'shop':
      shoL = 0.24; shoR = 0.24; elbL = 1.05; elbR = 1.05; flareL = -0.12; flareR = -0.12;
      headPitch = 0.10;
      break;
    case 'vendor':
      shoL = 0.52; shoR = 0.52; elbL = 0.98; elbR = 0.98; flareL = 0.22; flareR = 0.22;
      break;
    case 'lean':
      shoL = -0.10; shoR = 0.05; elbL = 0.24; elbR = 0.52; flareL = 0.30;
      break;
    case 'wave':
      shoR = 1.42 + 0.10 * s(t * 6.6 + seed);
      elbR = 0.72 + 0.40 * s(t * 6.6 + seed);
      flareR = 0.52;
      break;
    case 'flinch':
      shoL = 0.86; shoR = 0.86; elbL = 1.55; elbR = 1.55; flareL = 0.40; flareR = 0.40;
      headPitch = -0.14;
      break;
    default:
      return;
  }

  // This person's own carriage, so a pavement of people on their phones is a
  // pavement of people rather than a rack of the same mannequin.
  elbL += style.armCarriage;
  elbR += style.armCarriage;
  flareL += style.armOut;
  flareR += style.armOut;
  shoL += style.armAsym;
  shoR -= style.armAsym;

  setArm(rig, BI.upperArmL, BI.forearmL, shoL, elbL, flareL);
  setArm(rig, BI.upperArmR, BI.forearmR, shoR, elbR, -flareR);
  if (headPitch !== 0 || style.headDown !== 0) {
    const head = b[BI.head];
    _e.set(headPitch + style.headDown, 0, style.headTilt, 'XYZ');
    _q.setFromEuler(_e);
    head.quaternion.multiply(_q);
  }
}

/**
 * Pose one arm.
 *
 * `bone.quaternion = rest * delta` — the SAME composition
 * `AnimationController.applyTo` uses, and the reason this function exists.
 *
 * It used to be `upper.quaternion.setFromEuler(...)`, which assigns the whole
 * local rotation and therefore throws the bind pose away. The upper arm's
 * parent is the clavicle, whose bone axis runs out to the shoulder, so a
 * near-identity local rotation aims the arm ALONG THE COLLARBONE: measured on
 * the average male rig, the wrist ended up 576 mm out to the side and 66 mm
 * below the shoulder, when a hanging arm puts it 142 mm out and 554 mm down.
 * Every pedestrian on a phone, mid-conversation, smoking, leaning, waving,
 * shopping or serving at a stall stood in a T-pose with their forearms folded
 * — which is a third of the standing crowd at any moment.
 */
function setArm(
  rig: CharacterActor['rig'],
  upperIdx: number,
  foreIdx: number,
  pitch: number,
  elbow: number,
  roll: number,
): void {
  const upper = rig.bones[upperIdx];
  const fore = rig.bones[foreIdx];
  if (!upper || !fore) return;
  _e.set(pitch, 0, roll, 'XYZ');
  _q.setFromEuler(_e);
  upper.quaternion.copy(rig.rest[upperIdx]).multiply(_q);
  _e.set(elbow, 0, 0, 'XYZ');
  _q.setFromEuler(_e);
  fore.quaternion.copy(rig.rest[foreIdx]).multiply(_q);
}

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
