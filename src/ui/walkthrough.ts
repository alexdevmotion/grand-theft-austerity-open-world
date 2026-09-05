/**
 * THE WALKTHROUGH — a first-time player's first two minutes.
 *
 * The front-end teaches the keys on the launch curtain, but reading a list is
 * not the same as having done it. This system coaches one step at a time in the
 * world itself and watches for proof: it measures metres walked, radians looked,
 * seconds sprinted, whether an E press hit something, whether the player got
 * into a car and drove it, whether the map and the pause menu were ever opened.
 *
 * RULES IT KEEPS
 *   - Only on a genuine first run. `game:started` carries `firstRun`, which the
 *     front-end sets from the same save state that enables CONTINUE.
 *   - It never blocks. Every step has a patience (`WALK_STEPS[i].seconds`); when
 *     that runs out the guide moves on without comment.
 *   - It gets out of the way. Finishing a mission ends it early — a player who
 *     just completed an objective does not need to be told what E does.
 *   - It is not in the way. Right flank, `pointer-events: none`; the left column
 *     is the minimap and the stats, the centre is subtitles and mission cards.
 *
 * The steps, their copy and their completion rules are data in
 * `walkthroughSteps.ts`; this file is the measuring and the DOM.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services } from '../core/services';
import { hintRows } from '../core/keyHints';
import { t } from '../core/i18n';
import {
  WALK_STEPS,
  noSignals,
  stepCounter,
  stepOutcome,
  type WalkSignals,
  type WalkStep,
} from './walkthroughSteps';

/** Seconds the cleared step stays up with its tick before the next one. */
const CLEARED_SECONDS = 1.3;
/** Seconds of grace after the curtain, so the card is not part of the fade. */
const OPENING_DELAY = 1.2;

const _pos = new THREE.Vector3();

export class WalkthroughSystem implements System {
  readonly name = 'walkthrough';
  /** After the HUD (420) and the minimap (425), before the pause menu (440). */
  readonly order = 430;

  private ctx!: GameContext;
  private el: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private offs: Array<() => void> = [];

  private active = false;
  private index = -1;
  private elapsed = 0;
  private clearedFor = -1;
  private delay = 0;
  private signals: WalkSignals = noSignals();
  private last = new THREE.Vector3();
  private hasLast = false;
  /** Raised by events between frames, folded into `signals` on update. */
  private sawInteract = false;
  private sawVehicle = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.offs.push(
      ctx.events.on('game:started', ({ firstRun }) => {
        if (firstRun) this.begin();
      }),
      ctx.events.on('player:interact', () => {
        this.sawInteract = true;
      }),
      ctx.events.on('player:enteredVehicle', () => {
        this.sawVehicle = true;
      }),
      // Someone who just finished an objective is not a beginner any more.
      ctx.events.on('mission:complete', () => this.finish()),
      ctx.events.on('player:died', () => this.finish()),
    );
    this.installDebugHook();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  begin(): void {
    if (this.active || this.index >= WALK_STEPS.length) return;
    this.active = true;
    this.delay = OPENING_DELAY;
    this.hasLast = false;
    this.build();
    this.goTo(0);
  }

  finish(): void {
    if (!this.active) return;
    this.active = false;
    this.index = WALK_STEPS.length;
    const el = this.el;
    if (!el) return;
    el.classList.remove('is-on');
    window.setTimeout(() => el.remove(), 500);
    this.el = null;
  }

  private goTo(i: number): void {
    this.index = i;
    this.elapsed = 0;
    this.clearedFor = -1;
    this.signals = noSignals();
    this.sawInteract = false;
    this.sawVehicle = false;
    if (i >= WALK_STEPS.length) {
      this.finish();
      return;
    }
    this.paint(WALK_STEPS[i], false);
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                            */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    if (!this.active) return;
    const step = WALK_STEPS[this.index];
    if (!step) return;

    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay <= 0) this.el?.classList.add('is-on');
      return;
    }

    // A cleared step holds its tick for a beat, then the next one slides in.
    if (this.clearedFor >= 0) {
      this.clearedFor += dt;
      if (this.clearedFor >= CLEARED_SECONDS) this.goTo(this.index + 1);
      return;
    }

    this.measure(dt, ctx);
    this.elapsed += dt;

    const outcome = stepOutcome(step, this.signals, this.elapsed);
    if (outcome === 'hold') return;
    if (outcome === 'timeout') {
      this.goTo(this.index + 1);
      return;
    }
    this.clearedFor = 0;
    this.paint(step, true);
  }

  /** Everything the steps are allowed to look at, measured from the live world. */
  private measure(dt: number, ctx: GameContext): void {
    const s = this.signals;
    const input = ctx.input;
    const player = ctx.tryGet(Services.Player);

    if (this.sawInteract) s.interacted = true;
    if (this.sawVehicle) s.inVehicle = true;
    if (player?.inVehicle) s.inVehicle = true;

    if (input.actionPressed('map')) s.mapOpened = true;
    if (input.actionPressed('pause')) s.pausePressed = true;

    s.lookedRadians += Math.abs(input.axes.lookX) + Math.abs(input.axes.lookY);

    const onFoot = player?.isOnFoot ?? true;
    if (onFoot && input.action('sprint') && Math.abs(input.axes.moveY) + Math.abs(input.axes.moveX) > 0.1) {
      s.sprintSeconds += dt;
    }

    if (!player) return;
    _pos.copy(player.position);
    if (this.hasLast) {
      const d = Math.hypot(_pos.x - this.last.x, _pos.z - this.last.z);
      // A teleport (respawn, debug `goTo`) is not a walk.
      if (d < 12) {
        if (onFoot) s.walkedMeters += d;
        else s.drivenMeters += d;
      }
    }
    this.last.copy(_pos);
    this.hasLast = true;
  }

  /* ---------------------------------------------------------------- */
  /* Card                                                            */
  /* ---------------------------------------------------------------- */

  private paint(step: WalkStep, cleared: boolean): void {
    const el = this.el;
    if (!el) return;
    const chips = hintRows(step.hints)
      .map(
        (r) => `<span class="gw-key">
          <span class="gw-k">${r.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}</span>
          <span class="gw-l">${escapeHtml(r.label)}</span>
        </span>`,
      )
      .join('');
    el.classList.toggle('is-cleared', cleared);
    el.innerHTML = `
      <p class="gw-kicker">${t('GHID')} · ${stepCounter(this.index)}</p>
      <h4 class="gw-title">${cleared ? '✓ ' : ''}${escapeHtml(t(step.title))}</h4>
      <div class="gw-keys">${chips}</div>
      <p class="gw-body">${escapeHtml(t(step.body))}</p>`;
  }

  private build(): void {
    if (this.el) return;
    const host = document.getElementById('ui-root') ?? document.body;

    if (!this.styleEl) {
      const style = document.createElement('style');
      style.textContent = WALKTHROUGH_CSS;
      document.head.appendChild(style);
      this.styleEl = style;
    }

    const el = document.createElement('aside');
    el.className = 'gta-walk';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    host.appendChild(el);
    this.el = el;
  }

  /* ---------------------------------------------------------------- */

  private installDebugHook(): void {
    const w = window as unknown as { __GTA_WALK__?: unknown };
    w.__GTA_WALK__ = {
      state: () => ({
        active: this.active,
        index: this.index,
        step: WALK_STEPS[this.index]?.id ?? null,
        elapsed: Math.round(this.elapsed * 10) / 10,
        signals: { ...this.signals },
      }),
      /** Verification only: run the guide without a front-end. */
      begin: () => this.begin(),
      next: () => this.goTo(this.index + 1),
      finish: () => this.finish(),
    };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.el?.remove();
    this.el = null;
    this.styleEl?.remove();
    this.styleEl = null;
    this.active = false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

/**
 * Right flank, below centre, never interactive: the click that takes the
 * pointer lock has to reach the canvas.
 */
const WALKTHROUGH_CSS = `
.gta-walk {
  position: absolute;
  z-index: 6;
  right: clamp(14px, 2.2vw, 34px);
  top: 54%;
  width: min(340px, 40vw);
  padding: 14px 16px 12px;
  background: linear-gradient(160deg, rgba(16,6,28,.9), rgba(9,3,16,.86));
  border: 1px solid rgba(255,61,127,.34);
  border-left: 3px solid #ffb020;
  box-shadow: 0 16px 44px rgba(0,0,0,.5);
  color: #f4ecff;
  font-family: Inter, system-ui, -apple-system, sans-serif;
  pointer-events: none;
  opacity: 0;
  transform: translate(22px, -50%);
  transition: opacity .34s ease, transform .34s cubic-bezier(.2,.9,.3,1), border-left-color .3s;
}
.gta-walk.is-on { opacity: 1; transform: translate(0, -50%); }
.gta-walk.is-cleared { border-left-color: #4ad6c4; }
.gta-walk .gw-kicker { margin: 0 0 3px; color: #ffb020; font: 800 9px/1 inherit; letter-spacing: .3em; }
.gta-walk.is-cleared .gw-kicker { color: #4ad6c4; }
.gta-walk .gw-title { margin: 0 0 10px; font: 800 15px/1.25 inherit; letter-spacing: .01em; }
.gta-walk .gw-keys { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.gta-walk .gw-key { display: inline-flex; align-items: center; gap: 6px; }
.gta-walk .gw-k { display: inline-flex; gap: 3px; }
.gta-walk .gw-l { font-size: 10px; color: #d9c8ee; }
.gta-walk kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; padding: 4px 6px;
  background: rgba(162,92,255,.16); border: 1px solid rgba(255,61,127,.35);
  color: #ffd9f0; font: 700 9.5px/1 ui-monospace, monospace; letter-spacing: .06em;
  white-space: nowrap;
}
.gta-walk .gw-body { margin: 10px 0 0; font: 500 11px/1.5 inherit; color: #a793c2; }
@media (max-width: 900px) { .gta-walk { width: min(260px, 60vw); } }
@media (prefers-reduced-motion: reduce) { .gta-walk { transition-duration: .01ms; } }
`;
