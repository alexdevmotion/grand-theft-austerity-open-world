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
import { buildBeard, buildBrows, buildHairCards, buildHairShell, buildLashes, ALLY_HAIR, HEAVY_BROW, LEAN_BROW, NICUSOR_HAIR, PLAYER_HAIR, SOFT_BROW, type BeardSpec, type BrowSpec, type HairSpec } from '../hair/styles';
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
    // Olive/tanned, mid-forties to fifties. Authored, not sampled.
    skin: 0xcaa183,
    skinOpts: { sss: 0.55, sssTint: 0xfff0e4, transScale: 2.1, microStrength: 0.34 },
    irisColor: 0x3d2c1d,
    tired: 0.95,
    age: 0.68,
    jawPush: 0.034,
    browPush: 0.016,
    beardShade: 0.85,
    beardColor: 0x6d6058,
    hair: PLAYER_HAIR,
    hairColor: 0x241c15,
    brow: HEAVY_BROW,
    // The signature: heavy, dark, and they stay dark as the hair greys.
    browColor: 0x140f0a,
    beard: { density: 0.9, length: 0.0048, grey: 0.24 },
    beardCardColor: 0x241d18,
  },
  nicusor: {
    id: 'nicusor',
    cloud: () => cloud('nicusor'),
    skin: 0xdbb69a,
    skinOpts: { sss: 0.55, sssTint: 0xfff2e8, transScale: 2.0, microStrength: 0.30 },
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
    skin: 0xcda589,
    skinOpts: { sss: 0.55, sssTint: 0xfff0e4, transScale: 1.9, microStrength: 0.30 },
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
    browColor: 0x1d1610,
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

export class HeroHead {
  readonly group = new THREE.Group();
  readonly anchors: HeadAnchors;

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
      tired: cfg.tired,
      age: cfg.age,
      jawPush: cfg.jawPush,
      browPush: cfg.browPush,
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
    this.group.add(this.headMesh);

    /* ---- eyes ---- */
    this.eyes = buildEyes(built.anchors.eyeL, built.anchors.eyeR, {
      irisColor: cfg.irisColor,
      tired: cfg.tired,
      seed: opts.seed ?? 0,
    });
    this.group.add(this.eyes.globe, this.eyes.cornea, this.eyes.meniscus);

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
      this.group.add(mesh);
      this.hairMats.push(mat);
      this.geometries.push(geo);
    };

    const seed = String(opts.seed ?? 0);
    addHair(buildHairShell(built.anchors, cfg.hair), cfg.hairColor, 'hair-shell',
      { gloss: 160, roughness: 0.52, alphaTest: 0.42, rootDark: 0.34, shell: true, shadow: true, specular: 0.075 });
    addHair(buildHairCards(built.anchors, cfg.hair, `hair|${cfg.id}|${seed}`), cfg.hairColor, 'hair-cards',
      { gloss: 220, roughness: 0.40, alphaTest: 0.30, rootDark: 0.30, specular: 0.10 });
    addHair(buildBrows(built.anchors, cfg.brow, `brow|${cfg.id}|${seed}`), cfg.browColor, 'brows',
      { gloss: 46, roughness: 0.72, alphaTest: 0.16, rootDark: 0.12, specular: 0.045 });
    addHair(buildLashes(built.anchors, `lash|${cfg.id}|${seed}`), 0x0d0a08, 'lashes',
      { gloss: 40, roughness: 0.8, alphaTest: 0.10, rootDark: 0, specular: 0.03 });
    addHair(buildBeard(built.anchors, cfg.beard, `beard|${cfg.id}|${seed}`), cfg.beardCardColor, 'beard',
      { gloss: 60, roughness: 0.74, alphaTest: 0.20, rootDark: 0.22, tint: cfg.beardCardColor, specular: 0.035 });

    this.group.position.copy(opts.boneOrigin).negate();
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
