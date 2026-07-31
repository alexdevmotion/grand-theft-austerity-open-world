/** THE MAP.
 *
 *  OWNER: map agent. Streets come from `CityService.roadNodes`, districts from
 *  `CityService.districtAt`, the route from `CityService.findPath`; the player,
 *  the Ministry, ambient traffic, side activities and the mission waypoint come
 *  through the service seam. Nothing on the map is hand-drawn, so it cannot
 *  drift out of sync with the city.
 *
 *  Three pieces:
 *    `minimap.ts`  the corner widget, always on in gameplay
 *    `fullMap.ts`  the pannable, zoomable sheet on `M`
 *    `route.ts`    the road-graph line from you to the waypoint
 *
 *  WHERE THE MAP'S FACTS COME FROM
 *  -------------------------------
 *  Every layer is read through the service seam, once a frame or once a
 *  repaint. Nothing is monkey-patched and nothing is inferred:
 *
 *    waypoint       `HudService.waypoint` — the one place the campaign, the
 *                   side activities and the player's own map pin converge.
 *                   This used to be a runtime wrapper around `setWaypoint`
 *                   because the contract was setter-only.
 *    HUD visibility `HudService.visible`, same story.
 *    blocks         `CityService.blocksIn` — real building footprints, baked
 *                   into the district wash at init. Without them the sheet is
 *                   a flat district wash with streets on it, which is the one
 *                   thing that read as "not a shipped map".
 *    search circle  `WantedService.lastKnown` / `.searchRadius` / `.inContact`
 *                   — the Ministry's ACTUAL belief, resolved against real
 *                   sight lines in `src/ai/police.ts`. This used to be derived
 *                   from pursuer-count transitions: plausible fiction.
 *    act on offer   `MissionService.offered` — so the map can say "go here to
 *                   start Act II" with no mission running, instead of showing
 *                   nothing at all about the story.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../../core/engine';
import { Services, type CityService, type Footprint } from '../../core/services';
import { MapData } from './mapData';
import { MapPainter } from './mapRender';
import { MapWorld } from './mapWorld';
import { Minimap } from './minimap';
import { FullMap } from './fullMap';
import { Router } from './route';
import { ACTIVITY_GLYPH, ACTIVITY_INK, MAP_CSS, MapInk } from './mapStyle';

const NORTH_UP_KEY = 'gta.map.northUp.v1';
const _v = new THREE.Vector3();

/**
 * Blip tag for an act you can go and start. `ACTIVITY_INK` / `ACTIVITY_GLYPH`
 * are open registries keyed by tag with a fallback, so a new kind of mark
 * registers itself here rather than being hard-coded into the painter — the
 * same way the side activities' four kinds do.
 */
const OFFER_TAG = 'act';

/** Long edge, in pixels, of the baked wash + blocks raster. */
const WASH_BAKE = 1400;
/**
 * Building masses, inked over the district wash.
 *
 * Darker, not lighter: the streets on this sheet are the PALE marks, so making
 * blocks pale would put them in direct competition with the carriageways and
 * turn the city into a single bright smear. Darkening them instead gives the
 * sheet the thing it was missing — solid masses with lit streets threading
 * between them — without touching the layer order the painter already tuned.
 */
const BLOCK_INK = 'rgba(5, 2, 12, 0.62)';
/** Tall masses get a touch more weight, so the towers read from the wash. */
const BLOCK_INK_TALL = 'rgba(3, 1, 8, 0.78)';
const TALL_M = 34;

export class MinimapSystem implements System {
  readonly name = 'minimap';
  readonly order = 425;
  /** The full-screen map stops the world; it has to keep drawing itself. */
  readonly ticksWhenPaused = true;

  private ctx!: GameContext;
  private data = new MapData();
  private painter = new MapPainter();
  private world = new MapWorld();
  private router = new Router();
  private minimap!: Minimap;
  private full!: FullMap;
  private northUp = false;
  private hudVisible = true;
  private ready = false;
  private disposers: Array<() => void> = [];

  /**
   * The waypoint WE dropped, in world metres, or null. The map paints a
   * campaign destination amber and a player's own pin magenta, and the HUD
   * stores one waypoint either way — so the distinction has to be remembered
   * here, at the only place that knows which of the two happened.
   */
  private ownWaypoint: { x: number; z: number } | null = null;
  /** Scratch for `blocksIn`, kept so a repaint never allocates. */
  private footprints: Footprint[] = [];
  private blocksBaked = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;

    const city = ctx.tryGet(Services.City);
    if (city) {
      try {
        this.data.build(city);
        this.ready = this.data.segs.length > 0;
        this.bakeBlocks(city);
      } catch (err) {
        console.error('[map] could not build map data:', err);
      }
    }

    ACTIVITY_INK[OFFER_TAG] = MapInk.missionMark;
    ACTIVITY_GLYPH[OFFER_TAG] = '★';

    try {
      this.northUp = localStorage.getItem(NORTH_UP_KEY) === '1';
    } catch {
      this.northUp = false;
    }

    const host = document.getElementById('ui-root');
    if (!host) return;

    const style = document.createElement('style');
    style.textContent = MAP_CSS;
    host.appendChild(style);

    this.minimap = new Minimap(this.painter);
    host.appendChild(this.minimap.root);

    this.full = new FullMap(this.painter, {
      setWaypoint: (x, z) => this.dropWaypoint(x, z),
      clearWaypoint: () => this.clearWaypoint(),
      isNorthUp: () => this.northUp,
      setNorthUp: (v) => this.setNorthUp(v),
      close: () => this.closeMap(),
    });
    host.appendChild(this.full.root);

    this.bindKeys();
    this.installDebugHook();

    this.disposers.push(() => style.remove());
  }

  /* ---------------------------------------------------------------- */
  /* blocks                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * BAKE THE CITY'S BUILDING MASSES INTO THE DISTRICT WASH.
   *
   * The painter already blits `MapData.wash` once, stretched over the world
   * bounds, under everything else. That is the cheapest possible place to put
   * blocks: they arrive for free in both views, at every zoom, costing exactly
   * the drawImage that was already happening, and the layer order the map
   * agent tuned is untouched.
   *
   * The district raster is 160x160 — 15 m a pixel, which is fine for a wash of
   * colour and useless for a 24 m plot. So this re-bakes at ~1.8 m a pixel:
   * the same wash upscaled (identical on screen, it was being smoothed up to
   * this size anyway), with real footprints inked on top of it.
   *
   * Once, at init. ~2000 rectangles into one canvas.
   */
  private bakeBlocks(city: CityService): void {
    if (typeof city.blocksIn !== 'function') return;
    const d = this.data;
    const ww = d.worldWidth;
    const wh = d.worldHeight;
    if (!(ww > 1 && wh > 1)) return;

    const scale = WASH_BAKE / Math.max(ww, wh);
    const cw = Math.max(2, Math.round(ww * scale));
    const ch = Math.max(2, Math.round(wh * scale));
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const g = cv.getContext('2d');
    if (!g) return;

    if (d.wash) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(d.wash, 0, 0, cw, ch);
    } else {
      g.fillStyle = MapInk.paper;
      g.fillRect(0, 0, cw, ch);
    }

    const n = city.blocksIn(d.minX, d.minZ, d.maxX, d.maxZ, this.footprints);
    // Two passes, one fill each: shorter masses, then the towers over them.
    // Batched into Path2D because 2000 separate fills is 2000 state changes.
    const low = new Path2D();
    const tall = new Path2D();
    for (let i = 0; i < n; i++) {
      const b = this.footprints[i];
      const path = b.height >= TALL_M ? tall : low;
      // World +z is canvas +y, so a rotation about world Y (which turns +x
      // toward -z) is a NEGATIVE rotation on the canvas.
      const c = Math.cos(-b.rot);
      const s = Math.sin(-b.rot);
      const ex = (b.x - d.minX) * scale;
      const ey = (b.z - d.minZ) * scale;
      const ax = b.hx * scale * c;
      const ay = b.hx * scale * s;
      const bx = -b.hz * scale * s;
      const by = b.hz * scale * c;
      path.moveTo(ex - ax - bx, ey - ay - by);
      path.lineTo(ex + ax - bx, ey + ay - by);
      path.lineTo(ex + ax + bx, ey + ay + by);
      path.lineTo(ex - ax + bx, ey - ay + by);
      path.closePath();
    }
    g.fillStyle = BLOCK_INK;
    g.fill(low);
    g.fillStyle = BLOCK_INK_TALL;
    g.fill(tall);

    d.wash = cv;
    this.blocksBaked = n;
  }

  /* ---------------------------------------------------------------- */
  /* waypoint                                                          */
  /* ---------------------------------------------------------------- */

  private dropWaypoint(x: number, z: number): void {
    const hud = this.ctx.tryGet(Services.Hud);
    const city = this.ctx.tryGet(Services.City);
    let y = 0;
    if (city) {
      const g = city.spatial.groundHeight(x, z);
      if (g > -1e5) y = g;
    }
    _v.set(x, y, z);
    this.ownWaypoint = { x, z };
    hud?.setWaypoint(_v.clone());
    // Applied here as well as read back by `syncWaypoint` next frame: the click
    // that drops a pin should move the mark in the frame it happened, and with
    // no HUD registered at all there is nothing to read back from.
    this.world.setWaypoint({ x, z }, true);
    hud?.toast('Marcaj pe hartă', 'info', 1600);
  }

  private clearWaypoint(): void {
    const hud = this.ctx.tryGet(Services.Hud);
    hud?.setWaypoint(null);
    this.ownWaypoint = null;
    this.world.setWaypoint(null, false);
    this.router.clear();
  }

  /**
   * Read the HUD's waypoint into the map, once a frame.
   *
   * This replaces a runtime wrap of `HudService.setWaypoint` that existed only
   * because the contract had no getter. Polling is also strictly more correct
   * than intercepting writes: it cannot miss a waypoint set before this system
   * initialised, and it cannot be defeated by a second wrapper.
   *
   * `ownWaypoint` survives only while the HUD still holds the exact pin we
   * dropped; the instant anything else writes a different one, that write is
   * the campaign's or an activity's and the mark goes back to amber.
   */
  private syncWaypoint(): void {
    const hud = this.ctx.tryGet(Services.Hud);
    if (!hud) return;
    const wp = hud.waypoint;
    if (!wp) {
      this.ownWaypoint = null;
      if (this.world.hasWaypoint) this.world.setWaypoint(null, false);
      return;
    }
    const own = this.ownWaypoint;
    const mine = !!own && Math.abs(own.x - wp.x) < 1e-3 && Math.abs(own.z - wp.z) < 1e-3;
    if (!mine) this.ownWaypoint = null;
    this.world.setWaypoint({ x: wp.x, z: wp.z }, mine);
  }

  /**
   * Overwrite the map's guessed search circle with the Ministry's real one.
   *
   * `MapWorld.sample` derives a circle from `pursuerCount` transitions because
   * that was all the contract offered. `WantedService` now publishes what the
   * pursuit system actually believes — a last sighting resolved against real
   * sight lines, and a cordon that widens by how far you could have driven
   * since it lost you. The lerp is presentation only: the value is honest, but
   * a radius that steps 13 m every tick reads as a stutter, not a search.
   */
  private applyRealSearch(dt: number): void {
    const wanted = this.ctx.tryGet(Services.Wanted);
    if (!wanted || typeof wanted.searchRadius !== 'number') return;
    const lk = wanted.lastKnown;
    const r = wanted.searchRadius;
    if (!lk || r <= 0) {
      this.world.searchRadius = 0;
      this.world.contact = 0;
      return;
    }
    this.world.searchX = lk.x;
    this.world.searchZ = lk.z;
    const k = Math.min(1, dt * 3);
    this.world.searchRadius =
      this.world.searchRadius > 0 ? this.world.searchRadius + (r - this.world.searchRadius) * k : r;
    const target = wanted.inContact ? 1 : 0;
    this.world.contact += (target - this.world.contact) * Math.min(1, dt * 2.5);
  }

  /**
   * Put the act you can go and start onto the map.
   *
   * Appended to the activities pool — the one blip layer the painter already
   * walks with a per-tag ink and glyph — so "go here to start Act II" is a
   * mark on the sheet rather than something you can only find by walking into
   * the giver's E prompt. Suppressed while an act is running, when the current
   * objective is the only campaign mark that should be on screen.
   */
  private applyOffers(): void {
    const missions = this.ctx.tryGet(Services.Missions);
    const offered = missions?.offered;
    if (!offered || offered.length === 0) return;
    if (missions?.currentId) return;
    for (let i = 0; i < offered.length; i++) {
      const o = offered[i];
      // Not `hot`: the painter draws a hot blip white, which it reserves for
      // the activity you are actually inside. An act on offer is amber — the
      // ink the full map's legend already promises for "Misiune".
      this.world.activities.push(o.position.x, o.position.z, NaN, OFFER_TAG, false);
    }
  }

  private setNorthUp(v: boolean): void {
    this.northUp = v;
    try {
      localStorage.setItem(NORTH_UP_KEY, v ? '1' : '0');
    } catch {
      /* private mode — the preference just does not survive the session */
    }
  }

  /* ---------------------------------------------------------------- */
  /* keys                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Capture phase, exactly like the pause menu: while the map is up the world
   * is stopped and gameplay input is off, so the only way it can still hear a
   * key is to take it before anything else does. Consumed keys are stopped
   * dead so a single Escape cannot both close the map and open the pause menu.
   */
  private bindKeys(): void {
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted && !ALLOW_SYNTHETIC) return;
      const open = this.full?.isOpen ?? false;

      if (e.code === 'KeyM') {
        if (open) this.closeMap();
        else if (this.canOpen()) this.openMap();
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!open) {
        // North-up is useful without opening anything; `N` is unbound in
        // src/core/input.ts, so nothing else wants it.
        if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey && !this.ctx.time.paused) {
          this.setNorthUp(!this.northUp);
          e.preventDefault();
        }
        return;
      }
      if (e.code === 'Escape') {
        this.closeMap();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.full.key(e.code)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKey, true);
    this.disposers.push(() => window.removeEventListener('keydown', onKey, true));
  }

  /** No map over the title screen, the pause menu, or a cutscene. */
  private canOpen(): boolean {
    return this.ready && !this.ctx.time.paused && this.hudVisible;
  }

  private openMap(): void {
    if (!this.full || this.full.isOpen) return;
    this.full.show(this.world);
    this.ctx.time.paused = true;
    this.ctx.input.enabled = false;
    this.ctx.input.exitPointerLock();
    this.minimap.setVisible(false);
  }

  private closeMap(): void {
    if (!this.full?.isOpen) return;
    this.full.hide();
    this.ctx.time.paused = false;
    this.ctx.input.enabled = true;
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  update(dt: number): void {
    if (!this.ready) return;
    const paused = this.ctx.time.paused;
    const mapOpen = this.full.isOpen;

    // Mirrors `HudService.visible`. Read, not intercepted: the map cannot end
    // up on screen over a menu just because it initialised after the HUD did.
    this.hudVisible = this.ctx.tryGet(Services.Hud)?.visible ?? true;

    // Everything that is not the map itself hides while the world is stopped —
    // the same rule the HUD follows, so the two never disagree on screen.
    this.minimap.setVisible(!paused && this.hudVisible);

    this.world.sample(this.ctx, dt);
    this.syncWaypoint();
    this.applyRealSearch(dt);
    this.applyOffers();
    this.router.update(
      this.ctx.tryGet(Services.City),
      this.world.x,
      this.world.z,
      this.world.hasWaypoint ? { x: this.world.waypointX, z: this.world.waypointZ } : null,
      dt,
    );

    const city = this.ctx.tryGet(Services.City);
    if (mapOpen) this.full.update(dt, this.data, this.world, this.router, city);
    else if (!paused && this.hudVisible) {
      this.minimap.update(dt, this.data, this.world, this.router, city, this.northUp);
    }
  }

  /* ---------------------------------------------------------------- */
  /* automation                                                        */
  /* ---------------------------------------------------------------- */

  private installDebugHook(): void {
    (window as unknown as { __GTA_MAP__: unknown }).__GTA_MAP__ = {
      open: () => this.openMap(),
      close: () => this.closeMap(),
      isOpen: () => this.full?.isOpen ?? false,
      northUp: (v?: boolean) => {
        if (v !== undefined) this.setNorthUp(v);
        return this.northUp;
      },
      setWaypoint: (x: number, z: number) => this.dropWaypoint(x, z),
      clearWaypoint: () => this.clearWaypoint(),
      /** Waypoint to the named landmark — the quickest way to test a route. */
      routeTo: (landmarkId: string) => {
        const lm = this.ctx.tryGet(Services.City)?.landmarks.get(landmarkId);
        if (!lm) return false;
        this.dropWaypoint(lm.position.x, lm.position.z);
        return true;
      },
      route: () => this.router.points.map((p) => [Math.round(p.x), Math.round(p.z)]),
      /**
       * Cost of one minimap frame, in milliseconds — sample, route and repaint,
       * i.e. everything this system does per frame during normal play. Reported
       * as an average over `n` repaints so a single GC pause cannot flatter it.
       */
      bench: (n = 180) => {
        const city = this.ctx.tryGet(Services.City);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          this.world.sample(this.ctx, 1 / 60);
          this.syncWaypoint();
          this.applyRealSearch(1 / 60);
          this.applyOffers();
          this.router.update(
            city,
            this.world.x,
            this.world.z,
            this.world.hasWaypoint ? { x: this.world.waypointX, z: this.world.waypointZ } : null,
            1 / 60,
          );
          this.minimap.update(1 / 60, this.data, this.world, this.router, city, this.northUp);
        }
        return Number(((performance.now() - t0) / n).toFixed(3));
      },
      /** Cost of one full-screen map repaint, ms. */
      benchFull: (n = 60) => {
        if (!this.full.isOpen) return -1;
        const city = this.ctx.tryGet(Services.City);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) this.full.update(1 / 60, this.data, this.world, this.router, city);
        return Number(((performance.now() - t0) / n).toFixed(3));
      },
      state: () => ({
        ready: this.ready,
        segments: this.data.segs.length,
        landmarks: this.data.landmarks.length,
        districtLabels: this.data.districtLabels.length,
        /** Building footprints baked into the wash. 0 means blocks are missing. */
        blocks: this.blocksBaked,
        washPx: this.data.wash ? [this.data.wash.width, this.data.wash.height] : null,
        /** Acts on offer, as the map is drawing them. */
        offered: (this.ctx.tryGet(Services.Missions)?.offered ?? []).map((o) => ({
          id: o.id,
          at: [Math.round(o.position.x), Math.round(o.position.z)],
        })),
        /** The Ministry's own numbers, before the map's presentation lerp. */
        wanted: (() => {
          const w = this.ctx.tryGet(Services.Wanted);
          const lk = w?.lastKnown ?? null;
          return {
            lastKnown: lk ? [Math.round(lk.x), Math.round(lk.z)] : null,
            searchRadius: Math.round(w?.searchRadius ?? 0),
            contact: w?.inContact ?? false,
          };
        })(),
        hudWaypoint: (() => {
          const wp = this.ctx.tryGet(Services.Hud)?.waypoint ?? null;
          return wp ? [Math.round(wp.x), Math.round(wp.z)] : null;
        })(),
        northUp: this.northUp,
        open: this.full?.isOpen ?? false,
        player: [Math.round(this.world.x), Math.round(this.world.z)],
        headingDeg: Math.round((this.world.heading * 180) / Math.PI),
        speedKmh: Math.round(this.world.speedKmh),
        stars: this.world.stars,
        pursuers: this.world.pursuers,
        searchRadius: Math.round(this.world.searchRadius),
        police: this.world.police.used,
        traffic: this.world.traffic.used,
        activities: this.world.activities.used,
        waypoint: this.world.hasWaypoint
          ? [Math.round(this.world.waypointX), Math.round(this.world.waypointZ)]
          : null,
        /** True for a pin the player dropped (magenta), false for the campaign's (amber). */
        waypointCustom: this.world.waypointIsCustom,
        routePoints: this.router.points.length,
        routeDirect: this.router.direct,
        routeRemaining: Math.round(this.router.remaining),
      }),
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.minimap?.dispose();
    this.full?.dispose();
  }
}

/**
 * Automated playtests press M by `dispatchEvent`, and `isTrusted` is false for
 * those, so the map accepts untrusted keys.
 *
 * THE TRAP THAT MAKES THIS SAFE. `PauseMenu.readBindings()` discovers the key
 * map by firing a synthetic keydown for *every* key on the keyboard, KeyM and
 * KeyN included. Nothing here may react to that. It cannot: the probe only runs
 * with the pause menu open, which means `time.paused` is true, and both the
 * open path (`canOpen`) and the north-up toggle refuse while the world is
 * stopped. If that ever stops being true, this constant is the switch.
 */
const ALLOW_SYNTHETIC = true;
