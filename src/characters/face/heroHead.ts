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
import { applyBlenderSculpt, blinkWeight } from './blenderSculpt';
import { buildAnatomicalHead, type AnatomicalCast } from './anatomicalHead';
import anatomicalCook from './generated/anatomical-cast.json';
import { applyAnatomicalAlbedo } from '../skin/anatomicalAlbedo';
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
    skin: 0x8d6550,
    skinOpts: {
      sss: 0.50, sssTint: 0xffeadf, transScale: 0.80, transColor: 0xf05a30,
      microScale: 42, microStrength: 0.20, roughnessBias: 0.13,
    },
    irisColor: 0x4a3520,
    tired: 0.95,
    age: 0.82,
    jawPush: 0.021,
    browPush: 0.032,
    beardShade: 1.0,
    beardColor: 0x4a4139,
    hair: PLAYER_HAIR,
    hairColor: 0x2b241b,
    brow: HEAVY_BROW,
    browColor: 0x1b1814,
    beard: { density: 1.0, length: 0.0068, grey: 0.24 },
    beardCardColor: 0x29251f,
  },
  nicusor: {
    id: 'nicusor',
    cloud: () => cloud('nicusor'),
    skin: 0x9e7d68,
    skinOpts: { sss: 0.32, sssTint: 0xffe8da, transScale: 1.00, microScale: 42, microStrength: 0.18, roughnessBias: 0.13 },
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
    skin: 0x946f55,
    skinOpts: { sss: 0.33, sssTint: 0xffe4d4, transScale: 0.95, microScale: 42, microStrength: 0.18, roughnessBias: 0.13 },
    irisColor: 0x577078,
    tired: 0.42,
    age: 0.44,
    jawPush: -0.004,
    browPush: 0.007,
    // Clean-shaven with a faint stubble shadow along the jaw.
    beardShade: 0.16,
    beardColor: 0x6a6058,
    hair: ALLY_HAIR,
    hairColor: 0x2a2018,
    brow: LEAN_BROW,
    browColor: 0x2a2018,
    beard: { density: 0.07, length: 0.0009, grey: 0.03 },
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
  private lashes: THREE.Mesh | null = null;
  private readonly hairMats: THREE.MeshPhysicalMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly blinkPhase: number;
  private sky: SkySource | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private lookedUp = false;
  private usingFallback = false;
  private readonly keyColor = new THREE.Color();

  constructor(cfg: CastConfig, opts: HeroHeadOptions) {
    const detail = opts.detail ?? 1;
    this.blinkPhase = ((opts.seed ?? 0) * 0.61803398875 + ['player', 'nicusor', 'ally'].indexOf(cfg.id) * 0.29) % 1;
    let built = buildHeadGeometry({
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
    const anatomical = buildAnatomicalHead(
      (anatomicalCook.casts as unknown as Record<string, AnatomicalCast>)[cfg.id], cfg, built,
    );
    if (anatomical) {
      built.geometry.dispose();
      built = anatomical;
    } else {
      applyBlenderSculpt(built.geometry, cfg.id, detail, built.anchors.frame);
    }
    this.anchors = built.anchors;
    this.geometries.push(built.geometry);

    this.skinOpts = cfg.skinOpts;
    this.skinMat = createSkinMaterial(cfg.skinOpts);
    this.fallbackMat = createFallbackSkinMaterial();
    if (anatomical) {
      applyAnatomicalAlbedo(this.skinMat, cfg.id);
      applyAnatomicalAlbedo(this.fallbackMat, cfg.id);
    }
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
      if (name === 'lashes') this.lashes = mesh;
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
    const blink = distance < 15 && this.headMesh.morphTargetInfluences ? blinkWeight(ctx.time.elapsed, this.blinkPhase) : 0;
    if (this.headMesh.morphTargetInfluences) this.headMesh.morphTargetInfluences[0] = blink;
    this.eyes.globe.visible = blink < 0.96;
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
    this.eyes.cornea.visible = !wantFallback && blink < 0.30;
    this.eyes.meniscus.visible = !wantFallback && blink < 0.30;
    // Static lash roots follow the open lid; hide them during its closure.
    if (this.lashes) this.lashes.visible = !wantFallback && blink < 0.30;
  }

  /**
   * Rebuild this head as a different cast member, in place.
   *
   * The inspection hook changes this instance without advancing the campaign:
   * `__GTA_FACE__.swap('nicusor')`.
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
