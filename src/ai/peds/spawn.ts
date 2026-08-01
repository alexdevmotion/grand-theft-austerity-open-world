/**
 * WHO IS ON THIS STREET — archetype mix, wardrobe and crowd density.
 *
 * Density varies by district and by hour: the glass quarter empties after the
 * evening rush, the old town fills up, the government axis is tourists in the
 * afternoon and nobody at 3 a.m.
 */

import * as THREE from 'three';
import { Palette } from '../../artDirection';
import type { Rng } from '../../core/rng';
import type { DistrictKind, PedArchetype } from '../../core/services';
import { crowdFaceVariant, type PedAppearance } from './rig';

const c = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();

/**
 * Take a palette entry BY VALUE.
 *
 * `rng.pick` hands back the array element itself, and `copyWardrobe` in
 * `src/ai/peds.ts` dresses an imposter by writing INTO the Colors it finds on
 * the PedAppearance (`out.setHex(hex)`). Handing out the module-level palette
 * entry therefore let any one pedestrian permanently repaint a palette slot for
 * every pedestrian spawned after it — a shared Color serving as `top` was
 * measured drifting from #b9b6b0 to #272a32 mid-session. Clone on the way out
 * and these palettes stay the constants they are written as.
 */
const pick = (rng: Rng, palette: readonly THREE.Color[]): THREE.Color => rng.pick(palette).clone();

/* ------------------------------------------------------------------ */
/* wardrobe                                                            */
/* ------------------------------------------------------------------ */

const SKIN = [
  c(0xd9ab89), c(0xc59372), c(0xa9764f), c(0x8a5a3b), c(0x6b432b),
  c(0xe3bda0), c(0xb98a63), c(0x53341f),
];

const HAIR = [
  c(0x1a1310), c(0x2c1f18), c(0x4a3225), c(0x6b4a2e), c(0x8d6a3f),
  c(0x241a24), c(0x9a9088), c(0x3a2a30),
];

/** Everyday Bucharest street clothes — muted, but never neutral grey. */
const CIVILIAN_TOPS = [
  c(0x2a3350), c(0x3b2a3f), c(0x1e2733), c(0x4a2d33), c(0x2f4038),
  c(0x6b4a52), c(0x8a7a6a), c(0x39406b), c(0x5a3a2c), c(0x243040),
  c(0xa3644f), c(0x4d5b7a), c(0x7a3f5c),
];

const CIVILIAN_LEGS = [
  c(0x24283a), c(0x1b1d28), c(0x3a3340), c(0x2e2a25), c(0x1f2c3a),
  c(0x453a44), c(0x2a2f26),
];

const SHOES = [c(0x14121a), c(0x241c1a), c(0x2f2a33), c(0x3c2a20), c(0xb9b2ae)];

const OFFICE_TOPS = [c(0x171b2b), c(0x22273c), c(0x2a2130), c(0x1a2430), c(0x30263a)];
const OFFICE_SHIRTS = [c(0xd8dde8), c(0xc3cede), c(0xdcd2c8), c(0xb9c6d8)];

const TOURIST_TOPS = [
  c(0xd9663f), c(0x3fa4d9), c(0xe0c04a), c(0x5cc27a), c(0xd94f7a), c(0xe8e2d4),
];

const BAG_COLORS = [c(0x2a2230), c(0x4a3a2a), c(0x1c2434), c(0x6b3a4a), c(0x3a4a3a)];

const HIVIS = c(0xf0a52a);
const HIVIS2 = c(0xd8e83a);

/* ------------------------------------------------------------------ */
/* archetype mix                                                       */
/* ------------------------------------------------------------------ */

const CIVIL: PedArchetype[] = ['civilian'];

/** Weighted archetype table per district. */
function mixFor(district: DistrictKind, hour: number): { kinds: PedArchetype[]; weights: number[] } {
  const office = hour > 6.5 && hour < 20 ? 1 : 0.12;
  const night = hour < 6 || hour > 21 ? 1 : 0;
  switch (district) {
    case 'glassCorporate':
      return {
        kinds: ['officeWorker', 'civilian', 'builder', 'streetVendor', 'protester'],
        weights: [4.2 * office, 2.4, 0.9, 0.5, 0.7],
      };
    case 'guvern':
      return {
        kinds: ['tourist', 'civilian', 'ministryAgent', 'protester', 'officeWorker'],
        weights: [2.6, 2.0, 1.1, 1.0, 1.2 * office],
      };
    case 'centruVechi':
      return {
        kinds: ['civilian', 'streetVendor', 'tourist', 'officeWorker'],
        weights: [4.0 + night * 1.6, 1.7, 1.5, 0.7 * office],
      };
    case 'bulevard':
      return {
        kinds: ['civilian', 'officeWorker', 'builder', 'streetVendor', 'tourist'],
        weights: [4.4, 1.6 * office, 1.0, 0.6, 0.5],
      };
    case 'cartier':
      return { kinds: ['civilian', 'builder', 'streetVendor'], weights: [5.2, 1.1, 0.4] };
    case 'industrial':
      return { kinds: ['builder', 'civilian'], weights: [3.0, 1.4] };
    case 'parc':
      return { kinds: ['civilian', 'tourist', 'streetVendor'], weights: [5.0, 1.2, 0.5] };
    default:
      return { kinds: CIVIL, weights: [1] };
  }
}

export function pickArchetype(district: DistrictKind, hour: number, rng: Rng): PedArchetype {
  const m = mixFor(district, hour);
  return rng.weighted(m.kinds, m.weights);
}

/* ------------------------------------------------------------------ */
/* density                                                             */
/* ------------------------------------------------------------------ */

/** Crowd multiplier for a district, 0..1.6. */
export function districtDensity(district: DistrictKind): number {
  switch (district) {
    case 'glassCorporate': return 1.45;
    case 'centruVechi': return 1.5;
    case 'guvern': return 1.0;
    case 'bulevard': return 1.1;
    case 'parc': return 0.85;
    case 'cartier': return 0.62;
    case 'industrial': return 0.34;
    default: return 0.8;
  }
}

/**
 * Hour-of-day curve. Two rush peaks, a lunch bump, a dead small-hours trough.
 * Bucharest at 19:00 — the reference hour — is close to peak.
 */
export function timeOfDayDensity(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const bump = (centre: number, width: number, amp: number) =>
    amp * Math.exp(-((h - centre) ** 2) / (2 * width * width));
  const base = 0.16 + 0.5 * smoothstep(4.6, 8.2, h) * (1 - smoothstep(21.5, 24.5, h));
  return Math.max(
    0.09,
    Math.min(
      1.55,
      base + bump(8.4, 1.5, 0.62) + bump(13.0, 1.6, 0.34) + bump(18.4, 2.1, 0.78) + bump(22.4, 1.4, 0.2),
    ),
  );
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/* wardrobe generation                                                 */
/* ------------------------------------------------------------------ */

export function makeAppearance(archetype: PedArchetype, rng: Rng): PedAppearance {
  const female = rng.bool(0.5);
  const height = (female ? rng.range(1.54, 1.76) : rng.range(1.65, 1.93)) ;
  const build = rng.range(0.87, female ? 1.06 : 1.18);
  const skin = pick(rng, SKIN);
  const hair = pick(rng, HAIR);

  const app: PedAppearance = {
    height,
    build,
    skin,
    hair,
    top: pick(rng, CIVILIAN_TOPS),
    sleeve: c(0x000000),
    shortSleeve: false,
    legs: pick(rng, CIVILIAN_LEGS),
    shoes: pick(rng, SHOES),
    vest: null,
    headwear: female && rng.bool(0.62) ? 4 : rng.bool(0.18) ? 1 : 0,
    faceVariant: (female ? 4 : 0) + (crowdFaceVariant(rng.int(0, 1 << 20)) % 4),
    hatColor: pick(rng, CIVILIAN_TOPS),
    bag: rng.bool(0.34) ? rng.weighted([1, 2, 3], [3, 2, 1.6]) : 0,
    bagColor: pick(rng, BAG_COLORS),
    phone: rng.bool(0.34),
    cigarette: rng.bool(0.16),
    placard: null,
  };

  switch (archetype) {
    case 'officeWorker':
      app.top = pick(rng, OFFICE_TOPS);
      app.legs = rng.bool(0.7) ? app.top.clone() : pick(rng, CIVILIAN_LEGS);
      app.shoes = c(0x16131a);
      app.bag = rng.weighted([0, 1, 2], [1, 3.4, 1.6]);
      app.phone = rng.bool(0.58);
      app.headwear = female ? (rng.bool(0.7) ? 4 : 0) : 0;
      // A pale shirt cuff reading out of a dark sleeve.
      app.sleeve = rng.bool(0.42) ? pick(rng, OFFICE_SHIRTS) : app.top.clone();
      break;

    case 'builder':
      app.top = rng.bool(0.5) ? c(0x3a4450) : c(0x4a3a2e);
      app.legs = rng.bool(0.6) ? c(0x2f3a44) : c(0x3d3226);
      app.vest = rng.bool(0.72) ? (rng.bool() ? HIVIS : HIVIS2).clone() : null;
      app.headwear = 2;
      app.hatColor = rng.weighted([c(0xf0c020), c(0xe8622a), c(0xdadada), c(0x2a6cd0)], [4, 2, 1.4, 1]);
      app.shoes = c(0x2a2018);
      app.bag = 0;
      app.cigarette = rng.bool(0.42);
      app.phone = rng.bool(0.22);
      break;

    case 'protester':
      app.top = rng.weighted(
        [c(0x232838), c(0x8a2a3a), Palette.roYellow.clone(), c(0x2a4a6a), c(0x1c1c22)],
        [3, 1.6, 1.1, 1.4, 2],
      );
      app.headwear = rng.bool(0.4) ? 3 : app.headwear;
      app.placard = rng.bool(0.45)
        ? rng.weighted([c(0xd8d2c4), Palette.roYellow.clone(), c(0xd84a3a)], [4, 1.4, 1.6])
        : null;
      app.bag = rng.bool(0.3) ? 2 : 0;
      break;

    case 'ministryAgent':
      app.top = c(0x14161f);
      app.legs = c(0x14161f);
      app.shoes = c(0x101018);
      app.sleeve = c(0x14161f);
      app.headwear = 0;
      app.bag = 0;
      app.phone = rng.bool(0.4);
      app.cigarette = false;
      break;

    case 'police':
      app.top = c(0x1b2c4a);
      app.legs = c(0x161d2e);
      app.vest = c(0x22304e);
      app.headwear = 1;
      app.hatColor = c(0x141c30);
      app.shoes = c(0x0f0f14);
      app.bag = 0;
      break;

    case 'streetVendor':
      app.top = pick(rng, CIVILIAN_TOPS);
      app.vest = rng.bool(0.6) ? c(0x7a4a2a) : c(0x2a5a4a);
      app.headwear = rng.bool(0.5) ? 1 : app.headwear;
      app.bag = 0;
      app.cigarette = rng.bool(0.3);
      break;

    case 'tourist':
      app.top = pick(rng, TOURIST_TOPS);
      app.legs = rng.bool(0.5) ? c(0x6a6a72) : pick(rng, CIVILIAN_LEGS);
      app.headwear = rng.bool(0.45) ? 1 : app.headwear;
      app.hatColor = pick(rng, TOURIST_TOPS);
      app.bag = rng.weighted([0, 2, 3], [1, 4, 2]);
      app.phone = rng.bool(0.66);
      app.shoes = rng.bool(0.5) ? c(0xd8d4cc) : app.shoes;
      break;

    default:
      break;
  }

  if (app.sleeve.getHex() === 0) {
    /* A short sleeve bares the FOREARM. It does not bare the shoulder, which
     * is what assigning the skin colour to `sleeve` here used to do — see the
     * arm block in rig.ts. The upper arm is always cloth. */
    app.shortSleeve = rng.bool(0.42);
    app.sleeve = app.top.clone();
  }
  return app;
}

/** Walking speed in m/s for an archetype, with per-person variation. */
export function baseSpeed(archetype: PedArchetype, rng: Rng): number {
  switch (archetype) {
    case 'officeWorker': return rng.range(1.42, 1.82);
    case 'ministryAgent': return rng.range(1.5, 1.8);
    case 'police': return rng.range(1.3, 1.55);
    case 'builder': return rng.range(1.15, 1.45);
    case 'tourist': return rng.range(0.85, 1.2);
    case 'streetVendor': return rng.range(0.8, 1.1);
    case 'protester': return rng.range(1.05, 1.4);
    default: return rng.range(1.05, 1.55);
  }
}
