/** Sun + sky fill + a shadow camera that follows the player.
 *  OWNER: lighting agent. Must deliver long raking sunset shadows, violet
 *  ambient fill, and stable shadows across the whole draw distance. */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { HeroSun, Palette } from '../artDirection';
import { QUALITY } from './renderer';
import { Services } from '../core/services';

export class LightingSystem implements System {
  readonly name = 'lighting';
  readonly order = 12;

  sun!: THREE.DirectionalLight;
  hemi!: THREE.HemisphereLight;
  private target = new THREE.Object3D();
  private ctx!: GameContext;
  /** Distance the shadow frustum covers. */
  private shadowRange = 300;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const q = QUALITY[ctx.tryGet(Services.Render)?.quality ?? 'high'];
    this.shadowRange = q.shadowDistance;

    this.sun = new THREE.DirectionalLight(Palette.sunLight.getHex(), HeroSun.intensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.045;
    this.sun.shadow.radius = 2.4;

    const half = this.shadowRange * 0.5;
    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = this.shadowRange * 3.2;
    cam.updateProjectionMatrix();

    ctx.scene.add(this.target);
    this.sun.target = this.target;
    ctx.scene.add(this.sun);

    // Sky/ground fill. This is what makes shadows read violet instead of black.
    this.hemi = new THREE.HemisphereLight(
      Palette.skyAmbient.getHex(),
      Palette.groundBounce.getHex(),
      HeroSun.ambientIntensity,
    );
    ctx.scene.add(this.hemi);
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    // Keep the shadow frustum snapped around the camera focus, quantised to
    // texel size so shadows don't shimmer while driving.
    const sky = ctx.scene.getObjectByName('__sunDir__');
    void sky;
    const focus = ctx.camera.position;
    const texelSize = this.shadowRange / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texelSize) * texelSize;
    const fz = Math.round(focus.z / texelSize) * texelSize;

    this.target.position.set(fx, 0, fz);
    const dir = this.sunDir();
    this.sun.position.set(
      fx + dir.x * this.shadowRange * 1.6,
      dir.y * this.shadowRange * 1.6 + 40,
      fz + dir.z * this.shadowRange * 1.6,
    );
  }

  private _dir = new THREE.Vector3();
  private sunDir(): THREE.Vector3 {
    const el = THREE.MathUtils.degToRad(HeroSun.elevationDeg);
    const az = THREE.MathUtils.degToRad(HeroSun.azimuthDeg);
    return this._dir
      .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
      .normalize();
  }

  dispose(): void {
    this.sun?.dispose();
    this.hemi?.dispose();
  }
}
