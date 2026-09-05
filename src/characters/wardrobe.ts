/**
 * WARDROBE — one rig, many people.
 *
 * An `Appearance` fully describes a character: body type, height, garments,
 * hair, headwear, accessory and colours. It splits into two cache keys:
 *
 *   geoKey — everything that changes the MESH (body, garments, hair, headwear)
 *   texKey — everything that only changes COLOUR / face
 *
 * so a crowd of a hundred people collapses onto a few dozen shared geometries
 * and materials. Height never enters the geometry key: builds are authored at
 * NOMINAL_HEIGHT and scaled on the actor root.
 *
 * Texture atlas layout (256 x 256, generated to a canvas, no downloads):
 *   x   0..128   eight 16px "slot" columns, full height, addressed by uv.x
 *   x 128..256 / y   0..128   the face (see faces.ts)
 *   x 128..256 / y 128..256   cloth detail patch (jacket backs, bag flaps)
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import type { PedArchetype } from '../core/services';
import { Rng } from '../core/rng';
import { HERO_FACE, paintFace, rollFace, type FaceParams } from './faces';
import type { CastId } from './face/fitData';
import type { BodyType } from './rig';

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */

export const SLOT = {
  SKIN: 0,
  HAIR: 1,
  TOP: 2,
  OUTER: 3,
  LEGS: 4,
  SHOES: 5,
  ACCENT: 6,
  DETAIL: 7,
} as const;
export type SlotId = (typeof SLOT)[keyof typeof SLOT];

export const ATLAS_SIZE = 256;
const SLOT_COUNT = 8;
const SLOT_W = 16;

/** Centre of a slot column in three.js UV space. */
export function slotU(slot: SlotId): number {
  return (slot * SLOT_W + SLOT_W * 0.5) / ATLAS_SIZE;
}

/* ------------------------------------------------------------------ */
/* Garment vocabulary                                                  */
/* ------------------------------------------------------------------ */

export type TopId = 'tee' | 'shirt' | 'poloShirt' | 'hoodie' | 'blouse' | 'tankTop';
export type OuterId =
  | 'none' | 'jacket' | 'denimJacket' | 'coat' | 'longCoat' | 'suit'
  | 'hiVis' | 'puffer' | 'apron' | 'uniform';
export type LegsId = 'jeans' | 'trousers' | 'suitTrousers' | 'workTrousers' | 'skirt' | 'shorts' | 'longSkirt';
export type ShoeId = 'boots' | 'workBoots' | 'sneakers' | 'dressShoes' | 'heels';
export type HairId = 'bald' | 'buzz' | 'short' | 'sweptShort' | 'medium' | 'long' | 'bun' | 'ponytail';
export type HeadwearId = 'none' | 'cap' | 'beanie' | 'hardHat' | 'peakedCap';
/**
 * `sitePass` is the player's one purple thing — see `HERO_APPEARANCE`. It
 * replaced `builderHarness`, a full shoulder-to-hip brace-and-belt rig in
 * saturated violet that an immersion review named as the most saturated object
 * on the character and the least supported by the reference frame, where both
 * men are in plain clothes.
 */
export type AccessoryId = 'none' | 'lanyard' | 'backpack' | 'satchel' | 'toolBelt' | 'sitePass' | 'hipBag';

export interface AppearanceColors {
  skin: number;
  hair: number;
  top: number;
  outer: number;
  legs: number;
  shoes: number;
  accent: number;
  detail: number;
}

export interface Appearance {
  /** Full identity — used for debugging, not for caching. */
  id: string;
  body: BodyType;
  female: boolean;
  /** Metres, crown of the head. */
  height: number;
  top: TopId;
  outer: OuterId;
  legs: LegsId;
  shoes: ShoeId;
  hair: HairId;
  headwear: HeadwearId;
  accessory: AccessoryId;
  colors: AppearanceColors;
  face: FaceParams;
  /** Emissive strength of the ACCENT slot (0 = matte). */
  glow: number;
  /** Sleeves rolled / short sleeves expose forearm skin. */
  shortSleeve: boolean;
  /** Texture seed so two identical wardrobes still get different grain. */
  texSeed: number;
  /**
   * Named cast member. When set, the low-poly skull, nose, ears and hair are
   * left out of the body mesh and a full landmark-fitted head is attached to
   * the head bone instead (`face/heroHead.ts`). Four people, never the crowd.
   */
  cast?: CastId;
  /**
   * Wear the outer garment's collar UP, standing at the jaw, instead of the flat
   * shirt neckline every other outfit gets.
   *
   * Off by default: a street full of popped collars reads as a costume party.
   * It is on for the player because the reference frame is unambiguous about it
   * — dark navy jacket, collar up under the beard — and because it is the
   * cheapest identity win available. A low neckline leaves 25 mm of bare neck
   * under a bearded jaw, which is the single largest area of flat untextured
   * skin in the whole portrait and pulls the eye straight off the face.
   */
  collarUp?: boolean;
}

/* ------------------------------------------------------------------ */
/* Palettes                                                            */
/* ------------------------------------------------------------------ */

const SKIN = [0xf0d3b8, 0xe6c1a1, 0xd9ab88, 0xc9976f, 0xb8825d, 0xa06d4a, 0x8a5a3c, 0x6f452c];
const HAIR = [
  0x14100c, 0x241a12, 0x35251a, 0x4a3220, 0x6b4a2c, 0x8a6a3e,
  0xb09257, 0x8e8e92, 0xb9b6b0, 0x5f5a58, 0x7a2c28, 0x53306e,
];
/*
 * A FLOOR UNDER EVERY GARMENT.
 *
 * Half of these entries used to sit between 0x12 and 0x23 per channel, which is
 * 0.5-1.6% linear reflectance — below coal. A crowd painted out of that palette
 * has no lit side at dusk, and the frames that showed it worst were the ones
 * where the sun is behind the camera and everything SHOULD be readable.
 *
 * Nothing here goes under ~0x22 on its brightest channel any more (≈3% linear),
 * which is the bottom of what real dyed cloth measures. The hues are unchanged;
 * only the value floor moved, so the street is still a dark, cold, austere place
 * — it just is not made of cut-outs.
 */
const TOP_COLORS = [
  0xe9e6e0, 0xd8dce4, 0x343a47, 0x272a32, 0x6d7d8c, 0x8f4a4a,
  0x4b5f45, 0xc9b184, 0x3a4d6b, 0xa9a29a, 0x5a3a55, 0xbf6a3a,
];
const OUTER_COLORS = [
  0x2b3142, 0x22242b, 0x353942, 0x453427, 0x3d4436, 0x2f4360,
  0x54323f, 0x54504a, 0x2c3c4e, 0x342b3c,
];
const LEG_COLORS = [0x323a4b, 0x25272f, 0x2f3542, 0x3d3a33, 0x4a4e58, 0x362a34, 0x38445c];
const SHOE_COLORS = [0x24242c, 0x33241b, 0x3a3a40, 0xd8d4cc, 0x2b333e, 0x4a3226];

/* ------------------------------------------------------------------ */
/* Rolling appearances                                                 */
/* ------------------------------------------------------------------ */

interface ArchetypeRecipe {
  bodies: BodyType[];
  bodyW: number[];
  femaleChance: number;
  tops: TopId[];
  outers: OuterId[];
  outerW: number[];
  legs: LegsId[];
  shoes: ShoeId[];
  headwear: HeadwearId[];
  headwearW: number[];
  accessories: AccessoryId[];
  accessoryW: number[];
  outerPalette?: number[];
  accentPalette?: number[];
  ageRange?: [number, number];
}

const RECIPES: Record<PedArchetype, ArchetypeRecipe> = {
  civilian: {
    bodies: ['slim', 'average', 'stocky', 'heavy', 'tall', 'short'],
    bodyW: [1.1, 1.6, 1, 0.6, 0.7, 0.7],
    femaleChance: 0.48,
    tops: ['tee', 'shirt', 'poloShirt', 'hoodie', 'blouse'],
    outers: ['none', 'jacket', 'denimJacket', 'coat', 'puffer', 'longCoat'],
    outerW: [1.0, 1.3, 0.9, 0.9, 0.8, 0.5],
    legs: ['jeans', 'trousers', 'skirt', 'longSkirt', 'shorts'],
    shoes: ['sneakers', 'boots', 'dressShoes', 'heels'],
    headwear: ['none', 'cap', 'beanie'],
    headwearW: [4, 1, 1],
    accessories: ['none', 'satchel', 'backpack', 'hipBag'],
    accessoryW: [3, 1.2, 1, 0.6],
  },
  builder: {
    bodies: ['average', 'stocky', 'heavy', 'slim', 'tall'],
    bodyW: [1.4, 1.3, 0.7, 0.7, 0.6],
    femaleChance: 0.22,
    tops: ['tee', 'hoodie', 'shirt'],
    outers: ['hiVis', 'jacket', 'none', 'puffer'],
    outerW: [2.2, 1, 0.9, 0.6],
    legs: ['workTrousers', 'jeans'],
    shoes: ['workBoots', 'boots'],
    headwear: ['hardHat', 'cap', 'none', 'beanie'],
    headwearW: [1.8, 1, 1, 0.7],
    accessories: ['toolBelt', 'none', 'backpack'],
    accessoryW: [2, 1, 0.5],
    accentPalette: [0xe8b21a, 0xe2632a, 0x7b3fd4],
  },
  officeWorker: {
    bodies: ['slim', 'average', 'tall', 'stocky', 'heavy'],
    bodyW: [1.2, 1.5, 0.8, 0.7, 0.5],
    femaleChance: 0.5,
    tops: ['shirt', 'blouse', 'poloShirt'],
    outers: ['suit', 'jacket', 'none', 'coat'],
    outerW: [2, 1, 1.1, 0.8],
    legs: ['suitTrousers', 'trousers', 'skirt'],
    shoes: ['dressShoes', 'heels', 'sneakers'],
    headwear: ['none'],
    headwearW: [1],
    accessories: ['lanyard', 'satchel', 'none', 'backpack'],
    accessoryW: [1.6, 1.4, 1, 0.8],
  },
  protester: {
    bodies: ['slim', 'average', 'tall', 'stocky', 'short'],
    bodyW: [1.3, 1.4, 0.8, 0.7, 0.6],
    femaleChance: 0.44,
    tops: ['hoodie', 'tee', 'shirt'],
    outers: ['none', 'jacket', 'puffer', 'denimJacket'],
    outerW: [1.4, 1.2, 1, 1],
    legs: ['jeans', 'trousers', 'shorts'],
    shoes: ['sneakers', 'boots'],
    headwear: ['beanie', 'cap', 'none'],
    headwearW: [1.2, 1, 1.6],
    accessories: ['backpack', 'none', 'hipBag'],
    accessoryW: [1.6, 1.2, 0.7],
    accentPalette: [0xce1126, 0xfcd116, 0x002b7f, 0x7b3fd4],
  },
  police: {
    bodies: ['average', 'stocky', 'tall', 'heavy'],
    bodyW: [1.4, 1.2, 0.8, 0.5],
    femaleChance: 0.25,
    tops: ['shirt'],
    outers: ['uniform'],
    outerW: [1],
    legs: ['workTrousers'],
    shoes: ['boots'],
    headwear: ['peakedCap', 'none'],
    headwearW: [2.2, 1],
    accessories: ['toolBelt'],
    accessoryW: [1],
    outerPalette: [0x1b2436, 0x161d2c],
    accentPalette: [0x2b6cff, 0xe8e2d6],
  },
  ministryAgent: {
    bodies: ['average', 'slim', 'tall', 'stocky'],
    bodyW: [1.3, 1, 1, 0.9],
    femaleChance: 0.3,
    tops: ['shirt'],
    outers: ['suit', 'longCoat'],
    outerW: [1.6, 1],
    legs: ['suitTrousers'],
    shoes: ['dressShoes'],
    headwear: ['none'],
    headwearW: [1],
    accessories: ['lanyard', 'none'],
    accessoryW: [1.6, 1],
    outerPalette: [0x121317, 0x191b22, 0x22242c],
    accentPalette: [0x8d1622, 0x2a2f3d],
  },
  streetVendor: {
    bodies: ['stocky', 'heavy', 'average', 'short'],
    bodyW: [1.2, 1, 1.2, 0.9],
    femaleChance: 0.45,
    tops: ['shirt', 'tee', 'poloShirt'],
    outers: ['apron', 'jacket', 'none'],
    outerW: [1.8, 1, 0.9],
    legs: ['trousers', 'jeans'],
    shoes: ['boots', 'sneakers'],
    headwear: ['cap', 'none', 'beanie'],
    headwearW: [1.5, 1.2, 0.7],
    accessories: ['hipBag', 'none'],
    accessoryW: [1.6, 1],
  },
  tourist: {
    bodies: ['average', 'heavy', 'slim', 'tall', 'short'],
    bodyW: [1.3, 1, 0.9, 0.7, 0.7],
    femaleChance: 0.5,
    tops: ['tee', 'poloShirt', 'shirt'],
    outers: ['none', 'jacket', 'puffer'],
    outerW: [1.6, 1, 0.8],
    legs: ['shorts', 'jeans', 'trousers'],
    shoes: ['sneakers', 'boots'],
    headwear: ['cap', 'none'],
    headwearW: [1.6, 1],
    accessories: ['backpack', 'satchel', 'hipBag'],
    accessoryW: [1.8, 1, 0.8],
  },
};

function heightFor(body: BodyType, female: boolean, rng: Rng): number {
  const base = female ? 1.655 : 1.786;
  const mod =
    body === 'tall' ? 0.085 :
    body === 'short' ? -0.085 :
    body === 'slim' ? 0.012 :
    body === 'heavy' ? -0.012 : 0;
  return base + mod + rng.gauss() * 0.038;
}

function hairFor(rng: Rng, female: boolean, age: number): HairId {
  if (!female) {
    if (age > 0.6 && rng.bool(0.34)) return rng.bool(0.5) ? 'bald' : 'buzz';
    return rng.weighted(
      ['buzz', 'short', 'sweptShort', 'medium', 'bald', 'long'] as HairId[],
      [1.2, 2.2, 1.6, 0.8, 0.35, 0.25],
    );
  }
  return rng.weighted(
    ['short', 'medium', 'long', 'bun', 'ponytail', 'sweptShort'] as HairId[],
    [1.2, 1.8, 1.6, 1.1, 1.1, 0.7],
  );
}

/** Deterministic appearance for an archetype. */
export function rollAppearance(rng: Rng, archetype: PedArchetype = 'civilian'): Appearance {
  const r = RECIPES[archetype] ?? RECIPES.civilian;
  const female = rng.bool(r.femaleChance);
  const body = rng.weighted(r.bodies, r.bodyW);
  const height = heightFor(body, female, rng);

  let top = rng.pick(r.tops);
  if (female && top === 'shirt' && rng.bool(0.5)) top = 'blouse';
  if (!female && top === 'blouse') top = 'shirt';

  const outer = rng.weighted(r.outers, r.outerW);
  let legs = rng.pick(r.legs);
  if (!female && (legs === 'skirt' || legs === 'longSkirt')) legs = 'trousers';
  if (outer === 'suit' && legs !== 'skirt') legs = 'suitTrousers';

  let shoes = rng.pick(r.shoes);
  if (!female && shoes === 'heels') shoes = 'dressShoes';

  const face = rollFace(rng, {
    female,
    age: r.ageRange ? rng.range(r.ageRange[0], r.ageRange[1]) : undefined,
  });
  const hair = hairFor(rng, female, face.age);
  const headwear = rng.weighted(r.headwear, r.headwearW);
  const accessory = rng.weighted(r.accessories, r.accessoryW);

  const outerBase = r.outerPalette ? rng.pick(r.outerPalette) : rng.pick(OUTER_COLORS);
  const outerCol =
    outer === 'hiVis' ? rng.pick([0xe4d21e, 0xe9761f, 0xd8e024]) :
    outer === 'denimJacket' ? rng.pick([0x2f4360, 0x3a5170, 0x22303f]) :
    outer === 'apron' ? rng.pick([0x5a2f2a, 0x2f3f4a, 0x3d3a33]) :
    outerBase;

  const accent = r.accentPalette ? rng.pick(r.accentPalette) : rng.pick([0x7b3fd4, 0xc04ad0, 0xe8b21a, 0x2b6cff, 0xce1126, 0x4ade50]);

  return {
    id: `${archetype}-${(rng.next() * 1e9) | 0}`,
    body,
    female,
    height,
    top,
    outer,
    legs,
    shoes,
    hair,
    headwear,
    accessory,
    colors: {
      skin: rng.weighted(SKIN, [1.2, 2, 2.2, 1.6, 1.1, 0.7, 0.5, 0.35]),
      hair: rng.weighted(HAIR, [2.4, 2.2, 1.8, 1.5, 1.1, 0.7, 0.4, 0.5, 0.35, 0.6, 0.25, 0.15]),
      top: rng.pick(TOP_COLORS),
      outer: outerCol,
      legs: rng.pick(LEG_COLORS),
      shoes: rng.pick(SHOE_COLORS),
      accent,
      detail: rng.pick([0x1a1a20, 0x3a3630, 0x8e8e92, 0x5a4a3a]),
    },
    face,
    glow: 0,
    shortSleeve: rng.bool(archetype === 'tourist' ? 0.6 : 0.25),
    texSeed: (rng.next() * 1e9) | 0,
  };
}

/**
 * ILIE BOLOJAN-AGATINEI — the player.
 *
 * Dark practical clothing (denim jacket over a black tee, dark jeans, work
 * boots) plus exactly one exaggerated purple builder accessory, per
 * docs/STORY.md.
 *
 * THE ACCESSORY IS NOW A SITE PASS, NOT A HARNESS. It used to be an oversized
 * luminous violet brace-and-belt rig: two straps over each shoulder, a belt,
 * a buckle and hip loops, all in `accent`. An immersion review put it plainly —
 * nothing in `docs/reference/house-under-siege-duo.png` supports it, where both
 * men are plain-clothed in a navy chore jacket and a black tee, and it was the
 * most saturated thing anywhere on the character. "One exaggerated purple
 * accessory" is a story note about a READ, not a licence to paint a quarter of
 * the silhouette violet: a purple site pass on a purple cord, worn with a
 * purple wristband, is louder as a character note precisely because it is
 * small enough to be a choice rather than a uniform.
 */
export const HERO_APPEARANCE: Appearance = {
  id: 'bolojan-agatinei',
  body: 'average',
  female: false,
  height: 1.805,
  top: 'tee',
  outer: 'jacket',
  legs: 'jeans',
  shoes: 'workBoots',
  hair: 'short',
  headwear: 'none',
  accessory: 'sitePass',
  colors: {
    /* The NECK is this colour and the FACE is `CAST.player.skin`, and they were
     * two different men: 0xc9976f against 0x8b6d53 is 29% brighter and a good
     * deal more orange, so the neck rendered as a pale column under a dark
     * bearded jaw and read as "the collar sits too low" long before anyone
     * measured the collar. It does sit too low — see `collarUp` — but the value
     * mismatch was doing at least as much of the damage. Held a little lighter
     * than the face on purpose: a neck genuinely is, because it spends its life
     * shaded by the jaw and gets less sun than a forehead. */
    skin: 0x8d6d53,
    hair: 0x2b2119,
    /* HE WAS A CUTOUT.
     *
     * Measured against the shipped build: backlit on the plaza at 19:24 his
     * torso rendered at luma 15/255 while the pavement under him sat at 56 and
     * a pedestrian in a nearly identical navy suit read at 40+. Replacing his
     * material with plain 0.5 grey lit him perfectly, which rules the lighting
     * rig out — the fault was entirely here.
     *
     * 0x1c2230 is 0.012/0.016/0.030 in linear reflectance. That is not "dark
     * navy", it is the albedo of charcoal: one to three percent of the light
     * that lands on it comes back, so no amount of sky fill can put form on it
     * and he collapses to a silhouette the moment the sun is not square on his
     * chest. Real dark denim measures 4-7%.
     *
     * BUT ALBEDO IS ONLY HALF OF IT, and it is the smaller half. The pedestrian
     * he was losing to wears `OUTER_COLORS[0] = 0x1b1f2b` — the same colour to
     * within a hair. What that pedestrian had and he did not was a SUIT, whose
     * style sets roughness 0.66, against a jacket sitting on the 0.86 default.
     * At 0.86 there is no specular lobe worth the name, so with the sun behind
     * him the only light reaching the camera was diffuse off 1% albedo, which
     * is nothing. Lower roughness on the garment styles below is the real fix;
     * it buys a grazing rim off the sky and costs nothing in full sun.
     *
     * So these are held to ~1.35x the old values — 2.4x and 1.8x were both
     * tried and both read as pale grey-blue in open sun, because the tone curve
     * at this exposure is very compressive down here and a small change in
     * albedo is a large change on screen. He is still the darkest figure on the
     * street, which is what the reference frame wants. Do not move either the
     * colours or the roughness without re-shooting BOTH the backlit and the
     * sunlit plaza: either frame on its own will point you the wrong way.
     */
    top: 0x1d212b,
    outer: 0x232a3c,
    legs: 0x252b39,
    shoes: 0x282219,
    accent: 0x7b3fd4,
    detail: 0x2c2832,
  },
  face: HERO_FACE,
  // Just enough to catch the eye at dusk; any more and AgX burns the violet
  // out to white.
  glow: 0.13,
  shortSleeve: false,
  texSeed: 0x8ea55,
  // The `lead` fit with Bolojan pushed in — see face/heroHead.ts.
  cast: 'player',
  collarUp: true,
};

/**
 * NICUSOR LAN — infrastructure ally.
 *
 * Slight build and narrow shoulders under a plain dark suit with no tie (he is
 * the network guy), a lanyard and cable coils as role props. He must be
 * silhouette-distinct from the player at a glance: the head carries that with a
 * tall curly mop over a lean face against the player's cropped hair and heavy
 * build, and the body carries the rest.
 */
export const NICUSOR_APPEARANCE: Appearance = {
  id: 'nicusor-lan',
  body: 'slim',
  female: false,
  height: 1.79,
  top: 'shirt',
  outer: 'suit',
  legs: 'suitTrousers',
  shoes: 'dressShoes',
  hair: 'medium',
  headwear: 'none',
  accessory: 'lanyard',
  colors: {
    skin: 0xd7ac8a,
    hair: 0x3b2f24,
    top: 0xd8dce4,
    outer: 0x1b1f2b,
    legs: 0x1b1f2b,
    shoes: 0x14141a,
    accent: 0x6d7d8c,
    detail: 0x2a2530,
  },
  face: {
    ...HERO_FACE,
    age: 0.6, beard: 0, stubble: 0.06, tired: 0.3, jaw: 0.42,
    browThick: 0.5, noseLength: 0.86, noseWidth: 0.62, lipFull: 0.18,
  },
  glow: 0,
  shortSleeve: false,
  texSeed: 0x4c17b,
  cast: 'nicusor',
};

/**
 * ALEX NEED-AID — Recorder operative.
 *
 * Slim athletic build, black `recorder` t-shirt with the small red circular
 * logo at the chest; that logo is his identifier and has to stay legible.
 */
export const ALLY_APPEARANCE: Appearance = {
  id: 'alex-need-aid',
  body: 'slim',
  female: false,
  height: 1.80,
  top: 'tee',
  outer: 'none',
  legs: 'jeans',
  shoes: 'sneakers',
  hair: 'sweptShort',
  headwear: 'none',
  accessory: 'satchel',
  colors: {
    skin: 0xc99873,
    hair: 0x2a2018,
    top: 0x0e0e11,
    outer: 0x0e0e11,
    legs: 0x232a38,
    shoes: 0x14141a,
    accent: 0xc0392b,
    detail: 0x2a2530,
  },
  face: {
    ...HERO_FACE,
    age: 0.44, beard: 0, stubble: 0.35, tired: 0.42, jaw: 0.6,
    browThick: 0.6, noseLength: 0.62, noseWidth: 0.52, lipFull: 0.42,
  },
  glow: 0,
  shortSleeve: true,
  texSeed: 0x2be91,
  cast: 'ally',
};

/** Every named cast member, for anything that wants to spawn the story cast. */
export const CAST_APPEARANCES: Record<CastId, Appearance> = {
  player: HERO_APPEARANCE,
  nicusor: NICUSOR_APPEARANCE,
  ally: ALLY_APPEARANCE,
};

/* ------------------------------------------------------------------ */
/* Cache keys                                                          */
/* ------------------------------------------------------------------ */

/** Everything that changes the mesh. Height is deliberately excluded. */
export function appearanceGeoKey(a: Appearance): string {
  return [
    a.body, a.female ? 'f' : 'm', a.top, a.outer, a.legs, a.shoes,
    a.hair, a.headwear, a.accessory, a.shortSleeve ? 's' : 'l',
    (a.face.jaw * 3) | 0, (a.face.noseWidth * 3) | 0,
    a.cast ?? '-',
    // A mesh change, so it has to be in the MESH key. It happens to be implied
    // by `cast` today because only the player sets it, but two appearances that
    // differ only here must not share a geometry.
    a.collarUp ? 'cu' : '-',
  ].join('|');
}

/** Everything that only changes colour. */
export function appearanceTexKey(a: Appearance): string {
  const c = a.colors;
  const f = a.face;
  return [
    c.skin, c.hair, c.top, c.outer, c.legs, c.shoes, c.accent, c.detail,
    a.outer, a.top, a.legs, a.shoes, a.glow.toFixed(2), a.texSeed,
    (f.age * 8) | 0, (f.beard * 6) | 0, (f.stubble * 5) | 0, (f.tired * 5) | 0,
    (f.eyeSpacing * 5) | 0, (f.eyeSize * 5) | 0, (f.mouthWidth * 5) | 0,
    (f.noseWidth * 5) | 0, (f.noseLength * 5) | 0, (f.browThick * 5) | 0,
    (f.browHeight * 5) | 0, (f.lipFull * 5) | 0, (f.makeup * 4) | 0,
    f.eyeColor, (f.freckles * 4) | 0, (f.jaw * 4) | 0, (f.cheek * 4) | 0,
    (f.brow * 4) | 0, a.cast ?? '-',
  ].join('|');
}

/* ------------------------------------------------------------------ */
/* Texture generation                                                  */
/* ------------------------------------------------------------------ */

function rgb(hex: number, a = 1): string {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

interface ColumnStyle {
  /** Weave/grain strength. */
  grain: number;
  /** Horizontal detail bands: [v, height, colour, alpha]. */
  bands: Array<[number, number, number, number]>;
  /** Vertical shading: top and bottom multipliers. */
  shadeTop: number;
  shadeBottom: number;
  roughness: number;
  metalness: number;
}

const DEFAULT_STYLE: ColumnStyle = {
  grain: 0.05, bands: [], shadeTop: 1.06, shadeBottom: 0.8, roughness: 0.86, metalness: 0.02,
};

function topStyle(a: Appearance): ColumnStyle {
  const c = a.colors.top;
  const s: ColumnStyle = { ...DEFAULT_STYLE, bands: [] };
  // collar (v measured down the canvas, 0 = collar, 0.55 = hem, 0.6..1 = sleeve)
  s.bands.push([0.0, 0.035, mix(c, 0x000000, 0.35), 0.55]);
  s.bands.push([0.53, 0.03, mix(c, 0x000000, 0.3), 0.4]);
  if (a.top === 'shirt' || a.top === 'blouse') {
    s.bands.push([0.035, 0.012, mix(c, 0xffffff, 0.35), 0.5]);
    s.grain = 0.035;
    s.roughness = 0.72;
  }
  if (a.top === 'hoodie') {
    s.bands.push([0.04, 0.05, mix(c, 0x000000, 0.22), 0.5]);
    s.bands.push([0.46, 0.06, mix(c, 0x000000, 0.25), 0.45]);
    s.grain = 0.09;
    s.roughness = 0.86;
  }
  if (a.top === 'poloShirt') s.bands.push([0.02, 0.03, mix(c, 0xffffff, 0.2), 0.4]);
  // sleeve cuff
  s.bands.push([0.96, 0.04, mix(c, 0x000000, 0.3), 0.5]);
  return s;
}

function outerStyle(a: Appearance): ColumnStyle {
  const c = a.colors.outer;
  const s: ColumnStyle = { ...DEFAULT_STYLE, bands: [] };
  switch (a.outer) {
    case 'hiVis':
      s.roughness = 0.68;
      s.bands.push([0.20, 0.045, 0xd9d9dd, 0.92]);
      s.bands.push([0.28, 0.045, 0xd9d9dd, 0.92]);
      s.bands.push([0.0, 0.03, mix(c, 0x000000, 0.3), 0.5]);
      s.bands.push([0.72, 0.05, 0xd9d9dd, 0.9]);
      s.grain = 0.04;
      break;
    case 'denimJacket':
      s.grain = 0.13;
      // Denim is woven cotton, not chalk — see the sheen note in the default
      // case below. 0.9 leaves it with no grazing highlight at all.
      s.roughness = 0.80;
      s.bands.push([0.0, 0.035, mix(c, 0x000000, 0.28), 0.6]);
      s.bands.push([0.13, 0.012, mix(c, 0x000000, 0.4), 0.55]);
      s.bands.push([0.28, 0.010, mix(c, 0xffffff, 0.25), 0.3]);
      s.bands.push([0.48, 0.05, mix(c, 0x000000, 0.22), 0.6]);
      break;
    case 'suit':
      s.grain = 0.03;
      s.roughness = 0.66;
      s.bands.push([0.0, 0.06, mix(c, 0x000000, 0.35), 0.45]);
      s.bands.push([0.30, 0.008, mix(c, 0x000000, 0.5), 0.4]);
      break;
    case 'uniform':
      s.roughness = 0.7;
      s.bands.push([0.0, 0.04, mix(c, 0x000000, 0.4), 0.6]);
      s.bands.push([0.10, 0.02, a.colors.accent, 0.75]);
      s.bands.push([0.44, 0.05, mix(c, 0x000000, 0.3), 0.6]);
      break;
    case 'puffer':
      s.grain = 0.05;
      s.roughness = 0.5;
      for (let i = 0; i < 7; i++) s.bands.push([0.03 + i * 0.075, 0.012, mix(c, 0x000000, 0.42), 0.55]);
      for (let i = 0; i < 4; i++) s.bands.push([0.62 + i * 0.09, 0.012, mix(c, 0x000000, 0.42), 0.55]);
      break;
    case 'apron':
      s.roughness = 0.80;
      s.bands.push([0.0, 0.02, mix(c, 0x000000, 0.4), 0.6]);
      s.bands.push([0.30, 0.02, mix(c, 0xffffff, 0.15), 0.3]);
      break;
    case 'coat':
    case 'longCoat':
      s.grain = 0.07;
      s.roughness = 0.74;
      s.bands.push([0.0, 0.05, mix(c, 0x000000, 0.3), 0.5]);
      s.bands.push([0.35, 0.010, mix(c, 0x000000, 0.45), 0.5]);
      break;
    default:
      /* SHEEN, NOT ALBEDO.
       *
       * A jacket at 0.86 roughness has no specular lobe worth the name, so with
       * the sun behind him the only light reaching the camera was diffuse — and
       * diffuse off 3% albedo is nothing, which is how the player ended up a
       * black cut-out at dusk. Real coated cotton and denim are 0.65-0.75: they
       * carry a broad grazing-angle sheen that puts a bright edge on a shoulder
       * against a bright sky. That edge is what makes a figure sit IN a scene
       * rather than on top of it, and unlike raising the albedo it costs nothing
       * in full sun, where the value has to stay dark.
       */
      s.grain = 0.06;
      s.roughness = 0.70;
      s.bands.push([0.0, 0.035, mix(c, 0x000000, 0.3), 0.5]);
      s.bands.push([0.47, 0.04, mix(c, 0x000000, 0.25), 0.5]);
      break;
  }
  s.bands.push([0.96, 0.04, mix(c, 0x000000, 0.3), 0.5]);
  return s;
}

function legStyle(a: Appearance): ColumnStyle {
  const c = a.colors.legs;
  const s: ColumnStyle = { ...DEFAULT_STYLE, bands: [], shadeBottom: 0.74 };
  s.bands.push([0.0, 0.045, mix(c, 0x000000, 0.3), 0.55]);
  if (a.legs === 'jeans' || a.legs === 'workTrousers') {
    s.grain = 0.12;
    // Denim is not chalk: 0.92 left the legs with no grazing sheen at all, so
    // they went flat black the moment the sun came round. See `outerStyle`.
    s.roughness = 0.80;
    s.bands.push([0.06, 0.012, mix(c, 0xffffff, 0.2), 0.3]);
    s.bands.push([0.40, 0.06, mix(c, 0xffffff, 0.13), 0.35]);
    s.bands.push([0.78, 0.03, mix(c, 0x000000, 0.3), 0.5]);
  } else if (a.legs === 'suitTrousers' || a.legs === 'trousers') {
    s.grain = 0.03;
    s.roughness = 0.7;
    s.bands.push([0.79, 0.02, mix(c, 0x000000, 0.3), 0.4]);
  } else {
    s.grain = 0.05;
    s.roughness = 0.8;
  }
  if (a.legs === 'workTrousers') {
    s.bands.push([0.33, 0.05, mix(c, 0x000000, 0.25), 0.5]);
    s.bands.push([0.50, 0.02, a.colors.accent, 0.35]);
  }
  return s;
}

function shoeStyle(a: Appearance): ColumnStyle {
  const c = a.colors.shoes;
  const s: ColumnStyle = { ...DEFAULT_STYLE, bands: [], roughness: 0.55, metalness: 0.03 };
  s.bands.push([0.0, 0.10, mix(c, 0x000000, 0.35), 0.6]);
  s.bands.push([0.80, 0.20, mix(c, 0x000000, 0.55), 0.85]); // sole
  if (a.shoes === 'sneakers') {
    s.bands.push([0.72, 0.08, 0xe8e6e0, 0.7]);
    s.roughness = 0.75;
  }
  if (a.shoes === 'workBoots' || a.shoes === 'boots') {
    s.bands.push([0.20, 0.03, mix(c, 0xffffff, 0.2), 0.3]);
    s.bands.push([0.74, 0.06, mix(c, 0x000000, 0.5), 0.7]);
    s.roughness = 0.66;
  }
  if (a.shoes === 'dressShoes') s.roughness = 0.32;
  return s;
}

function skinStyle(a: Appearance): ColumnStyle {
  // v 0.30-0.50 forearm, 0.50-0.62 hand, 0.62-0.75 ankle/foot.
  const c = a.colors.skin;
  /* The hand band used to mix 16% toward a dark red-brown and then lay it down
   * at 55% alpha, so a hand rendered a clear step DARKER than the forearm it
   * belongs to. Hands are small, they are always in frame in third person, and
   * they are the second thing after the face an eye checks a humanoid against —
   * a dark patch there is read as a stump, which is exactly what happened. The
   * back of a hand is in fact the most sun-exposed skin on a clothed body: it
   * goes warmer and very slightly LIGHTER, never darker. */
  const hand = mix(c, 0xc98a5e, 0.20);
  return {
    grain: 0.045,
    bands: [
      [0.0, 0.03, mix(c, 0x000000, 0.25), 0.35],
      [0.50, 0.12, hand, 0.45],
      // knuckle creases — the only dark marks on a hand, and they are thin
      [0.545, 0.006, mix(c, 0x000000, 0.30), 0.30],
      [0.575, 0.006, mix(c, 0x000000, 0.26), 0.26],
      [0.62, 0.05, mix(c, 0x000000, 0.18), 0.28],
    ],
    shadeTop: 1.06,
    shadeBottom: 0.90,
    roughness: 0.62,
    metalness: 0.0,
  };
}

function hairStyle(a: Appearance): ColumnStyle {
  const c = a.colors.hair;
  return {
    grain: 0.17,
    bands: [
      [0.0, 0.10, mix(c, 0xffffff, 0.14), 0.35],
      [0.82, 0.18, mix(c, 0x000000, 0.4), 0.5],
    ],
    shadeTop: 1.12,
    shadeBottom: 0.62,
    roughness: 0.5,
    metalness: 0.0,
  };
}

function accentStyle(a: Appearance): ColumnStyle {
  const c = a.colors.accent;
  return {
    grain: 0.05,
    bands: [
      [0.10, 0.05, mix(c, 0xffffff, 0.4), 0.5],
      [0.55, 0.06, mix(c, 0x000000, 0.35), 0.5],
    ],
    shadeTop: 1.1,
    shadeBottom: 0.85,
    roughness: 0.44,
    metalness: 0.1,
  };
}

function detailStyle(a: Appearance): ColumnStyle {
  const c = a.colors.detail;
  return {
    grain: 0.06,
    bands: [[0.4, 0.08, mix(c, 0xffffff, 0.35), 0.4]],
    shadeTop: 1.05,
    shadeBottom: 0.8,
    roughness: 0.5,
    metalness: 0.25,
  };
}

function paintColumn(
  g: CanvasRenderingContext2D,
  slot: SlotId,
  base: number,
  style: ColumnStyle,
  rng: Rng,
): void {
  const x = slot * SLOT_W;
  const H = ATLAS_SIZE;

  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, rgb(mix(base, 0xffffff, (style.shadeTop - 1) * 1.6)));
  grad.addColorStop(0.5, rgb(base));
  grad.addColorStop(1, rgb(mix(base, 0x000000, 1 - style.shadeBottom)));
  g.fillStyle = grad;
  g.fillRect(x, 0, SLOT_W, H);

  for (const [v, h, col, alpha] of style.bands) {
    g.fillStyle = rgb(col, alpha);
    g.fillRect(x, v * H, SLOT_W, Math.max(1, h * H));
  }

  // Grain: horizontal weave streaks so cloth reads as fabric, not plastic.
  const n = Math.round(style.grain * 2600);
  for (let i = 0; i < n; i++) {
    const py = rng.next() * H;
    const px = x + rng.next() * SLOT_W;
    const w = rng.range(1, SLOT_W * 0.7);
    const a = rng.range(0.03, 0.14) * (style.grain * 6);
    g.fillStyle = rng.bool() ? rgb(0xffffff, a * 0.5) : rgb(0x000000, a);
    g.fillRect(px, py, w, 1);
  }
}

/**
 * The roughness/metalness this look will paint into the MRA atlas, per slot.
 *
 * Split out of `buildAppearanceTextures` so the surface response can be
 * asserted without a canvas — see `body.test.ts`. It matters: the player read
 * as a black cut-out at dusk mostly because his jacket sat on the 0.86 default
 * roughness and therefore had no grazing sheen at all, and that is invisible in
 * a colour palette and invisible in a screenshot taken with the sun in front.
 */
export function slotSurface(a: Appearance): Map<SlotId, { roughness: number; metalness: number }> {
  const styles = slotStyles(a);
  const out = new Map<SlotId, { roughness: number; metalness: number }>();
  for (let s = 0; s < SLOT_COUNT; s++) {
    const st = styles[s];
    out.set(s as SlotId, { roughness: st.roughness, metalness: st.metalness });
  }
  return out;
}

function slotStyles(a: Appearance): Record<number, ColumnStyle> {
  const styles: Record<number, ColumnStyle> = {
    [SLOT.SKIN]: skinStyle(a),
    [SLOT.HAIR]: hairStyle(a),
    [SLOT.TOP]: topStyle(a),
    [SLOT.OUTER]: outerStyle(a),
    [SLOT.LEGS]: legStyle(a),
    [SLOT.SHOES]: shoeStyle(a),
    [SLOT.ACCENT]: accentStyle(a),
    [SLOT.DETAIL]: detailStyle(a),
  };
  if (a.cast) {
    // Dark fabric keeps its dye colour on shoulders. Mixing 10% white into
    // its atlas was painting a broad grey highlight independent of lighting.
    for (const slot of [SLOT.TOP, SLOT.OUTER, SLOT.LEGS]) {
      styles[slot].shadeTop = 1.01;
      styles[slot].shadeBottom = 0.92;
      styles[slot].metalness = 0;
      styles[slot].roughness = Math.max(0.74, styles[slot].roughness);
    }
  }
  return styles;
}

export interface AppearanceTextures {
  map: THREE.CanvasTexture;
  mra: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture | null;
  dispose(): void;
}

function makeCanvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  return { c, g };
}

/** Build the albedo / roughness-metalness / emissive textures for one look. */
export function buildAppearanceTextures(a: Appearance): AppearanceTextures {
  const rng = new Rng(a.texSeed ^ 0x51ed27);
  const { c, g } = makeCanvas(ATLAS_SIZE, ATLAS_SIZE);

  const styles = slotStyles(a);
  const bases: Record<number, number> = {
    [SLOT.SKIN]: a.colors.skin,
    [SLOT.HAIR]: a.colors.hair,
    [SLOT.TOP]: a.colors.top,
    [SLOT.OUTER]: a.colors.outer,
    [SLOT.LEGS]: a.colors.legs,
    [SLOT.SHOES]: a.colors.shoes,
    [SLOT.ACCENT]: a.colors.accent,
    [SLOT.DETAIL]: a.colors.detail,
  };

  for (let s = 0; s < SLOT_COUNT; s++) {
    paintColumn(g, s as SlotId, bases[s], styles[s], rng);
  }

  // Face square, then a spare cloth patch below it.
  paintFace(g, 128, 0, 128, a.face, a.colors.skin, a.colors.hair, rng);
  g.fillStyle = rgb(a.colors.outer);
  g.fillRect(128, 128, 128, 128);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.generateMipmaps = false;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = 1;

  /* roughness (G) + metalness (B) */
  const mraSize = 64;
  const { c: mc, g: mg } = makeCanvas(mraSize, mraSize);
  mg.fillStyle = 'rgb(0,180,4)';
  mg.fillRect(0, 0, mraSize, mraSize);
  for (let s = 0; s < SLOT_COUNT; s++) {
    const st = styles[s];
    mg.fillStyle = `rgb(0,${Math.round(st.roughness * 255)},${Math.round(st.metalness * 255)})`;
    mg.fillRect((s / SLOT_COUNT) * (mraSize / 2), 0, mraSize / (SLOT_COUNT * 2), mraSize);
  }
  // face half = skin response
  mg.fillStyle = `rgb(0,${Math.round(0.6 * 255)},0)`;
  mg.fillRect(mraSize / 2, 0, mraSize / 2, mraSize);
  const mra = new THREE.CanvasTexture(mc);
  mra.colorSpace = THREE.NoColorSpace;
  mra.generateMipmaps = false;
  mra.minFilter = THREE.LinearFilter;
  mra.magFilter = THREE.LinearFilter;

  /* emissive — only the accent column glows */
  let emissive: THREE.CanvasTexture | null = null;
  if (a.glow > 0.01) {
    const { c: ec, g: eg } = makeCanvas(mraSize, mraSize);
    eg.fillStyle = '#000';
    eg.fillRect(0, 0, mraSize, mraSize);
    const ax = (SLOT.ACCENT / SLOT_COUNT) * (mraSize / 2);
    eg.fillStyle = rgb(a.colors.accent);
    eg.fillRect(ax, 0, mraSize / (SLOT_COUNT * 2), mraSize);
    emissive = new THREE.CanvasTexture(ec);
    emissive.colorSpace = THREE.SRGBColorSpace;
    emissive.generateMipmaps = false;
    emissive.minFilter = THREE.LinearFilter;
    emissive.magFilter = THREE.LinearFilter;
  }

  return {
    map,
    mra,
    emissive,
    dispose() {
      map.dispose();
      mra.dispose();
      emissive?.dispose();
    },
  };
}
