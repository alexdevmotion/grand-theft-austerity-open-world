/**
 * CHARACTERS — public API.
 *
 * Everything downstream (player, pedestrians, police, story cast) builds
 * against this module and nothing else in `src/characters/`. It is stable:
 * additions are welcome, signature changes are not.
 *
 * TYPICAL USE
 *
 *   import { CharacterFactory, rollAppearance } from '../characters';
 *
 *   const factory = CharacterFactory.of(ctx);          // shared caches
 *   const actor = factory.create(rollAppearance(rng, 'builder'));
 *   ctx.scene.add(actor.object);
 *
 *   // every frame, from your system's update():
 *   actor.setTransform(position, yaw);
 *   actor.drive({ state: 'walk', speed: 1.8, grounded: true, turnRate });
 *   actor.update(dt, ctx);                             // LOD + culling inside
 *
 *   actor.lookAt(player.position);                     // additive head track
 *   actor.ragdoll(new THREE.Vector3(0, 2, -6));        // death / big impact
 *   actor.dispose();                                   // returns cache refs
 *
 * `drive().speed` is metres per second on the ground plane; the controller
 * blends idle -> walk -> jog -> sprint continuously from it and advances the
 * gait phase by distance, so feet never skate whatever your mover does.
 *
 * OWNER: characters agent.
 */

export {
  CharacterFactory,
  CharacterActor,
  buildHumanoidGeometry,
  type CharacterActorOptions,
  type FootfallListener,
} from './humanoid';

export { AnimationController, Pose, type Drive } from './animation';

export {
  rollAppearance,
  HERO_APPEARANCE,
  NICUSOR_APPEARANCE,
  ALLY_APPEARANCE,
  CAST_APPEARANCES,
  appearanceGeoKey,
  appearanceTexKey,
  buildAppearanceTextures,
  SLOT,
  type Appearance,
  type AppearanceColors,
  type TopId,
  type OuterId,
  type LegsId,
  type ShoeId,
  type HairId,
  type HeadwearId,
  type AccessoryId,
} from './wardrobe';

export {
  rollFace,
  HERO_FACE,
  type FaceParams,
} from './faces';

export {
  BONE_NAMES,
  BI,
  BONE_COUNT,
  NOMINAL_HEIGHT,
  BODY_TYPES,
  bodyMetrics,
  buildRig,
  type BoneName,
  type BodyType,
  type BodyMetrics,
  type Rig,
} from './rig';

export { Ragdoll, solveTwoBone } from './ik';

export { prof } from './profile';

/**
 * The landmark-fitted hero head. Built automatically for any Appearance that
 * carries a `cast` id — nothing outside `src/characters/` has to construct it.
 */
export { HeroHead, CAST, type CastConfig } from './face/heroHead';
export { type CastId, type FitId, fitMeasure, fitPose } from './face/fitData';
