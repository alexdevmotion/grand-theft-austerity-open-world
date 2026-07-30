/**
 * MAP PAINTER — one canvas-2D renderer, used by both the minimap and the
 * full-screen map.
 *
 * OWNER: map agent.
 *
 * There is deliberately no GL here. The whole map is a few hundred line
 * segments and a couple of dozen blips; a 2D context draws that in well under
 * a millisecond and costs the renderer zero draw calls, which matters because
 * the 3D frame is the budget we are guests in.
 *
 * WHAT MAKES IT CHEAP
 * -------------------
 *  - Streets are batched into three `Path2D`s by class (minor / boulevard /
 *    monumental axis) and stroked twice each — casing then carriageway. Six
 *    stroke calls for the entire street network in view, instead of one per
 *    segment. This is the single reason the minimap is free.
 *  - The district wash is one `drawImage` of a 160×160 raster built at init.
 *  - Scanlines and the vignette are cached patterns/gradients, rebuilt only
 *    when the canvas is resized.
 *  - Nothing allocates per frame: scratch points are module-level.
 *
 * WHAT MAKES IT LEGIBLE
 * ---------------------
 * Everything the eye needs at a glance is on top and high contrast: the route,
 * the waypoint, the player. Everything that is context — wash, streets,
 * traffic — is pushed down in value so the important marks read instantly at
 * 214 px wide while you are driving.
 */

import { ACTIVITY_GLYPH, ACTIVITY_INK, MapInk } from './mapStyle';
import { chamferRing, clamp, clampToRect, fmtDistance, project, type MapView, type Pt } from './mapMath';
import type { MapData } from './mapData';
import type { MapWorld } from './mapWorld';
import type { Router } from './route';

export interface PaintOpts {
  /** Device pixel ratio the backing store was sized with. */
  dpr: number;
  /** Small corner widget vs the full-screen sheet — changes weights and labels. */
  compact: boolean;
  /** Seconds, for pulses and dash animation. */
  time: number;
  /** Draw district captions and landmark names. */
  labels: boolean;
  /** Draw ambient traffic dots. */
  traffic: boolean;
}

const _p: Pt = { x: 0, y: 0 };
const _q: Pt = { x: 0, y: 0 };
const _clamped: Pt = { x: 0, y: 0 };
const _segIdx: number[] = [];

export class MapPainter {
  private minor = new Path2D();
  private major = new Path2D();
  private axis = new Path2D();

  /**
   * Occupied label rectangles for this frame, flat [x0,y0,x1,y1,...].
   *
   * The OSM import gives the city 140-odd named POIs on top of the authored
   * anchors and the district captions. Drawn naively they pile into an
   * unreadable stack over the centre — the first full-map screenshot had four
   * captions on the same twenty pixels. Anything that wants a caption claims a
   * box first and is silently dropped if the box is taken, in priority order:
   * districts, then story/plaza anchors, then POIs.
   */
  private taken: number[] = [];

  private scanline: CanvasPattern | null = null;
  private scanKey = '';
  private vignette: CanvasGradient | null = null;
  private vignetteKey = '';

  /* ---------------------------------------------------------------- */
  /* transforms                                                        */
  /* ---------------------------------------------------------------- */

  /** Canvas transform that maps world metres straight to device pixels. */
  private worldTransform(g: CanvasRenderingContext2D, v: MapView, dpr: number): void {
    const c = Math.cos(v.rot) * v.scale * dpr;
    const s = Math.sin(v.rot) * v.scale * dpr;
    g.setTransform(c, -s, s, c, v.ox * dpr, v.oy * dpr);
  }

  private pixelTransform(g: CanvasRenderingContext2D, dpr: number): void {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------------------------------------------------------------- */
  /* entry point                                                       */
  /* ---------------------------------------------------------------- */

  paint(
    g: CanvasRenderingContext2D,
    v: MapView,
    data: MapData,
    world: MapWorld,
    router: Router,
    o: PaintOpts,
  ): void {
    this.pixelTransform(g, o.dpr);
    g.clearRect(0, 0, v.w, v.h);
    this.taken.length = 0;

    g.fillStyle = MapInk.paper;
    g.fillRect(0, 0, v.w, v.h);

    this.drawWash(g, v, data, o);
    this.drawLandmarkGrounds(g, v, data, o);
    this.drawRoads(g, v, data, o);
    if (!o.compact) this.drawDistrictLabels(g, v, data, o);
    this.drawSearch(g, v, world, o);
    this.drawRoute(g, v, world, router, o);
    if (o.traffic) this.drawTraffic(g, v, world, o);
    this.drawLandmarkBlips(g, v, data, o);
    this.drawActivities(g, v, world, o);
    this.drawPolice(g, v, world, o);
    this.drawWaypoint(g, v, world, router, o);
    this.drawPlayer(g, v, world, o);
    if (!o.compact) this.drawScaleBar(g, v, o);
  }

  /**
   * A real scale bar, snapped to a 1/2/5 step. Without one, a pannable map
   * gives you no sense of how far anything actually is, and "is that two
   * minutes or ten" is the question a city map exists to answer.
   */
  private drawScaleBar(g: CanvasRenderingContext2D, v: MapView, o: PaintOpts): void {
    const want = 190 / v.scale; // metres that would fill ~190 px
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, want))));
    const step = [1, 2, 5, 10].find((m) => m * pow >= want * 0.55)! * pow;
    const px = step * v.scale;
    const x = v.w / 2 - px / 2;
    const y = v.h - 26;

    g.lineWidth = 2;
    g.strokeStyle = 'rgba(6,3,12,.85)';
    g.beginPath();
    g.moveTo(x, y - 5);
    g.lineTo(x, y);
    g.lineTo(x + px, y);
    g.lineTo(x + px, y - 5);
    g.stroke();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(226,201,255,.8)';
    g.stroke();

    g.font = '700 10px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    label(g, fmtDistance(step), x + px / 2, y - 19, 'rgba(226,201,255,.9)');
  }

  /* ---------------------------------------------------------------- */
  /* layers                                                            */
  /* ---------------------------------------------------------------- */

  private drawWash(g: CanvasRenderingContext2D, v: MapView, data: MapData, o: PaintOpts): void {
    if (!data.wash) return;
    g.save();
    this.worldTransform(g, v, o.dpr);
    g.globalAlpha = MapInk.washAlpha;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(
      data.wash,
      data.minX - v.cx,
      data.minZ - v.cz,
      data.worldWidth,
      data.worldHeight,
    );
    g.restore();
    this.pixelTransform(g, o.dpr);
  }

  /** Parks and plaza decks, as soft discs under the streets. */
  private drawLandmarkGrounds(g: CanvasRenderingContext2D, v: MapView, data: MapData, o: PaintOpts): void {
    for (const lm of data.landmarks) {
      if (lm.kind === 'story' || lm.kind === 'poi') continue;
      project(v, lm.x, lm.z, _p);
      const r = lm.radius * v.scale;
      if (r < 1.5) continue;
      if (_p.x + r < 0 || _p.x - r > v.w || _p.y + r < 0 || _p.y - r > v.h) continue;
      g.beginPath();
      g.arc(_p.x, _p.y, r, 0, Math.PI * 2);
      g.fillStyle = lm.kind === 'park' ? MapInk.park : MapInk.plaza;
      g.fill();
    }
  }

  private drawRoads(g: CanvasRenderingContext2D, v: MapView, data: MapData, o: PaintOpts): void {
    const b = viewBoundsOf(v);
    data.query(b.x0, b.z0, b.x1, b.z1, _segIdx);
    if (!_segIdx.length) return;

    this.minor = new Path2D();
    this.major = new Path2D();
    this.axis = new Path2D();

    for (let i = 0; i < _segIdx.length; i++) {
      const s = data.segs[_segIdx[i]];
      project(v, s.ax, s.az, _p);
      project(v, s.bx, s.bz, _q);
      const path = s.lanes >= 3 ? this.axis : s.major ? this.major : this.minor;
      path.moveTo(_p.x, _p.y);
      path.lineTo(_q.x, _q.y);
    }

    // Streets are drawn at a *stylised* weight, not at their true 16 m width.
    // Drawn to scale, a boulevard is 22 px on a 214 px minimap and the widget
    // becomes a solid pale slab — the first version of this file did exactly
    // that. The width still grows with zoom, but between tight bounds, which
    // is what keeps the hierarchy (lane / boulevard / monumental axis)
    // readable at every scale.
    const wMinor = clamp(6.5 * v.scale, o.compact ? 1.5 : 1.1, o.compact ? 2.8 : 4.5);
    const wMajor = clamp(11 * v.scale, o.compact ? 2.2 : 1.7, o.compact ? 4.4 : 7);
    const wAxis = clamp(15 * v.scale, o.compact ? 3.0 : 2.2, o.compact ? 5.8 : 9);

    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Casing first: one dark under-stroke gives the network depth and stops
    // pale streets from dissolving into a pale district wash.
    g.strokeStyle = MapInk.casing;
    g.globalAlpha = 0.9;
    g.lineWidth = wMinor + 1.8;
    g.stroke(this.minor);
    g.lineWidth = wMajor + 2.2;
    g.stroke(this.major);
    g.lineWidth = wAxis + 2.6;
    g.stroke(this.axis);

    g.globalAlpha = 1;
    g.strokeStyle = MapInk.minor;
    g.lineWidth = wMinor;
    g.stroke(this.minor);
    g.strokeStyle = MapInk.major;
    g.lineWidth = wMajor;
    g.stroke(this.major);
    g.strokeStyle = MapInk.axis;
    g.lineWidth = wAxis;
    g.stroke(this.axis);
  }

  private drawDistrictLabels(g: CanvasRenderingContext2D, v: MapView, data: MapData, o: PaintOpts): void {
    if (!o.labels || v.scale < 0.055) return;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 10px Inter, system-ui, sans-serif';
    for (const d of data.districtLabels) {
      project(v, d.x, d.z, _p);
      if (_p.x < -80 || _p.x > v.w + 80 || _p.y < -20 || _p.y > v.h + 20) continue;
      const text = spaced(d.name);
      const w = g.measureText(text).width;
      if (!this.claim(_p.x - w / 2, _p.y - 7, _p.x + w / 2, _p.y + 7)) continue;
      g.fillStyle = 'rgba(6,3,12,.75)';
      g.fillText(text, _p.x + 1, _p.y + 1);
      g.fillStyle = 'rgba(226,201,255,.42)';
      g.fillText(text, _p.x, _p.y);
    }
  }

  /** Reserve a label box; false when something more important already has it. */
  private claim(x0: number, y0: number, x1: number, y1: number): boolean {
    const t = this.taken;
    for (let i = 0; i < t.length; i += 4) {
      if (x0 < t[i + 2] && x1 > t[i] && y0 < t[i + 3] && y1 > t[i + 1]) return false;
    }
    t.push(x0, y0, x1, y1);
    return true;
  }

  /**
   * The Ministry's search area. It sits where you were last seen; the ring
   * turns hard red and stops breathing the moment they actually have you.
   */
  private drawSearch(g: CanvasRenderingContext2D, v: MapView, w: MapWorld, o: PaintOpts): void {
    if (w.stars <= 0 || w.searchRadius <= 0) return;
    project(v, w.searchX, w.searchZ, _p);
    const pulse = 1 + Math.sin(o.time * 2.4) * 0.035 * (1 - w.contact);
    const r = w.searchRadius * v.scale * pulse;
    if (r < 2) return;

    g.save();
    g.beginPath();
    g.arc(_p.x, _p.y, r, 0, Math.PI * 2);
    g.fillStyle = MapInk.search;
    g.fill();
    g.setLineDash([6, 5]);
    g.lineDashOffset = -o.time * 14;
    g.lineWidth = w.contact > 0.5 ? 2 : 1.4;
    g.strokeStyle = w.contact > 0.5 ? MapInk.searchEdge : 'rgba(255,61,127,.42)';
    g.stroke();
    g.restore();
  }

  private drawRoute(
    g: CanvasRenderingContext2D,
    v: MapView,
    w: MapWorld,
    router: Router,
    o: PaintOpts,
  ): void {
    const pts = router.points;
    if (pts.length < 2) return;

    const start = Math.min(router.advance, pts.length - 1);
    const path = new Path2D();
    project(v, w.x, w.z, _p);
    path.moveTo(_p.x, _p.y);
    for (let i = start; i < pts.length; i++) {
      project(v, pts[i].x, pts[i].z, _p);
      path.lineTo(_p.x, _p.y);
    }

    const wide = clamp(9 * v.scale, o.compact ? 4.2 : 3.4, 12);
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (router.direct) g.setLineDash([9, 7]);

    // Glow, body, core — three strokes of the same path read as a lit ribbon
    // without a single expensive shadowBlur.
    //
    // The ribbon is ALWAYS magenta, even when the destination mark is the
    // campaign's amber. An amber route was tried and it disappeared: the
    // boulevards and the monumental axis are drawn in warm amber too, so the
    // one line you are supposed to follow was camouflaged against the one
    // thing it runs along. Magenta is the only ink on this sheet that no
    // street uses.
    g.strokeStyle = MapInk.routeGlow;
    g.lineWidth = wide + 6;
    g.stroke(path);
    g.strokeStyle = MapInk.route;
    g.lineWidth = wide;
    g.stroke(path);
    g.strokeStyle = MapInk.routeCore;
    g.lineWidth = Math.max(1, wide * 0.34);
    g.globalAlpha = 0.9;
    g.stroke(path);
    g.restore();
  }

  private drawTraffic(g: CanvasRenderingContext2D, v: MapView, w: MapWorld, o: PaintOpts): void {
    const n = w.traffic.used;
    if (!n) return;
    const r = o.compact ? 1.5 : 2;
    g.fillStyle = MapInk.traffic;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const b = w.traffic.items[i];
      project(v, b.x, b.z, _p);
      if (_p.x < -4 || _p.x > v.w + 4 || _p.y < -4 || _p.y > v.h + 4) continue;
      g.moveTo(_p.x + r, _p.y);
      g.arc(_p.x, _p.y, r, 0, Math.PI * 2);
    }
    g.fill();
  }

  /**
   * Three passes, in importance order, so the crowd never buries the anchors:
   * POI dots, then the authored anchors with their names, then POI names in
   * whatever space is left.
   */
  private drawLandmarkBlips(g: CanvasRenderingContext2D, v: MapView, data: MapData, o: PaintOpts): void {
    g.textAlign = 'center';
    g.textBaseline = 'top';
    // The OSM import contributes ~140 minor POIs. They only earn a mark once
    // the full map is zoomed past a street-level scale, and a name past that.
    const poiDots = !o.compact && v.scale > 0.9;
    const poiNames = !o.compact && v.scale > 1.6 && o.labels;

    if (poiDots) {
      g.fillStyle = 'rgba(226,201,255,.5)';
      g.beginPath();
      for (const lm of data.landmarks) {
        if (lm.kind !== 'poi') continue;
        project(v, lm.x, lm.z, _p);
        if (!this.onSheet(v, 6)) continue;
        g.moveTo(_p.x + 2.2, _p.y);
        g.arc(_p.x, _p.y, 2.2, 0, Math.PI * 2);
      }
      g.fill();
    }

    g.font = '700 9.5px Inter, system-ui, sans-serif';
    for (const lm of data.landmarks) {
      if (lm.kind === 'poi') continue;
      project(v, lm.x, lm.z, _p);
      if (!this.onSheet(v, 30)) continue;
      const story = lm.kind === 'story';
      const r = story ? (o.compact ? 4 : 5.5) : o.compact ? 2.6 : 3.6;

      g.beginPath();
      g.arc(_p.x, _p.y, r + 1.6, 0, Math.PI * 2);
      g.fillStyle = MapInk.shadow;
      g.fill();

      g.beginPath();
      g.arc(_p.x, _p.y, r, 0, Math.PI * 2);
      g.fillStyle = story ? MapInk.story : MapInk.landmark;
      g.fill();
      if (story) {
        g.beginPath();
        g.arc(_p.x, _p.y, r * 0.42, 0, Math.PI * 2);
        g.fillStyle = '#2a0f3a';
        g.fill();
      }

      if (o.labels && !o.compact) this.tryLabel(g, lm.name, _p.x, _p.y + r + 4, MapInk.text);
    }

    if (poiNames) {
      g.font = '600 9px Inter, system-ui, sans-serif';
      for (const lm of data.landmarks) {
        if (lm.kind !== 'poi') continue;
        project(v, lm.x, lm.z, _p);
        if (!this.onSheet(v, 30)) continue;
        this.tryLabel(g, lm.name, _p.x, _p.y + 5, 'rgba(226,201,255,.72)');
      }
    }
  }

  /** Is the last projected point (`_p`) near enough to the canvas to matter? */
  private onSheet(v: MapView, pad: number): boolean {
    return _p.x > -pad && _p.x < v.w + pad && _p.y > -pad && _p.y < v.h + pad;
  }

  /** Centred caption that gives way to anything already occupying the space. */
  private tryLabel(g: CanvasRenderingContext2D, text: string, x: number, y: number, ink: string): void {
    const w = g.measureText(text).width;
    if (w > 300) return;
    if (!this.claim(x - w / 2 - 2, y - 1, x + w / 2 + 2, y + 11)) return;
    label(g, text, x, y, ink);
  }

  private drawActivities(g: CanvasRenderingContext2D, v: MapView, w: MapWorld, o: PaintOpts): void {
    const n = w.activities.used;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const b = w.activities.items[i];
      project(v, b.x, b.z, _p);
      if (_p.x < -20 || _p.x > v.w + 20 || _p.y < -20 || _p.y > v.h + 20) continue;
      const ink = ACTIVITY_INK[b.tag] ?? MapInk.activity;
      const r = o.compact ? 4.6 : 6.4;

      g.beginPath();
      chamferSquare(g, _p.x, _p.y, r + 1.4);
      g.fillStyle = MapInk.shadow;
      g.fill();

      g.beginPath();
      chamferSquare(g, _p.x, _p.y, r);
      g.fillStyle = b.hot ? '#fff' : ink;
      g.fill();

      g.fillStyle = '#160a24';
      g.font = `700 ${(r * 1.25).toFixed(1)}px Inter, system-ui, sans-serif`;
      g.fillText(ACTIVITY_GLYPH[b.tag] ?? '•', _p.x, _p.y + 0.5);
    }
  }

  private drawPolice(g: CanvasRenderingContext2D, v: MapView, w: MapWorld, o: PaintOpts): void {
    const n = w.police.used;
    if (!n) return;
    const flash = (Math.sin(o.time * 9) + 1) * 0.5;
    for (let i = 0; i < n; i++) {
      const b = w.police.items[i];
      project(v, b.x, b.z, _p);
      if (_p.x < -24 || _p.x > v.w + 24 || _p.y < -24 || _p.y > v.h + 24) continue;

      // Vision wedge: which way this unit is looking. Only for cars, and only
      // while they are actually hunting — otherwise it is noise.
      if (w.stars > 0 && Number.isFinite(b.heading)) {
        const a = b.heading - v.rot - Math.PI / 2;
        const reach = clamp(46 * v.scale, 10, 46);
        g.beginPath();
        g.moveTo(_p.x, _p.y);
        g.arc(_p.x, _p.y, reach, a - 0.45, a + 0.45);
        g.closePath();
        g.fillStyle = MapInk.policeCone;
        g.fill();
      }

      const r = b.tag === 'car' ? (o.compact ? 3.6 : 4.6) : o.compact ? 2.4 : 3.2;
      g.beginPath();
      g.arc(_p.x, _p.y, r + 1.5, 0, Math.PI * 2);
      g.fillStyle = MapInk.shadow;
      g.fill();
      g.beginPath();
      g.arc(_p.x, _p.y, r, 0, Math.PI * 2);
      g.fillStyle = w.stars > 0 && b.tag === 'car'
        ? (flash > 0.5 ? MapInk.police : '#ff5a4a')
        : MapInk.police;
      g.fill();
    }
  }

  /**
   * The waypoint. Inside the frame it is a diamond with a pulsing ring; once
   * it leaves the frame it becomes an arrow pinned to the edge with the
   * remaining distance under it, which is the only part that matters at speed.
   */
  private drawWaypoint(
    g: CanvasRenderingContext2D,
    v: MapView,
    w: MapWorld,
    router: Router,
    o: PaintOpts,
  ): void {
    if (!w.hasWaypoint) return;
    const mission = !w.waypointIsCustom;
    const ink = mission ? MapInk.missionMark : MapInk.waypoint;
    const core = mission ? MapInk.missionMarkCore : MapInk.waypointCore;
    project(v, w.waypointX, w.waypointZ, _p);
    const m = o.compact ? 13 : 18;
    const off = clampToRect(_p, m, m, v.w - m, v.h - m, _clamped);

    if (off) {
      const a = Math.atan2(_p.y - _clamped.y, _p.x - _clamped.x);
      g.save();
      g.translate(_clamped.x, _clamped.y);
      g.rotate(a);
      g.beginPath();
      g.moveTo(7, 0);
      g.lineTo(-5, 5.5);
      g.lineTo(-5, -5.5);
      g.closePath();
      g.fillStyle = ink;
      g.strokeStyle = MapInk.shadow;
      g.lineWidth = 1.6;
      g.stroke();
      g.fill();
      g.restore();

      const dist = router.points.length > 1 && !router.direct ? router.remaining : w.distanceToWaypoint();
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '800 9px Inter, system-ui, sans-serif';
      const ty = _clamped.y + (_clamped.y < v.h / 2 ? 13 : -13);
      // Pinned to the edge, the caption would hang off the side of the widget
      // and be clipped in half. Keep it inside by its own half-width.
      const tw = g.measureText(fmtDistance(dist)).width;
      const tx = clamp(_clamped.x, tw / 2 + 4, v.w - tw / 2 - 4);
      label(g, fmtDistance(dist), tx, ty, core, 'middle');
      return;
    }

    const pulse = 1 + Math.sin(o.time * 3.4) * 0.14;
    const r = (o.compact ? 5.4 : 7.2) * pulse;
    g.beginPath();
    g.arc(_p.x, _p.y, r * 2.1, 0, Math.PI * 2);
    g.globalAlpha = 0.42 - 0.2 * pulse;
    g.strokeStyle = ink;
    g.lineWidth = 1.4;
    g.stroke();
    g.globalAlpha = 1;

    g.save();
    g.translate(_p.x, _p.y);
    g.rotate(Math.PI / 4);
    g.fillStyle = ink;
    g.strokeStyle = MapInk.shadow;
    g.lineWidth = 1.8;
    g.strokeRect(-r, -r, r * 2, r * 2);
    g.fillRect(-r, -r, r * 2, r * 2);
    g.fillStyle = core;
    g.fillRect(-r * 0.32, -r * 0.32, r * 0.64, r * 0.64);
    g.restore();
  }

  private drawPlayer(g: CanvasRenderingContext2D, v: MapView, w: MapWorld, o: PaintOpts): void {
    project(v, w.x, w.z, _p);
    const a = w.heading - v.rot;
    const r = o.compact ? 8 : 11;

    g.save();
    g.translate(_p.x, _p.y);

    // Halo + ring, so the arrow survives on top of a pale boulevard and can
    // still be found instantly on a sheet covering two kilometres of city.
    g.beginPath();
    g.arc(0, 0, r * 1.6, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,61,127,.18)';
    g.fill();
    if (!o.compact) {
      g.beginPath();
      g.arc(0, 0, r * 1.75, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,61,127,.65)';
      g.lineWidth = 1.5;
      g.stroke();
    }

    g.rotate(a);
    g.beginPath();
    g.moveTo(0, -r);
    g.lineTo(r * 0.72, r * 0.78);
    g.lineTo(0, r * 0.34);
    g.lineTo(-r * 0.72, r * 0.78);
    g.closePath();
    g.strokeStyle = MapInk.playerEdge;
    g.lineWidth = 2.4;
    g.lineJoin = 'round';
    g.stroke();
    g.fillStyle = w.inVehicle ? MapInk.player : '#ffd9f0';
    g.fill();
    g.restore();
  }

  /* ---------------------------------------------------------------- */
  /* minimap furniture                                                 */
  /* ---------------------------------------------------------------- */

  /** Chamfered clip path in CSS pixels — the shape of the whole widget. */
  framePath(w: number, h: number, cut: number): Path2D {
    const ring = chamferRing(w, h, cut);
    const p = new Path2D();
    p.moveTo(ring[0], ring[1]);
    for (let i = 2; i < ring.length; i += 2) p.lineTo(ring[i], ring[i + 1]);
    p.closePath();
    return p;
  }

  /**
   * Scanlines + vignette + Ministry interference, painted last over the
   * minimap. This is the broadcast identity: the map is a monitor feed, and
   * when the Ministry is looking for you the feed tears.
   */
  overlay(
    g: CanvasRenderingContext2D,
    v: MapView,
    world: MapWorld,
    o: PaintOpts,
    canvas: HTMLCanvasElement,
  ): void {
    this.pixelTransform(g, o.dpr);

    if (world.stars > 0 && Math.random() < 0.055 + world.stars * 0.02) {
      // One-frame cosmetic tear — `Math.random` is explicitly fine for this
      // (see docs/ARCHITECTURE.md, Determinism): it shapes nothing.
      const bandY = Math.random() * v.h;
      const bandH = 4 + Math.random() * 14;
      const shift = (Math.random() - 0.5) * 14;
      g.save();
      g.globalCompositeOperation = 'copy';
      g.drawImage(
        canvas,
        0, bandY * o.dpr, canvas.width, bandH * o.dpr,
        shift, bandY, v.w, bandH,
      );
      g.restore();
      this.pixelTransform(g, o.dpr);
    }

    const key = `${v.w}x${v.h}`;
    if (!this.scanline || this.scanKey !== key) {
      const t = document.createElement('canvas');
      t.width = 1;
      t.height = 3;
      const tg = t.getContext('2d');
      if (tg) {
        tg.fillStyle = 'rgba(8,3,16,.30)';
        tg.fillRect(0, 0, 1, 1);
      }
      this.scanline = g.createPattern(t, 'repeat');
      this.scanKey = key;
    }
    if (this.scanline) {
      g.fillStyle = this.scanline;
      g.fillRect(0, 0, v.w, v.h);
    }

    if (!this.vignette || this.vignetteKey !== key) {
      const grd = g.createRadialGradient(v.w / 2, v.h / 2, Math.min(v.w, v.h) * 0.28, v.w / 2, v.h / 2, Math.max(v.w, v.h) * 0.72);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, 'rgba(6,2,12,.55)');
      this.vignette = grd;
      this.vignetteKey = key;
    }
    g.fillStyle = this.vignette;
    g.fillRect(0, 0, v.w, v.h);
  }

  /**
   * Compass ring. North is a tricolour-yellow tick with an N; the other three
   * cardinals are hairlines, which is enough to keep you oriented without
   * turning the minimap into an instrument panel.
   */
  compass(g: CanvasRenderingContext2D, v: MapView, o: PaintOpts): void {
    this.pixelTransform(g, o.dpr);
    const cx = v.w / 2;
    const cy = v.h / 2;
    const rad = Math.min(v.w, v.h) / 2 - 7;
    const marks: Array<[number, string]> = [
      [0, 'N'],
      [Math.PI / 2, ''],
      [Math.PI, ''],
      [-Math.PI / 2, ''],
    ];
    for (const [bearing, name] of marks) {
      const a = bearing - v.rot - Math.PI / 2;
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      if (name) {
        g.beginPath();
        g.arc(x, y, 7.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(10,4,20,.82)';
        g.fill();
        g.strokeStyle = 'rgba(252,209,22,.55)';
        g.lineWidth = 1;
        g.stroke();
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = '800 9px Inter, system-ui, sans-serif';
        g.fillStyle = MapInk.tri[1];
        g.fillText('N', x, y + 0.5);
      } else {
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * (rad - 3), cy + Math.sin(a) * (rad - 3));
        g.lineTo(cx + Math.cos(a) * (rad + 3), cy + Math.sin(a) * (rad + 3));
        g.strokeStyle = 'rgba(226,201,255,.30)';
        g.lineWidth = 1;
        g.stroke();
      }
    }
  }

  /** Frame stroke for the widget, drawn over everything. */
  frame(g: CanvasRenderingContext2D, path: Path2D, o: PaintOpts, hot: number): void {
    this.pixelTransform(g, o.dpr);
    g.save();
    g.lineWidth = 2;
    g.strokeStyle = MapInk.frameSoft;
    g.stroke(path);
    g.lineWidth = 1;
    g.strokeStyle = hot > 0 ? `rgba(255,90,74,${(0.5 + hot * 0.5).toFixed(2)})` : MapInk.frame;
    g.stroke(path);
    g.restore();
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function viewBoundsOf(v: MapView): { x0: number; z0: number; x1: number; z1: number } {
  // Inline of mapMath.viewBounds without the allocation, on the hot path.
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  const inv = 1 / v.scale;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? v.w : 0;
    const sy = i & 2 ? v.h : 0;
    const a = (sx - v.ox) * inv;
    const b = (sy - v.oy) * inv;
    const x = v.cx + a * c - b * s;
    const z = v.cz + a * s + b * c;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0: x0 - 20, z0: z0 - 20, x1: x1 + 20, z1: z1 + 20 };
}

function chamferSquare(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const c = r * 0.45;
  g.moveTo(x - r + c, y - r);
  g.lineTo(x + r, y - r);
  g.lineTo(x + r, y + r - c);
  g.lineTo(x + r - c, y + r);
  g.lineTo(x - r, y + r);
  g.lineTo(x - r, y - r + c);
  g.closePath();
}

function label(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  ink: string,
  baseline: CanvasTextBaseline = 'top',
): void {
  g.textBaseline = baseline;
  g.fillStyle = 'rgba(6,3,12,.9)';
  g.fillText(text, x + 1, y + 1);
  g.fillStyle = ink;
  g.fillText(text, x, y);
}

function spaced(s: string): string {
  return s.split('').join(' ');
}
