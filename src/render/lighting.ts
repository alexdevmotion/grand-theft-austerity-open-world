/** Sun, sky fill, image-based lighting and cascaded shadows.
 *
 *  This system owns every light in the game and the live state of the shared
 *  material library. It exists to satisfy two rules from the visual target:
 *  "the sky is the key light" and "never neutral".
 *
 *  THE THREE TERMS, AND WHY THEY ARE SPLIT THIS WAY
 *
 *    KEY   a hot, deep-amber directional light with cascaded shadows. It is
 *          the only thing in the frame that produces FORM — a lit face and a
 *          shadowed face on the same building. It must dominate.
 *    FILL  a decisively BLUE hemisphere light. Chroma separation is what gives
 *          the reference its power: ~2000K direct sun against ~12000K skylight,
 *          so lit stone is amber and its own shadow is blue. Fill and key must
 *          never converge on one hue.
 *    IBL   the real sky dome in a PMREM probe. It supplies the magenta mosaic
 *          on glass, chrome and wet asphalt. It is a REFLECTION term, not the
 *          key: when it was the dominant light (ENV_GAIN 2.15) every surface in
 *          the city was lit to the same value from every direction and the city
 *          rendered as one flat violet wedge with no readable sun at all.
 *
 *  OWNER: lighting/materials agent.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Atmosphere, HeroSun, Palette, WorldScale } from '../artDirection';
import { QUALITY, detectQuality, type Quality } from './renderer';
import { Services, type WeatherPreset } from '../core/services';
import { CascadedShadows } from './csm';
import { EnvProbe } from './envProbe';
import { MATERIAL_IDS, Materials } from './materials';

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * COLOUR SPACE — read this before touching any light colour below.
 *
 * three's ColorManagement is on, so `new Color(0xff9c5a)` already decodes sRGB
 * into linear. `src/artDirection.ts` then calls `.convertSRGBToLinear()` on top,
 * so every Palette entry arrives DECODED TWICE. For `Palette.sunLight` that
 * turns a warm amber into (1.000, 0.092, 0.010) — a near-primary RED whose
 * luminance is 0.28 rather than 1.0.
 *
 * Two things followed from that, and both were visible in every capture:
 *   1. the key light was three and a half stops darker than its `intensity`
 *      suggested, which is why the ambient looked like it was doing all the
 *      work — it was;
 *   2. lighting a city with a red primary cannot make stone look warm, only
 *      burnt, so the "warm" half of the frame collapsed into the same wedge as
 *      the violet half.
 *
 * artDirection.ts is not this agent's file. `L()` decodes exactly once, and
 * `unit()` renormalises any colour so the brightest channel is 1 — which is the
 * contract three actually wants: colour carries chromaticity, `intensity`
 * carries magnitude.
 */
const L = (hex: number): THREE.Color => {
  const c = new THREE.Color(hex);
  if (!THREE.ColorManagement.enabled) c.convertSRGBToLinear();
  return c;
};

function unit(c: THREE.Color, out = new THREE.Color()): THREE.Color {
  const m = Math.max(c.r, c.g, c.b, 1e-5);
  return out.copy(c).multiplyScalar(1 / m);
}

const luma = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

/**
 * The palette stores how a light SOURCE LOOKS, not the spectrum it emits.
 * Real light is broad-spectrum; mixing back toward the colour's own luminance
 * restores the achromatic component that lets a surface show its own albedo.
 * `keep` = 1 leaves the hue untouched, 0 makes it neutral.
 */
function broadSpectrum(c: THREE.Color, keep: number, out = new THREE.Color()): THREE.Color {
  const l = luma(c);
  return out.copy(c).lerp(TMP_GREY.setRGB(l, l, l), 1 - keep);
}
const TMP_GREY = new THREE.Color();

/* ------------------------------------------------------------------ */
/* The sky contract                                                    */
/* ------------------------------------------------------------------ */

/**
 * SkySystem publishes itself on a marker object rather than through a
 * ServiceKey, because `src/core/services.ts` is frozen. This is the structural
 * view of it the lighting rig needs — declared locally so the two systems stay
 * decoupled at the type level as well as the import level.
 *
 * Before this was wired up, LightingSystem computed its own sun from
 * `HeroSun` and never looked at the clock: scrubbing `timeOfDay` moved the sky,
 * the sun disc and the cloud deck while the key light, its colour and its
 * shadows stayed pinned to 19:24 forever. That is why night frames had a
 * daylight-direction sun at daylight chroma over a black sky.
 */
interface SkySource {
  readonly sunDirection: THREE.Vector3;
  readonly nightFactor: number;
  sunLightColor(target?: THREE.Color): THREE.Color;
  skyAmbientColor(target?: THREE.Color): THREE.Color;
  horizonColor(target?: THREE.Color): THREE.Color;
  sunIntensityScale(): number;
}

/** Per-preset lighting response. Multipliers on the hero sunset values. */
interface WeatherLook {
  sun: number;
  env: number;
  hemi: number;
  /** Brightness of the analytic sky mirrored by wet ground. */
  skyEnergy: number;
  /** Warm/cool bias applied to the sun colour. */
  sunTint: THREE.Color;
}

const LOOKS: Record<WeatherPreset, WeatherLook> = {
  clearSunset: { sun: 1.0, env: 1.0, hemi: 1.0, skyEnergy: 1.0, sunTint: new THREE.Color(1, 1, 1) },
  rain: { sun: 0.42, env: 0.9, hemi: 1.2, skyEnergy: 0.72, sunTint: new THREE.Color(0.9, 0.86, 1.0) },
  stormRain: { sun: 0.18, env: 0.75, hemi: 1.35, skyEnergy: 0.5, sunTint: new THREE.Color(0.78, 0.8, 1.0) },
  fogDusk: { sun: 0.5, env: 1.0, hemi: 1.3, skyEnergy: 0.66, sunTint: new THREE.Color(1.0, 0.92, 0.95) },
  overcast: { sun: 0.3, env: 1.05, hemi: 1.4, skyEnergy: 0.6, sunTint: new THREE.Color(0.92, 0.9, 1.0) },
  // Time of day already carries the night look through the sky keyframes; this
  // preset only has to bias on top of it, not darken a second time.
  night: { sun: 0.5, env: 1.0, hemi: 1.0, skyEnergy: 0.7, sunTint: new THREE.Color(0.7, 0.78, 1.0) },
};

export class LightingSystem implements System {
  readonly name = 'lighting';
  readonly order = 12;

  /** Primary cascade light — kept for systems that want the sun transform. */
  sun!: THREE.DirectionalLight;
  hemi!: THREE.HemisphereLight;
  csm!: CascadedShadows;
  probe!: EnvProbe;

  private ctx!: GameContext;
  private quality: Quality = 'high';
  private shadowRange = 300;
  private readonly sunDir = new THREE.Vector3();
  private readonly keyDir = new THREE.Vector3();
  private readonly sunColor = new THREE.Color();
  private look: WeatherLook = LOOKS.clearSunset;
  private lab: THREE.Group | null = null;

  private sky: SkySource | null = null;
  private nightFactor = 0;
  private skyProbeTimer = 0;

  /* scratch */
  private readonly _c0 = new THREE.Color();
  private readonly _c1 = new THREE.Color();
  private readonly _c2 = new THREE.Color();

  /* ---------------- init ---------------- */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.quality = this.resolveQuality(ctx);
    const q = QUALITY[this.quality];
    this.shadowRange = q.shadowDistance;

    Materials.setAnisotropy(ctx.renderer.capabilities.getMaxAnisotropy());

    this.computeSunDirection(HeroSun.elevationDeg, HeroSun.azimuthDeg);
    this.keyDirection(this.sunDir, this.keyDir);
    this.sunColor.copy(KEY_BLACKBODY);

    /* --- cascaded sun --- */
    this.csm = new CascadedShadows({
      camera: ctx.camera,
      parent: ctx.scene,
      cascades: q.shadowCascades,
      shadowMapSize: q.shadowMapSize > 2048 ? 2048 : q.shadowMapSize,
      maxFar: this.shadowRange,
      // CSM points the light ALONG this vector, so it is the direction light
      // travels: from the sun toward the world.
      lightDirection: this.keyDir.clone().negate(),
      lightIntensity: HeroSun.intensity * SUN_GAIN,
      lightColor: this.sunColor.clone(),
      fade: true,
    });
    this.sun = this.csm.lights[0];

    // Materials created by the library are registered the moment they exist,
    // so they never render a frame with N-times-over directional light.
    Materials.onMaterialCreated((m) => this.csm.setupMaterial(m));

    /* --- sky/ground fill ---
     * Decisively BLUE, and bright enough to matter. It is the only term that
     * every consumer gets at full strength: the city scales `envMapIntensity`
     * down to ~0.3 on its own materials, so the IBL cannot be relied on to
     * fill shadows, but a hemisphere light lands the same on everything. */
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, HeroSun.ambientIntensity * HEMI_GAIN);
    this.hemi.color.copy(FILL_SKY);
    this.hemi.groundColor.copy(FILL_GROUND);
    ctx.scene.add(this.hemi);

    /* --- image-based lighting --- */
    this.probe = new EnvProbe(ctx.renderer, ctx.scene, { resolution: 128, minInterval: 0.5 });
    this.probe.setSunDirection(this.sunDir);
    this.probe.setIntensity(ENV_GAIN);
    // Deferred one frame: the sky dome is added by SkySystem in the same init
    // pass, and the probe wants to clone the real thing.
    this.probe.markDirty();

    /* --- shared material state --- */
    Materials.setSunDirection(this.sunDir);
    this.pushSkyColors();
    Materials.setWetness(Atmosphere.wetness);

    ctx.events.on('weather:changed', ({ preset }) => this.applyWeather(preset as WeatherPreset));
    ctx.events.on('timeOfDay:changed', () => this.probe.markDirty());

    if (new URLSearchParams(location.search).has('matlab')) this.buildMaterialLab(ctx);

    (window as unknown as { __GTA_LIGHT__: Record<string, unknown> }).__GTA_LIGHT__ = {
      sun: (v: number) => this.csm.setLight(this.sunColor, v),
      env: (v: number) => this.probe.setIntensity(v),
      hemi: (v: number) => { this.hemi.intensity = v; },
      skyEnergy: (v: number) => Materials.setSkyEnergy(v),
      wet: (v: number) => Materials.setWetness(v),
      setSun: (el: number, az: number) => this.setSun(el, az),
      /** Hand the sun back to the clock after a manual `setSun`. */
      releaseSun: () => { this.sunOverride = false; },
      info: () => ({
        cascades: this.csm.cascadeCount,
        csmMaterials: this.csm.registeredMaterials,
        env: this.probe.intensity,
        hemi: this.hemi.intensity,
        hemiColor: this.hemi.color.getHexString(),
        sun: this.csm.lights[0]?.intensity ?? 0,
        sunColor: this.sunColor.getHexString(),
        sunElevationDeg: +(THREE.MathUtils.radToDeg(Math.asin(this.sunDir.y))).toFixed(2),
        keyElevationDeg: +(THREE.MathUtils.radToDeg(Math.asin(this.keyDir.y))).toFixed(2),
        nightFactor: +this.nightFactor.toFixed(3),
        skyLinked: !!this.sky,
        wetness: Materials.wetness,
        hasEnvMap: !!ctx.scene.environment,
      }),
    };
  }

  /** PostFX registers RenderService at order 900, i.e. after this system. */
  private resolveQuality(ctx: GameContext): Quality {
    const fromService = ctx.tryGet(Services.Render)?.quality;
    if (fromService) return fromService;
    const p = new URLSearchParams(location.search).get('q') as Quality | null;
    return p ?? detectQuality();
  }

  /* ---------------- the sky link ---------------- */

  /**
   * SkySystem parks a marker named `__sunDir__` in the scene carrying itself in
   * `userData.sky`. Resolved lazily because system init order is not a contract
   * we should depend on.
   */
  private findSky(): SkySource | null {
    if (this.sky) return this.sky;
    const marker = this.ctx.scene.getObjectByName('__sunDir__');
    const fromMarker = marker?.userData?.sky as SkySource | undefined;
    const fromWindow = (window as unknown as { __GTA_SKY__?: SkySource }).__GTA_SKY__;
    const s = fromMarker ?? fromWindow;
    if (s && typeof s.sunIntensityScale === 'function') this.sky = s;
    return this.sky;
  }

  /**
   * Pulls sun direction, chroma, strength and night factor out of the sky and
   * rebuilds every light from them. Cheap: a handful of colour ops.
   */
  private syncToSky(): void {
    const sky = this.findSky();
    if (!sky) return;

    this.nightFactor = sky.nightFactor;

    // `setSun` is a look-dev / verification override: without this latch the
    // per-frame sky sync silently put the sun straight back where the clock
    // says it is, so a manual sweep looked like the sun was doing nothing.
    const dirChanged =
      !this.sunOverride && this.sunDir.distanceToSquared(sky.sunDirection) > 1e-8;
    if (!this.sunOverride) this.sunDir.copy(sky.sunDirection);

    if (dirChanged) {
      this.keyDirection(this.sunDir, this.keyDir);
      this.csm.setSunDirection(this.keyDir.clone().negate());
      this.probe.setSunDirection(this.sunDir);
      Materials.setSunDirection(this.sunDir);
    }

    /* --- key colour --- */
    const raw = unit(sky.sunLightColor(this._c0), this._c0);
    // How warm the sky says the light is. Moonlight is cool and must stay cool,
    // so the blackbody pull is proportional to the warmth already present.
    const warmth = THREE.MathUtils.clamp(raw.r - raw.b, 0, 1);
    this._c1.copy(raw).lerp(KEY_BLACKBODY, KEY_HUE_PULL * warmth);
    broadSpectrum(this._c1, SUN_CHROMA, this.sunColor);
    unit(this.sunColor, this.sunColor);
    this.sunColor.multiply(this.look.sunTint);

    /* --- key strength ---
     * A grazing sun delivers cos(elevation) of its flux to the ground but
     * nearly all of it to a wall facing it, which is exactly the split the
     * reference is built on. `sunIntensityScale()` is the sky's own dimming
     * curve across the day; the gain converts authored intent into the linear
     * units three wants. */
    const sunI = HeroSun.intensity * SUN_GAIN * sky.sunIntensityScale() * this.look.sun;
    this.csm.setLight(this.sunColor, sunI);

    /* --- fill colour and strength ---
     * The sky's own ambient tint drifts violet at dusk and indigo at night;
     * pulling it toward a hard blue keeps the shadow side of every surface on
     * the opposite side of the colour wheel from the key. Without the pull the
     * whole frame measured a 37-degree hue spread against the reference's 130. */
    unit(sky.skyAmbientColor(this._c2), this._c2).lerp(FILL_SKY, FILL_BLUE_PULL);
    this.hemi.color.copy(this._c2);
    this.hemi.groundColor.copy(FILL_GROUND).lerp(this._c2, 0.25 * this.nightFactor);

    // Night keeps a floor so building masses stay readable silhouettes rather
    // than holes in the frame. The measured target is 8-12% luminance on an
    // unlit facade; below that the Palace of Parliament simply vanishes.
    const fill = THREE.MathUtils.lerp(1, NIGHT_FILL_SCALE, this.nightFactor);
    this.hemi.intensity = HeroSun.ambientIntensity * HEMI_GAIN * this.look.hemi * fill;

    const env = THREE.MathUtils.lerp(1, NIGHT_ENV_SCALE, this.nightFactor);
    this.probe.setIntensity(ENV_GAIN * this.look.env * env);

    this.pushSkyColors(sky);
  }

  /** Re-tints the analytic sky the wet-ground shader mirrors. */
  private pushSkyColors(sky?: SkySource | null): void {
    const horizon = sky ? sky.horizonColor(this._c0) : Palette.skyHorizon;
    const amb = sky ? sky.skyAmbientColor(this._c1) : Palette.skyAmbient;
    Materials.setSkyColors({
      horizon: broadSpectrum(horizon, ROAD_CHROMA),
      low: broadSpectrum(horizon, ROAD_CHROMA * 0.9).multiplyScalar(0.7),
      mid: broadSpectrum(amb, ROAD_CHROMA).multiplyScalar(1.4),
      high: broadSpectrum(amb, ROAD_CHROMA).multiplyScalar(0.8),
      zenith: broadSpectrum(amb, ROAD_CHROMA).multiplyScalar(0.45),
      sun: broadSpectrum(horizon, ROAD_CHROMA * 0.8).multiplyScalar(1.6),
    });
  }

  /* ---------------- per-frame ---------------- */

  update(dt: number, ctx: GameContext): void {
    const weather = ctx.tryGet(Services.Weather);
    if (weather) Materials.setWetness(weather.wetness);

    this.syncToSky();

    // The dome changes continuously with the clock, so the probe has to be
    // refreshed on a slow cadence rather than only on discrete events —
    // otherwise the IBL keeps lighting a night street with a sunset.
    this.skyProbeTimer -= dt;
    if (this.skyProbeTimer <= 0) {
      this.skyProbeTimer = PROBE_REFRESH_SECONDS;
      this.probe.markDirty();
    }
    this.probe.update(dt);
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    this.syncQuality(ctx);
    // Runs after the camera is final so the cascades bracket what is on screen.
    this.csm.update(dt, ctx.scene);
  }

  private lastQuality: Quality | null = null;
  private syncQuality(ctx: GameContext): void {
    const q = ctx.tryGet(Services.Render)?.quality;
    if (!q || q === this.lastQuality) return;
    this.lastQuality = q;
    if (q === this.quality) return;
    this.quality = q;
    const s = QUALITY[q];
    this.shadowRange = s.shadowDistance;
    this.rebuildCascades(ctx);
  }

  private rebuildCascades(ctx: GameContext): void {
    const q = QUALITY[this.quality];
    this.csm.dispose();
    this.csm = new CascadedShadows({
      camera: ctx.camera,
      parent: ctx.scene,
      cascades: q.shadowCascades,
      shadowMapSize: q.shadowMapSize > 2048 ? 2048 : q.shadowMapSize,
      maxFar: this.shadowRange,
      lightDirection: this.keyDir.clone().negate(),
      lightIntensity: HeroSun.intensity * SUN_GAIN * this.look.sun,
      lightColor: this.sunColor.clone(),
      fade: true,
    });
    this.sun = this.csm.lights[0];
    this.csm.registerScene(ctx.scene, true);
    Materials.onMaterialCreated((m) => this.csm.setupMaterial(m));
  }

  /* ---------------- weather / sun ---------------- */

  private applyWeather(preset: WeatherPreset): void {
    this.look = LOOKS[preset] ?? LOOKS.clearSunset;
    Materials.setSkyEnergy(this.look.skyEnergy);
    this.probe.markDirty();
    this.syncToSky();
  }

  /** True while `setSun` is holding the sun away from the clock. */
  private sunOverride = false;

  /** Repoint the sun. Elevation in degrees above the horizon, azimuth 0 = +Z. */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    this.sunOverride = true;
    this.computeSunDirection(elevationDeg, azimuthDeg);
    this.keyDirection(this.sunDir, this.keyDir);
    this.csm.setSunDirection(this.keyDir.clone().negate());
    this.probe.setSunDirection(this.sunDir);
    Materials.setSunDirection(this.sunDir);
    this.probe.markDirty();
  }

  private computeSunDirection(elevationDeg: number, azimuthDeg: number): void {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir
      .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
      .normalize();
  }

  /**
   * The SHADOW-CASTING direction, which is deliberately not the sun disc's.
   *
   * At the authored hero elevation of 3.2 degrees the shadow of a 70m tower is
   * 1.25km long: it leaves the cascade range, never lands on anything the
   * camera can see, and the ground receives cos(3.2) = 5% of the sun's flux, so
   * nothing on the street plane shows any modelling at all. Every capture the
   * critic took had zero building shadows on the road for exactly this reason.
   *
   * Lifting only the lighting rig to KEY_MIN_ELEVATION_DEG buys metre-scale
   * contact shadows and a real lit/shadow split on facades while the sun disc,
   * the horizon rip and the cloud lighting stay exactly where the sky authored
   * them. The azimuth is untouched, so shadows still run the direction the
   * visible sun says they should — which is the only part a viewer can check.
   *
   * The clean fix is `HeroSun.elevationDeg = 7.5` in artDirection.ts; that file
   * belongs to another agent, so this is the local equivalent.
   */
  private keyDirection(sunDir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const el = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)));
    if (el >= KEY_MIN_ELEVATION_DEG || el < -2) return out.copy(sunDir);
    // Below the horizon the "sun" is the moon; lift it the same way so night
    // shadows also read, but never flip it above the horizon from below.
    const lifted = el < 0 ? Math.max(el, -1.5) : KEY_MIN_ELEVATION_DEG;
    const horiz = Math.hypot(sunDir.x, sunDir.z) || 1e-5;
    const r = Math.cos(THREE.MathUtils.degToRad(lifted));
    return out
      .set((sunDir.x / horiz) * r, Math.sin(THREE.MathUtils.degToRad(lifted)), (sunDir.z / horiz) * r)
      .normalize();
  }

  /* ---------------- material lab (debug) ---------------- */

  /**
   * `?matlab=1` builds a material showcase outside the city grid so the
   * library can be judged on its own: every surface on a sphere and a slab,
   * over a wet asphalt apron with kerbs and puddles.
   */
  private buildMaterialLab(ctx: GameContext): void {
    const g = new THREE.Group();
    g.name = 'materialLab';
    const originX = WorldScale.halfExtent + 320;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      Materials.tiledFor('asphaltWet', 220, 220),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.position.set(originX, 0.01, 0);
    g.add(ground);

    const walk = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 26),
      Materials.tiledFor('pavingStone', 220, 26),
    );
    walk.rotation.x = -Math.PI / 2;
    walk.receiveShadow = true;
    walk.position.set(originX, 0.16, 34);
    g.add(walk);

    const kerb = new THREE.Mesh(new THREE.BoxGeometry(220, 0.34, 1.2), Materials.tiledFor('kerbConcrete', 220, 1.2));
    kerb.position.set(originX, 0.16, 21);
    kerb.castShadow = true;
    kerb.receiveShadow = true;
    g.add(kerb);

    const sphere = new THREE.SphereGeometry(2.6, 48, 32);
    const slab = new THREE.BoxGeometry(5.4, 11, 5.4);

    MATERIAL_IDS.forEach((id, i) => {
      if (id === 'roadMarkings') return;
      const x = originX - 45 + i * 8.5;
      const m = Materials.get(id);

      const s = new THREE.Mesh(sphere, m);
      s.position.set(x, 3.2, 0);
      s.castShadow = true;
      s.receiveShadow = true;
      g.add(s);

      const b = new THREE.Mesh(slab, Materials.tiledFor(id, 5.4, 11));
      b.position.set(x, 5.6, -12);
      b.castShadow = true;
      b.receiveShadow = true;
      g.add(b);
    });

    // A tall curtain-wall slab, the hero surface of the reference frame.
    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(26, 74, 18),
      Materials.tiledFor('glassCurtain', 26, 74),
    );
    tower.position.set(originX + 62, 37, -28);
    tower.castShadow = true;
    tower.receiveShadow = true;
    g.add(tower);

    const stone = new THREE.Mesh(
      new THREE.BoxGeometry(12, 74, 18.4),
      Materials.tiledFor('travertine', 12, 74),
    );
    stone.position.set(originX + 43, 37, -28);
    stone.castShadow = true;
    stone.receiveShadow = true;
    g.add(stone);

    ctx.scene.add(g);
    this.lab = g;
    // eslint-disable-next-line no-console
    console.info(`[lighting] material lab at x=${originX.toFixed(0)}`);
  }

  dispose(): void {
    this.csm?.dispose();
    this.hemi?.dispose();
    this.probe?.dispose();
    if (this.lab) {
      this.lab.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      this.lab.removeFromParent();
    }
    Materials.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Exposure calibration                                                */
/*                                                                     */
/* artDirection holds the authored intent; these gains convert it into */
/* the physical units three.js wants. They live here rather than in    */
/* artDirection because they are a property of the renderer setup, not */
/* of the look.                                                        */
/* ------------------------------------------------------------------ */

/*
 * Calibrated by measuring the reference frame itself (decoded in-browser and
 * histogrammed) and matching `window.__GTA_POST__.meter()` against it:
 *
 *              p05  p25  p50  p75  p95  mean  saturation  hue std
 *   reference   12   28   50   93  165    66        0.29     130 deg
 *
 * The two failures the previous calibration produced, both measured:
 *   saturation 0.43-0.65 (1.5-2.3x the reference) and hue std 36-39 degrees
 *   (a quarter of the reference). Both had the same root cause: the IBL probe
 *   carrying the magenta dome was the dominant light, so every surface in the
 *   city was tinted by the same magenta and nothing had a second hue to
 *   contrast against. Cutting ENV and giving the fill a hard blue fixes the
 *   hue spread AND most of the saturation, at the source rather than by
 *   desaturating an already-committed frame in the grade.
 */

/** ~2000K low sun, in linear RGB. A grazing sun is amber, not white. */
const KEY_BLACKBODY = new THREE.Color(1.0, 0.44, 0.15);
/** How far the sky's reported sun colour is pulled toward that blackbody. */
const KEY_HUE_PULL = 0.82;
/** ~12000K skylight. The fill must sit opposite the key on the colour wheel. */
const FILL_SKY = L(0x5a76ff);
/** Bounce off wet violet tarmac: dark, and warmer than the sky. */
const FILL_GROUND = L(0x4a3050);
/** How hard the sky's own ambient tint is pulled toward that blue. */
const FILL_BLUE_PULL = 0.6;

/** How much of the palette's chroma the direct sun keeps. See broadSpectrum. */
const SUN_CHROMA = 0.9;
/** Chroma of the analytic sky the wet road mirrors. */
const ROAD_CHROMA = 0.62;

/**
 * The key. `HeroSun.intensity` (4.6) times this lands at ~11 linear units,
 * which is what makes a west-facing facade a full stop and a half above its own
 * north face — the split that gives the city form.
 */
const SUN_GAIN = 2.05;
/**
 * The IBL is a REFLECTION term. At 2.15 it was the key light and the sun was a
 * rounding error; the city additionally scales it by `envMapIntensity` 0.28-0.35
 * on its own materials, so this number only really reaches glass, chrome and
 * water — which is exactly where it should land.
 */
const ENV_GAIN = 0.8;
/** The blue fill. Unlike the IBL this lands at full strength on everything. */
const HEMI_GAIN = 0.44;

/** Minimum shadow-casting elevation. See LightingSystem.keyDirection. */
const KEY_MIN_ELEVATION_DEG = 8.0;

/** Night floors, as fractions of the daytime fill. Silhouettes must survive. */
const NIGHT_FILL_SCALE = 0.42;
const NIGHT_ENV_SCALE = 0.85;

/** Seconds between IBL refreshes while the clock is running. */
const PROBE_REFRESH_SECONDS = 2.5;
