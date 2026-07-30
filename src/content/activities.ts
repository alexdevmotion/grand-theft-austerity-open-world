/**
 * SIDE ACTIVITIES — the reason to free-roam, as data.
 *
 * Four kinds, ten instances, all repeatable and all scored by
 * `src/gameplay/activityScoring.ts`:
 *
 *   curier    deliver a server / coffee / an evidence drive against the clock
 *   cursă     a checkpoint race along the boulevards
 *   evadare   the Ministry comes for you; lose them
 *   foto      photograph Georgescu's propaganda screens before the patrol
 *
 * COORDINATES. The city is a 92 m grid whose road centrelines fall on
 * `-1196 + 92k` (see `WorldScale`, src/artDirection.ts). Every point below is
 * on one of those lines or on a plaza deck, so nothing is ever authored inside
 * a building.
 */

import type { ActivityKind } from '../gameplay/activityScoring';

export interface ActivityPoint {
  x: number;
  z: number;
  /** Prompt/waypoint label. */
  label?: string;
}

export interface ActivityDef {
  id: string;
  kind: ActivityKind;
  /** Romanian display name. */
  name: string;
  /** One line of flavour for the start card. */
  blurb: string;
  /** Where the start marker stands. */
  x: number;
  z: number;
  /**
   * courier  [0] is the pickup, the rest are drops
   * race     checkpoints, in order
   * photo    the screens to photograph
   * evade    unused
   */
  points: ActivityPoint[];
  /** Seconds before the run fails. */
  limit: number;
  /** Race only: the time to beat. */
  par?: number;
  /** Evade only: Crisis Stars applied at the start, and seconds to hold out. */
  stars?: number;
  target?: number;
  /** Checkpoints have to be driven through. */
  inVehicle?: boolean;
  /** Only offered once this unlock is earned (see progression.ts). */
  requiresUnlock?: string;
}

/** Road-grid helper so the intent of a coordinate is readable. */
const G = (k: number): number => -1196 + 92 * k;

export const ACTIVITIES: ActivityDef[] = [
  /* ---------------- curier ---------------- */
  {
    id: 'curier_server',
    kind: 'courier',
    name: 'Curier: server',
    blurb: 'Un rack de 40 kg și două adrese. Nu frâna brusc.',
    x: G(13), z: G(13) + 46,
    limit: 180,
    points: [
      { x: G(13), z: G(13) + 46, label: 'Ridică serverul' },
      { x: G(17), z: G(12), label: 'Livrare 1' },
      { x: G(14), z: G(16), label: 'Livrare 2' },
    ],
  },
  {
    id: 'curier_cafea',
    kind: 'courier',
    name: 'Curier: cafea',
    blurb: 'Douăsprezece cafele pentru echipa de noapte. Reci nu se plătesc.',
    x: G(10), z: G(14),
    limit: 150,
    points: [
      { x: G(10), z: G(14), label: 'Ridică tava' },
      { x: G(12), z: G(13), label: 'Livrare 1' },
      { x: G(14), z: G(15), label: 'Livrare 2' },
    ],
  },
  {
    id: 'curier_dovezi',
    kind: 'courier',
    name: 'Curier: dovezi',
    blurb: 'Un stick, două redacții și un Minister care ascultă.',
    x: G(16), z: G(11),
    limit: 165,
    points: [
      { x: G(16), z: G(11), label: 'Ridică stickul' },
      { x: G(18), z: G(13), label: 'Redacția 1' },
      { x: G(15), z: G(10), label: 'Redacția 2' },
    ],
  },

  /* ---------------- cursă ---------------- */
  {
    id: 'cursa_magheru',
    kind: 'race',
    name: 'Cursă: Bulevardul Magheru',
    blurb: 'Patru viraje, zero scuze.',
    x: G(13), z: G(12),
    limit: 220,
    par: 105,
    inVehicle: true,
    points: [
      { x: G(13), z: G(10), label: 'Punct 1' },
      { x: G(15), z: G(10), label: 'Punct 2' },
      { x: G(15), z: G(13), label: 'Punct 3' },
      { x: G(13), z: G(13), label: 'Sosire' },
    ],
  },
  {
    id: 'cursa_unirii',
    kind: 'race',
    name: 'Cursă: Unirii',
    blurb: 'Tur complet. Dacia nu iartă bordurile.',
    x: G(11), z: G(15),
    limit: 260,
    par: 125,
    inVehicle: true,
    requiresUnlock: 'level_4',
    points: [
      { x: G(11), z: G(17), label: 'Punct 1' },
      { x: G(14), z: G(17), label: 'Punct 2' },
      { x: G(14), z: G(15), label: 'Punct 3' },
      { x: G(11), z: G(15), label: 'Sosire' },
    ],
  },

  /* ---------------- evadare ---------------- */
  {
    id: 'evadare_centru',
    kind: 'evade',
    name: 'Evadare: Centrul Vechi',
    blurb: 'Trei stele, străzi înguste. Pierde-i.',
    x: G(14), z: G(14),
    limit: 200,
    stars: 3,
    target: 70,
    points: [],
  },
  {
    id: 'evadare_guvern',
    kind: 'evade',
    name: 'Evadare: Cartierul guvernamental',
    blurb: 'Patru stele lângă Palat. Fugi pe unde poți.',
    x: G(12), z: G(8),
    limit: 240,
    stars: 4,
    target: 95,
    requiresUnlock: 'level_3',
    points: [],
  },

  /* ---------------- foto ---------------- */
  {
    id: 'foto_victoriei',
    kind: 'photo',
    name: 'Recompensă foto: Piața Victoriei',
    blurb: 'Trei ecrane cu Georgescu. Fă-le poză înainte de patrulă.',
    x: 276, z: -340,
    limit: 140,
    points: [
      { x: 276, z: -300, label: 'Ecran 1' },
      { x: 232, z: -368, label: 'Ecran 2' },
      { x: 320, z: -400, label: 'Ecran 3' },
    ],
  },
  {
    id: 'foto_parlament',
    kind: 'photo',
    name: 'Recompensă foto: Palatul Parlamentului',
    blurb: 'Portretele de pe axa monumentală. Curaj.',
    x: -92, z: -790,
    limit: 160,
    points: [
      { x: -140, z: -820, label: 'Ecran 1' },
      { x: -44, z: -820, label: 'Ecran 2' },
      { x: -92, z: -760, label: 'Ecran 3' },
    ],
  },
  {
    id: 'foto_casa',
    kind: 'photo',
    name: 'Recompensă foto: Casa Constructorilor',
    blurb: 'Ecranele de pe fațada propriei tale clădiri.',
    x: -20, z: 22,
    limit: 120,
    points: [
      { x: -42, z: 26, label: 'Ecran fațadă' },
      { x: -30, z: 12, label: 'Ecran lateral' },
      { x: -66, z: 14, label: 'Panou curte' },
    ],
  },
];

export const ACTIVITIES_BY_ID: ReadonlyMap<string, ActivityDef> = new Map(
  ACTIVITIES.map((a) => [a.id, a]),
);

export const KIND_LABEL: Record<ActivityKind, string> = {
  courier: 'CURIER',
  race: 'CURSĂ',
  evade: 'EVADARE',
  photo: 'FOTO',
};
