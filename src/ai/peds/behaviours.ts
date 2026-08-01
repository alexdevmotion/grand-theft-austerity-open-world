/**
 * WHAT PEOPLE ARE DOING — the idle life that stops a crowd reading as a
 * conveyor belt of walkers.
 *
 * A pedestrian is either ROUTING (following the pavement graph) or ANCHORED
 * (standing somewhere doing something). Anchored behaviour is what sells an
 * inhabited city: pairs talking, someone on a phone, a smoker at the kerb,
 * window shoppers, a vendor behind a counter, builders standing around a
 * barrier, tourists photographing the Parliament.
 */

import type { Rng } from '../../core/rng';
import type { DistrictKind, PedArchetype } from '../../core/services';
import type { PoseState } from './rig';

export type IdleKind =
  | 'phone'
  | 'smoke'
  | 'talk'
  | 'listen'
  | 'shop'
  | 'vendor'
  | 'wait'
  | 'sit'
  | 'lean'
  | 'watch'
  | 'photo';

export interface IdleSpec {
  kind: IdleKind;
  pose: PoseState;
  /** Seconds before the ped moves on. */
  duration: number;
  /** True when the ped should face a partner rather than the anchor facing. */
  facesGroup: boolean;
}

const WEIGHTS: Record<IdleKind, number> = {
  phone: 2.6,
  smoke: 1.5,
  talk: 3.0,
  listen: 0,
  shop: 1.4,
  vendor: 0,
  wait: 1.5,
  // DISABLED until there is furniture to sit on. The character rig's sit clip
  // puts the seat 44 cm above the root, which is a bench or a chair — on a
  // 17 cm kerb it reads as sitting on thin air. Restore this weight the moment
  // the props system publishes bench / shelter / step anchors; the pose, the
  // anchor plumbing and the duration are all already here.
  sit: 0,
  lean: 0.9,
  watch: 1.2,
  photo: 0,
};

const KINDS = Object.keys(WEIGHTS) as IdleKind[];

export function poseForIdle(kind: IdleKind): PoseState {
  switch (kind) {
    case 'phone': return 'phone';
    case 'smoke': return 'smoke';
    case 'talk': return 'talk';
    case 'listen': return 'idle';
    case 'shop': return 'shop';
    case 'vendor': return 'vendor';
    case 'wait': return 'idle';
    case 'sit': return 'sit';
    case 'lean': return 'lean';
    case 'watch': return 'idle';
    case 'photo': return 'phone';
    default: return 'idle';
  }
}

/**
 * Choose something to do, weighted by who this is and where they are.
 * `atShopfront` means the anchor faces a building; otherwise it faces the road.
 */
export function pickIdle(
  archetype: PedArchetype,
  district: DistrictKind,
  atShopfront: boolean,
  rng: Rng,
): IdleSpec {
  const w = KINDS.map((k) => WEIGHTS[k]);
  const bump = (k: IdleKind, m: number) => {
    w[KINDS.indexOf(k)] *= m;
  };

  if (atShopfront) {
    bump('shop', 3.2);
    bump('smoke', 1.5);
    bump('wait', 0.5);
    bump('sit', 0.3);
  } else {
    bump('wait', 2.0);
    bump('watch', 1.6);
    bump('sit', 1.7);
    bump('shop', 0.1);
  }

  switch (archetype) {
    case 'officeWorker':
      bump('phone', 2.4);
      bump('smoke', 2.0);
      bump('talk', 1.4);
      bump('sit', 0.5);
      break;
    case 'builder':
      bump('smoke', 3.4);
      bump('talk', 2.2);
      bump('lean', 2.0);
      bump('phone', 0.5);
      bump('shop', 0.15);
      break;
    case 'tourist':
      bump('photo', 6.0);
      bump('watch', 2.6);
      bump('talk', 1.6);
      bump('smoke', 0.3);
      break;
    case 'streetVendor':
      bump('vendor', 40);
      break;
    case 'protester':
      bump('talk', 2.4);
      bump('watch', 2.0);
      bump('phone', 0.7);
      break;
    case 'ministryAgent':
      bump('watch', 5.0);
      bump('phone', 1.6);
      bump('smoke', 0.4);
      bump('sit', 0.05);
      bump('shop', 0.05);
      break;
    default:
      break;
  }

  const kind = rng.weighted(KINDS, w);
  return {
    kind,
    pose: poseForIdle(kind),
    duration: durationFor(kind, rng),
    facesGroup: kind === 'talk' || kind === 'listen',
  };
}

function durationFor(kind: IdleKind, rng: Rng): number {
  switch (kind) {
    case 'vendor': return 1e6;
    case 'talk':
    case 'listen': return rng.range(16, 48);
    case 'smoke': return rng.range(22, 55);
    case 'sit': return rng.range(30, 90);
    case 'lean': return rng.range(18, 46);
    case 'phone': return rng.range(9, 26);
    case 'shop': return rng.range(7, 20);
    case 'photo': return rng.range(6, 16);
    case 'watch': return rng.range(10, 30);
    default: return rng.range(8, 26);
  }
}

/* ------------------------------------------------------------------ */
/* clusters                                                            */
/* ------------------------------------------------------------------ */

export interface ClusterSpec {
  /** How many people. */
  size: number;
  /** Radius of the ring they stand in. */
  radius: number;
  /** Everyone in the cluster gets this archetype, when set. */
  archetype?: PedArchetype;
  idle: IdleKind;
}

/**
 * Groups that appear in the world as a unit. Weighted per district so the
 * builders cluster around Builders House and the tourists at the Parliament.
 */
export function pickCluster(district: DistrictKind, rng: Rng): ClusterSpec | null {
  const r = rng.next();
  switch (district) {
    case 'glassCorporate':
      if (r < 0.16) return { size: rng.int(2, 4), radius: 0.78, archetype: 'officeWorker', idle: 'talk' };
      if (r < 0.22) return { size: rng.int(2, 4), radius: 0.9, archetype: 'builder', idle: 'talk' };
      if (r < 0.27) return { size: 2, radius: 0.74, archetype: 'protester', idle: 'talk' };
      return null;
    case 'guvern':
      if (r < 0.2) return { size: rng.int(2, 5), radius: 1.05, archetype: 'tourist', idle: 'photo' };
      if (r < 0.26) return { size: rng.int(2, 4), radius: 0.85, archetype: 'protester', idle: 'talk' };
      return null;
    case 'centruVechi':
      if (r < 0.22) return { size: rng.int(2, 4), radius: 0.8, idle: 'talk' };
      if (r < 0.3) return { size: rng.int(2, 3), radius: 0.72, archetype: 'tourist', idle: 'photo' };
      return null;
    case 'industrial':
      if (r < 0.24) return { size: rng.int(2, 4), radius: 0.95, archetype: 'builder', idle: 'smoke' };
      return null;
    case 'parc':
      if (r < 0.18) return { size: 2, radius: 0.7, idle: 'talk' };
      return null;
    default:
      if (r < 0.12) return { size: 2, radius: 0.76, idle: 'talk' };
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* reaction tuning                                                     */
/* ------------------------------------------------------------------ */

export const React = {
  /** How far ahead of a car someone notices it and shies away. */
  flinchRadius: 6.5,
  /** Half-width of the corridor in which a passing car is unnerving. */
  flinchCorridor: 3.2,
  /** Speed above which a car is genuinely frightening, m/s (~40 km/h). */
  scarySpeed: 11.0,
  /** Half-width of the corridor a speeding car will actually sweep. */
  dangerCorridor: 3.0,
  /** How far ahead a speeding car makes people run. */
  scatterRadius: 19.0,
  /** Below this distance a stationary car counts as touching. */
  hitRadius: 1.05,
  /** Half the footprint of a typical saloon, used for the knockdown test. */
  carHalfLength: 2.15,
  carHalfWidth: 0.94,
  /** Speed below which a car just makes people step aside. */
  hitSpeed: 2.6,
  flinchSeconds: 1.35,
  fleeSeconds: 7.5,
  /** How long a knocked-down ped stays down before despawning. */
  downSeconds: 22,
  /** Player attention radius. */
  noticeRadius: 13.0,
  /** Root-to-root floor: player body + pedestrian shoulders. */
  playerSeparation: 0.9,
} as const;
