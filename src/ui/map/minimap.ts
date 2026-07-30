/**
 * THE MINIMAP — the corner widget that is on screen the whole time you are
 * playing.
 *
 * OWNER: map agent.
 *
 * It sits above the HUD's money/XP/health block at the same left margin, so
 * the bottom-left corner reads as one instrument stack rather than two
 * unrelated overlays. It is mounted into `#ui-root` the way `PauseMenu` does —
 * `src/ui/hud.ts` is not ours to edit.
 *
 * DESIGN NOTES
 * ------------
 *  - The player sits at 62% down the frame, not in the middle: you need to see
 *    where you are going, not where you have been.
 *  - It rotates with the *camera*, not the body, because that is what the
 *    player's eyes are already aligned to. `N` (or the button on the full map)
 *    locks it north-up for people who navigate that way.
 *  - The window opens up with speed — 78 m at a walk, 205 m at 135 km/h —
 *    smoothed, so you keep roughly the same number of seconds of road ahead of
 *    you at any velocity.
 *  - Zero draw calls, zero triangles: it is a 2D canvas over the frame.
 */

import { MapPainter, type PaintOpts } from './mapRender';
import { DISTRICT_NAMES, type MapData } from './mapData';
import { MapInk } from './mapStyle';
import { compassLetter, damp, dampAngle, fmtDistance, makeView, rangeForSpeed, type MapView } from './mapMath';
import type { MapWorld } from './mapWorld';
import type { Router } from './route';
import type { CityService } from '../../core/services';

const W = 214;
const H = 182;
const CUT = 16;

export class Minimap {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private capLeft: HTMLElement;
  private capRight: HTMLElement;
  private view: MapView = makeView(W, H);
  private clip: Path2D;
  private dpr = 1;
  private range = 90;
  private rot = 0;
  private time = 0;
  private lastDistrict = '';
  private lastRight = '';
  private visible = true;

  constructor(private painter: MapPainter) {
    this.root = document.createElement('div');
    this.root.className = 'gta-mm';
    this.root.innerHTML =
      '<div class="gta-mm-shell"><canvas></canvas></div>' +
      `<div class="gta-mm-tri"><i style="background:${MapInk.tri[0]}"></i>` +
      `<i style="background:${MapInk.tri[1]}"></i><i style="background:${MapInk.tri[2]}"></i></div>` +
      '<div class="gta-mm-cap"><b></b><i></i></div>';

    this.canvas = this.root.querySelector('canvas')!;
    this.capLeft = this.root.querySelector('.gta-mm-cap b')!;
    this.capRight = this.root.querySelector('.gta-mm-cap i')!;
    this.g = this.canvas.getContext('2d', { alpha: true });
    this.clip = this.painter.framePath(W, H, CUT);
    this.resize();
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.root.classList.toggle('is-off', !v);
  }

  /**
   * WHY THE `sized` FLAG AND NOT `canvas.width`.
   *
   * A fresh `<canvas>` reports width 300, height 150 — not 0. Guarding on
   * `if (dpr === this.dpr && this.canvas.width) return` therefore short-
   * circuited on the very first call, the backing store stayed 300×150, and
   * the CSS `height:auto` squashed a 182 px map into 107 px. Everything drawn
   * was vertically compressed and nobody could tell from the code why.
   *
   * The backing store is also at least 2× the CSS size on purpose: at 214 px
   * wide, hairline streets and 9 px captions need the supersampling to stay
   * crisp, and it costs a fraction of a millisecond.
   */
  private sized = false;

  private resize(): void {
    const dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    if (this.sized && dpr === this.dpr) return;
    this.sized = true;
    this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
  }

  update(
    dt: number,
    data: MapData,
    world: MapWorld,
    router: Router,
    city: CityService | undefined,
    northUp: boolean,
  ): void {
    if (!this.visible) return;
    const g = this.g;
    if (!g) return;
    this.resize();
    this.time += dt;

    this.range = damp(this.range, rangeForSpeed(world.speedKmh), 3.2, dt);
    const targetRot = northUp ? 0 : world.cameraHeading;
    // Snapping to exactly 0 in north-up mode avoids a permanent sub-degree
    // wobble that made straight streets shimmer.
    this.rot = northUp && Math.abs(this.rot) < 0.002 ? 0 : dampAngle(this.rot, targetRot, 11, dt);

    const v = this.view;
    v.w = W;
    v.h = H;
    v.cx = world.x;
    v.cz = world.z;
    v.ox = W / 2;
    v.oy = H * 0.62;
    v.rot = this.rot;
    v.scale = v.oy / this.range;

    const opts: PaintOpts = {
      dpr: this.dpr,
      compact: true,
      time: this.time,
      labels: false,
      traffic: true,
    };

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.save();
    g.clip(this.clip);
    this.painter.paint(g, v, data, world, router, opts);
    this.painter.overlay(g, v, world, opts, this.canvas);
    this.painter.compass(g, v, opts);
    g.restore();
    this.painter.frame(g, this.clip, opts, world.stars > 0 ? Math.min(1, world.stars / 3) : 0);

    this.caption(world, router, city);
  }

  /** District on the left, distance-to-waypoint (or heading) on the right. */
  private caption(world: MapWorld, router: Router, city: CityService | undefined): void {
    let district = '';
    try {
      const k = city?.districtAt(world.x, world.z);
      district = k ? DISTRICT_NAMES[k] : '';
    } catch {
      district = '';
    }
    if (district !== this.lastDistrict) {
      this.capLeft.textContent = district;
      this.lastDistrict = district;
    }

    const right = world.hasWaypoint
      ? fmtDistance(router.points.length > 1 && !router.direct ? router.remaining : world.distanceToWaypoint())
      : compassLetter(world.cameraHeading);
    if (right !== this.lastRight) {
      this.capRight.textContent = right;
      this.lastRight = right;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
