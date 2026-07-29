/** SKY AND ATMOSPHERE — the key light and the emotional centre of the frame.
 *
 *  OWNER: sky/atmosphere agent.
 *
 *  What lives here:
 *    - a far-plane sky dome running the multi-deck scattering/cloud shader
 *      (src/render/sky/skyShader.ts, cloudShader.ts, noise.ts)
 *    - the solar model and the time-of-day / weather keyframe blend
 *      (src/render/sky/skyState.ts)
 *    - directional aerial perspective replacing three's flat fog
 *      (src/render/sky/aerialPerspective.ts)
 *    - screen-space veiling glare / light shafts
 *      (src/render/sky/godRays.ts)
 *
 *  PUBLIC CONTRACT for the lighting rig — read these, don't recompute them:
 *    sky.sunDirection            unit vector toward the sun
 *    sky.skyAmbientColor(out?)   sky ambient / IBL tint for this instant
 *    sky.sunLightColor(out?)     directional light colour
 *    sky.sunIntensityScale()     multiplier on HeroSun.intensity
 *    sky.horizonColor(out?)      horizon band colour toward the sun
 *    sky.nightFactor             0 day .. 1 night
 *
 *  Because src/core/services.ts is frozen there is no ServiceKey for the sky.
 *  Instead a marker Object3D named `__sunDir__` is parked in the scene with
 *  `userData.sky` pointing at this system (the lighting rig already looks that
 *  name up), and the same object is mirrored on `window.__GTA_SKY__`.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Atmosphere, HeroSun } from '../artDirection';
import { Services } from '../core/services';
import { SKY_FRAG, SKY_VERT } from './sky/skyShader';
import {
  HERO_HOUR,
  cloneWeather,
  desaturateKey,
  keyForElevation,
  lerpWeather,
  newKey,
  sunAnglesForTime,
  weatherLook,
  type SkyKey,
  type SunAngles,
  type WeatherLook,
} from './sky/skyState';
import {
  AerialUniforms,
  adoptCustomFogMaterials,
  aerialForElevation,
  installAerialPerspective,
  updateAerialCamera,
} from './sky/aerialPerspective';
import { GodRays } from './sky/godRays';

/** Hours the sky takes to cross-fade when the weather preset changes. */
const WEATHER_BLEND = 3.5;
/** Hour the "night" preset pins the sun to when the clock says daytime. */
const FORCED_NIGHT_HOUR = 23.2;

export class SkySystem implements System {
  readonly name = 'sky';
  readonly order = 10;

  mesh!: THREE.Mesh;
  material!: THREE.ShaderMaterial;

  /** Unit vector pointing at the sun; other systems read this. */
  readonly sunDirection = new THREE.Vector3();
  /** Unit vector pointing at the moon. */
  readonly moonDirection = new THREE.Vector3();
  /** Solar elevation in degrees, negative below the horizon. */
  sunElevationDeg: number = HeroSun.elevationDeg;
  /** Solar azimuth in degrees, 0 = +Z. */
  sunAzimuthDeg: number = HeroSun.azimuthDeg;
  /** 0 = full day, 1 = full night. Drives street lamps, headlights, HUD. */
  nightFactor = 0;

  private ctx!: GameContext;
  private marker!: THREE.Object3D;
  private godRays = new GodRays();

  private key: SkyKey = newKey();
  private angles: SunAngles = { elevationDeg: HeroSun.elevationDeg, azimuthDeg: HeroSun.azimuthDeg };
  private nightAngles: SunAngles = { elevationDeg: 0, azimuthDeg: 0 };

  private look: WeatherLook = cloneWeather(weatherLook('clearSunset'));
  private lookFrom: WeatherLook = cloneWeather(weatherLook('clearSunset'));
  private lookTo: WeatherLook = cloneWeather(weatherLook('clearSunset'));
  private lastPreset = 'clearSunset';
  private blend = 1;
  private nightPull = 0;

  private time = 0;
  private flash = 0;
  private nextStrike = 4;
  private strikeSeed = 0;
  private adoptTimer = 0;

  private _c = new THREE.Color();
  private _fogNear = new THREE.Color();

  init(ctx: GameContext): void {
    this.ctx = ctx;

    // Must happen before any material compiles a program. SkySystem is the
    // first world system, so this is the earliest safe point.
    installAerialPerspective();

    this.applySolar(HeroSun.elevationDeg, HeroSun.azimuthDeg);
    keyForElevation(this.key, HeroSun.elevationDeg);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
      defines: { SK_QUALITY: 2, SK_LIGHT_TAPS: 3 },
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uMoonDir: { value: this.moonDirection },
        uSunAz: { value: new THREE.Vector2(0, 1) },

        cHorizon: { value: this.key.horizon },
        cLow: { value: this.key.low },
        cMid: { value: this.key.mid },
        cHigh: { value: this.key.high },
        cZenith: { value: this.key.zenith },
        cAway: { value: this.key.away },
        cToward: { value: this.key.toward },
        cSunCore: { value: this.key.sunCore },
        cSunHalo: { value: this.key.sunHalo },
        cCloudLit: { value: this.key.cloudLit },
        cCloudMid: { value: this.key.cloudMid },
        cCloudCore: { value: this.key.cloudCore },
        cGroundHaze: { value: this.key.groundHaze },
        cMoon: { value: this.key.moon },

        uTime: { value: 0 },
        uCover: { value: new THREE.Vector3(0.56, 0.44, 0.34) },
        uP: { value: new THREE.Vector4(1, 1, 0, 1) },
        uP2: { value: new THREE.Vector4(1, 0.62, 0, 0) },
        uLightStep: { value: new THREE.Vector2(0.9, 0.7) },
        uSunRadius: { value: 0.0082 },
        uFlash: { value: 0 },
        uWind: { value: 0.06 },
      },
    });

    // Radius is irrelevant (the shader pins depth to the far plane); it only
    // has to comfortably enclose the near plane.
    // Low tessellation on purpose: everything is computed per-fragment, the
    // geometry only has to enclose the near plane. 32x20 = 1,280 triangles.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 20), this.material);
    this.mesh.frustumCulled = false;
    // Drawn last in the opaque pass so early-Z throws away every sky pixel the
    // city already covers. On a street framing that is ~70% of the screen.
    this.mesh.renderOrder = 2000;
    this.mesh.name = '__skyDome__';
    this.mesh.matrixAutoUpdate = true;
    ctx.scene.add(this.mesh);

    ctx.scene.add(this.godRays.mesh);

    // Fog object exists purely so three defines USE_FOG / FOG_EXP2; the actual
    // model is the aerial-perspective chunk override.
    const fog = new THREE.FogExp2(0x2a1c3a, Atmosphere.fogDensity);
    ctx.scene.fog = fog;

    this.marker = new THREE.Object3D();
    this.marker.name = '__sunDir__';
    this.marker.userData.sky = this;
    this.marker.visible = false;
    ctx.scene.add(this.marker);

    (window as unknown as { __GTA_SKY__: SkySystem }).__GTA_SKY__ = this;

    this.refreshUniforms(0);
  }

  /* ---------------------------------------------------------------- */
  /* Public contract                                                   */
  /* ---------------------------------------------------------------- */

  /** Sky ambient / IBL tint for this instant. This is the fill light that
   *  makes shadows read violet instead of black. */
  skyAmbientColor(target?: THREE.Color): THREE.Color {
    const out = target ?? new THREE.Color();
    return out.copy(this.key.ambient).multiplyScalar(this.look.skyMul);
  }

  /** Directional (sun/moon) light colour for this instant. */
  sunLightColor(target?: THREE.Color): THREE.Color {
    const out = target ?? new THREE.Color();
    return out.copy(this.key.sunLight);
  }

  /** Multiplier the lighting rig should apply to HeroSun.intensity. */
  sunIntensityScale(): number {
    return this.key.sunPower * THREE.MathUtils.lerp(1, 0.35, 1 - this.look.skyMul);
  }

  /** Horizon band colour toward the sun — good for rim/backlight tinting.
   *
   *  NORMALISED, not radiometric. The horizon band is now authored well above
   *  1.0 in linear because it is the hottest thing in the dome and the fog
   *  converges onto it; handing that raw magnitude to a rim-light multiplier
   *  would multiply someone else's term by ~2 without warning. Consumers of
   *  this contract want a HUE. */
  horizonColor(target?: THREE.Color): THREE.Color {
    const out = target ?? new THREE.Color().copy(this.key.horizon);
    out.copy(this.key.horizon);
    const peak = Math.max(out.r, out.g, out.b, 1e-4);
    return out.multiplyScalar((0.55 / peak) * this.look.skyMul);
  }

  /** Kept from the original contract: force an explicit sun angle. */
  updateSunDirection(elevationDeg: number, azimuthDeg: number): void {
    this.applySolar(elevationDeg, azimuthDeg);
  }

  /** Fire a lightning pop (weather system may drive this too). */
  triggerLightning(strength = 1): void {
    this.flash = Math.max(this.flash, strength);
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    this.time += dt;

    const weather = ctx.tryGet(Services.Weather);
    const preset = weather?.preset ?? 'clearSunset';

    if (preset !== this.lastPreset) {
      // Start a new cross-fade from wherever the blend currently sits.
      this.lookFrom = cloneWeather(this.look);
      this.lookTo = cloneWeather(weatherLook(preset));
      this.blend = 0;
      this.lastPreset = preset;
    }
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / WEATHER_BLEND);
      lerpWeather(this.look, this.lookFrom, this.lookTo, THREE.MathUtils.smoothstep(this.blend, 0, 1));
    }

    // "night" preset overrides the clock without mutating the weather service.
    const wantNight = this.lookTo.forceNight ? 1 : 0;
    this.nightPull += (wantNight - this.nightPull) * Math.min(1, dt / WEATHER_BLEND);

    const hours = weather?.timeOfDay ?? HERO_HOUR;
    sunAnglesForTime(hours, this.angles);
    if (this.nightPull > 0.001) {
      sunAnglesForTime(FORCED_NIGHT_HOUR, this.nightAngles);
      // Only pull if the clock isn't already dark; a 2am clock needs no help.
      const need = THREE.MathUtils.smoothstep(this.angles.elevationDeg, -14, -4);
      const t = this.nightPull * need;
      this.angles.elevationDeg = THREE.MathUtils.lerp(this.angles.elevationDeg, this.nightAngles.elevationDeg, t);
      this.angles.azimuthDeg = THREE.MathUtils.lerp(this.angles.azimuthDeg, this.nightAngles.azimuthDeg, t);
    }

    this.applySolar(this.angles.elevationDeg, this.angles.azimuthDeg);
    keyForElevation(this.key, this.angles.elevationDeg);
    desaturateKey(this.key, this.look.desaturate);

    this.nightFactor = 1 - THREE.MathUtils.smoothstep(this.angles.elevationDeg, -12, -1.5);

    // Lightning: deterministic, seeded off elapsed time so screenshots repeat.
    if (this.look.lightning > 0.001) {
      this.nextStrike -= dt * this.look.lightning * 3;
      if (this.nextStrike <= 0) {
        this.strikeSeed = (this.strikeSeed * 1103515245 + 12345) & 0x7fffffff;
        this.nextStrike = 1.2 + (this.strikeSeed % 1000) / 1000 * 5.5;
        this.flash = 0.55 + ((this.strikeSeed >> 10) % 1000) / 1000 * 0.9;
      }
    }
    this.flash = Math.max(0, this.flash - dt * 4.2);

    this.refreshUniforms(dt);

    // Keep the dome centred on the camera so directions stay exact.
    this.mesh.position.copy(ctx.camera.position);

    this.adoptTimer -= dt;
    if (this.adoptTimer <= 0) {
      this.adoptTimer = 2;
      adoptCustomFogMaterials(ctx.scene);
    }
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    this.mesh.position.copy(ctx.camera.position);
    updateAerialCamera(ctx.camera);

    const q = ctx.tryGet(Services.Render)?.quality ?? 'high';
    this.applyQuality(q);
    const shaftQuality = q === 'low' ? 0 : q === 'medium' ? 0.6 : 1;

    // Veiling glare scales with how low and how strong the sun is.
    const lowSun = 1 - THREE.MathUtils.smoothstep(this.angles.elevationDeg, 2, 26);
    const above = THREE.MathUtils.smoothstep(this.angles.elevationDeg, -4.5, 1.5);
    // Deliberately small: this is veiling glare in the air, not a lens flare.
    // GodRays additionally clamps it, and its quad is depth-tested at the far
    // plane so it can only brighten open sky.
    const strength = 0.11 * this.look.shafts * shaftQuality * (0.35 + 0.65 * lowSun) * above;
    // Reddened by the same airmass as the disc, so the veiling glare in the air
    // is the same colour as the sun that is causing it.
    this.godRays.setColor(
      this._c.copy(this.key.sunHalo).multiply(this.airmassExtinction(this._ext)).multiplyScalar(0.6),
    );
    this.godRays.update(dt, ctx.camera, this.sunDirection, strength);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private lastQuality = '';

  /** Drop the cirrus deck and a shadow tap on the cheaper tiers. The sky is
   *  fill-rate bound, not vertex bound, so this is the only lever that matters. */
  private applyQuality(q: string): void {
    if (q === this.lastQuality) return;
    this.lastQuality = q;
    const level = q === 'low' ? 0 : q === 'medium' ? 1 : 2;
    const taps = q === 'low' ? 2 : q === 'medium' ? 2 : 3;
    const d = this.material.defines as Record<string, number>;
    if (d.SK_QUALITY === level && d.SK_LIGHT_TAPS === taps) return;
    d.SK_QUALITY = level;
    d.SK_LIGHT_TAPS = taps;
    this.material.needsUpdate = true;
  }

  private applySolar(elevationDeg: number, azimuthDeg: number): void {
    this.sunElevationDeg = elevationDeg;
    this.sunAzimuthDeg = azimuthDeg;
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDirection
      .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
      .normalize();

    // The moon rides the opposite arc, so it is up exactly when the sun is not.
    const mel = THREE.MathUtils.degToRad(-elevationDeg * 0.86 + 9);
    const maz = THREE.MathUtils.degToRad(azimuthDeg + 168);
    this.moonDirection
      .set(Math.cos(mel) * Math.sin(maz), Math.sin(mel), Math.cos(mel) * Math.cos(maz))
      .normalize();
  }

  private refreshUniforms(dt: number): void {
    void dt;
    const u = this.material.uniforms;
    const k = this.key;

    u.cHorizon.value = k.horizon;
    u.cLow.value = k.low;
    u.cMid.value = k.mid;
    u.cHigh.value = k.high;
    u.cZenith.value = k.zenith;
    u.cAway.value = k.away;
    u.cToward.value = k.toward;
    u.cSunCore.value = k.sunCore;
    u.cSunHalo.value = k.sunHalo;
    u.cCloudLit.value = k.cloudLit;
    u.cCloudMid.value = k.cloudMid;
    u.cCloudCore.value = k.cloudCore;
    u.cGroundHaze.value = k.groundHaze;
    u.cMoon.value = k.moon;

    (u.uSunAz.value as THREE.Vector2).set(this.sunDirection.x, this.sunDirection.z).normalize();
    (u.uCover.value as THREE.Vector3).set(this.look.cover[0], this.look.cover[1], this.look.cover[2]);

    const haze = k.haze * this.look.hazeMul;
    (u.uP.value as THREE.Vector4).set(this.look.skyMul, k.sunIntensity, this.nightFactor, haze);
    (u.uP2.value as THREE.Vector4).set(
      this.look.cloudDark,
      this.look.shafts,
      k.stars * (1 - this.look.desaturate * 0.85),
      k.moonAmount * (1 - this.look.desaturate * 0.7),
    );

    // A low sun cuts a long chord through each deck: march further.
    const lowness = 1 - THREE.MathUtils.smoothstep(this.sunDirection.y, 0.02, 0.55);
    (u.uLightStep.value as THREE.Vector2).set(
      THREE.MathUtils.lerp(0.75, 2.55, lowness),
      THREE.MathUtils.lerp(0.58, 1.90, lowness),
    );

    u.uTime.value = this.time;
    u.uWind.value = 0.055 * this.look.wind;
    u.uFlash.value = this.flash * this.flash * 2.4;

    this.refreshAerial();
  }

  /** Feed the shared fog uniforms so the city dissolves into this exact sky.
   *
   *  MIRROR, DO NOT RE-AUTHOR. Every band below is the SAME Color object the
   *  dome's own uniform is pointing at, copied component-wise into the shared
   *  plain-object payload. The fog shader then runs the identical
   *  `skBandRadiance` on the identical values, so fogged geometry and open sky
   *  are the same function of the same argument and converge at the horizon by
   *  construction.
   *
   *  There used to be a separate hand-authored table of in-scatter triples
   *  here. It cannot work: two independent answers to "what colour is the sky
   *  in direction d" always disagree somewhere, and they disagree most visibly
   *  exactly where the two meet — which is what put a razor-straight full-width
   *  hue step along the horizon line. */
  private refreshAerial(): void {
    const a = aerialForElevation(this.angles.elevationDeg);
    const k = this.key;

    const put = (t: { x: number; y: number; z: number }, c: THREE.Color): void => {
      t.x = c.r;
      t.y = c.g;
      t.z = c.b;
    };
    put(AerialUniforms.bHorizon, k.horizon);
    put(AerialUniforms.bLow, k.low);
    put(AerialUniforms.bMid, k.mid);
    put(AerialUniforms.bHigh, k.high);
    put(AerialUniforms.bZenith, k.zenith);
    put(AerialUniforms.bAway, k.away);
    put(AerialUniforms.bToward, k.toward);
    put(AerialUniforms.bGround, k.groundHaze);

    // The halo the shared function uses for its solar veil has to be reddened
    // by the same airmass the dome shader applies, or the far end of a
    // boulevard glows a different colour from the sky directly above it.
    this._c.copy(k.sunHalo).multiply(this.airmassExtinction(this._ext));
    put(AerialUniforms.bHalo, this._c);

    AerialUniforms.sunDir.x = this.sunDirection.x;
    AerialUniforms.sunDir.y = this.sunDirection.y;
    AerialUniforms.sunDir.z = this.sunDirection.z;
    const azLen = Math.hypot(this.sunDirection.x, this.sunDirection.z) || 1;
    AerialUniforms.sunAz.x = this.sunDirection.x / azLen;
    AerialUniforms.sunAz.y = this.sunDirection.z / azLen;

    AerialUniforms.params.x = a.density * this.look.fogMul;
    // Steeper height falloff: the haze is a street-level phenomenon, so
    // rooftops and towers keep their own albedo instead of dissolving.
    AerialUniforms.params.y = 0.0115;
    AerialUniforms.params.z = 0.70;
    // The Mie lobe peaks near 1.75 at cos = 1, so this weight is effectively
    // doubling the in-scatter down-sun. Kept small.
    AerialUniforms.params.w = 0.10 * this.look.shafts + 0.03;
    // Near-field guard: nothing inside 70 m is veiled, and the veil eases in
    // to full physical strength by 260 m. See FOG_FRAGMENT in
    // sky/aerialPerspective.ts — this is what keeps the foreground's contrast
    // while still letting the far boulevard dissolve.
    AerialUniforms.params2.x = 70;
    AerialUniforms.params3.w = 260;
    /* Max opacity has to be essentially 1. This is what actually closes the
     * seam: at 0.94 a surface at infinite distance still showed 6% of its own
     * albedo against 0% for the sky one pixel above it, which is a visible
     * step all by itself even once the colours agree. */
    AerialUniforms.params2.y = 0.998;
    AerialUniforms.params2.z = k.haze * this.look.hazeMul;
    AerialUniforms.params2.w = this.look.skyMul;

    // Keep the legacy fog colour roughly right for anything that falls back.
    const fog = this.ctx.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      this._fogNear.copy(k.low).lerp(k.mid, 0.5).multiplyScalar(this.look.skyMul);
      fog.color.copy(this._fogNear);
      fog.density = 0.0009 * this.look.fogMul;
    }
  }

  private _ext = new THREE.Color();

  /** CPU mirror of `skAirmassExtinction` in sky/skyBands.ts. Keep the two in
   *  step — the dome and the fog must redden by the same amount. */
  private airmassExtinction(out: THREE.Color): THREE.Color {
    const airmass = 1 / Math.max(this.sunDirection.y, 0.025);
    const t = (airmass - 1) * 0.075;
    return out.setRGB(
      Math.exp(-0.55 * t),
      Math.exp(-1.80 * t),
      Math.exp(-3.60 * t),
    );
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.godRays.dispose();
  }
}
