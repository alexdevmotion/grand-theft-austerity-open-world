/**
 * HERO HEAD — the assembled face, and the only thing the rest of the game
 * needs to know about `src/characters/face/`.
 *
 * One of these is built per hero (four people, never the crowd) and parented to
 * the `head` bone of the existing humanoid rig, so it inherits the animation
 * state machine, the look-at and the ragdoll for free. Ambient pedestrians keep
 * the cheap instanced path untouched.
 *
 * What it puts together, in the order the FACE_PIPELINE mask-causes are listed:
 *   1  albedo authored per vertex, de-lit by construction  (headMesh.ts)
 *   2  pre-integrated subsurface scattering                (skin/sssLut.ts)
 *   3  thin-part transmission                             (skin/skinMaterial.ts)
 *   4  dual-lobe specular over a real T-zone roughness     (skin/skinMaterial.ts)
 *   5  procedural pore/wrinkle normal + a cavity term      (skin/microDetail.ts)
 *   6  layered eyes with a refracting cornea               (face/eyes.ts)
 *   7  hair, brows, lashes and beard as alpha geometry     (hair/*)
 *   8  deterministic asymmetry baked into the deformation  (face/headMesh.ts)
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import type { GameContext } from '../../core/engine';
import { BEARD_TOP, buildBeard, buildBrows, buildHairCards, buildHairShell, buildLashes, ALLY_HAIR, HEAVY_BROW, LEAN_BROW, NICUSOR_HAIR, PLAYER_HAIR, SOFT_BROW, type BeardSpec, type BrowSpec, type HairSpec } from '../hair/styles';
import { createHairMaterial } from '../hair/hair';
import { createFallbackSkinMaterial, createSkinMaterial, lodSkinMaterial, type SkinMaterial, type SkinMaterialOptions } from '../skin/skinMaterial';
import { buildEyes, type EyeBuild } from './eyes';
import { blendClouds, cloud, pushRegion, type CastId, type Cloud } from './fitData';
import { buildHeadGeometry, type HeadAnchors } from './headMesh';
import { BROW_L_BOTTOM, BROW_L_TOP, BROW_R_BOTTOM, BROW_R_TOP } from './landmarks';

/* ------------------------------------------------------------------ */
/* Cast                                                                */
/* ------------------------------------------------------------------ */

export interface CastConfig {
  id: CastId;
  /** Landmark cloud this head deforms to. */
  cloud(): Cloud;
  skin: number;
  skinOpts: SkinMaterialOptions;
  irisColor: number;
  tired: number;
  age: number;
  jawPush: number;
  browPush: number;
  beardShade: number;
  beardColor: number;
  hair: HairSpec;
  hairColor: number;
  brow: BrowSpec;
  browColor: number;
  beard: BeardSpec;
  beardCardColor: number;
}

/** The lower half of the face oval — the jaw line Bolojan's mass is pushed into. */
const JAW_IDX = [
  172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 58, 132, 93, 323,
];
const BROW_IDX = [...BROW_L_TOP, ...BROW_L_BOTTOM, ...BROW_R_TOP, ...BROW_R_BOTTOM];
/** The nasolabial ridge and the cheek mass that deepens the folds. */
const MIDFACE_IDX = [129, 209, 49, 64, 98, 97, 358, 429, 279, 294, 327, 326, 205, 425, 50, 280];

/**
 * The player is a fusion. `lead` is the primary silhouette — he has to stay the
 * man in the target frame — and Bolojan is pushed in exactly where the brief
 * says he shows: a broader, heavier jaw, the heavy angled brow ridge, and
 * deeper nasolabial folds.
 */
function playerCloud(): Cloud {
  let c = blendClouds(cloud('lead'), cloud('bolojan'), 0.24);
  c = pushRegion(c, cloud('bolojan'), JAW_IDX, 0.42);
  c = pushRegion(c, cloud('bolojan'), BROW_IDX, 0.55);
  c = pushRegion(c, cloud('bolojan'), MIDFACE_IDX, 0.38);
  return c;
}

export const CAST: Record<CastId, CastConfig> = {
  player: {
    id: 'player',
    cloud: playerCloud,
    /* Olive/tanned, mid-forties to fifties. Authored, not sampled.
     *
     * 0xcaa183 was authored against a neutral preview and blew out to bare
     * white under the game's low sunset key, which is the whole of "waxy": a
     * clipped highlight carries no pore detail, no scattering and no colour,
     * however good the shader under it is. A weathered olive complexion is
     * genuinely this dark in base albedo — the sun is what makes it read warm.
     *
     * 0x9c7452 was still not dark enough and was still not olive. Sampled off
     * the sunset render, the face came back at R = 240-251 out of 255 with
     * G/R = 0.57 and B/R = 0.42; the reference photograph measures G/R = 0.64-0.71
     * and B/R = 0.50-0.58 on the same features. Two separate faults, and the
     * first causes half of the second: red was CLIPPING, which throws away every
     * pore, blotch and capillary in that channel and drags the hue bodily toward
     * orange no matter what the other two do. So the value comes down about 12%
     * to stop the clip, and green and blue come up against red to put the cool
     * green-grey undertone back into an otherwise pure orange-brown. Checked
     * under a neutral noon key as well as the sunset, because a warm key is a
     * legitimate reason for a face to look warm and is not a reason to
     * mis-author the albedo.
     *
     * And then it had to come down a great deal FURTHER than that reasoning
     * suggested, because the face sits in the shoulder of the tone curve where
     * the response is almost flat: measured on the sunset render, an 11% cut in
     * albedo moved the rendered red by 2 counts (240 -> 238). Sweeping a
     * multiplier on the live material found the knee — 0.72 in linear takes the
     * cheek from 240 to 186, which is the reference photograph's range, and it
     * is the point where the cheekbone, the sub-malar hollow and the brow shadow
     * come back out of the highlight. Below about 0.6 the scene's purple sky
     * ambient starts to dominate and the face goes magenta, so this is a knee
     * with a floor under it, not a direction to keep pushing.
     *
     * AND THEN THE TRIM WAS MEASURED AGAINST THE BODY AND WAS WRONG.
     *
     * The whole paragraph above was tuned against the RENDER of the head alone,
     * with nothing beside it to calibrate against, and it over-corrected. The
     * decisive measurement is the one nobody took: the head and the NECK are
     * lit by the same key, in the same frame, one centimetre apart, and the
     * neck is painted by `wardrobe.ts` at `skin: 0x8d6d53`. Sampled off a
     * 1600x900 capture at 0.6 m with the face turned into a 40-degree sun,
     * the neck came back at 186/158/130 and the lit forehead at 165/135/113 —
     * and every part of the head that was NOT taking the key directly fell to
     * 33-40, against a scene whose pavement sat at 152-161. That is the
     * "near-black head over a correctly lit jacket" the immersion review saw,
     * and it is not a shading bug: a plain `MeshPhysicalMaterial` on the same
     * geometry with the same vertex colours renders just as dark (33/19/26),
     * and the same head with albedo forced to white renders at 134-189, i.e.
     * in line with the pavement. The light arriving at this head is fine. The
     * paint on it is roughly 40% too dark, and the paint on the beard, brows
     * and scalp is an order of magnitude too dark — see those entries.
     *
     * So this value is now pinned to the body's own skin rather than to a
     * sweep: 0x8d6550 carries the same linear luminance as `wardrobe.ts`'s
     * 0x8d6d53 (0.156 against 0.170) with G/R = 0.716 and B/R = 0.567, which
     * is inside the reference photograph's measured 0.64-0.71 and 0.50-0.58.
     * The head and the neck now differ by less than a stop, which is what
     * "one man" looks like. If the head ever needs to come down again, the
     * body's skin has to come down with it or this bug is back. */
    skin: 0x8d6550,
    /* `microScale` is tiles per metre of object space. At 820 one tile of the
     * 256 px pore map covered 1.2 mm of skin, so a pore was seven microns
     * across: it mipmapped to flat grey long before it reached a pixel, which
     * is why no micro-detail survived to screen. At 0.6 m and a 32 degree fov
     * one pixel subtends 0.21 mm, so detail has to be around half a millimetre
     * to read at all. 34 tiles/metre puts a tile at 29 mm and the crease octave
     * at 0.5-1.8 mm — visible, and still fine enough not to read as noise. */
    /* `sssTint` and `transColor` are the shader's OWN warm terms, and they are
     * where the last of the orange lives once the albedo is right.
     *
     * Under a neutral noon key the corrected albedo renders at G/R = 0.718
     * against the reference photograph's 0.713 — so the base colour is not the
     * problem and darkening it further would only make a grey man. Under the
     * sunset it still came back at R = 236/255 with B/R = 0.43. Two reasons, and
     * neither is the albedo: the scattered diffuse is multiplied by a warm tint,
     * and the transmission term adds a saturated orange-red to direct diffuse
     * over the WHOLE face, because `thick` has a 0.06 floor everywhere and the
     * term is deliberately unshadowed. Those are legitimate effects at an ear
     * rim and a nostril and they were being applied at cheek scale. */
    /* `sss` up from 0.36. The scattering strength is also the WIDTH of the
     * terminator: at 0.36 the wrap is mostly plain Lambert, so the moment a
     * facet turns away from the key it falls off a cliff — measured across the
     * cheekbone in full sun the face went 172 -> 33 over about fifteen pixels.
     * Real flesh has a centimetre of red bleed there. 0.50 is still short of
     * the 0.60 default (this face is weathered, not a child's) and it is what
     * stops the shaded half of the head reading as a hole. */
    skinOpts: {
      sss: 0.50, sssTint: 0xffeadf, transScale: 0.80, transColor: 0xf05a30,
      microScale: 34, microStrength: 0.88,
    },
    irisColor: 0x4a3520,
    tired: 0.95,
    age: 0.82,
    /* Down from 0.046. `jawPush` multiplies the gonial ramus term in
     * anatomy.ts, and at 0.046 it alone added 41 of the 69 thousandths that
     * pushed the mouth-level width past the cheekbones. Bolojan reads as a
     * heavy jaw because of DEPTH and a square corner, which `masseter` and
     * `jawEdge` supply, not because his face is widest at the mouth. */
    jawPush: 0.021,
    /* Up from 0.024. The supraorbital shelf is what casts the shadow that makes
     * a heavy brow read as BONE rather than as hair stuck on a smooth forehead,
     * and 0.024 (4.4 mm at head scale) is a normal male ridge. Bolojan is well
     * past normal. 0.032 is 5.8 mm, which is at the top of the male range and
     * still under the point where the sculpt starts to overhang the eye. */
    browPush: 0.032,
    beardShade: 1.0,
    /* The stubble tone under the cards: a salt-and-pepper beard is much greyer
     * than the hair, so this is a warm iron grey, not the hair's near-black.
     *
     * Still 0.24 lighter than the hair (0x1d1710), and a lot darker than it was.
     * Measured against the reference photograph the beard was rendering at
     * 140-193/255 where the reference sits at 64-118 — roughly twice as bright,
     * which is what turns a beard into a haze. Skin albedo came down 28% in the
     * same pass, so holding the beard where it was would have shrunk the
     * contrast between them as well.
     *
     * That reasoning compared the RENDERED beard against the reference's
     * rendered beard and then moved the ALBEDO by the same factor, which is
     * only valid if the two are lit alike — and they are not. 0x241e17 is
     * 0.017/0.012/0.008 in linear reflectance: an order of magnitude under the
     * skin beside it and about the albedo of charcoal. Sampled in full sun the
     * whole lower half of the face came back at 33/27/27 while the neck an
     * inch below it read 186. That is not a beard, it is a hole in the head,
     * and it is most of why the review reported both "the head is near-black"
     * and "the beard mass is absent" — the mass is there, 9300 cards of it,
     * painted in a colour that cannot return light.
     *
     * Human hair keratin does not go below about 0.04 linear even when it
     * reads jet black; a salt-and-pepper beard sits nearer 0.06-0.08. At 0x4a4139
     * (0.066/0.051/0.041 linear) the beard is still 2.4x darker than the
     * cheek, which is all the contrast a beard needs, and it now reads as a
     * mass with strands catching the key rather than as a silhouette. */
    beardColor: 0x4a4139,
    hair: PLAYER_HAIR,
    /* Also the scalp: `headMesh.paintVertices` paints this colour over the
     * whole scalp at 95% opacity, so a near-black hair colour puts a black cap
     * on the skull that the shell and cards then have to light on their own.
     * 0x1d1710 is 0.011 linear. 0x2b241b is 0.026 — still very dark brown,
     * still clearly darker than the greying cards over it. */
    hairColor: 0x2b241b,
    brow: HEAVY_BROW,
    /* The signature: heavy, dark, and they stay dark as the hair greys — but
     * 0x0f0b07 is 0.0033 linear, which is darker than any pigment on earth and
     * three times darker than the eye socket it sits in. It rendered as one
     * black smear from brow to lash, which is exactly the "flat heavy brow is
     * absent" reading: you cannot see a brow that has merged with its own
     * shadow. 0x241b13 is 0.017 linear — 9x darker than the skin around it,
     * dark enough to be unmistakably a brow, light enough to have a shape. */
    browColor: 0x241b13,
    /* Longer cards. At 5.6 mm the beard was shorter than the pore-scale relief
     * beside it and never broke the jaw silhouette; 6.8 mm is a two-week
     * trimmed beard at head scale and shows against the sky. */
    beard: { density: 1.0, length: 0.0068, grey: 0.24 },
    beardCardColor: 0x453d34,
  },
  nicusor: {
    id: 'nicusor',
    cloud: () => cloud('nicusor'),
    skin: 0x9e7d68,   // same 0.72 linear trim as the player — same key, same shoulder.
    skinOpts: { sss: 0.32, sssTint: 0xffe8da, transScale: 1.00, microScale: 34, microStrength: 0.74 },
    irisColor: 0x4d5a4c,
    tired: 0.30,
    age: 0.62,
    jawPush: -0.008,
    browPush: 0.004,
    beardShade: 0.10,
    beardColor: 0x8a7f74,
    hair: NICUSOR_HAIR,
    hairColor: 0x3b2f24,
    brow: SOFT_BROW,
    browColor: 0x3a2c20,
    beard: { density: 0, length: 0.006, grey: 0.4 },
    beardCardColor: 0x4a4038,
  },
  ally: {
    id: 'ally',
    cloud: () => cloud('ally'),
    skin: 0x946f55,   // same 0.72 linear trim as the player — same key, same shoulder.
    skinOpts: { sss: 0.33, sssTint: 0xffe4d4, transScale: 0.95, microScale: 34, microStrength: 0.74 },
    irisColor: 0x4a3826,
    tired: 0.42,
    age: 0.44,
    jawPush: -0.004,
    browPush: 0.007,
    // Clean-shaven with a faint stubble shadow along the jaw.
    beardShade: 0.34,
    beardColor: 0x6a6058,
    hair: ALLY_HAIR,
    hairColor: 0x2a2018,
    brow: LEAN_BROW,
    // Floored at ~0.02 linear for the same reason as the player's: below that
    // a brow stops being a feature and becomes a hole. See `browColor` above.
    browColor: 0x2a2018,
    beard: { density: 0.14, length: 0.0035, grey: 0.06 },
    beardCardColor: 0x2e2620,
  },
};

/* ------------------------------------------------------------------ */
/* Sun lookup                                                          */
/* ------------------------------------------------------------------ */

interface SkySource {
  readonly sunDirection: THREE.Vector3;
  sunLightColor(target?: THREE.Color): THREE.Color;
  sunIntensityScale(): number;
}

/**
 * `src/core/services.ts` is frozen and has no key for the sky, so the sky
 * system parks a marker object named `__sunDir__` in the scene carrying itself
 * — the lighting rig already looks it up the same way.
 */
function findSky(scene: THREE.Object3D): SkySource | null {
  const marker = scene.getObjectByName('__sunDir__');
  const s = marker?.userData?.sky as SkySource | undefined;
  return s && typeof s.sunIntensityScale === 'function' ? s : null;
}

function findSun(scene: THREE.Object3D): THREE.DirectionalLight | null {
  let found: THREE.DirectionalLight | null = null;
  scene.traverse((o) => {
    if (!found && (o as THREE.DirectionalLight).isDirectionalLight) found = o as THREE.DirectionalLight;
  });
  return found;
}

/* ------------------------------------------------------------------ */
/* Hero head                                                           */
/* ------------------------------------------------------------------ */

/** Beyond this the full stack is switched off entirely. */
const LOD_FALLBACK = 30;

export interface HeroHeadOptions {
  chinY: number;
  crownY: number;
  /** Bone-local offset: the head bone's origin in character space. */
  boneOrigin: THREE.Vector3;
  seed?: number;
  /** Lower-resolution grid for the non-player cast. */
  detail?: number;
}

/**
 * The hero's default head set: a few degrees of yaw and tilt, baked in.
 *
 * A head squared dead-on to the camera with a symmetric brow is a passport
 * photograph, and it is most of why the front view read as stiffer than the
 * three-quarter even once the geometry was the same man. Nobody holds their head
 * level and square. The reference is turned very slightly to his own left with
 * the chin a fraction down and one brow lower than the other, and that asymmetry
 * is doing as much identifying work as any single feature.
 *
 * Small on purpose: past about five degrees this stops reading as a pose and
 * starts reading as a rigging error, and it also has to survive being composed
 * with the animation system's own head stabilisation.
 */
const HEAD_SET = { pitch: 0.022, yaw: -0.062, roll: 0.020 } as const;

export class HeroHead {
  /** Parented to the head bone; carries the default head set. */
  readonly group = new THREE.Group();
  readonly anchors: HeadAnchors;

  /**
   * Inside `group`, carrying the bone-origin offset so the head set above
   * rotates about the base of the skull rather than about the character-space
   * origin — which is on the floor, and would swing the head across the street.
   */
  private readonly pivot = new THREE.Group();

  private readonly headMesh: THREE.Mesh;
  private readonly skinMat: SkinMaterial;
  private readonly fallbackMat: THREE.MeshStandardMaterial;
  private readonly skinOpts: SkinMaterialOptions;
  private readonly eyes: EyeBuild;
  private readonly hairMats: THREE.MeshPhysicalMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private sky: SkySource | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private lookedUp = false;
  private usingFallback = false;
  private readonly keyColor = new THREE.Color();

  constructor(cfg: CastConfig, opts: HeroHeadOptions) {
    const detail = opts.detail ?? 1;
    const built = buildHeadGeometry({
      cloud: cfg.cloud(),
      chinY: opts.chinY,
      crownY: opts.crownY,
      skin: cfg.skin,
      beard: cfg.beardShade,
      beardColor: cfg.beardColor,
      hairColor: cfg.hairColor,
      tired: cfg.tired,
      age: cfg.age,
      jawPush: cfg.jawPush,
      browPush: cfg.browPush,
      hairline: cfg.hair.hairline,
      beardLine: BEARD_TOP,
      cols: Math.round(108 * detail),
      rows: Math.round(84 * detail),
      seed: opts.seed ?? 0x51a5e,
    });
    this.anchors = built.anchors;
    this.geometries.push(built.geometry);

    this.skinOpts = cfg.skinOpts;
    this.skinMat = createSkinMaterial(cfg.skinOpts);
    this.fallbackMat = createFallbackSkinMaterial();
    this.headMesh = new THREE.Mesh(built.geometry, this.skinMat);
    this.headMesh.name = `head:${cfg.id}`;
    this.headMesh.castShadow = true;
    this.headMesh.receiveShadow = true;
    this.headMesh.frustumCulled = false;
    this.pivot.add(this.headMesh);

    /* ---- eyes ---- */
    this.eyes = buildEyes(built.anchors.eyeL, built.anchors.eyeR, {
      irisColor: cfg.irisColor,
      tired: cfg.tired,
      seed: opts.seed ?? 0,
    });
    this.pivot.add(this.eyes.globe, this.eyes.cornea, this.eyes.meniscus);

    /* ---- hair, brows, lashes, beard ---- */
    const addHair = (
      geo: THREE.BufferGeometry | null, color: number, name: string,
      o: {
        gloss?: number; roughness?: number; alphaTest?: number; rootDark?: number;
        tint?: number; shell?: boolean; shadow?: boolean; specular?: number;
      },
    ): void => {
      if (!geo) return;
      const mat = createHairMaterial({
        color,
        tintColor: o.tint ?? color,
        gloss: o.gloss,
        roughness: o.roughness,
        alphaTest: o.alphaTest,
        rootDark: o.rootDark,
        shell: o.shell,
        specular: o.specular,
      });
      mat.name = name;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      // Only the hair mass casts: brows, lashes and beard are sub-shadow-texel
      // and every extra caster costs one draw per shadow cascade.
      mesh.castShadow = o.shadow === true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.pivot.add(mesh);
      this.hairMats.push(mat);
      this.geometries.push(geo);
    };

    const seed = String(opts.seed ?? 0);
    /* THE HAIR SHELL MUST NOT CAST.
     *
     * This is the second half of the "near-black head" report and it is a
     * different bug from the albedo: measured at 0.6 m with the face turned
     * into a low sun, a hard, stair-stepped shadow band ran diagonally across
     * the forehead and down the right cheek, taking that cheek from 195 to 40
     * out of 255 while the cheek 30 mm away stayed lit. Isolated by toggling
     * one caster at a time on the live material:
     *
     *   baseline .................................. cheek 40
     *   head.receiveShadow = false ................ cheek 159
     *   head + hair castShadow = false ............ cheek 104
     *   hair shell castShadow = false ONLY ........ cheek 188
     *
     * So it is the shell, and the reason is geometric rather than a tuning
     * error. The shell is a scalp-hugging surface sitting 3-8 mm proud of the
     * skull, and the cascade that covers the player at street scale has texels
     * far larger than that offset — so from the light's point of view the shell
     * and the forehead under it are the same depth sample, and which one wins is
     * decided by the depth bias and the sun angle. There is no bias that fixes
     * that without detaching every other shadow in the city, and it is not the
     * lighting agent's to fix: a 4 mm shell should never have been a caster in
     * the first place. The head mesh itself still casts, so the character's
     * silhouette on the ground keeps its head; what is lost is 4 mm of hair
     * thickness in that silhouette, which is invisible, against a black band
     * across the face, which was the single most-reported defect in the game. */
    addHair(buildHairShell(built.anchors, cfg.hair), cfg.hairColor, 'hair-shell',
      { gloss: 130, roughness: 0.60, alphaTest: 0.42, rootDark: 0.34, shell: true, shadow: false, specular: 0.045 });
    addHair(buildHairCards(built.anchors, cfg.hair, `hair|${cfg.id}|${seed}`), cfg.hairColor, 'hair-cards',
      { gloss: 180, roughness: 0.50, alphaTest: 0.30, rootDark: 0.30, specular: 0.058 });
    addHair(buildBrows(built.anchors, cfg.brow, `brow|${cfg.id}|${seed}`), cfg.browColor, 'brows',
      { gloss: 46, roughness: 0.80, alphaTest: 0.10, rootDark: 0.10, specular: 0.028 });
    // 0x0d0a08 was 0.0026 linear — blacker than the pupil behind it, so the
    // lash line swallowed the eye's upper edge instead of drawing it.
    addHair(buildLashes(built.anchors, `lash|${cfg.id}|${seed}`), 0x1a1512, 'lashes',
      { gloss: 40, roughness: 0.8, alphaTest: 0.10, rootDark: 0, specular: 0.03 });
    addHair(buildBeard(built.anchors, cfg.beard, `beard|${cfg.id}|${seed}`), cfg.beardCardColor, 'beard',
      { gloss: 60, roughness: 0.74, alphaTest: 0.20, rootDark: 0.22, tint: cfg.beardCardColor, specular: 0.035 });

    this.pivot.position.copy(opts.boneOrigin).negate();
    this.group.add(this.pivot);
    this.group.rotation.set(HEAD_SET.pitch, HEAD_SET.yaw, HEAD_SET.roll);
    this.group.name = `heroHead:${cfg.id}`;
  }

  /** Parent to the rig's head bone; the animation system drives it from there. */
  attachTo(bone: THREE.Object3D): void {
    bone.add(this.group);
  }

  /**
   * Per frame: hand the key light to the transmission term and LOD the stack.
   * The full skin runs for hero faces near the camera only.
   */
  update(ctx: GameContext, distance: number): void {
    if (!this.lookedUp) {
      this.lookedUp = true;
      this.sky = findSky(ctx.scene);
      this.sun = findSun(ctx.scene);
    }

    const u = this.skinMat.skin;
    if (this.sky) {
      u.uKeyDir.value.copy(this.sky.sunDirection);
      this.sky.sunLightColor(this.keyColor);
      const gain = this.sun ? this.sun.intensity : 2.5;
      u.uKeyColor.value.copy(this.keyColor).multiplyScalar(gain * this.sky.sunIntensityScale() * 0.16);
    } else if (this.sun) {
      u.uKeyDir.value.copy(this.sun.position).normalize();
      u.uKeyColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.16);
    }

    lodSkinMaterial(this.skinMat, distance, this.skinOpts);

    const wantFallback = distance > LOD_FALLBACK;
    if (wantFallback !== this.usingFallback) {
      this.usingFallback = wantFallback;
      this.headMesh.material = wantFallback ? this.fallbackMat : this.skinMat;
      // Everything but the head mass is sub-pixel at this range.
      this.eyes.cornea.visible = !wantFallback;
      this.eyes.meniscus.visible = !wantFallback;
    }
  }

  /**
   * Rebuild this head as a different cast member, in place.
   *
   * Nothing in `src/gameplay/**` spawns Nicusor or Alex yet (see the report),
   * so this is how their heads are inspected: `__GTA_FACE__.swap('nicusor')`.
   */
  static debugHook(head: HeroHead, rebuild: (id: CastId) => void): void {
    if (typeof window === 'undefined') return;
    (window as unknown as { __GTA_FACE__: unknown }).__GTA_FACE__ = {
      head,
      cast: Object.keys(CAST),
      swap: (id: CastId) => rebuild(id),
    };
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.hairMats) m.dispose();
    this.skinMat.dispose();
    this.fallbackMat.dispose();
    this.eyes.dispose();
  }
}
