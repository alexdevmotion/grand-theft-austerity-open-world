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
 *  WHY THIS SYSTEM WATCHES `HudService.setWaypoint`
 *  ------------------------------------------------
 *  The map has to draw whatever the current waypoint is, wherever it came
 *  from: the campaign sets one per objective, side activities set one per leg,
 *  and the player sets one by clicking the map. `HudService` has a setter and
 *  no getter, and `src/ui/hud.ts` belongs to the UI agent, so this system wraps
 *  the live service instance's `setWaypoint` (and `setVisible`) at init and
 *  forwards every call straight through. It is a read-only tap: behaviour is
 *  unchanged, and the map can never show a waypoint the HUD does not have.
 *  A `readonly waypoint` on the interface would make the tap unnecessary — see
 *  the report.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../../core/engine';
import { Services, type HudService } from '../../core/services';
import { MapData } from './mapData';
import { MapPainter } from './mapRender';
import { MapWorld } from './mapWorld';
import { Minimap } from './minimap';
import { FullMap } from './fullMap';
import { Router } from './route';
import { MAP_CSS } from './mapStyle';

const NORTH_UP_KEY = 'gta.map.northUp.v1';
const _v = new THREE.Vector3();

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
  /** Set while we are the ones calling `setWaypoint`, to tag it as the player's. */
  private settingOwn = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;

    const city = ctx.tryGet(Services.City);
    if (city) {
      try {
        this.data.build(city);
        this.ready = this.data.segs.length > 0;
      } catch (err) {
        console.error('[map] could not build map data:', err);
      }
    }

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

    this.tapHud();
    this.bindKeys();
    this.installDebugHook();

    this.disposers.push(() => style.remove());
  }

  /* ---------------------------------------------------------------- */
  /* waypoint tap                                                      */
  /* ---------------------------------------------------------------- */

  private tapHud(): void {
    const hud = this.ctx.tryGet(Services.Hud) as (HudService & { __mapTapped?: boolean }) | undefined;
    if (!hud || hud.__mapTapped) return;
    hud.__mapTapped = true;

    const setWaypoint = hud.setWaypoint.bind(hud);
    hud.setWaypoint = (p: THREE.Vector3 | null) => {
      this.world.setWaypoint(p ? { x: p.x, z: p.z } : null, this.settingOwn);
      setWaypoint(p);
    };

    const setVisible = hud.setVisible.bind(hud);
    hud.setVisible = (v: boolean) => {
      this.hudVisible = v;
      setVisible(v);
    };

    this.disposers.push(() => {
      hud.setWaypoint = setWaypoint;
      hud.setVisible = setVisible;
      hud.__mapTapped = false;
    });
  }

  private dropWaypoint(x: number, z: number): void {
    const hud = this.ctx.tryGet(Services.Hud);
    const city = this.ctx.tryGet(Services.City);
    let y = 0;
    if (city) {
      const g = city.spatial.groundHeight(x, z);
      if (g > -1e5) y = g;
    }
    _v.set(x, y, z);
    this.settingOwn = true;
    try {
      hud?.setWaypoint(_v.clone());
    } finally {
      this.settingOwn = false;
    }
    if (!hud) this.world.setWaypoint({ x, z }, true);
    hud?.toast('Marcaj pe hartă', 'info', 1600);
  }

  private clearWaypoint(): void {
    const hud = this.ctx.tryGet(Services.Hud);
    hud?.setWaypoint(null);
    this.world.setWaypoint(null, false);
    this.router.clear();
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

    // Everything that is not the map itself hides while the world is stopped —
    // the same rule the HUD follows, so the two never disagree on screen.
    this.minimap.setVisible(!paused && this.hudVisible);

    this.world.sample(this.ctx, dt);
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
