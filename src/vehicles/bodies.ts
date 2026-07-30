/**
 * Body dispatch.
 *
 * `VehicleClass` is what the physics and the traffic AI reason about; a MODEL
 * is what you actually see. This module maps (class, variant) onto a model in
 * `models.ts`, caches the built geometry, and hands the class-representative
 * dimensions to anything that only knows about classes.
 */

import * as THREE from 'three';
import type { VehicleClass } from '../core/services';
import { CLASS_MODELS, MODELS, VARIANTS, modelFor, type VehicleModel } from './models';
import type { BodyAnchors, BodyBuild, DoorPart, VehicleSpec } from './carkit';

export type { BodyAnchors, BodyBuild, DoorPart, VehicleSpec };
export { VARIANTS, modelFor };
export {
  CHROME, CHROME_DULL, BLACK_TRIM, RUBBER, GLASS, LENS_RED, LENS_AMBER, LENS_CLEAR, LAMP_WHITE,
} from './carkit';

/**
 * Class-representative dimensions: the first model in each class. Used by the
 * staging/showcase helpers and by anything that needs a size before a specific
 * model has been chosen. The authoritative spec for a spawned vehicle is
 * always `modelFor(...).spec`.
 */
export const SPECS: Record<VehicleClass, VehicleSpec> = Object.fromEntries(
  (Object.keys(CLASS_MODELS) as VehicleClass[]).map((k) => [k, MODELS[CLASS_MODELS[k][0]].spec]),
) as Record<VehicleClass, VehicleSpec>;

const cache = new Map<string, BodyBuild>();

export function buildBody(kind: VehicleClass, variant: number, hero: boolean): BodyBuild {
  const model: VehicleModel = modelFor(kind, variant, hero);
  const key = `${model.id}|${variant}|${hero ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = model.build(variant, hero);
  cache.set(key, built);
  return built;
}

/** Total triangles across every body built so far — reported by `__VEH__`. */
export function cachedBodyStats(): { bodies: number; triangles: number } {
  let tris = 0;
  for (const b of cache.values()) tris += b.triangles ?? 0;
  return { bodies: cache.size, triangles: Math.round(tris) };
}

export function bodyColour(): THREE.Color {
  return new THREE.Color(1, 1, 1);
}
