/**
 * THE FULL-SCREEN MAP — `M`.
 *
 * OWNER: map agent.
 *
 * The pause-menu pattern: its own DOM in `#ui-root`, its own capture-phase key
 * listener, and it freezes the simulation while it is up (the engine keeps
 * ticking systems with `order >= 400`, and the map is 425, so it stays alive
 * and interactive with the world stopped).
 *
 * It is north-up on purpose. A rotating full map is unreadable — you cannot
 * hold a city in your head if the city keeps turning. The minimap is the one
 * that rotates, and the toggle for it lives here.
 *
 * Click anywhere to drop a waypoint; the route to it is planned over the real
 * road graph and appears on the minimap immediately. Right-click clears it.
 */

import { MapPainter, type PaintOpts } from './mapRender';
import { DISTRICT_NAMES, type MapData } from './mapData';
import { ACTIVITY_INK, MapInk } from './mapStyle';
import { clamp, fmtDistance, makeView, unproject, type MapView } from './mapMath';
import type { MapWorld } from './mapWorld';
import type { Router } from './route';
import type { CityService } from '../../core/services';
import { onLangChange, t, tp } from '../../core/i18n';

const MIN_SCALE = 0.24;
const MAX_SCALE = 3.2;

export interface FullMapHooks {
  setWaypoint(x: number, z: number): void;
  clearWaypoint(): void;
  isNorthUp(): boolean;
  setNorthUp(v: boolean): void;
  close(): void;
}

const _w = { x: 0, z: 0 };

/** Every piece of chrome that sits over the sheet. Order does not matter. */
const CHROME_SELECTORS = [
  '.gta-map-head',
  '.gta-map-rule',
  '.gta-map-readout',
  '.gta-map-tools',
  '.gta-map-legend',
  '.gta-map-foot',
] as const;

export class FullMap {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private frameEl: HTMLDivElement;
  private readoutEl: HTMLDivElement;
  private northBtn: HTMLButtonElement;
  private view: MapView = makeView(100, 100);
  private dpr = 1;
  private open = false;
  private time = 0;
  private dragging = false;
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;
  private hover: { x: number; z: number } | null = null;
  private disposers: Array<() => void> = [];

  constructor(private painter: MapPainter, private hooks: FullMapHooks) {
    this.root = document.createElement('div');
    this.root.className = 'gta-map';
    this.root.innerHTML = template();

    this.frameEl = this.root.querySelector('.gta-map-frame')!;
    this.canvas = this.root.querySelector('canvas')!;
    this.readoutEl = this.root.querySelector('.gta-map-readout')!;
    this.northBtn = this.root.querySelector('[data-act="north"]')!;
    this.g = this.canvas.getContext('2d', { alpha: true });

    this.paintChrome();
    this.bind();

    // The map panel is built once and lives for the session, so a language
    // switch has to repaint its copy in place. Only the chrome is rebuilt —
    // rebuilding the whole panel would drop the canvas and the bound handlers.
    this.disposers.push(onLangChange(() => this.paintChrome()));
  }

  /** Everything on the panel that is copy rather than canvas. */
  private paintChrome(): void {
    const set = (sel: string, html: string): void => {
      const el = this.root.querySelector(sel);
      if (el) el.innerHTML = html;
    };
    set('.gta-map-eyebrow', t('B★ BULETIN CARTOGRAFIC — SECTORUL 0'));
    set('.gta-map-head h2', t('HARTA BUCUREȘTIULUI'));
    set('.gta-map-sub', t('CLIC <b>MARCAJ</b> · ROTIȚĂ <b>ZOOM</b> · TRAGE <b>MUTĂ</b>'));
    set('.gta-map-foot', t('M / ESC ÎNCHIDE · N ROTIRE MINIMAPĂ · SĂGEȚI MUTĂ · SPAȚIU CENTREAZĂ'));
    set('.gta-map-legend', legendHtml());
    const buttons: ReadonlyArray<readonly [string, string]> = [
      ['in', 'MĂREȘTE  +'],
      ['out', 'MICȘOREAZĂ  −'],
      ['centre', 'CENTREAZĂ'],
      ['clear', 'ȘTERGE MARCAJUL'],
      ['close', 'ÎNCHIDE  M'],
    ];
    for (const [act, label] of buttons) set(`[data-act="${act}"]`, t(label));
    // The north toggle's label depends on state, not just on language.
    this.syncButtons();
    // Force the next frame to rewrite the readout: `lastReadout` is a cached
    // HTML string and the cache does not know the language moved under it.
    this.lastReadout = '';
  }

  get isOpen(): boolean {
    return this.open;
  }

  /* ---------------------------------------------------------------- */
  /* open / close                                                      */
  /* ---------------------------------------------------------------- */

  show(world: MapWorld): void {
    if (this.open) return;
    this.open = true;
    this.root.classList.add('is-open');
    this.view.cx = world.x;
    this.view.cz = world.z;
    this.view.scale = 0.62;
    this.resize();
    this.syncButtons();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.dragging = false;
    this.root.classList.remove('is-open', 'is-drag');
  }

  /* ---------------------------------------------------------------- */
  /* input                                                             */
  /* ---------------------------------------------------------------- */

  private bind(): void {
    const cv = this.canvas;

    const onDown = (e: PointerEvent) => {
      if (e.button === 2) return;
      this.dragging = true;
      this.dragMoved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      cv.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (this.dragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        // Pan in world space: north-up, so screen and world axes agree.
        this.view.cx -= dx / this.view.scale;
        this.view.cz -= dy / this.view.scale;
        this.root.classList.add('is-drag');
      }
      unproject(this.view, sx, sy, _w);
      this.hover = { x: _w.x, z: _w.z };
    };

    const onUp = (e: PointerEvent) => {
      if (this.dragging && this.dragMoved < 5) {
        const r = cv.getBoundingClientRect();
        unproject(this.view, e.clientX - r.left, e.clientY - r.top, _w);
        this.hooks.setWaypoint(_w.x, _w.z);
      }
      this.dragging = false;
      this.root.classList.remove('is-drag');
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
    };

    const onCtx = (e: Event) => {
      e.preventDefault();
      this.hooks.clearWaypoint();
    };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', onCtx);
    this.disposers.push(() => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('contextmenu', onCtx);
    });

    this.root.querySelectorAll<HTMLButtonElement>('.gta-map-tools button').forEach((b) => {
      b.addEventListener('click', () => this.tool(b.dataset.act ?? ''));
    });
  }

  private tool(act: string): void {
    switch (act) {
      case 'north':
        this.hooks.setNorthUp(!this.hooks.isNorthUp());
        this.syncButtons();
        break;
      case 'in':
        this.zoomAt(this.view.w / 2, this.view.h / 2, 1.35);
        break;
      case 'out':
        this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.35);
        break;
      case 'centre':
        this.centreOnPlayer = true;
        break;
      case 'clear':
        this.hooks.clearWaypoint();
        break;
      case 'close':
        this.hooks.close();
        break;
      default:
    }
  }

  private centreOnPlayer = false;

  private zoomAt(sx: number, sy: number, factor: number): void {
    unproject(this.view, sx, sy, _w);
    const before = { x: _w.x, z: _w.z };
    this.view.scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    unproject(this.view, sx, sy, _w);
    this.view.cx += before.x - _w.x;
    this.view.cz += before.z - _w.z;
  }

  /** Arrow keys / +- while the map is up. Called by the system's key handler. */
  key(code: string): boolean {
    const step = 90 / this.view.scale;
    switch (code) {
      case 'ArrowLeft':
        this.view.cx -= step;
        return true;
      case 'ArrowRight':
        this.view.cx += step;
        return true;
      case 'ArrowUp':
        this.view.cz -= step;
        return true;
      case 'ArrowDown':
        this.view.cz += step;
        return true;
      case 'Equal':
      case 'NumpadAdd':
        this.zoomAt(this.view.w / 2, this.view.h / 2, 1.35);
        return true;
      case 'Minus':
      case 'NumpadSubtract':
        this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.35);
        return true;
      case 'KeyN':
        this.hooks.setNorthUp(!this.hooks.isNorthUp());
        this.syncButtons();
        return true;
      case 'Space':
        this.centreOnPlayer = true;
        return true;
      default:
        return false;
    }
  }

  private syncButtons(): void {
    const on = this.hooks.isNorthUp();
    this.northBtn.classList.toggle('on', on);
    this.northBtn.textContent = t(on ? 'MINIMAPĂ ⇧ NORD' : 'MINIMAPĂ ⇧ DIRECȚIE');
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  private resize(): void {
    const r = this.frameEl.getBoundingClientRect();
    // At least 2×, like the minimap: the sheet is dense with 9 px Romanian
    // captions and they have to survive.
    const dpr = Math.min(2.5, Math.max(2, window.devicePixelRatio || 1));
    const w = Math.max(64, Math.round(r.width));
    const h = Math.max(64, Math.round(r.height));
    if (this.view.w === w && this.view.h === h && this.dpr === dpr) return;
    this.dpr = dpr;
    this.view.w = w;
    this.view.h = h;
    this.view.ox = w / 2;
    this.view.oy = h / 2;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  update(
    dt: number,
    data: MapData,
    world: MapWorld,
    router: Router,
    city: CityService | undefined,
  ): void {
    if (!this.open) return;
    const g = this.g;
    if (!g) return;
    this.resize();
    this.time += dt;

    if (this.centreOnPlayer) {
      this.centreOnPlayer = false;
      this.view.cx = world.x;
      this.view.cz = world.z;
    }

    // Keep the sheet over the city: panning into the void is disorienting and
    // there is nothing out there to look at.
    const pad = 400;
    this.view.cx = clamp(this.view.cx, data.minX - pad, data.maxX + pad);
    this.view.cz = clamp(this.view.cz, data.minZ - pad, data.maxZ + pad);
    this.view.rot = 0;

    const opts: PaintOpts = {
      dpr: this.dpr,
      compact: false,
      time: this.time,
      labels: true,
      traffic: this.view.scale > 0.5,
      reserved: this.measureChrome(),
    };
    this.painter.paint(g, this.view, data, world, router, opts);
    this.drawCursor(g, opts);
    this.readout(world, router, city, data);
  }

  private chrome: number[] = [];
  private chromeKey = '';

  /**
   * WHERE THE PAINTER MAY NOT WRITE.
   *
   * The chrome is DOM, laid out by the CSS in `mapStyle.ts`, and the canvas
   * underneath it has no idea any of it is there — which is how "ZONA
   * INDUSTRIALĂ" came to be drawn behind the button column and sliced in half
   * by it, and how the anchors around Casa Builderilor ended up stacked
   * under the title strip.
   *
   * Measuring the real elements rather than hardcoding boxes means the
   * reservation cannot drift out of sync with the stylesheet — including the
   * readout card, whose height changes with the hovered POI's name. The result
   * is cached against the sheet size and that height, so the common frame does
   * no layout work at all.
   */
  private measureChrome(): readonly number[] {
    const cr = this.canvas.getBoundingClientRect();
    const key = `${Math.round(cr.width)}x${Math.round(cr.height)}|${this.readoutEl.offsetHeight}|${this.readoutEl.offsetWidth}`;
    if (key === this.chromeKey) return this.chrome;
    this.chromeKey = key;

    const out: number[] = [];
    for (const sel of CHROME_SELECTORS) {
      const el = this.root.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // A few pixels of air: a caption that merely TOUCHES the panel edge still
      // reads as colliding with it.
      out.push(
        r.left - cr.left - 7,
        r.top - cr.top - 7,
        r.right - cr.left + 7,
        r.bottom - cr.top + 7,
      );
    }
    this.chrome = out;
    return out;
  }

  /** Crosshair on the hovered spot, so a click feels aimed. */
  private drawCursor(g: CanvasRenderingContext2D, o: PaintOpts): void {
    if (!this.hover) return;
    const v = this.view;
    const p = { x: 0, y: 0 };
    const c = Math.cos(v.rot);
    const s = Math.sin(v.rot);
    const dx = this.hover.x - v.cx;
    const dz = this.hover.z - v.cz;
    p.x = v.ox + (dx * c + dz * s) * v.scale;
    p.y = v.oy + (-dx * s + dz * c) * v.scale;
    g.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
    g.strokeStyle = 'rgba(255,61,127,.45)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(p.x - 11, p.y);
    g.lineTo(p.x - 4, p.y);
    g.moveTo(p.x + 4, p.y);
    g.lineTo(p.x + 11, p.y);
    g.moveTo(p.x, p.y - 11);
    g.lineTo(p.x, p.y - 4);
    g.moveTo(p.x, p.y + 4);
    g.lineTo(p.x, p.y + 11);
    g.stroke();
  }

  private lastReadout = '';

  private readout(world: MapWorld, router: Router, city: CityService | undefined, data: MapData): void {
    const h = this.hover;
    let title = t('BUCUREȘTI');
    let line = t(world.missionTitle || 'Fără misiune activă');
    let sub = '';

    if (h) {
      let district = '';
      try {
        const k = city?.districtAt(h.x, h.z);
        district = k ? t(DISTRICT_NAMES[k]) : '';
      } catch {
        district = '';
      }
      let nearest = '';
      let bestD = 130;
      for (const lm of data.landmarks) {
        const d = Math.hypot(lm.x - h.x, lm.z - h.z);
        if (d < bestD) {
          bestD = d;
          nearest = t(lm.name);
        }
      }
      title = district || t('BUCUREȘTI');
      line = nearest || `${Math.round(h.x)}, ${Math.round(h.z)}`;
      sub = tp('{dist} de tine', { dist: fmtDistance(Math.hypot(h.x - world.x, h.z - world.z)) });
    }

    if (world.hasWaypoint) {
      const dist = router.points.length > 1 && !router.direct ? router.remaining : world.distanceToWaypoint();
      sub =
        `${sub ? `${sub} · ` : ''}` +
        tp('MARCAJ {dist}', { dist: fmtDistance(dist) }) +
        (router.direct ? t(' (linie directă)') : '');
    }

    const html =
      `<h4>${title}</h4><p>${line}</p>` +
      `<small>${sub || t('Clic pentru marcaj · clic dreapta pentru anulare')}</small>`;
    if (html !== this.lastReadout) {
      this.readoutEl.innerHTML = html;
      this.lastReadout = html;
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root.remove();
  }
}

/* ------------------------------------------------------------------ */

/**
 * Built per render, not once at import. Everything on this panel is copy, and
 * copy has to be able to change language without a page reload.
 */
const LEGEND_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Tu', MapInk.player],
  ['Misiune', MapInk.story],
  ['Marcaj', MapInk.waypoint],
  ['Minister', MapInk.police],
  ['Curier', ACTIVITY_INK.courier],
  ['Cursă', ACTIVITY_INK.race],
  ['Evadare', ACTIVITY_INK.evade],
  ['Foto', ACTIVITY_INK.photo],
];

const legendHtml = (): string =>
  LEGEND_ROWS.map(
    ([name, ink]) => `<span><em style="background:${ink}"></em>${t(name)}</span>`,
  ).join('');

const template = (): string => `
<div class="gta-map-frame">
  <canvas class="gta-map-cv"></canvas>
</div>
<div class="gta-map-ui">
<div class="gta-map-head">
  <div>
    <div class="gta-map-eyebrow">${t('B★ BULETIN CARTOGRAFIC — SECTORUL 0')}</div>
    <h2>${t('HARTA BUCUREȘTIULUI')}</h2>
  </div>
  <div class="gta-map-sub">${t('CLIC <b>MARCAJ</b> · ROTIȚĂ <b>ZOOM</b> · TRAGE <b>MUTĂ</b>')}</div>
</div>
<div class="gta-map-rule"></div>
<div class="gta-map-readout"></div>
<div class="gta-map-tools">
  <button data-act="north">${t('MINIMAPĂ ⇧ DIRECȚIE')}</button>
  <button data-act="in">${t('MĂREȘTE  +')}</button>
  <button data-act="out">${t('MICȘOREAZĂ  −')}</button>
  <button data-act="centre">${t('CENTREAZĂ')}</button>
  <button data-act="clear">${t('ȘTERGE MARCAJUL')}</button>
  <button data-act="close">${t('ÎNCHIDE  M')}</button>
</div>
<div class="gta-map-legend"></div>
<div class="gta-map-foot">${t('M / ESC ÎNCHIDE · N ROTIRE MINIMAPĂ · SĂGEȚI MUTĂ · SPAȚIU CENTREAZĂ')}</div>
</div>`;
