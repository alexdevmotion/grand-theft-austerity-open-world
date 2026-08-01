/**
 * THE VOICE DIRECTOR — one mouth, and the rules it obeys.
 *
 * `clipContexts.ts` is the editorial spec: which *Ce Ne Enervează* line belongs
 * to which game moment, hand-picked by what the line actually says. It also
 * states four playback rules, and this file is where they are enforced rather
 * than merely written down:
 *
 *   1. NEVER INTERRUPT A LINE. A request that arrives mid-sentence is queued by
 *      priority, or dropped when the queue is full or the moment has gone
 *      stale. There is exactly one voice source alive at a time — that is the
 *      whole reason this class exists instead of a `say()` on three systems.
 *   2. NEVER REPEAT UNTIL THE CONTEXT IS EXHAUSTED. Each context owns a
 *      shuffled bag; a line is drawn without replacement and the bag is only
 *      refilled once empty, so you hear all three crash lines before you hear
 *      the first one twice.
 *   3. DUCK RADIO AND AMBIENCE UNDER A LINE. `duck` rises fast and falls slow,
 *      broadcast-style; AudioSystem folds it into the bus ducking and Radio
 *      folds it into the folk bed.
 *   4. REACTIONS STAY UNDER ~9 s. Anything longer in a reaction context is not
 *      a reaction, it is radio filler, so it is moved into the filler pool at
 *      construction time and never fires on a crash.
 *
 * Three routes, one authority:
 *
 *   radio  ─▶ the car-speaker chain (cabin / near-car / facade PA) in radio.ts
 *   street ─▶ a specific world position: a kiosk radio, a shop doorway, the
 *             parked Dacia with its window down. Spatialised, so you walk past
 *             it and hear it — the thing that makes a city feel inhabited.
 *   (both share the queue; a kiosk never talks over the commentator.)
 */

import type { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import {
  STREET_CONTEXT_BY_SOURCE,
  STREET_EXCLUDED_FILES,
  STREET_VOICE_CONTEXTS,
  VOICE_CONTEXTS,
  type StreetVoiceSource,
  type VoiceContext,
  type VoiceLine,
} from './clipContexts';
import { bucket as legacyBucket, type VoBucket } from './clips';

/** The longest a line may be and still count as a reaction. */
export const REACTION_MAX_SECONDS = 9;

export interface SpokenLine {
  /** Stable identity for history / usage counting. */
  key: string;
  file: string;
  /** Subtitle text. */
  text: string;
  /** Known duration, or 0 when it must be taken from the decoded buffer. */
  seconds: number;
}

export type VoiceRoute = 'radio' | 'street';

/** The editorial identity carried all the way to the actual start boundary. */
export interface VoicePlaybackRequest {
  line: SpokenLine;
  context: string;
  route: VoiceRoute;
}

/** Last-played/active voice telemetry. A request alone must not mutate it. */
export interface VoicePlaybackTelemetry {
  lastKey: string;
  lastContext: string;
  nowPlaying: string;
  route: VoiceRoute;
}

export type VoicePlaybackEventRequest = Pick<VoicePlaybackRequest, 'line' | 'context' | 'route'>;

export type VoicePlaybackTelemetryEvent =
  | { type: 'start'; request: VoicePlaybackEventRequest }
  | { type: 'stop' };

/**
 * Apply the only telemetry transitions that matter to the voice surface.
 *
 * A line may be queued, dropped, or expire before it ever reaches WebAudio.
 * Only `start` can establish the active and last-played source, keeping the
 * subtitle/key/context tuple atomic.
 */
export function reduceVoicePlaybackTelemetry(
  state: VoicePlaybackTelemetry,
  event: VoicePlaybackTelemetryEvent,
): VoicePlaybackTelemetry {
  if (event.type === 'stop') return { ...state, nowPlaying: '' };
  return {
    ...state,
    lastKey: event.request.line.key,
    lastContext: event.request.context,
    nowPlaying: event.request.line.text,
    route: event.request.route,
  };
}

/** Resolve physical source identity to its source-specific editorial pool. */
export function streetContextForSource(source: StreetVoiceSource): VoiceContext {
  return STREET_CONTEXT_BY_SOURCE[source];
}

interface Request extends VoicePlaybackRequest {
  priority: number;
  /** Where a street line comes from. */
  destination?: VoiceAudioNode;
  speaker: string;
  /** Context time after which the request is pointless. */
  expiresAt: number;
}

/** Contexts whose lines fire ON an event and must therefore be short. */
export const REACTION_CONTEXTS: VoiceContext[] = [
  'carFirstStart', 'carHardAccel', 'carFuel',
  'collisionMinor', 'collisionMajor', 'nearMiss',
  'starsUp', 'starsMax', 'escaped', 'money',
];

function lineKey(l: VoiceLine): string {
  // "episode-52/03-romania-legata-cu-sarme" — short, stable, greppable.
  const m = /episode-(\d+)\/(.+)\.mp3$/.exec(l.file);
  return m ? `ep${m[1]}/${m[2]}` : l.file;
}

function toSpoken(l: VoiceLine): SpokenLine {
  return { key: lineKey(l), file: l.file, text: l.line, seconds: l.seconds };
}

/**
 * Split every context into what may fire as a reaction and what is too long
 * to be one. Nothing is discarded: the long tail of a reaction context joins
 * the filler pool, so a curated line never sits on disk unheard.
 */
export function buildPools(): {
  reaction: Record<VoiceContext, SpokenLine[]>;
  filler: SpokenLine[];
} {
  const reaction = {} as Record<VoiceContext, SpokenLine[]>;
  const fillerKeys = new Set<string>();
  const filler: SpokenLine[] = [];

  const addFiller = (s: SpokenLine) => {
    if (fillerKeys.has(s.key)) return;
    fillerKeys.add(s.key);
    filler.push(s);
  };

  for (const name of Object.keys(VOICE_CONTEXTS) as VoiceContext[]) {
    const all = VOICE_CONTEXTS[name]
      .filter((line) => !STREET_VOICE_CONTEXTS.includes(name as (typeof STREET_VOICE_CONTEXTS)[number])
        || !STREET_EXCLUDED_FILES.has(line.file))
      .map(toSpoken);
    if (name === 'radioFiller') {
      for (const s of all) addFiller(s);
      reaction[name] = all;
      continue;
    }
    if (!REACTION_CONTEXTS.includes(name)) {
      reaction[name] = all;
      continue;
    }
    const short = all.filter((s) => s.seconds <= REACTION_MAX_SECONDS);
    for (const s of all) if (s.seconds > REACTION_MAX_SECONDS) addFiller(s);
    // A context where every line is long still has to be able to fire; it gets
    // its shortest line rather than nothing at all.
    reaction[name] = short.length
      ? short
      : [all.slice().sort((a, b) => a.seconds - b.seconds)[0]].filter(Boolean);
  }
  return { reaction, filler };
}

/** Draw without replacement; refill only when the bag is empty. */
class Bag<T> {
  private order: number[] = [];

  constructor(private items: T[], private rng: Rng) {}

  get size(): number {
    return this.items.length;
  }

  /** How many draws remain before anything repeats. */
  get remaining(): number {
    return this.order.length;
  }

  draw(): T | undefined {
    if (!this.items.length) return undefined;
    if (!this.order.length) {
      this.order = this.items.map((_, i) => i);
      // Fisher-Yates with the seeded Rng — deterministic, never Math.random().
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = this.rng.int(0, i + 1);
        const t = this.order[i];
        this.order[i] = this.order[j];
        this.order[j] = t;
      }
    }
    return this.items[this.order.pop()!];
  }
}

export interface DirectorHooks {
  /** Resolve a file to a decoded buffer (the radio's LRU loader). */
  load(file: string): Promise<VoiceAudioBuffer | null>;
  /** Already-decoded buffer, or undefined. */
  cached(file: string): VoiceAudioBuffer | undefined;
}

/** Small structural seam used by the director; browser AudioNodes satisfy it. */
export interface VoiceAudioNode {
  readonly numberOfInputs: number;
  readonly numberOfOutputs: number;
}

export interface VoiceAudioBuffer {
  readonly duration: number;
}

export interface VoiceAudioBufferSource {
  buffer: VoiceAudioBuffer | null;
  connect(destination: VoiceAudioNode): unknown;
  start(when?: number): void;
  stop(when?: number): void;
  onended: ((event: Event) => unknown) | null;
}

export interface VoiceAudioContext {
  readonly currentTime: number;
  createBufferSource(): VoiceAudioBufferSource;
}

export class VoiceDirector {
  /** 0..1 — how hard everything else should get out of the way. */
  duck = 0;
  /** Subtitle currently on screen. */
  nowPlaying = '';
  lastKey = '';
  /** Context of the most recent line that actually reached `start()`. */
  lastContext: string = '';
  /** Every line played this session, by key. */
  readonly played = new Map<string, number>();

  private ctx: VoiceAudioContext;
  private hooks: DirectorHooks;
  private events: EventBus;
  private rng: Rng;

  private pools: ReturnType<typeof buildPools>;
  private bags = new Map<string, Bag<SpokenLine>>();
  private legacyBags = new Map<VoBucket, Bag<SpokenLine>>();

  private source: VoiceAudioBufferSource | null = null;
  private endsAt = 0;
  private currentPriority = 0;
  private currentRoute: VoiceRoute = 'radio';
  private queue: Request[] = [];

  constructor(
    ctx: VoiceAudioContext,
    hooks: DirectorHooks,
    events: EventBus,
    /** The car-speaker chain input; every `radio`-route line goes here. */
    private radioDestination: VoiceAudioNode,
    seed = 'gta-voice-director',
  ) {
    this.ctx = ctx;
    this.hooks = hooks;
    this.events = events;
    this.rng = new Rng(seed);
    this.pools = buildPools();
  }

  private applyTelemetry(event: VoicePlaybackTelemetryEvent): void {
    const next = reduceVoicePlaybackTelemetry({
      lastKey: this.lastKey,
      lastContext: this.lastContext,
      nowPlaying: this.nowPlaying,
      route: this.currentRoute,
    }, event);
    this.lastKey = next.lastKey;
    this.lastContext = next.lastContext;
    this.nowPlaying = next.nowPlaying;
    this.currentRoute = next.route;
  }

  get speaking(): boolean {
    return !!this.source && this.ctx.currentTime < this.endsAt;
  }

  /** Route of whatever is speaking — Radio uses it to decide its own routing. */
  get route(): VoiceRoute {
    return this.currentRoute;
  }

  get priority(): number {
    return this.speaking ? this.currentPriority : 0;
  }

  /** Seconds of talking left, for schedulers that must not overlap it. */
  get remaining(): number {
    return this.speaking ? this.endsAt - this.ctx.currentTime : 0;
  }

  /** How many un-repeated lines a context still has. Proves rule 2 by measure. */
  bagRemaining(context: string): number {
    return this.bags.get(context)?.remaining ?? -1;
  }

  private bagFor(context: VoiceContext): Bag<SpokenLine> {
    let b = this.bags.get(context);
    if (!b) {
      b = new Bag(this.pools.reaction[context] ?? [], this.rng.fork(context));
      this.bags.set(context, b);
    }
    return b;
  }

  /** Curated line for a game moment. Returns false when nothing was scheduled. */
  request(
    context: VoiceContext,
    priority = 1,
    opts?: { ttl?: number; speaker?: string },
  ): boolean {
    const line = this.bagFor(context).draw();
    if (!line) return false;
    return this.schedule({
      line, context,
      priority,
      route: 'radio',
      speaker: opts?.speaker ?? 'CE NE ENERVEAZĂ',
      expiresAt: this.ctx.currentTime + (opts?.ttl ?? ttlFor(priority)),
    });
  }

  /** Filler between everything else: the long lines and the radioFiller pool. */
  requestFiller(priority = 0.4): boolean {
    let b = this.bags.get('__filler');
    if (!b) {
      b = new Bag(this.pools.filler, this.rng.fork('filler'));
      this.bags.set('__filler', b);
    }
    const line = b.draw();
    if (!line) return false;
    return this.schedule({
      line, context: 'radioFiller', priority, route: 'radio', speaker: 'CE NE ENERVEAZĂ',
      expiresAt: this.ctx.currentTime + 4,
    });
  }

  /**
   * A line from the first clip batch (src/clips.ts buckets) — the station
   * idents, the show segments and the free-roam chatter that predate the
   * curated table. Same queue, same rules.
   */
  requestBucket(b: VoBucket, priority = 0.4): boolean {
    let bag = this.legacyBags.get(b);
    if (!bag) {
      const lines: SpokenLine[] = legacyBucket(b).map((c) => ({
        key: c.key, file: c.file, text: c.text, seconds: c.long ? 52 : 0,
      }));
      bag = new Bag(lines, this.rng.fork(`bucket:${b}`));
      this.legacyBags.set(b, bag);
    }
    const line = bag.draw();
    if (!line) return false;
    return this.schedule({
      line, context: b, priority, route: 'radio', speaker: 'CE NE ENERVEAZĂ',
      expiresAt: this.ctx.currentTime + ttlFor(priority),
    });
  }

  /**
   * A line heard out in the street, from a specific place. `destination` is the
   * emitter's own EQ + panner chain, so the line arrives from the kiosk, not
   * from inside the player's head. The typed physical source selects its
   * editorial pool; the localized speaker label is presentation only.
   */
  requestStreet(
    destination: VoiceAudioNode,
    source: StreetVoiceSource,
    speaker: string,
  ): boolean {
    const context = streetContextForSource(source);
    const line = this.bagFor(context).draw();
    if (!line) return false;
    return this.schedule({
      line, context,
      priority: 0.3,
      route: 'street',
      destination,
      speaker,
      // Street chatter is scenery: if it cannot play now it is not worth
      // waiting for, because the player will have walked past by then.
      expiresAt: this.ctx.currentTime + 0.25,
    });
  }

  private schedule(r: Request): boolean {
    // Rule 1: never cut a line off. A higher-priority request goes to the FRONT
    // of the queue and plays the moment the current line finishes.
    if (this.speaking) {
      if (r.priority <= 0.35 && this.currentRoute === 'radio') return false; // scenery: drop
      if (this.queue.length >= 3) {
        // Full: only keep this one if it outranks the weakest thing queued.
        const weakest = this.queue.reduce((a, b) => (b.priority < a.priority ? b : a));
        if (r.priority <= weakest.priority) return false;
        this.queue.splice(this.queue.indexOf(weakest), 1);
      }
      this.queue.push(r);
      this.queue.sort((a, b) => b.priority - a.priority);
      return true;
    }
    void this.play(r);
    return true;
  }

  private async play(r: Request): Promise<void> {
    const cached = this.hooks.cached(r.line.file);
    const buf = cached ?? (await this.hooks.load(r.line.file));
    if (!buf) return;
    // The await may have let something else start; respect rule 1 by requeueing
    // rather than cutting in.
    if (this.speaking) {
      if (this.ctx.currentTime < r.expiresAt) this.queue.push(r);
      return;
    }
    if (this.ctx.currentTime > r.expiresAt + buf.duration) return;

    const dest = r.route === 'street' && r.destination ? r.destination : this.radioDestination;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(dest);
    const now = this.ctx.currentTime;
    s.start(now);
    // A "complete" show cut is minutes of talk radio; cap it so it can never
    // block a reaction for the rest of the session.
    const dur = Math.min(buf.duration, r.line.seconds > 30 ? 52 : buf.duration);
    if (dur < buf.duration) s.stop(now + dur);

    this.source = s;
    this.endsAt = now + dur;
    this.currentPriority = r.priority;
    this.applyTelemetry({ type: 'start', request: r });
    this.played.set(r.line.key, (this.played.get(r.line.key) ?? 0) + 1);

    this.events.emit('ui:subtitle', {
      speaker: r.speaker,
      text: r.line.text,
      ms: Math.round(dur * 1000) + 400,
    });

    s.onended = () => {
      if (this.source === s) {
        this.source = null;
        this.currentPriority = 0;
        this.applyTelemetry({ type: 'stop' });
      }
    };
  }

  update(dt: number): void {
    const t = this.ctx.currentTime;
    const speaking = this.speaking;

    // Rule 3. A street line is scenery and only asks for a little room; a
    // reaction from the commentator asks for all of it.
    const want = speaking ? (this.currentRoute === 'street' ? 0.45 : 1) : 0;
    this.duck += (want - this.duck) * (1 - Math.exp(-(want > this.duck ? 12 : 2.2) * dt));

    if (speaking) return;
    if (this.source) {
      this.source = null;
      this.currentPriority = 0;
      this.applyTelemetry({ type: 'stop' });
    }
    // Drain: highest priority first, dropping anything whose moment has passed.
    while (this.queue.length) {
      const next = this.queue.shift()!;
      if (t > next.expiresAt) continue;
      void this.play(next);
      return;
    }
  }

  /** Silence everything — station off, pause, dispose. */
  stop(): void {
    this.queue.length = 0;
    if (!this.source) return;
    try {
      this.source.onended = null;
      this.source.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.currentPriority = 0;
    this.applyTelemetry({ type: 'stop' });
  }

  /** Diagnostics for the measurement harness. */
  stats(): Record<string, unknown> {
    const bags: Record<string, number> = {};
    for (const [k, b] of this.bags) bags[k] = b.remaining;
    return {
      speaking: this.speaking,
      route: this.currentRoute,
      priority: this.currentPriority,
      remaining: Math.round(this.remaining * 100) / 100,
      queued: this.queue.length,
      duck: Math.round(this.duck * 1000) / 1000,
      lastKey: this.lastKey,
      lastContext: this.lastContext,
      nowPlaying: this.nowPlaying,
      distinctPlayed: this.played.size,
      bags,
    };
  }
}

/** How long a request stays worth playing. Big moments wait, small ones do not. */
function ttlFor(priority: number): number {
  return priority >= 3 ? 12 : priority >= 2 ? 6 : priority >= 1 ? 3 : 1.5;
}
