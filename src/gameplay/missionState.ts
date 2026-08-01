/**
 * THE MISSION STATE MACHINE — pure, and therefore testable.
 *
 * Everything about *when* a mission moves on, fails, times out, restarts or
 * completes lives here, in arithmetic over plain objects. Nothing in this file
 * imports three, the engine or a service; the world-facing half (are you in
 * the car, are you inside the radius, has the wanted level dropped) lives in
 * `missions.ts`, which asks a `MissionRun` what it is waiting for and tells it
 * when the answer arrives.
 *
 * That seam is deliberate. Mission bugs are nearly always ordering bugs —
 * completing the last objective twice, a timer that keeps running after a
 * fail, a restart that leaves the old objective's waypoint up — and none of
 * them need a GPU to reproduce. See `missionState.test.ts`.
 */

export interface Vec3Lite {
  x: number;
  y: number;
  z: number;
}

/**
 * What the world has to do for this objective to tick over.
 *
 *  interact  press E on a marker the mission placed
 *  reach     stand/drive inside a radius
 *  board     be in any vehicle, near a point
 *  flee      get at least `distance` away from a point
 *  escape    drop the Crisis Stars back to zero
 *  hold      stay inside a radius for `seconds` without leaving
 */
export type ObjectiveTrigger =
  | { kind: 'interact'; at: Vec3Lite; label: string; radius?: number }
  | { kind: 'reach'; at: Vec3Lite; radius: number }
  | { kind: 'board'; at: Vec3Lite; radius: number }
  | { kind: 'flee'; from: Vec3Lite; distance: number }
  | { kind: 'escape' }
  | { kind: 'hold'; at: Vec3Lite; radius: number; seconds: number };

export interface Say {
  speaker: string;
  text: string;
  /** Milliseconds after the objective starts. */
  delayMs?: number;
  /** Show for this long. */
  ms?: number;
}

export interface ObjectiveDef {
  id: string;
  /** The line on the HUD: "Ia serverul comunității". */
  title: string;
  /** Second line, optional. */
  hint?: string;
  trigger: ObjectiveTrigger;
  /** Seconds before the objective fails. 0/undefined = untimed. */
  timeLimit?: number;
  /** Crisis Stars forced when this objective begins. */
  stars?: number;
  /** Must be on foot / must be driving for the trigger to count. */
  onFoot?: boolean;
  inVehicle?: boolean;
  /** Authored, subtitled dialogue attached to this story beat. */
  say?: Say[];
  /** Whether `say` belongs to objective arrival or successful interaction. */
  sayAt?: 'enter' | 'complete';
  /**
   * A *Ce Ne Enervează* context to route to the audio agent, emitted as
   * `audio:oneShot { id: 'voice:<context>' }`. See src/audio/clipContexts.ts.
   */
  voice?: string;
  /** Emit `broadcast:hijacked` when this objective completes. */
  hijack?: boolean;
  /** Award on completing this objective (beats, not just missions, pay). */
  xp?: number;
}

export interface MissionDef {
  id: string;
  /** 1..4 */
  act: number;
  title: string;
  /** The mission card's second line. */
  brief: string;
  /** Mission id that must be completed first. */
  requires?: string;
  /** Where the mission is offered from. */
  startAt: Vec3Lite;
  startLabel: string;
  objectives: ObjectiveDef[];
  rewardXp: number;
  rewardLei: number;
  /** Stars applied the moment the mission starts. */
  startStars?: number;
  /** Fails when the player dies. Default true. */
  failOnDeath?: boolean;
}

export type MissionPhase = 'running' | 'complete' | 'failed';

export interface MissionSnapshot {
  id: string;
  phase: MissionPhase;
  objectiveIndex: number;
  objectiveTitle: string;
  objectiveHint: string;
  /** Seconds left on the current objective, or null when untimed. */
  timeLeft: number | null;
  /** 0..1 progress of a `hold` objective. */
  holdProgress: number;
  failReason: string;
}

/** How many objectives a definition has to have to be playable. */
export function isPlayable(def: MissionDef): boolean {
  return def.objectives.length > 0;
}

/**
 * One attempt at one mission. Construct it, poll `objective`, call
 * `satisfy()` when the world says the trigger fired, `tick(dt)` every frame,
 * and `restart()` to play it again. Nothing here mutates the definition.
 */
export class MissionRun {
  readonly def: MissionDef;

  private _phase: MissionPhase = 'running';
  private _index = 0;
  private _elapsed = 0;
  private _objElapsed = 0;
  private _hold = 0;
  private _failReason = '';
  /** Guards double-completion: the last objective can only land once. */
  private _finished = false;

  constructor(def: MissionDef) {
    if (!isPlayable(def)) throw new Error(`[mission] "${def.id}" has no objectives`);
    this.def = def;
  }

  get phase(): MissionPhase {
    return this._phase;
  }
  get index(): number {
    return this._index;
  }
  get elapsed(): number {
    return this._elapsed;
  }
  get failReason(): string {
    return this._failReason;
  }
  get isRunning(): boolean {
    return this._phase === 'running';
  }
  get objective(): ObjectiveDef {
    return this.def.objectives[Math.min(this._index, this.def.objectives.length - 1)];
  }
  get isLastObjective(): boolean {
    return this._index === this.def.objectives.length - 1;
  }
  /** Seconds left on the current objective, or null when it is untimed. */
  get timeLeft(): number | null {
    const limit = this.objective.timeLimit ?? 0;
    return limit > 0 ? Math.max(0, limit - this._objElapsed) : null;
  }
  /** 0..1 for a `hold` objective; 0 for everything else. */
  get holdProgress(): number {
    const t = this.objective.trigger;
    return t.kind === 'hold' ? Math.min(1, this._hold / t.seconds) : 0;
  }

  /**
   * Advance time. Returns `'timeout'` on the frame a time limit expires (which
   * also fails the run), otherwise null. Ticking a finished run is a no-op, so
   * a system that forgets to stop calling it cannot corrupt the result.
   */
  tick(dt: number): 'timeout' | null {
    if (this._phase !== 'running' || dt <= 0) return null;
    this._elapsed += dt;
    this._objElapsed += dt;
    const limit = this.objective.timeLimit ?? 0;
    if (limit > 0 && this._objElapsed >= limit) {
      this.fail('timp expirat');
      return 'timeout';
    }
    return null;
  }

  /**
   * Accumulate a `hold` objective. `inside` is whether the player is in the
   * zone this frame; leaving resets the progress rather than failing, so a
   * clipped corner is survivable. Returns true once the hold is satisfied.
   */
  hold(dt: number, inside: boolean): boolean {
    const t = this.objective.trigger;
    if (this._phase !== 'running' || t.kind !== 'hold') return false;
    if (inside) this._hold += dt;
    else this._hold = Math.max(0, this._hold - dt * 1.5);
    return this._hold >= t.seconds;
  }

  /**
   * The world says the current objective's trigger fired.
   *
   * Returns `'complete'` when that was the last one, `'next'` when there is
   * more to do, and `'ignored'` when the run is not in a state to accept it —
   * which is what stops a queued interaction from completing a failed mission.
   */
  satisfy(): 'next' | 'complete' | 'ignored' {
    if (this._phase !== 'running' || this._finished) return 'ignored';
    if (this.isLastObjective) {
      this._finished = true;
      this._phase = 'complete';
      return 'complete';
    }
    this._index++;
    this._objElapsed = 0;
    this._hold = 0;
    return 'next';
  }

  fail(reason: string): boolean {
    if (this._phase !== 'running') return false;
    this._phase = 'failed';
    this._failReason = reason;
    return true;
  }

  /** Play it again from objective zero. Legal from any phase. */
  restart(): void {
    this._phase = 'running';
    this._index = 0;
    this._elapsed = 0;
    this._objElapsed = 0;
    this._hold = 0;
    this._failReason = '';
    this._finished = false;
  }

  snapshot(): MissionSnapshot {
    const o = this.objective;
    return {
      id: this.def.id,
      phase: this._phase,
      objectiveIndex: this._index,
      objectiveTitle: o.title,
      objectiveHint: o.hint ?? '',
      timeLeft: this.timeLeft,
      holdProgress: this.holdProgress,
      failReason: this._failReason,
    };
  }
}

/**
 * Which missions the player may start, given what they have completed.
 * Order is act order, so "the next thing to do" is always `[0]`.
 */
export function offerable(
  all: ReadonlyArray<MissionDef>,
  completed: ReadonlySet<string>,
): MissionDef[] {
  return all
    .filter((m) => !m.requires || completed.has(m.requires))
    .sort((a, b) => a.act - b.act);
}

/** The next act to play — the first offerable mission not yet completed. */
export function nextMission(
  all: ReadonlyArray<MissionDef>,
  completed: ReadonlySet<string>,
): MissionDef | null {
  for (const m of offerable(all, completed)) {
    if (!completed.has(m.id)) return m;
  }
  return null;
}

export function planarDistance(a: Vec3Lite, b: Vec3Lite): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
