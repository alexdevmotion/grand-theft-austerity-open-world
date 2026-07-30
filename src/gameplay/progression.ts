/** XP, levels and unlocks — "Runway", "Tracțiune", "Seria A"…
 *
 *  The curve and the level-up event were already here; nothing fed them and
 *  nothing came out of them. This adds both halves.
 *
 *  WHAT PAYS
 *    activities   score -> XP, one for one (the score model in
 *                 `activityScoring.ts` is tuned against this curve)
 *    missions     `MissionSystem` awards per objective and per act
 *    free roam    distance covered, escaping the Ministry, and finding a
 *                 landmark for the first time — so simply driving around the
 *                 city moves the bar
 *
 *  WHAT YOU GET — every unlock has to be something the player NOTICES:
 *    2  sprint_boost   you run 15% faster
 *    3  dacia_call     call your Dacia to the kerb; a four-star evade opens
 *    4  cool_head      the Crisis Stars decay 45% faster
 *    5  payday         activity payouts +50%
 *    6  tough_hide     you take 20% less damage
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { LEVEL_NAMES } from '../content/story';
import { Services, type CityService, type ProgressionService } from '../core/services';

const LEVEL_CURVE = [0, 400, 1100, 2300, 4200, 7000, 11000, 16500, 24000, 34000];

/** Named unlock and the sentence the banner shows, per level. */
export const LEVEL_UNLOCKS: Record<number, { id: string; text: string }> = {
  2: { id: 'sprint_boost', text: 'Alergi cu 15% mai repede' },
  3: { id: 'dacia_call', text: 'Dacia la comandă · evadare de patru stele' },
  4: { id: 'cool_head', text: 'Instabilitatea scade mai repede · cursa Unirii' },
  5: { id: 'payday', text: 'Recompensele activităților +50%' },
  6: { id: 'tough_hide', text: 'Încasezi cu 20% mai puțin' },
  // The economy now has an outflow (bribes, fines, repairs, food), so the
  // curve gets a rung that is about MONEY rather than about the body — and it
  // is the one that makes the two most satirical sinks affordable.
  7: { id: 'conexiuni', text: 'Ai cunoștințe: șpaga și amenzile −30%' },
};

/** How much cheaper `conexiuni` makes anything the Ministry charges you. */
export const CONEXIUNI_DISCOUNT = 0.7;

/** XP per metre, by how you covered it. Walking is worth more per metre. */
const XP_PER_METRE_FOOT = 1 / 12;
const XP_PER_METRE_DRIVE = 1 / 30;
/** Do not spam the event bus: bank the drips and flush them in lumps. */
const ROAM_FLUSH = 45;
const DISCOVERY_XP = 140;
const ESCAPE_XP = 110;

const _p = new THREE.Vector3();

export class ProgressionSystem implements System, ProgressionService {
  readonly name = 'progression';
  readonly order = 215;

  private _xp = 0;
  private _level = 1;
  private _unlocks = new Set<string>();
  private ctx!: GameContext;

  private lastPos: THREE.Vector3 | null = null;
  private roamBank = 0;
  private discoveredSet = new Set<string>();
  private city: CityService | null = null;
  private peakStars = 0;
  /** Metres covered this session, for the harness. */
  private _metres = 0;
  /** How many times the Ministry has actually caught him. */
  private _busted = 0;
  /** Set by `forfeitEscape`, consumed by the next drop to zero stars. */
  private escapeForfeited = false;

  get level(): number {
    return this._level;
  }
  get xp(): number {
    return this._xp;
  }
  get unlocks(): ReadonlySet<string> {
    return this._unlocks;
  }
  get discovered(): ReadonlySet<string> {
    return this.discoveredSet;
  }
  /** XP into the current level and what the next one costs. */
  get levelProgress(): { into: number; span: number } {
    const floor = LEVEL_CURVE[this._level - 1] ?? 0;
    const next = LEVEL_CURVE[this._level] ?? floor + 1;
    return { into: this._xp - floor, span: Math.max(1, next - floor) };
  }
  get levelName(): string {
    return LEVEL_NAMES[this._level] ?? `Nivel ${this._level}`;
  }
  get metres(): number {
    return this._metres;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Progression, this);
    this.city = ctx.tryGet(Services.City) ?? null;

    ctx.events.on('activity:finished', ({ score }) => this.addXp(Math.round(score), 'activitate'));

    // Losing the Ministry is worth real XP — it is the hardest thing the free
    // world asks of you, and until now it paid nothing at all.
    ctx.events.on('instability:changed', ({ stars, previous }) => {
      this.peakStars = Math.max(this.peakStars, previous, stars);
      if (stars === 0) {
        // A bust also ends at zero stars, and the event cannot tell the two
        // apart — `previous` is five either way. `forfeitEscape` raises the
        // flag; it is consumed here so the next genuine escape still pays.
        if (this.peakStars >= 2 && !this.escapeForfeited) {
          const gain = ESCAPE_XP * this.peakStars;
          this.addXp(gain, 'evadare');
          ctx.tryGet(Services.Hud)?.toast(`Ai scăpat de Minister · +${gain} XP`, 'good');
        }
        this.escapeForfeited = false;
        this.peakStars = 0;
      }
    });

    this.installDebugHook();
  }

  addXp(amount: number, reason: string): void {
    if (amount <= 0) return;
    this._xp += amount;
    this.ctx.events.emit('progression:xp', { amount, total: this._xp, reason });
    while (this._level < LEVEL_CURVE.length && this._xp >= LEVEL_CURVE[this._level]) {
      this._level++;
      const named = LEVEL_UNLOCKS[this._level];
      const unlock = named?.id ?? `level_${this._level}`;
      this._unlocks.add(unlock);
      // Activities gate on `level_N`, so always add that too.
      this._unlocks.add(`level_${this._level}`);
      this.ctx.events.emit('progression:levelUp', { level: this._level, unlock });
      this.ctx.tryGet(Services.Hud)?.toast(
        `NIVEL ${this._level} — ${this.levelName}: ${named?.text ?? 'conținut nou'}`,
        'good',
        5200,
      );
    }
  }

  has(unlock: string): boolean {
    return this._unlocks.has(unlock);
  }

  /**
   * SAVE / LOAD. Loading is not earning: this sets the curve directly and fires
   * neither `progression:levelUp` nor a banner, so resuming at level 5 does not
   * throw four "NIVEL n" toasts across the screen. Level and unlocks are
   * recomputed from XP when the record does not carry them, which is also what
   * repairs a slot written before an unlock table change.
   */
  restore(state: {
    xp: number;
    level?: number;
    unlocks?: readonly string[];
    discovered?: readonly string[];
  }): void {
    this._xp = Math.max(0, state.xp);
    this._level = 1;
    while (this._level < LEVEL_CURVE.length && this._xp >= LEVEL_CURVE[this._level]) this._level++;
    if (state.level !== undefined) this._level = Math.max(this._level, Math.round(state.level));

    this._unlocks = new Set(state.unlocks ?? []);
    // Whatever the slot says, the curve is authoritative about what this level
    // has earned — an old slot must not leave you without your sprint boost.
    for (let l = 2; l <= this._level; l++) {
      const named = LEVEL_UNLOCKS[l];
      this._unlocks.add(named?.id ?? `level_${l}`);
      this._unlocks.add(`level_${l}`);
    }
    this.discoveredSet = new Set(state.discovered ?? []);
    this.roamBank = 0;
    this.lastPos = null;
    this.peakStars = 0;

    // The HUD reads level and the XP bar off the service every frame, but the
    // bar only re-tints on this event. Fire the *value* change, not a level-up.
    this.ctx.events.emit('progression:xp', { amount: 0, total: this._xp, reason: 'încărcare' });
  }

  /**
   * THE CHASE YOU LOST DOES NOT PAY.
   *
   * `instability:changed` cannot tell the difference between shaking the
   * Ministry off and being put in the back of their van — both end at zero
   * stars. The detention loop in `wanted.ts` calls this first, so a bust
   * cannot hand out the evade bonus it just took away from you.
   */
  forfeitEscape(): void {
    this.peakStars = 0;
    this.escapeForfeited = true;
    this._busted++;
  }

  get bustedCount(): number {
    return this._busted;
  }

  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    void dt;
    const player = ctx.tryGet(Services.Player);
    if (!player) return;
    _p.copy(player.position);

    if (!this.lastPos) {
      this.lastPos = _p.clone();
      return;
    }
    const d = Math.hypot(_p.x - this.lastPos.x, _p.z - this.lastPos.z);
    // A teleport is not exploration.
    if (d > 0.01 && d < 12) {
      this._metres += d;
      this.roamBank += d * (player.isOnFoot ? XP_PER_METRE_FOOT : XP_PER_METRE_DRIVE);
      if (this.roamBank >= ROAM_FLUSH) {
        const lump = Math.floor(this.roamBank);
        this.roamBank -= lump;
        this.addXp(lump, 'explorare');
      }
    }
    this.lastPos.copy(_p);

    this.checkDiscovery(_p);
  }

  /** First arrival at a landmark is worth finding. */
  private checkDiscovery(p: THREE.Vector3): void {
    const city = this.city;
    if (!city) return;
    for (const [id, lm] of city.landmarks) {
      if (this.discoveredSet.has(id)) continue;
      const r = Math.max(24, lm.radius * 0.55);
      if (Math.hypot(p.x - lm.position.x, p.z - lm.position.z) > r) continue;
      this.discoveredSet.add(id);
      this.addXp(DISCOVERY_XP, 'descoperire');
      this.ctx.tryGet(Services.Hud)?.toast(`Descoperit: ${lm.name} · +${DISCOVERY_XP} XP`, 'good', 3600);
    }
  }

  private installDebugHook(): void {
    if (typeof window === 'undefined') return;
    (window as unknown as { __GTA_PROGRESS__: unknown }).__GTA_PROGRESS__ = {
      state: () => ({
        level: this._level,
        name: this.levelName,
        xp: this._xp,
        progress: this.levelProgress,
        unlocks: [...this._unlocks],
        discovered: [...this.discoveredSet],
        metres: Math.round(this._metres),
        busted: this._busted,
      }),
      addXp: (n: number) => this.addXp(n, 'debug'),
      table: () => LEVEL_UNLOCKS,
    };
  }
}
