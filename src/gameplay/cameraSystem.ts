/**
 * Third-person / vehicle chase camera with collision, spring smoothing and
 * speed-driven FOV.
 *
 * OWNER: camera/feel agent. Must deliver cinematic chase framing, look-behind,
 * aim over-the-shoulder, shake, cutscene focus and a photo mode.
 *
 * THREE INVARIANTS THIS FILE IS RESPONSIBLE FOR
 * --------------------------------------------
 * 1. THE CAMERA IS NEVER BELOW THE GROUND. Every solve — spring, collision
 *    pull-in, shake — is followed by a hard floor clamp built from
 *    `CityService.spatial.groundHeight` AND a physics probe, so the clamp also
 *    holds on kerbs, ramps and anything the city adds later. The clamp is
 *    applied to the *spring state*, not only to the rendered position:
 *    clamping only the output lets the spring keep integrating underground and
 *    the camera snaps back through the floor the moment the obstruction ends.
 * 2. THE CAMERA IS NEVER INSIDE ITS SUBJECT. Collision pull-in is floored at a
 *    per-mode minimum radius, and a final "eject" step pushes the camera back
 *    out along the view axis if anything (a wall on both sides, a floor clamp
 *    that shortened the boom) left it inside the player's head or the car.
 * 3. THE RIG SITS BEHIND THE CAR. Camera position is `anchor - F * distance`
 *    with `F = (sin yaw, 0, cos yaw)`, and vehicle forward is also
 *    `(sin heading, 0, cos heading)`, so `yaw == heading` frames the car from
 *    behind. Adding PI rotates the rig to the far side and frames it head-on.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { CG, PhysicsWorld, probeGroups } from '../physics/physics';
import { Rng } from '../core/rng';
import { Services, type CameraService, type CityService } from '../core/services';

/** Metres of clearance kept between the camera and whatever is under it. */
const FLOOR_MARGIN = 0.42;
/** How far above the camera the downward probe starts. */
const FLOOR_PROBE_UP = 3.0;
const FLOOR_PROBE_LENGTH = 24.0;

/* ================================================================== *
 * DIRECTION — the public surface other systems drive story beats with.
 * ================================================================== */

/**
 * ONE FRAMED SHOT.
 *
 * Everything is optional except the target, because the whole point is that a
 * caller says *what to look at* and the camera department decides where to
 * stand. `azimuthDeg` is the escape hatch for when a beat has a correct side
 * (the mast is only readable from the plaza); leave it off and the rig sweeps
 * for a spot with a clear eye-line, the way `frameLandmark` does, so a shot
 * cannot end up inside a wall when the city regenerates.
 */
export interface CinematicShot {
  /** World point to hold in frame. */
  target: THREE.Vector3;
  /** Track this instead of the fixed point (the player, a car). */
  follow?: THREE.Object3D | null;
  /** Seconds. Default 3.0. */
  duration?: number;
  /** Boom length at the start of the shot. Default 9. */
  distance?: number;
  /** Camera height above the target's ground. Default 2.6. */
  height?: number;
  /** How far above `target` the lens actually points. Default 1.1. */
  lookHeight?: number;
  fov?: number;
  /** Fixed side to shoot from. Omit to auto-pick a clear one. */
  azimuthDeg?: number;
  /** Metres travelled toward the subject over the shot. Negative pulls out. */
  push?: number;
  /** Metres of vertical drift over the shot. */
  rise?: number;
  /** Dutch angle, degrees. */
  rollDeg?: number;
  /** Letterbox bars. Default true. */
  bars?: boolean;
  title?: string;
  subtitle?: string;
  /**
   * Take the controls away for the duration. Default: only when the player is
   * on foot or nearly stopped — freezing the input of a car doing 25 m/s puts
   * it through a shopfront while the player is watching a title card.
   */
  hold?: boolean;
  /** Higher wins when a shot is already running. Default 0. */
  priority?: number;
}

/**
 * WHAT `MissionSystem` (or anything else) CALLS.
 *
 * `CameraService` in `src/core/services.ts` is frozen and only has `focusOn`,
 * which nudges the look point of the gameplay rig — useful, but it is not
 * direction. This is the widened contract the camera system actually
 * publishes; resolve `Services.Camera` and narrow to it:
 *
 *   const cam = ctx.get(Services.Camera) as CameraDirector;
 *   cam.climax('act3_termsheet');
 */
export interface CameraDirector extends CameraService {
  /** Play a shot. False when a higher-priority shot is already running. */
  playShot(shot: CinematicShot): boolean;
  /**
   * Play the authored beat for a story moment. `key` is a mission id, a
   * mission id prefixed `start:`, or one of the named climaxes below. `at`
   * overrides the subject; the default is the player.
   */
  climax(key: string, at?: THREE.Vector3): boolean;
  /** End the current shot immediately. */
  skipShot(): void;
  readonly cinematicActive: boolean;
  readonly photoActive: boolean;
  setPhotoMode(on: boolean): void;
}

/* ------------------------------------------------------------------ */
/* The direction table — one authored composition per story beat.      */
/*                                                                     */
/* This is a shot list, not configuration. Each act gets a lens, a     */
/* side and a move that says something about the beat: Act I runs      */
/* away from you, Act III rises off the mast, Act IV pushes into the   */
/* lobby doors. Keyed by the mission ids in `src/content/story.ts`.    */
/* ------------------------------------------------------------------ */

type ShotPreset = Omit<CinematicShot, 'target' | 'follow'>;

const ACT_TITLES: Record<string, string> = {
  act1_evacuare: 'ACTUL I',
  act2_bootstrap: 'ACTUL II',
  act3_termsheet: 'ACTUL III',
  act4_giftshop: 'ACTUL IV',
};

/** Mission start: a low, close, slightly rising push — "here we go". */
const START_SHOTS: Record<string, ShotPreset> = {
  act1_evacuare: {
    duration: 3.4, distance: 8.5, height: 1.35, lookHeight: 1.25, fov: 40,
    push: 3.0, rise: 0.45, rollDeg: -1.2,
    subtitle: 'Ordin de Evacuare',
  },
  act2_bootstrap: {
    duration: 3.2, distance: 10.0, height: 2.1, lookHeight: 1.2, fov: 44,
    push: 3.4, rise: -0.5, rollDeg: 1.4,
    subtitle: 'Bootstrap',
  },
  act3_termsheet: {
    duration: 3.3, distance: 12.0, height: 3.4, lookHeight: 1.2, fov: 38,
    push: 4.2, rise: -1.4,
    subtitle: 'Term Sheet',
  },
  act4_giftshop: {
    duration: 3.6, distance: 13.0, height: 1.1, lookHeight: 1.35, fov: 34,
    push: 4.6, rise: 1.1, rollDeg: -2.0,
    subtitle: 'Magazinul de Suveniruri',
  },
};

/** Act climaxes: wider, slower, and they pull back off the man. */
const CLIMAX_SHOTS: Record<string, ShotPreset> = {
  act1_evacuare: {
    duration: 4.0, distance: 9.0, height: 2.2, lookHeight: 1.2, fov: 46,
    push: -7.0, rise: 3.2, rollDeg: 1.0,
    title: 'ACTUL I — ÎNCHEIAT', subtitle: 'Serverul e în portbagaj. Casa nu mai e a nimănui.',
  },
  act2_bootstrap: {
    duration: 4.0, distance: 8.0, height: 1.7, lookHeight: 1.25, fov: 42,
    push: -6.0, rise: 2.4, rollDeg: -1.6,
    title: 'ACTUL II — ÎNCHEIAT', subtitle: 'Dovezile sunt la tine. Acum trebuie difuzate.',
  },
  act3_termsheet: {
    duration: 4.4, distance: 14.0, height: 4.5, lookHeight: 1.2, fov: 40,
    push: -10.0, rise: 7.0,
    title: 'ACTUL III — ÎNCHEIAT', subtitle: 'Toată țara v-a auzit.',
  },
  act4_giftshop: {
    duration: 5.0, distance: 11.0, height: 1.6, lookHeight: 1.3, fov: 36,
    push: -9.0, rise: 4.5, rollDeg: 1.2,
    title: 'CASA CONSTRUCTORILOR', subtitle: 'E din nou deschisă.',
  },
  /** Mid-act beat: the broadcast goes live. Fires off `broadcast:hijacked`. */
  hijack: {
    duration: 3.6, distance: 15.0, height: 5.5, lookHeight: 1.2, fov: 34,
    push: -6.0, rise: 6.5,
    title: 'EMISIE PIRAT', subtitle: 'Semnalul Ministerului e al nostru.',
  },
  /** Being taken by the Ministry. Driven by `wanted.ts`. */
  busted: {
    duration: 2.4, distance: 5.2, height: 1.05, lookHeight: 1.15, fov: 52,
    push: 1.6, rise: 0.9, rollDeg: 3.2, bars: true, hold: true, priority: 10,
    title: 'REȚINUT',
  },
  fail: {
    duration: 2.4, distance: 7.5, height: 2.0, lookHeight: 1.2, fov: 44,
    push: -3.5, rise: 1.6,
    title: 'EȘUAT',
  },
};

/* ------------------------------------------------------------------ */
/* Photo mode                                                          */
/* ------------------------------------------------------------------ */

/**
 * The look presets. Every one of them is a DOM/CSS pass over the canvas
 * rather than a change to the shared post chain, on purpose: the grade in
 * `src/render/postfx.ts` belongs to the render agent, it has no getters to
 * read the defaults back from, and a photo filter that half-restores itself
 * would poison every frame of the rest of the session. A `backdrop-filter`
 * stack costs one fullscreen composite while photo mode is open and exactly
 * nothing when it is closed.
 */
interface PhotoFilter {
  name: string;
  /** CSS backdrop-filter applied to the frame. */
  css: string;
  /** Colour wash: [css background, blend mode, opacity]. */
  wash?: [string, string, number];
  /** Vignette strength, 0..1. */
  vignette: number;
  /** Film grain opacity, 0..1. */
  grain: number;
}

const PHOTO_FILTERS: PhotoFilter[] = [
  {
    name: 'DIRECT',
    css: 'none',
    vignette: 0.18,
    grain: 0.03,
  },
  {
    name: 'MINISTERIAL',
    /* The identity: violet in the corners, magenta only where the frame is
     * already hot. The first cut of this was a flat pink veil over the whole
     * image — `hue-rotate(-8deg)` dragged the sunset's oranges into magenta
     * and a 0.9 soft-light wash finished the job, so a lit facade, a tree and
     * a pavement all came out the same bubblegum. A filter has to leave the
     * midtones alone or there is nothing left for it to be a filter OF. */
    css: 'saturate(1.2) contrast(1.2) brightness(0.95)',
    wash: ['radial-gradient(88% 76% at 50% 44%, rgba(255,61,127,.06) 0%, rgba(255,61,127,.10) 42%, rgba(52,18,92,.72) 100%)', 'soft-light', 0.72],
    vignette: 0.46,
    grain: 0.05,
  },
  {
    name: 'AUSTERITATE',
    // Bleach bypass: the colour is drained out of everything but the neon.
    css: 'saturate(0.34) contrast(1.42) brightness(1.04)',
    wash: ['linear-gradient(180deg, rgba(196,205,255,.22), rgba(24,18,38,.42))', 'overlay', 0.85],
    vignette: 0.5,
    grain: 0.09,
  },
  {
    name: 'ARHIVĂ 1989',
    css: 'saturate(0.12) sepia(0.62) contrast(1.24) brightness(0.94)',
    wash: ['radial-gradient(110% 100% at 50% 45%, rgba(255,196,128,.20), rgba(38,24,16,.62))', 'multiply', 0.9],
    vignette: 0.62,
    grain: 0.22,
  },
  {
    name: 'NOAPTE ELECTRICĂ',
    css: 'saturate(1.65) contrast(1.22) brightness(1.06) hue-rotate(-18deg)',
    wash: ['linear-gradient(140deg, rgba(0,229,255,.30), rgba(0,0,0,0) 45%, rgba(255,45,150,.34))', 'screen', 0.62],
    vignette: 0.4,
    grain: 0.06,
  },
  {
    name: 'NEGATIV DE STAT',
    css: 'invert(1) hue-rotate(180deg) saturate(1.35) contrast(1.06)',
    wash: ['radial-gradient(120% 90% at 50% 50%, rgba(255,61,127,.18), rgba(10,6,20,.34))', 'soft-light', 0.8],
    vignette: 0.3,
    grain: 0.07,
  },
];

/** Free-camera speeds, metres per second. */
const PHOTO_SPEED = 7.5;
const PHOTO_FAST = 4.2;
const PHOTO_SLOW = 0.22;
const PHOTO_LOOK = 0.0022;

export class CameraSystem implements System, CameraDirector {
  readonly name = 'camera';
  readonly order = 300;

  private _mode: CameraService['mode'] = 'thirdPerson';
  private yaw = 0;
  private pitch = 0.14;
  private ctx!: GameContext;
  private phys!: PhysicsWorld;
  private city: CityService | undefined;
  private shakeRng = new Rng('camera-shake');

  private currentPos = new THREE.Vector3();
  private currentLook = new THREE.Vector3();
  private shakeAmount = 0;
  private shakeTime = 0;
  private focusTimer = 0;
  private focusPoint = new THREE.Vector3();
  private currentFov = 58;

  /* ---- chase state (vehicle feel) ---- */
  /** Smoothed longitudinal acceleration, m/s². */
  private accel = 0;
  private lastSpeed = 0;
  /** Smoothed car yaw rate, rad/s. Drives the corner swing. */
  private yawRate = 0;
  private lastHeading = 0;
  private hasLastHeading = false;
  /** True while the rig has swung round to look over the bonnet in reverse. */
  private reversing = false;
  private reverseTimer = 0;
  /** Seconds left of "the player is looking around, do not auto-align". */
  private manualLook = 0;
  /** Extra boom length carried by the acceleration lag, metres. */
  private lagBoom = 0;
  /** Smoothed lateral corner swing, metres. */
  private swing = 0;

  /**
   * Per-mode rig.
   *
   * `minRadius` is the *comfortable* boom length: below it the rig starts
   * climbing rather than closing further, which is how a chase camera gets out
   * of an alley without ending up in the boot.
   * `hardMin` is the absolute floor — the radius at which the camera would be
   * inside the subject — and nothing is ever allowed to go under it.
   * `squeezeLift` is how far the rig climbs when squeezed all the way down.
   */
  private rigs = {
    thirdPerson: { distance: 4.4, height: 1.72, shoulder: 0.55, fov: 58, minRadius: 1.55, hardMin: 0.95, squeezeLift: 0.55 },
    vehicle: { distance: 6.6, height: 2.45, shoulder: 0, fov: 60, minRadius: 3.4, hardMin: 1.9, squeezeLift: 1.9 },
    aim: { distance: 1.9, height: 1.62, shoulder: 0.78, fov: 44, minRadius: 0.95, hardMin: 0.7, squeezeLift: 0.25 },
    cinematic: { distance: 7.0, height: 2.4, shoulder: 0, fov: 50, minRadius: 2.0, hardMin: 1.2, squeezeLift: 0.9 },
    photo: { distance: 5.0, height: 2.0, shoulder: 0, fov: 55, minRadius: 0.6, hardMin: 0.4, squeezeLift: 0.2 },
  };

  /* ---- direction ---- */
  private shot: ActiveShot | null = null;
  private shotRng = new Rng('camera-direction');
  private cine: CineDom | null = null;
  /** `input.enabled` as it was before a shot took the controls away. */
  private inputWasEnabled = true;

  /* ---- photo mode ---- */
  private photo: PhotoState | null = null;
  private photoDom: PhotoDom | null = null;
  /** Interactable ids photo mode switched off, to switch back on after. */
  private hiddenMarkers: string[] = [];

  get mode(): CameraService['mode'] {
    return this._mode;
  }

  get cinematicActive(): boolean {
    return this.shot !== null;
  }
  get photoActive(): boolean {
    return this.photo !== null;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.get(Services.Physics);
    this.city = ctx.tryGet(Services.City);
    ctx.provide(Services.Camera, this);
    this.currentPos.copy(ctx.camera.position);

    // Never grab the pointer back while a menu is up — the pause screen has to
    // be usable with a visible cursor.
    //
    // The lock is requested straight off the canvas rather than through
    // `Input.requestPointerLock()` so the returned promise can be caught:
    // browsers reject it for ~1 s after Escape released the lock, and an
    // unhandled rejection is wired to the fatal-error overlay in main.ts.
    ctx.canvas.addEventListener('click', () => {
      if (ctx.time.paused) return;
      if (ctx.input.pointerLocked) return;
      const p = ctx.canvas.requestPointerLock() as unknown;
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => undefined);
      }
    });

    this.buildCineDom();
    this.installStoryBeats(ctx);
    this.installPhotoKeys(ctx);
    this.installDebugHook();
  }

  /* ------------------------------------------------------------------ *
   * STORY BEATS, DRIVEN FROM THIS SIDE.
   *
   * `MissionSystem` is owned by another agent this round, so nothing was
   * going to appear there to call `playShot`. It does not have to: every beat
   * worth a camera move already announces itself on the event bus, and the
   * bus is the seam. Subscribing here means the campaign gets direction
   * without a single line changing in `missions.ts` — and the explicit API
   * above is still there for the beats an event cannot describe.
   * ------------------------------------------------------------------ */
  private installStoryBeats(ctx: GameContext): void {
    ctx.events.on('mission:advance', ({ id }) => {
      this.climax(`start:${id}`);
    });
    ctx.events.on('mission:complete', ({ id }) => {
      this.climax(id);
    });
    ctx.events.on('mission:failed', ({ id, reason }) => {
      if (reason === 'abandoned') return;
      const preset = { ...CLIMAX_SHOTS.fail, subtitle: reason };
      void id;
      this.playShotAt(preset, null);
    });
    // The Act III payoff fires mid-mission, from `MissionSystem.satisfy`.
    ctx.events.on('broadcast:hijacked', () => this.climax('hijack'));
  }

  setMode(m: CameraService['mode']): void {
    this._mode = m;
  }

  shake(intensity: number, seconds: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, intensity);
    this.shakeTime = Math.max(this.shakeTime, seconds);
  }

  focusOn(p: THREE.Vector3, seconds: number): void {
    this.focusPoint.copy(p);
    this.focusTimer = seconds;
  }

  /** Point the boom orbits around and the collision ray fires from. */
  private _pivot = new THREE.Vector3();
  /** Point the camera looks at. Leads the pivot in a fast car. */
  private _target = new THREE.Vector3();
  private _desired = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _tmp = new THREE.Vector3();
  private _tmp2 = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _probe = new THREE.Vector3();
  private _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private static readonly DOWN = new THREE.Vector3(0, -1, 0);

  update(dt: number, ctx: GameContext): void {
    // P toggles photo mode. Read before anything else consumes the frame.
    if (ctx.input.actionPressed('photoMode') && !this.shot) this.setPhotoMode(true);

    // Photo mode and cinematics both take the whole camera. Neither runs the
    // gameplay rig underneath — the spring would keep integrating toward the
    // player and snap the frame the instant control came back — so both
    // re-seed the spring state from wherever they finished.
    if (this.photo) {
      this.updatePhoto(dt, ctx);
      return;
    }
    if (this.shot && this.updateShot(dt, ctx)) return;

    const player = ctx.tryGet(Services.Player);
    if (!player) return;
    if (this.city === undefined) this.city = ctx.tryGet(Services.City);

    const input = ctx.input;
    const lookX = input.axes.lookX;
    this.yaw -= lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.axes.lookY, -0.72, 1.05);

    const veh = player.inVehicle;
    const rig = this.rigs[this._mode];

    let distance = rig.distance;
    let height = rig.height;
    let fov = rig.fov;
    let speed = 0;

    if (veh) {
      speed = veh.speed;
      this.updateChase(dt, veh, Math.abs(lookX));

      const fast = Math.min(1, Math.abs(speed) / 26);
      // Pull back and rise with speed, and let acceleration stretch the boom
      // so the car visibly "runs away" from the camera when you floor it.
      distance = rig.distance + fast * 3.4 + this.lagBoom;
      height = rig.height + fast * 0.75;
      fov = rig.fov + fast * 17;

      // The boom orbits the car itself; the look point sits a little above the
      // roofline and leads at speed, so the frame reads into the corner
      // instead of staring at the boot lid.
      this._pivot.copy(veh.position);
      this._pivot.y += height;
      this._target.copy(veh.position);
      this._target.y += 1.05 + fast * 0.25;
      this._target.addScaledVector(this._fwd, THREE.MathUtils.clamp(speed * 0.09, -1.2, 2.6));
    } else {
      this.resetChase();
      this._pivot.copy(player.position).add(this._tmp.set(0, rig.height, 0));
      this._target.copy(this._pivot);
    }

    // Hold `lookBehind` to spin the rig 180° without losing the yaw you had.
    const behind = input.action('lookBehind') ? Math.PI : 0;

    // Tell the player which way "forward" is. (Look-behind must NOT steer the
    // character, so the raw yaw is published, not the flipped one.)
    (ctx.get(Services.Player) as unknown as { desiredYaw: number }).desiredYaw = this.yaw;

    // Desired camera position on a sphere behind the anchor.
    const orbit = this.yaw + behind;
    const cosP = Math.cos(this.pitch);
    this._dir.set(
      Math.sin(orbit + Math.PI) * cosP,
      Math.sin(this.pitch),
      Math.cos(orbit + Math.PI) * cosP,
    );

    this._desired.copy(this._pivot).addScaledVector(this._dir, distance);

    if (veh && this.swing !== 0) {
      // Swing wide in corners: slide the rig toward the outside of the turn.
      this._right.set(Math.cos(orbit), 0, -Math.sin(orbit));
      this._desired.addScaledVector(this._right, this.swing);
    }

    if (rig.shoulder) {
      this._tmp.set(Math.cos(orbit), 0, -Math.sin(orbit)).multiplyScalar(rig.shoulder);
      this._desired.add(this._tmp);
      this._target.add(this._tmp);
    }

    // Keep the *desired* point out of the floor before the spring ever sees it,
    // otherwise the spring chases an underground target every frame.
    this.clampToFloor(this._desired);

    // Collision: pull the camera in if a wall is between it and the pivot.
    const toCam = this._tmp.subVectors(this._desired, this._pivot);
    const dist = toCam.length();
    if (dist > 0.001) {
      toCam.divideScalar(dist);
      const hit = this.phys.raycast(
        this._pivot,
        toCam,
        dist + 0.4,
        probeGroups(CG.STATIC | CG.TERRAIN),
      );
      if (hit && !this.isThinObstacle(hit.distance, dist, toCam)) {
        const pulled = Math.max(rig.hardMin, hit.distance - 0.35);
        if (pulled < dist) {
          this._desired.copy(this._pivot).addScaledVector(toCam, pulled);
          // Squeezed shorter than the comfortable boom: climb instead of
          // burrowing. Clamping the boom at `minRadius` and stopping there is
          // what parks the camera inside a shopfront when a car noses into a
          // building — the wall is closer than the rig wants to be, so the
          // only way out is up and over.
          const span = Math.max(0.001, rig.minRadius - rig.hardMin);
          const squeeze = THREE.MathUtils.clamp((rig.minRadius - pulled) / span, 0, 1);
          if (squeeze > 0) {
            this._desired.y += squeeze * rig.squeezeLift;
            // The lift must not tunnel through a ceiling either.
            const liftLen = this._tmp2.subVectors(this._desired, this._pivot).length();
            this._tmp2.divideScalar(Math.max(1e-4, liftLen));
            const up = this.phys.raycast(
              this._pivot,
              this._tmp2,
              liftLen,
              probeGroups(CG.STATIC | CG.TERRAIN),
            );
            if (up) {
              this._desired.copy(this._pivot)
                .addScaledVector(this._tmp2, Math.max(rig.hardMin, up.distance - 0.25));
            }
          }
        }
      }
    }

    // Spring follow — snappier in vehicles so the car never outruns the frame.
    const follow = veh ? 12 + Math.min(1, Math.abs(speed) / 24) * 8 : 11;
    const k = 1 - Math.exp(-follow * dt);
    this.currentPos.lerp(this._desired, k);
    this.currentLook.lerp(this._target, 1 - Math.exp(-16 * dt));

    // Cutscene focus override.
    if (this.focusTimer > 0) {
      this.focusTimer -= dt;
      this.currentLook.lerp(this.focusPoint, 1 - Math.exp(-4 * dt));
    }

    // HARD FLOOR. Applied to the spring state so an obstruction that shortened
    // the boom cannot leave the camera integrating below the pavement.
    this.clampToFloor(this.currentPos);
    // ...and never inside the subject, whatever the clamp did to the boom.
    this.ejectFromSubject(this.currentPos, this._pivot, rig.hardMin);

    ctx.camera.position.copy(this.currentPos);

    // Shake (deterministic — Math.random() would desync regression captures).
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const a = this.shakeAmount * Math.min(1, this.shakeTime * 3);
      ctx.camera.position.x += (this.shakeRng.next() - 0.5) * a;
      ctx.camera.position.y += (this.shakeRng.next() - 0.5) * a;
      ctx.camera.position.z += (this.shakeRng.next() - 0.5) * a;
      if (this.shakeTime <= 0) this.shakeAmount = 0;
      // Shake must not be able to punch through the pavement either.
      this.clampToFloor(ctx.camera.position);
    }

    ctx.camera.lookAt(this.currentLook);

    // Speed FOV, with a kick under hard acceleration.
    const targetFov = fov + (veh ? THREE.MathUtils.clamp(this.accel * 0.35, -3, 5) : 0);
    this.currentFov += (targetFov - this.currentFov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(ctx.camera.fov - this.currentFov) > 0.01) {
      ctx.camera.fov = this.currentFov;
      ctx.camera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Chase feel                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Track the car and fold its motion into the rig: acceleration lag, corner
   * swing, reverse swing-around and the auto-align that keeps the camera
   * behind the car when the player is not looking around.
   */
  private updateChase(
    dt: number,
    veh: { rotation: THREE.Quaternion; speed: number },
    lookMag: number,
  ): void {
    this._euler.setFromQuaternion(veh.rotation);
    const heading = this._euler.y;
    this._fwd.set(Math.sin(heading), 0, Math.cos(heading));

    const speed = veh.speed;

    // Longitudinal acceleration, smoothed hard — raw dv/dt at 60 Hz is noise.
    const rawAccel = dt > 0 ? (speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = speed;
    this.accel += (THREE.MathUtils.clamp(rawAccel, -30, 30) - this.accel) * (1 - Math.exp(-6 * dt));

    // Car yaw rate, for the corner swing.
    if (this.hasLastHeading && dt > 0) {
      let d = heading - this.lastHeading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const raw = THREE.MathUtils.clamp(d / dt, -4, 4);
      this.yawRate += (raw - this.yawRate) * (1 - Math.exp(-8 * dt));
    }
    this.lastHeading = heading;
    this.hasLastHeading = true;

    const fast = Math.min(1, Math.abs(speed) / 26);

    // Acceleration lag: the boom stretches when you floor it, compresses under
    // braking. Damped so it reads as weight rather than as a zoom.
    const lagTarget = THREE.MathUtils.clamp(this.accel * 0.16, -1.1, 2.2);
    this.lagBoom += (lagTarget - this.lagBoom) * (1 - Math.exp(-3.5 * dt));

    // Corner swing: slide toward the outside of the turn, proportional to how
    // hard the car is actually rotating and how fast it is going.
    const swingTarget = THREE.MathUtils.clamp(-this.yawRate * (0.9 + fast * 2.6), -2.4, 2.4);
    this.swing += (swingTarget - this.swing) * (1 - Math.exp(-4 * dt));

    // Reverse: swing the rig round to the nose after a sustained reverse, so
    // the player is looking where the car is actually going. Hysteresis on
    // both the speed threshold and a dwell timer stops it flip-flopping at a
    // three-point turn.
    if (speed < -1.8) this.reverseTimer = Math.min(1.2, this.reverseTimer + dt);
    else if (speed > 0.4) this.reverseTimer = Math.max(0, this.reverseTimer - dt * 2.5);
    else this.reverseTimer = Math.max(0, this.reverseTimer - dt * 0.6);
    if (!this.reversing && this.reverseTimer > 0.75) this.reversing = true;
    else if (this.reversing && this.reverseTimer < 0.15) this.reversing = false;

    // Auto-align. A short grace window after the player stops moving the mouse
    // keeps the rig from yanking itself out of a look the player just chose.
    if (lookMag > 0.0005) this.manualLook = 0.9;
    else this.manualLook = Math.max(0, this.manualLook - dt);

    if (this.manualLook <= 0) {
      // Trail the turn slightly: the rig lags the car's rotation, which is what
      // reads on screen as the camera swinging wide through a corner.
      const trail = THREE.MathUtils.clamp(this.yawRate * 0.16, -0.35, 0.35) * fast;
      const target = heading + (this.reversing ? Math.PI : 0) - trail;
      // Stationary cars must not be re-framed; the rate scales with speed, and
      // the reverse swing-around gets its own (faster) constant.
      const lambda = this.reversing || this.reverseTimer > 0
        ? 2.4
        : 3.0 * Math.min(1, Math.abs(speed) / 10);
      if (lambda > 0.001) this.yaw = dampAngle(this.yaw, target, lambda, dt);
    }
  }

  private resetChase(): void {
    this.accel = 0;
    this.lastSpeed = 0;
    this.yawRate = 0;
    this.hasLastHeading = false;
    this.reversing = false;
    this.reverseTimer = 0;
    this.lagBoom = 0;
    this.swing = 0;
    this._fwd.set(0, 0, 1);
  }

  /* ------------------------------------------------------------------ */
  /* Floor / subject clamps                                              */
  /* ------------------------------------------------------------------ */

  /**
   * True when whatever the collision ray hit is too thin to be worth reacting
   * to — a lamp post, a bollard, a sign pole, a catenary mast.
   *
   * A ray-based boom cannot tell a street lamp from a building: it just sees
   * "something is in the way" and slams the camera up against it, which on a
   * lamp-lined boulevard means the frame is a close-up of a pole several times
   * a second. Measuring the obstruction by firing a second ray back down the
   * boom costs one extra cast, and only when there was a hit at all.
   */
  private isThinObstacle(nearDist: number, boomLen: number, dir: THREE.Vector3): boolean {
    this._probe.copy(this._pivot).addScaledVector(dir, boomLen);
    this._tmp2.copy(dir).negate();
    const back = this.phys.raycast(
      this._probe,
      this._tmp2,
      boomLen,
      probeGroups(CG.STATIC | CG.TERRAIN),
    );
    // No far surface => the camera is inside the solid. Definitely not thin.
    if (!back) return false;
    const thickness = boomLen - nearDist - back.distance;
    return thickness < 0.7;
  }

  /**
   * Raise `p` so it can never sit below the walkable surface underneath it.
   *
   * Two sources, whichever is higher:
   *  - `CityService.spatial.groundHeight`, which already returns the kerb top
   *    on a footway, so the camera clears raised pavements as well as tarmac;
   *  - a physics probe straight down from just above the camera, which catches
   *    anything the analytic query does not model (ramps, plinths, bridges).
   *
   * The probe starts *above* the camera on purpose: starting at the camera
   * would miss the floor entirely once the camera is already through it, which
   * is precisely the case we have to recover from.
   */
  private clampToFloor(p: THREE.Vector3): void {
    let floor = -Infinity;

    const g = this.city?.spatial.groundHeight(p.x, p.z);
    if (g !== undefined && Number.isFinite(g)) floor = g;

    this._probe.set(p.x, p.y + FLOOR_PROBE_UP, p.z);
    const hit = this.phys.raycast(
      this._probe,
      CameraSystem.DOWN,
      FLOOR_PROBE_LENGTH,
      probeGroups(CG.STATIC | CG.TERRAIN),
    );
    if (hit) {
      const surface = this._probe.y - hit.distance;
      // Only trust the probe when it found something at or below the camera's
      // own level plus the probe offset — a hit far above is a ceiling.
      if (surface > floor) floor = surface;
    }

    if (Number.isFinite(floor) && p.y < floor + FLOOR_MARGIN) p.y = floor + FLOOR_MARGIN;
  }

  /**
   * Push the camera back out along the view axis if it ended up closer to the
   * subject than `minRadius`. Without this the floor clamp can shorten the
   * boom until the camera is inside the player's own head, and a wall behind
   * the car can do the same in a tight alley.
   */
  private ejectFromSubject(p: THREE.Vector3, pivot: THREE.Vector3, minRadius: number): void {
    this._tmp.subVectors(p, pivot);
    const d = this._tmp.length();
    if (d >= minRadius) return;
    if (d < 1e-4) {
      // Degenerate: fall back to the rig's own backward axis.
      this._tmp.copy(this._dir);
    } else {
      this._tmp.divideScalar(d);
    }
    p.copy(pivot).addScaledVector(this._tmp, minRadius);
    this.clampToFloor(p);
  }

  /* ================================================================== *
   * CINEMATIC DIRECTION                                                *
   * ================================================================== */

  playShot(spec: CinematicShot): boolean {
    if (this.photo) return false;
    const priority = spec.priority ?? 0;
    if (this.shot && priority < this.shot.priority) return false;
    if (this.shot) this.endShot();

    const dur = Math.max(0.4, spec.duration ?? 3.0);
    const distance = spec.distance ?? 9;
    const height = spec.height ?? 2.6;
    const lookHeight = spec.lookHeight ?? 1.1;
    const fov = spec.fov ?? 42;

    const look = spec.target.clone();
    look.y = this.groundAt(look.x, look.z) + lookHeight;

    const from = this.pickShotSpot(look, distance, height, spec.azimuthDeg);

    // The move. `push` runs along the horizontal eye line so a positive number
    // always closes on the subject whatever side the sweep picked, and `rise`
    // is the only thing allowed to change height — a push that also drifted
    // vertically would read as a crane, which is a different shot.
    this._tmp.subVectors(look, from);
    this._tmp.y = 0;
    const flat = this._tmp.length();
    if (flat > 1e-3) this._tmp.divideScalar(flat);
    else this._tmp.set(0, 0, 1);
    const to = from.clone().addScaledVector(this._tmp, spec.push ?? 0);
    to.y += spec.rise ?? 0;
    this.clampToFloor(to);

    const player = this.ctx.tryGet(Services.Player);
    const speed = player?.inVehicle ? Math.abs(player.inVehicle.speed) : 0;
    // Taking the controls off a car doing 25 m/s puts it into a shopfront
    // while the player is reading a title card, so a fast drive gets the bars
    // and the card but keeps its hands on the wheel.
    const held = spec.hold ?? (player ? player.isOnFoot || speed < 6 : false);
    if (held) {
      this.inputWasEnabled = this.ctx.input.enabled;
      this.ctx.input.enabled = false;
    }

    this.shot = {
      spec,
      t: 0,
      dur,
      from,
      to,
      look,
      lookHeight,
      fov,
      roll: THREE.MathUtils.degToRad(spec.rollDeg ?? 0),
      held,
      priority,
    };

    this.showBars(spec.bars ?? true, spec.title ?? '', spec.subtitle ?? '');
    this.installSkip();
    return true;
  }

  climax(key: string, at?: THREE.Vector3): boolean {
    if (key.startsWith('start:')) {
      const id = key.slice(6);
      const preset = START_SHOTS[id];
      if (!preset) return false;
      return this.playShotAt({ title: ACT_TITLES[id] ?? '', ...preset }, at ?? null);
    }
    const preset = CLIMAX_SHOTS[key] ?? START_SHOTS[key];
    if (!preset) return false;
    return this.playShotAt(preset, at ?? null);
  }

  /** Frame `at`, or the player when it is null. */
  private playShotAt(preset: ShotPreset, at: THREE.Vector3 | null): boolean {
    const player = this.ctx.tryGet(Services.Player);
    const target = at ? at.clone() : player?.position.clone();
    if (!target) return false;
    const follow = at
      ? null
      : (player?.inVehicle?.object ?? player?.character.object ?? null);
    return this.playShot({ ...preset, target, follow });
  }

  skipShot(): void {
    if (this.shot) this.endShot();
  }

  /** True while the shot owns the camera this frame. */
  private updateShot(dt: number, ctx: GameContext): boolean {
    const s = this.shot;
    if (!s) return false;
    s.t += dt;
    const u = THREE.MathUtils.clamp(s.t / s.dur, 0, 1);
    // Slow in, slow out. A linear dolly reads as a machine; this reads as an
    // operator easing off the wheel at both ends.
    const e = u * u * u * (u * (u * 6 - 15) + 10);

    if (s.spec.follow) {
      s.look.copy(s.spec.follow.position);
      s.look.y += s.lookHeight;
    }

    this._desired.lerpVectors(s.from, s.to, e);
    this.clampToFloor(this._desired);
    ctx.camera.position.copy(this._desired);
    ctx.camera.up.set(0, 1, 0);
    ctx.camera.lookAt(s.look);
    // The dutch eases in over the shot rather than being present from frame
    // one, which is the difference between a tilted camera and a tilting one.
    if (s.roll !== 0) ctx.camera.rotateZ(s.roll * (0.35 + 0.65 * e));

    if (Math.abs(ctx.camera.fov - s.fov) > 0.01) {
      ctx.camera.fov = s.fov;
      ctx.camera.updateProjectionMatrix();
    }

    if (u >= 1) this.endShot();
    // The handover is a CUT, not a glide: the spring state is deliberately
    // left where gameplay had it, so control returns on the next frame in the
    // frame the player last had rather than swooping back across the street.
    return true;
  }

  private endShot(): void {
    const s = this.shot;
    this.shot = null;
    if (!s) return;
    if (s.held) this.ctx.input.enabled = this.inputWasEnabled;
    this.showBars(false, '', '');
    this.removeSkip();
    this.currentFov = this.ctx.camera.fov;
  }

  /**
   * Where to stand. Sweeps azimuths around the subject and keeps the one with
   * the longest clear eye-line, exactly like `DebugApi.frameLandmark` — a
   * hardcoded offset lands inside a building the first time the city moves,
   * and a mission beat cannot afford to be shot from inside a wall.
   */
  private pickShotSpot(
    look: THREE.Vector3,
    distance: number,
    height: number,
    azimuthDeg?: number,
  ): THREE.Vector3 {
    const cand = new THREE.Vector3();
    let best: THREE.Vector3 | null = null;
    let bestClear = -1;

    const fixed = azimuthDeg !== undefined;
    const az0 = fixed ? THREE.MathUtils.degToRad(azimuthDeg) : this.shotRng.next() * Math.PI * 2;
    const steps = fixed ? 1 : 12;

    for (const scale of [1, 0.72, 1.35]) {
      for (let i = 0; i < steps; i++) {
        const az = az0 + (i / steps) * Math.PI * 2;
        const d = distance * scale;
        cand.set(look.x + Math.sin(az) * d, 0, look.z + Math.cos(az) * d);
        cand.y = this.groundAt(cand.x, cand.z) + height;
        this.clampToFloor(cand);

        // Buried in geometry? A surface immediately overhead is a ceiling and
        // fine; a hit at zero means the camera is inside the solid.
        const up = this.phys.raycast(cand, CameraSystem.UP, 40, probeGroups(CG.STATIC | CG.TERRAIN));
        if (up && up.distance < 0.5) continue;

        this._tmp2.subVectors(look, cand);
        const dist = this._tmp2.length();
        if (dist < 0.5) continue;
        this._tmp2.divideScalar(dist);
        const hit = this.phys.raycast(cand, this._tmp2, dist, probeGroups(CG.STATIC | CG.TERRAIN));
        const clear = hit ? hit.distance : dist;
        if (clear < dist * 0.85) continue;

        if (clear > bestClear) {
          bestClear = clear;
          best = cand.clone();
        }
      }
      if (best) break;
    }

    return best ?? cand.set(look.x, look.y + height, look.z + distance).clone();
  }

  private groundAt(x: number, z: number): number {
    const g = this.city?.spatial.groundHeight(x, z);
    return g !== undefined && g > -1e5 ? g : 0;
  }

  /* ---- letterbox + title card ---- */

  private buildCineDom(): void {
    const host = typeof document !== 'undefined' ? document.getElementById('ui-root') : null;
    if (!host) return;

    const style = document.createElement('style');
    style.textContent = CINE_CSS + PHOTO_CSS;
    host.appendChild(style);

    const root = document.createElement('div');
    root.className = 'gta-cine';
    root.innerHTML =
      '<div class="gta-cine-bar top"></div>' +
      '<div class="gta-cine-bar bottom"></div>' +
      '<div class="gta-cine-card"><div class="t"></div><div class="s"></div></div>';
    host.appendChild(root);

    this.cine = {
      root,
      card: root.querySelector('.gta-cine-card') as HTMLElement,
      title: root.querySelector('.gta-cine-card .t') as HTMLElement,
      sub: root.querySelector('.gta-cine-card .s') as HTMLElement,
    };
  }

  private showBars(on: boolean, title: string, sub: string): void {
    const c = this.cine;
    if (!c) return;
    c.root.classList.toggle('on', on);
    c.title.textContent = title;
    c.sub.textContent = sub;
    c.card.classList.toggle('on', on && (title !== '' || sub !== ''));
  }

  /* ---- skip ---- */

  private skipHandler: ((e: Event) => void) | null = null;

  private installSkip(): void {
    if (typeof window === 'undefined' || this.skipHandler) return;
    const h = (): void => {
      // A short grace window: the very press that started the beat must not
      // also dismiss it.
      if (this.shot && this.shot.t > 0.4) this.skipShot();
    };
    this.skipHandler = h;
    window.addEventListener('keydown', h);
    window.addEventListener('mousedown', h);
  }

  private removeSkip(): void {
    const h = this.skipHandler;
    if (!h || typeof window === 'undefined') return;
    window.removeEventListener('keydown', h);
    window.removeEventListener('mousedown', h);
    this.skipHandler = null;
  }

  /* ================================================================== *
   * PHOTO MODE                                                         *
   * ================================================================== */

  setPhotoMode(on: boolean): void {
    if (on === (this.photo !== null)) return;
    if (on) this.enterPhoto();
    else this.exitPhoto();
  }

  private enterPhoto(): void {
    const ctx = this.ctx;
    if (this.shot) this.endShot();

    // Start exactly where the gameplay camera is, so opening photo mode never
    // moves the picture the player was already looking at.
    const cam = ctx.camera;
    this._tmp.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const yaw = Math.atan2(-this._tmp.x, -this._tmp.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(this._tmp.y, -1, 1));

    this.photo = {
      pos: cam.position.clone(),
      yaw,
      pitch,
      roll: 0,
      fov: cam.fov,
      focus: 22,
      blur: 0,
      filter: 0,
      grid: false,
      bars: false,
      clean: false,
      prevMode: this._mode,
      prevFov: cam.fov,
      prevInputEnabled: ctx.input.enabled,
    };

    this._mode = 'photo';
    ctx.input.enabled = false;

    /* THE MARKERS ARE WORLD GEOMETRY, NOT HUD.
     *
     * Hiding `#ui-root` deals with the health bar and the minimap, but the
     * violet rings and floating diamonds over every interactable are meshes
     * in the scene, and they were the loudest thing in the first frame this
     * mode ever produced — a bright pink diamond parked over the hero's head
     * in a photograph. `setEnabled(false)` is the contract's own way to take
     * one out of the world, so photo mode takes them ALL out and puts back
     * exactly the set it found. */
    const it = ctx.tryGet(Services.Interaction);
    if (it) {
      this.hiddenMarkers = it.ids();
      for (const id of this.hiddenMarkers) it.setEnabled(id, false);
    }

    this.buildPhotoDom();
    document.getElementById('ui-root')?.classList.add('gta-photo-on');
    this.lookSig = '';
    this.applyPhotoLook();
  }

  private exitPhoto(): void {
    const st = this.photo;
    if (!st) return;
    this.photo = null;
    this.photoKeys.clear();
    this.photoPressed.clear();
    const ctx = this.ctx;

    const it = ctx.tryGet(Services.Interaction);
    if (it) {
      // Only what we hid, and only if it is still registered — the world may
      // have removed a mission marker while the shutter was open.
      for (const id of this.hiddenMarkers) {
        if (it.has(id)) it.setEnabled(id, true);
      }
    }
    this.hiddenMarkers = [];

    ctx.input.enabled = st.prevInputEnabled;
    this._mode = st.prevMode;
    ctx.camera.fov = st.prevFov;
    ctx.camera.updateProjectionMatrix();
    ctx.camera.up.set(0, 1, 0);
    this.currentFov = st.prevFov;
    // The gameplay rig re-derives its yaw from the mouse, but its pitch is
    // state; carry the photo pitch back so the handover is not a snap.
    this.pitch = THREE.MathUtils.clamp(-st.pitch, -0.72, 1.05);
    document.getElementById('ui-root')?.classList.remove('gta-photo-on', 'gta-photo-clean');
    this.photoDom?.root.remove();
    this.photoDom = null;
  }

  private updatePhoto(dt: number, ctx: GameContext): void {
    const st = this.photo!;
    const keys = this.photoKeys;
    const hit = this.photoPressed;

    /* ---- discrete controls ---- */
    if (hit.has('KeyP') || hit.has('Escape')) {
      this.exitPhoto();
      hit.clear();
      return;
    }
    if (hit.has('KeyF')) st.filter = (st.filter + 1) % PHOTO_FILTERS.length;
    if (hit.has('KeyG')) st.grid = !st.grid;
    if (hit.has('KeyB')) st.bars = !st.bars;
    if (hit.has('KeyH')) st.clean = !st.clean;
    if (hit.has('Digit0') || hit.has('Backspace')) {
      st.roll = 0;
      st.fov = 52;
      st.blur = 0;
      st.focus = 22;
    }

    /* ---- continuous controls ---- */
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const slow = keys.has('ControlLeft') || keys.has('ControlRight');
    const speed = PHOTO_SPEED * (fast ? PHOTO_FAST : 1) * (slow ? PHOTO_SLOW : 1);

    if (keys.has('Comma')) st.fov = Math.max(12, st.fov - 26 * dt);
    if (keys.has('Period')) st.fov = Math.min(96, st.fov + 26 * dt);
    if (keys.has('BracketLeft')) st.roll = Math.max(-0.7, st.roll - 0.6 * dt);
    if (keys.has('BracketRight')) st.roll = Math.min(0.7, st.roll + 0.6 * dt);
    if (keys.has('Minus')) st.focus = Math.max(1.5, st.focus - (st.focus * 0.9 + 2) * dt);
    if (keys.has('Equal')) st.focus = Math.min(260, st.focus + (st.focus * 0.9 + 2) * dt);
    if (keys.has('Semicolon')) st.blur = Math.max(0, st.blur - 9 * dt);
    if (keys.has('Quote')) st.blur = Math.min(18, st.blur + 9 * dt);

    /* ---- free camera ---- */
    this._euler.set(st.pitch, st.yaw, st.roll, 'YXZ');
    const q = ctx.camera.quaternion.setFromEuler(this._euler);
    this._fwd.set(0, 0, -1).applyQuaternion(q);
    this._right.set(1, 0, 0).applyQuaternion(q);

    const fwdIn = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const sideIn = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const upIn = (keys.has('Space') || keys.has('KeyE') ? 1 : 0)
      - (keys.has('KeyC') || keys.has('KeyQ') ? 1 : 0);

    if (fwdIn || sideIn || upIn) {
      st.pos.addScaledVector(this._fwd, fwdIn * speed * dt);
      st.pos.addScaledVector(this._right, sideIn * speed * dt);
      st.pos.y += upIn * speed * dt;
      this.clampToFloor(st.pos);
    }

    ctx.camera.position.copy(st.pos);
    if (Math.abs(ctx.camera.fov - st.fov) > 0.005) {
      ctx.camera.fov = st.fov;
      ctx.camera.updateProjectionMatrix();
    }

    // The spring's POSITION is deliberately left where gameplay parked it, so
    // closing photo mode is an instant cut back to the player rather than a
    // several-second swoop in from wherever the free camera wandered to. Only
    // the FOV is carried across, because that one does want to ease.
    this.currentFov = st.fov;

    // Real depth of field, for the moment `postfx.ts` turns its DoF pass back
    // on. It is a no-op today (`this.dof = null` there) — the visible focus in
    // photo mode is the masked blur below.
    const render = ctx.tryGet(Services.Render) as unknown as { setFocusDistance?(m: number): void } | undefined;
    render?.setFocusDistance?.(st.focus);

    this.applyPhotoLook();
    hit.clear();
  }

  /* ---- photo input: our own listeners, because `Input` is switched off ---- */

  private photoKeys = new Set<string>();
  private photoPressed = new Set<string>();

  private installPhotoKeys(ctx: GameContext): void {
    if (typeof window === 'undefined') return;

    const onDown = (e: KeyboardEvent): void => {
      if (!this.photo) return;
      // Leave the browser its F-keys: swallowing F5 and F12 in a mode whose
      // whole job is producing screenshots would be a poor trade.
      if (e.code.startsWith('F') && e.code.length <= 3) return;
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      this.photoKeys.add(e.code);
      this.photoPressed.add(e.code);
      // Escape would otherwise also reach the pause menu, and Space would
      // scroll the page. Photo mode owns the keyboard while it is open.
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onUp = (e: KeyboardEvent): void => {
      // Always release, even if photo mode closed between the press and the
      // release — otherwise leaving the mode with W held leaves W "held" and
      // the free camera walks off on its own the next time it opens.
      this.photoKeys.delete(e.code);
      if (!this.photo) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMove = (e: MouseEvent): void => {
      const st = this.photo;
      if (!st) return;
      if (document.pointerLockElement !== ctx.canvas) return;
      st.yaw -= e.movementX * PHOTO_LOOK;
      st.pitch = THREE.MathUtils.clamp(st.pitch - e.movementY * PHOTO_LOOK, -1.45, 1.45);
    };
    const onBlur = (): void => this.photoKeys.clear();

    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('blur', onBlur);
  }

  /* ---- photo presentation ---- */

  private buildPhotoDom(): void {
    const host = document.getElementById('ui-root');
    if (!host) return;
    const root = document.createElement('div');
    root.className = 'gta-photo-fx';
    root.innerHTML =
      '<div class="pf-focus"></div>' +
      '<div class="pf-filter"></div>' +
      '<div class="pf-wash"></div>' +
      '<div class="pf-grain"></div>' +
      '<div class="pf-vig"></div>' +
      '<div class="pf-bars"><i class="t"></i><i class="b"></i></div>' +
      '<div class="pf-ui">' +
      '<div class="pf-grid"></div>' +
      '<div class="pf-read"></div>' +
      `<div class="pf-legend">${PHOTO_LEGEND}</div>` +
      '</div>';
    host.appendChild(root);
    this.photoDom = {
      root,
      focus: root.querySelector('.pf-focus') as HTMLElement,
      filter: root.querySelector('.pf-filter') as HTMLElement,
      wash: root.querySelector('.pf-wash') as HTMLElement,
      grain: root.querySelector('.pf-grain') as HTMLElement,
      vig: root.querySelector('.pf-vig') as HTMLElement,
      bars: root.querySelector('.pf-bars') as HTMLElement,
      grid: root.querySelector('.pf-grid') as HTMLElement,
      read: root.querySelector('.pf-read') as HTMLElement,
    };
  }

  /** Signature of everything the DOM pass depends on, to skip no-op frames. */
  private lookSig = '';

  private applyPhotoLook(): void {
    const st = this.photo;
    const d = this.photoDom;
    if (!st || !d) return;

    // Rebuilding five style strings and an innerHTML sixty times a second is
    // real main-thread work for a screen that changes when a key is held.
    const band = st.blur > 0.05 ? Math.round(this.focusBandCentre(st)) : -1;
    const sig = `${st.filter}|${st.grid}|${st.bars}|${st.clean}|${band}|` +
      `${st.blur.toFixed(1)}|${st.fov.toFixed(1)}|${st.roll.toFixed(3)}|${st.focus.toFixed(1)}`;
    if (sig === this.lookSig) return;
    this.lookSig = sig;

    const f = PHOTO_FILTERS[st.filter];

    d.filter.style.backdropFilter = f.css;
    (d.filter.style as unknown as Record<string, string>).webkitBackdropFilter = f.css;

    if (f.wash) {
      d.wash.style.background = f.wash[0];
      d.wash.style.mixBlendMode = f.wash[1];
      d.wash.style.opacity = String(f.wash[2]);
    } else {
      d.wash.style.opacity = '0';
    }
    d.vig.style.opacity = String(f.vignette);
    d.grain.style.opacity = String(f.grain);
    d.grid.style.display = st.grid ? '' : 'none';
    d.bars.style.opacity = st.bars ? '1' : '0';

    /* FOCUS BAND.
     *
     * Depth of field needs depth, and the post chain's DoF pass is disabled.
     * What is available is the geometry: the ground point `focus` metres in
     * front of the lens projects to a screen row, and everything far from
     * that row on screen is, for a street photograph, also far from it in the
     * world. So the blur is masked to a band centred on that projected row —
     * which behaves the way a focus ring behaves (rack out and the sharp band
     * climbs toward the horizon) without a depth buffer. */
    if (st.blur > 0.05) {
      const half = THREE.MathUtils.clamp(9 + st.focus * 0.05, 8, 18);
      const a = Math.max(0, band - half);
      const b = Math.min(100, band + half);
      d.focus.style.display = '';
      d.focus.style.backdropFilter = `blur(${st.blur.toFixed(1)}px)`;
      (d.focus.style as unknown as Record<string, string>).webkitBackdropFilter =
        `blur(${st.blur.toFixed(1)}px)`;
      const mask =
        `linear-gradient(to bottom, #000 0%, #000 ${Math.max(0, a - 12).toFixed(1)}%,` +
        ` transparent ${a.toFixed(1)}%, transparent ${b.toFixed(1)}%,` +
        ` #000 ${Math.min(100, b + 12).toFixed(1)}%, #000 100%)`;
      d.focus.style.maskImage = mask;
      (d.focus.style as unknown as Record<string, string>).webkitMaskImage = mask;
    } else {
      d.focus.style.display = 'none';
    }

    if (!st.clean) {
      const roll = THREE.MathUtils.radToDeg(st.roll);
      d.read.innerHTML =
        `<b>FOTO</b><span class="f">${f.name}</span>` +
        `<span>FOV <b>${st.fov.toFixed(0)}°</b></span>` +
        `<span>ÎNCLINARE <b>${roll >= 0 ? '+' : ''}${roll.toFixed(1)}°</b></span>` +
        `<span>FOCUS <b>${st.focus.toFixed(1)} m</b></span>` +
        `<span>BLUR <b>${st.blur.toFixed(1)}</b></span>`;
    }
    document.getElementById('ui-root')?.classList.toggle('gta-photo-clean', st.clean);
  }

  /** Screen row (0..100, top to bottom) of the ground at the focus distance. */
  private focusBandCentre(st: PhotoState): number {
    const cam = this.ctx.camera;
    this._tmp.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._tmp.y = 0;
    if (this._tmp.lengthSq() < 1e-6) return 50;
    this._tmp.normalize();
    this._tmp2.copy(st.pos).addScaledVector(this._tmp, st.focus);
    this._tmp2.y = this.groundAt(this._tmp2.x, this._tmp2.z);
    this._tmp2.project(cam);
    return THREE.MathUtils.clamp((1 - this._tmp2.y) * 50, 0, 100);
  }

  /* ---- harness ---- */

  private installDebugHook(): void {
    if (typeof window === 'undefined') return;
    (window as unknown as { __GTA_CAM__: unknown }).__GTA_CAM__ = {
      state: () => ({
        mode: this._mode,
        photo: this.photo
          ? {
            fov: Math.round(this.photo.fov * 10) / 10,
            rollDeg: Math.round(THREE.MathUtils.radToDeg(this.photo.roll) * 10) / 10,
            focus: Math.round(this.photo.focus * 10) / 10,
            blur: Math.round(this.photo.blur * 10) / 10,
            filter: PHOTO_FILTERS[this.photo.filter].name,
            clean: this.photo.clean,
            grid: this.photo.grid,
            bars: this.photo.bars,
            pos: this.photo.pos.toArray().map((v) => Math.round(v * 10) / 10),
          }
          : null,
        shot: this.shot
          ? {
            t: Math.round(this.shot.t * 100) / 100,
            dur: this.shot.dur,
            held: this.shot.held,
            title: this.shot.spec.title ?? '',
          }
          : null,
      }),
      /** Named story beats: 'start:act1_evacuare', 'act3_termsheet', 'busted'… */
      shot: (key: string) => this.climax(key),
      shots: () => ({ start: Object.keys(START_SHOTS), climax: Object.keys(CLIMAX_SHOTS) }),
      skip: () => this.skipShot(),
      photo: (on: boolean) => this.setPhotoMode(on),
      /** Drive photo mode without a keyboard, for scripted screenshots. */
      set: (p: Partial<{ fov: number; rollDeg: number; focus: number; blur: number; filter: number; clean: boolean; grid: boolean; bars: boolean; yaw: number; pitch: number }>) => {
        const st = this.photo;
        if (!st) return false;
        if (p.fov !== undefined) st.fov = THREE.MathUtils.clamp(p.fov, 12, 96);
        if (p.rollDeg !== undefined) st.roll = THREE.MathUtils.degToRad(p.rollDeg);
        if (p.focus !== undefined) st.focus = Math.max(1.5, p.focus);
        if (p.blur !== undefined) st.blur = THREE.MathUtils.clamp(p.blur, 0, 18);
        if (p.filter !== undefined) st.filter = ((p.filter % PHOTO_FILTERS.length) + PHOTO_FILTERS.length) % PHOTO_FILTERS.length;
        if (p.clean !== undefined) st.clean = p.clean;
        if (p.grid !== undefined) st.grid = p.grid;
        if (p.bars !== undefined) st.bars = p.bars;
        if (p.yaw !== undefined) st.yaw = p.yaw;
        if (p.pitch !== undefined) st.pitch = THREE.MathUtils.clamp(p.pitch, -1.45, 1.45);
        this.applyPhotoLook();
        return true;
      },
      /** Move the free camera relative to where it is looking. */
      move: (forward = 0, right = 0, up = 0) => {
        const st = this.photo;
        if (!st) return false;
        this._euler.set(st.pitch, st.yaw, st.roll, 'YXZ');
        const q = new THREE.Quaternion().setFromEuler(this._euler);
        st.pos.addScaledVector(this._fwd.set(0, 0, -1).applyQuaternion(q), forward);
        st.pos.addScaledVector(this._right.set(1, 0, 0).applyQuaternion(q), right);
        st.pos.y += up;
        this.clampToFloor(st.pos);
        return true;
      },
      filters: () => PHOTO_FILTERS.map((f) => f.name),
    };
  }

  private static readonly UP = new THREE.Vector3(0, 1, 0);
}

/* ------------------------------------------------------------------ */
/* Internal shapes                                                     */
/* ------------------------------------------------------------------ */

interface ActiveShot {
  spec: CinematicShot;
  t: number;
  dur: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  look: THREE.Vector3;
  lookHeight: number;
  fov: number;
  roll: number;
  held: boolean;
  priority: number;
}

interface CineDom {
  root: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
}

interface PhotoState {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  fov: number;
  focus: number;
  blur: number;
  filter: number;
  grid: boolean;
  bars: boolean;
  clean: boolean;
  prevMode: CameraService['mode'];
  prevFov: number;
  prevInputEnabled: boolean;
}

interface PhotoDom {
  root: HTMLElement;
  focus: HTMLElement;
  filter: HTMLElement;
  wash: HTMLElement;
  grain: HTMLElement;
  vig: HTMLElement;
  bars: HTMLElement;
  grid: HTMLElement;
  read: HTMLElement;
}

const PHOTO_LEGEND = [
  '<b>WASD</b> mișcare · <b>Space/C</b> sus-jos · <b>Shift</b> rapid · <b>Ctrl</b> lent',
  '<b>,</b> <b>.</b> unghi · <b>[</b> <b>]</b> înclinare · <b>−</b> <b>=</b> focus · <b>;</b> <b>\'</b> blur',
  '<b>F</b> filtru · <b>G</b> grilă · <b>B</b> benzi · <b>H</b> ascunde interfața · <b>0</b> reset · <b>P</b> ieșire',
].join('<br>');

const CINE_CSS = `
.gta-cine{position:absolute;inset:0;pointer-events:none;z-index:30;}
.gta-cine-bar{position:absolute;left:0;right:0;height:0;background:#000;
  transition:height .55s cubic-bezier(.16,.84,.3,1);}
.gta-cine-bar.top{top:0;}
.gta-cine-bar.bottom{bottom:0;}
.gta-cine.on .gta-cine-bar{height:10.5%;}
.gta-cine-card{position:absolute;left:5.2%;bottom:14%;opacity:0;transform:translateY(10px);
  transition:opacity .5s ease,transform .5s cubic-bezier(.16,.84,.3,1);
  font-family:Inter,system-ui,sans-serif;text-shadow:0 2px 18px rgba(0,0,0,.85);max-width:64%;}
.gta-cine-card.on{opacity:1;transform:translateY(0);}
.gta-cine-card .t{font-weight:900;font-size:40px;line-height:1.02;letter-spacing:.09em;
  color:#fff;text-transform:uppercase;}
.gta-cine-card .t:not(:empty){border-left:4px solid #ff3d7f;padding-left:16px;}
.gta-cine-card .s{margin-top:9px;font-weight:600;font-size:17px;letter-spacing:.04em;
  color:#e6d8ff;padding-left:20px;}
`;

const PHOTO_CSS = `
#ui-root.gta-photo-on > *:not(.gta-photo-fx){display:none !important;}
#ui-root.gta-photo-on.gta-photo-clean .pf-ui{display:none !important;}
.gta-photo-fx{position:absolute;inset:0;pointer-events:none;z-index:35;}
.gta-photo-fx > div{position:absolute;inset:0;}
.pf-focus{-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;}
.pf-vig{background:radial-gradient(ellipse 78% 74% at 50% 50%,
  rgba(0,0,0,0) 38%, rgba(24,8,44,.55) 78%, rgba(8,2,16,.95) 100%);}
.pf-grain{background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/></filter><rect width='180' height='180' filter='url(%23n)' opacity='0.55'/></svg>");
  mix-blend-mode:overlay;}
.pf-bars{opacity:0;transition:opacity .3s;}
.pf-bars i{position:absolute;left:0;right:0;height:10.5%;background:#000;display:block;}
.pf-bars i.t{top:0;} .pf-bars i.b{bottom:0;}
/* The rule above only reaches DIRECT children of .gta-photo-fx, and the grid
   lives inside .pf-ui — without its own box it had no size and drew nothing. */
.pf-grid{position:absolute;inset:0;background:
  linear-gradient(to right, transparent 33.2%, rgba(255,255,255,.22) 33.2%, rgba(255,255,255,.22) 33.4%, transparent 33.4%,
   transparent 66.5%, rgba(255,255,255,.22) 66.5%, rgba(255,255,255,.22) 66.7%, transparent 66.7%),
  linear-gradient(to bottom, transparent 33.2%, rgba(255,255,255,.22) 33.2%, rgba(255,255,255,.22) 33.4%, transparent 33.4%,
   transparent 66.5%, rgba(255,255,255,.22) 66.5%, rgba(255,255,255,.22) 66.7%, transparent 66.7%);}
.pf-read{position:absolute;inset:auto auto 24px 26px;display:flex;gap:16px;align-items:baseline;
  padding:9px 16px;background:rgba(12,5,22,.74);border-left:3px solid #ff3d7f;border-radius:2px;
  font:600 12px/1 Inter,system-ui,sans-serif;letter-spacing:.09em;color:#cdb9e8;
  text-transform:uppercase;text-shadow:0 1px 4px #000;white-space:nowrap;}
.pf-read b{color:#fff;font-weight:800;}
.pf-read .f{color:#ff5d95;font-weight:900;letter-spacing:.16em;}
.pf-legend{position:absolute;inset:auto 26px 24px auto;text-align:right;
  font:500 11.5px/1.85 Inter,system-ui,sans-serif;letter-spacing:.05em;
  color:rgba(226,212,255,.62);text-shadow:0 1px 4px #000;}
.pf-legend b{color:#f6ecff;font-weight:800;}
`;

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}
