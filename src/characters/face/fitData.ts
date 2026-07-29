/**
 * FIT DATA — the fitted landmark clouds, in one canonical frame.
 *
 * `tools/facefit/out/faces.json` holds, per subject, MediaPipe's 478 landmarks
 * in IMAGE space plus the head-pose matrix and a `frontal` set that the fitter
 * has already de-rotated with that matrix (see FACE_PIPELINE.md's caveat: on the
 * three-quarter crops `lead` and `ally` every width in image space is
 * foreshortened by cos(yaw), which would otherwise make both men read as narrow
 * as each other and as narrow as nobody).
 *
 * The `frontal` frame, which is the only one anything downstream should touch:
 *   origin  the midpoint of the two outer eye corners
 *   +x      the subject's LEFT  (= character +X)
 *   +y      up
 *   +z      out of the face     (= character +Z, the direction a character faces)
 *   unit    the forehead-to-chin distance
 *
 * so it maps into character space with a single uniform scale and an offset —
 * no axis flips, no per-subject alignment.
 *
 * OWNER: characters agent.
 */

import raw from '../../../tools/facefit/out/faces.json';
import { LM_COUNT } from './landmarks';

export type CastId = 'player' | 'nicusor' | 'ally';
export type FitId = 'lead' | 'ally' | 'bolojan' | 'nicusor';

export const FIT_IDS: readonly FitId[] = ['lead', 'ally', 'bolojan', 'nicusor'];

interface RawFit {
  source: string;
  landmarkCount: number;
  imageSize?: [number, number];
  transform?: number[] | null;
  pose?: { yawDeg: number; pitchDeg: number; rollDeg: number } | null;
  measurements: Record<string, number>;
  frontalMeasurements?: Record<string, number> | null;
  landmarks: number[][];
  frontal?: number[][] | null;
  blendshapes: Record<string, number>;
}

const RAW = raw as unknown as Record<FitId, RawFit>;

/** Flat xyz triples, 478 * 3, in the frontal frame. */
export type Cloud = Float32Array;

function toCloud(f: RawFit): Cloud {
  const src = f.frontal ?? f.landmarks;
  const out = new Float32Array(LM_COUNT * 3);
  for (let i = 0; i < LM_COUNT; i++) {
    const p = src[i];
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

const CLOUDS: Record<FitId, Cloud> = {
  lead: toCloud(RAW.lead),
  ally: toCloud(RAW.ally),
  bolojan: toCloud(RAW.bolojan),
  nicusor: toCloud(RAW.nicusor),
};

/** Head pose that was divided out, kept so the de-rotation is auditable. */
export function fitPose(id: FitId): { yawDeg: number; pitchDeg: number; rollDeg: number } {
  return RAW[id].pose ?? { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
}

/**
 * Proportions measured on the DE-ROTATED cloud. These are the numbers that are
 * comparable between subjects; `RAW[id].measurements` is the foreshortened
 * image-space version and exists only for provenance.
 */
export function fitMeasure(id: FitId): Record<string, number> {
  return RAW[id].frontalMeasurements ?? RAW[id].measurements;
}

export function fitBlendshapes(id: FitId): Record<string, number> {
  return RAW[id].blendshapes;
}

export function cloud(id: FitId): Cloud {
  return CLOUDS[id];
}

/** The average of all four fits — the shared base every head deforms away from. */
export const MEAN_CLOUD: Cloud = (() => {
  const out = new Float32Array(LM_COUNT * 3);
  for (const id of FIT_IDS) {
    const c = CLOUDS[id];
    for (let i = 0; i < out.length; i++) out[i] += c[i] / FIT_IDS.length;
  }
  return out;
})();

/**
 * Linear blend of two fits. The player is Ilie Bolojan-Agatinei — the `lead`
 * crop carries the silhouette and the `bolojan` fit is pushed into it, which is
 * exactly a weighted blend of two clouds that already share a topology.
 */
export function blendClouds(a: Cloud, b: Cloud, t: number): Cloud {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/**
 * Push a single measured trait of `b` into `a` without dragging the rest of the
 * face along: only the landmarks listed are moved, and the move is smoothed by
 * the deformation field afterwards anyway.
 */
export function pushRegion(base: Cloud, target: Cloud, idx: readonly number[], t: number): Cloud {
  const out = new Float32Array(base);
  for (const i of idx) {
    for (let c = 0; c < 3; c++) {
      const k = i * 3 + c;
      out[k] = base[k] + (target[k] - base[k]) * t;
    }
  }
  return out;
}

/** Read one landmark out of a cloud. */
export function lm(c: Cloud, i: number): [number, number, number] {
  return [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
}

/** Centroid of a named set of landmarks. */
export function centroid(c: Cloud, idx: readonly number[]): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (const i of idx) {
    x += c[i * 3];
    y += c[i * 3 + 1];
    z += c[i * 3 + 2];
  }
  const n = idx.length || 1;
  return [x / n, y / n, z / n];
}
