/**
 * THE DACIA RADIO — *Ce Ne Enervează* plus the folk station.
 *
 * docs/STORY.md: the Dacia "coughs on first start and the radio comes on with
 * it", *Ce Ne Enervează* is the radio voice that "reacts to Crisis Star
 * increases with subtitled Romanian commentary", and Romanian folk music
 * starts the Builders House afterparty.
 *
 * Stations (cycle with R — `radioNext`, already bound in src/core/input.ts):
 *
 *   1. CE NE ENERVEAZĂ FM — the talk station. Fecioreasca de pe Mureș runs
 *      continuously as the music bed and ducks under each spoken clip, so the
 *      folk recording is audible from the first seconds of driving without the
 *      player doing anything. Idle chatter between segments, station idents,
 *      and reactive commentary on stars / crashes / missions.
 *   2. RADIO FOLCLOR — the same recording, unducked and at full level, with an
 *      occasional station ident over the top.
 *   3. OFF.
 *
 * Signal path — everything the radio emits goes through a car-speaker EQ:
 *
 *   clip/music source ─▶ [HP 190 ─▶ LP 4.3k ─▶ +4 dB @ 1.75k ─▶ cone shaper]
 *                        ├─▶ cabin gain ────────────────▶ voice/music bus  (driving)
 *                        ├─▶ world gain ─▶ panner ──────▶ voice/music bus  (on foot,
 *                        │                                  near your car)
 *                        └─▶ PA bandpass ─▶ pa gain ────▶ voice bus        (on foot,
 *                                                           facade screens)
 *
 * The afterparty bypasses the speaker EQ entirely: at that point the music is
 * not coming out of a Dacia any more.
 */

import * as THREE from 'three';
import type { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import { clamp, speakerCurve } from './dsp';
import type { AudioGraph } from './graph';
import { FOLK_TITLE, FOLK_TRACK, bucket, type Clip, type VoBucket } from './clips';

export type StationId = 'off' | 'enerveaza' | 'folclor';
export const STATIONS: StationId[] = ['enerveaza', 'folclor', 'off'];

export const STATION_LABELS: Record<StationId, string> = {
  off: 'RADIO OPRIT',
  enerveaza: 'CE NE ENERVEAZĂ FM',
  folclor: 'RADIO FOLCLOR',
};

/* ------------------------------------------------------------------ */
/* Clip loading                                                        */
/* ------------------------------------------------------------------ */

export class ClipLoader {
  private cache = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<AudioBuffer | null>>();
  private order: string[] = [];
  private failed = new Set<string>();
  /** Never evicted — the reaction clips that must fire without a fetch. */
  private pinned = new Set<string>();

  constructor(private ctx: AudioContext, private capacity = 30) {}

  pin(file: string): void {
    this.pinned.add(file);
  }

  get pinnedCount(): number {
    return this.pinned.size;
  }

  get loadedCount(): number {
    return this.cache.size;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  cached(file: string): AudioBuffer | undefined {
    return this.cache.get(file);
  }

  async load(file: string): Promise<AudioBuffer | null> {
    const hit = this.cache.get(file);
    if (hit) {
      this.touch(file);
      return hit;
    }
    if (this.failed.has(file)) return null;
    const pending = this.inflight.get(file);
    if (pending) return pending;

    const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
    const url = `${base}/${file}`;
    const p = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        const bytes = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(bytes);
        this.cache.set(file, buf);
        this.touch(file);
        this.evict();
        return buf;
      } catch (err) {
        // A missing mp3 (they are gitignored — `bun run audio:sync`) must never
        // break the game. Log once, then behave as if the clip does not exist.
        console.warn(`[audio] clip unavailable: ${file}`, err);
        this.failed.add(file);
        return null;
      } finally {
        this.inflight.delete(file);
      }
    })();
    this.inflight.set(file, p);
    return p;
  }

  private touch(file: string): void {
    const i = this.order.indexOf(file);
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(file);
  }

  private evict(): void {
    let guard = this.order.length;
    while (this.order.length - this.pinned.size > this.capacity && guard-- > 0) {
      const oldest = this.order.shift();
      if (!oldest) break;
      if (this.pinned.has(oldest)) {
        this.order.push(oldest); // keep pinned entries in the ring
        continue;
      }
      this.cache.delete(oldest);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Car speaker EQ                                                      */
/* ------------------------------------------------------------------ */

interface SpeakerChain {
  input: GainNode;
  cabin: GainNode;
  world: GainNode;
  /** City-wide facade-screen broadcast, for reactions heard on foot. */
  pa: GainNode;
  panner: PannerNode;
}

function buildSpeakerChain(ctx: AudioContext, destination: AudioNode): SpeakerChain {
  const input = ctx.createGain();

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 190;
  hp.Q.value = 0.7;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4300;
  lp.Q.value = 0.7;

  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 1750;
  presence.Q.value = 1.2;
  presence.gain.value = 4;

  const cone = ctx.createWaveShaper();
  cone.curve = speakerCurve(1024, 1.35) as Float32Array<ArrayBuffer>;

  input.connect(hp);
  hp.connect(lp);
  lp.connect(presence);
  presence.connect(cone);

  const cabin = ctx.createGain();
  cabin.gain.value = 0;
  cone.connect(cabin);
  cabin.connect(destination);

  // Heard from outside the car: further muffled and spatialised at the body.
  const outsideLp = ctx.createBiquadFilter();
  outsideLp.type = 'lowpass';
  outsideLp.frequency.value = 1800;
  const world = ctx.createGain();
  world.gain.value = 0;
  const panner = ctx.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = 3.5;
  panner.rolloffFactor = 1.6;
  panner.maxDistance = 60;
  cone.connect(outsideLp);
  outsideLp.connect(world);
  world.connect(panner);
  panner.connect(destination);

  // docs/STORY.md: from one Crisis Star the response package includes a
  // "Breaking-news strap, radio warning", and by five the "city screens flip".
  // So the commentator's reactions reach the player on foot too — through the
  // facade screens, which sound like a public-address system, not a car radio.
  const paBp = ctx.createBiquadFilter();
  paBp.type = 'bandpass';
  paBp.frequency.value = 1250;
  paBp.Q.value = 0.65;
  const paDrive = ctx.createWaveShaper();
  paDrive.curve = speakerCurve(512, 2.1) as Float32Array<ArrayBuffer>;
  const pa = ctx.createGain();
  pa.gain.value = 0;
  cone.connect(paBp);
  paBp.connect(paDrive);
  paDrive.connect(pa);
  pa.connect(destination);

  return { input, cabin, world, pa, panner };
}

/* ------------------------------------------------------------------ */
/* Radio                                                               */
/* ------------------------------------------------------------------ */

export interface RadioContext {
  /** True when the player is sitting in a vehicle with the engine running. */
  inCabin: boolean;
  /** Where the car is, for the on-foot spatialised path. */
  vehiclePosition: THREE.Vector3 | null;
  /** Distance from the listener to that vehicle. */
  vehicleDistance: number;
  /** True when a vehicle radio should be powered at all. */
  powered: boolean;
}

interface QueuedLine {
  clip: Clip;
  priority: number;
  bucket: VoBucket;
}

export class Radio {
  station: StationId = 'enerveaza';
  /** Set true once the player first starts a car. */
  powered = false;

  private ctx: AudioContext;
  private graph: AudioGraph;
  private loader: ClipLoader;
  private events: EventBus;
  private rng: Rng;

  private voiceChain: SpeakerChain;
  private musicChain: SpeakerChain;
  /** Dry (non-radio) music path — the Builders House afterparty. */
  private dryMusic: GainNode;
  private dryMusicSource: AudioBufferSourceNode | null = null;

  /** The folk bed, running continuously once loaded. */
  private folkBuffer: AudioBuffer | null = null;
  private folkSource: AudioBufferSourceNode | null = null;
  private folkGain: GainNode;
  private folkDuck: GainNode;

  /** Diegetic terrace speaker outside Builders House. */
  private housePanner: PannerNode | null = null;
  private houseGain: GainNode | null = null;
  private houseSource: AudioBufferSourceNode | null = null;

  private voiceSource: AudioBufferSourceNode | null = null;
  private voiceEndsAt = 0;
  private nextChatterAt = 0;
  private queue: QueuedLine[] = [];
  private history: string[] = [];
  private bucketCursor = new Map<VoBucket, number>();
  private segmentsSinceIdent = 0;
  private identDone = false;
  /** Every clip key that has actually been played this session. */
  readonly played = new Map<string, number>();

  /** 0..1 — how hard voice is currently ducking music/ambience. */
  duck = 0;
  nowPlaying = '';
  lastClipKey = '';
  afterparty = false;

  constructor(ctx: AudioContext, graph: AudioGraph, events: EventBus, seed = 'gta-radio') {
    this.ctx = ctx;
    this.graph = graph;
    this.events = events;
    this.rng = new Rng(seed);
    this.loader = new ClipLoader(ctx);

    this.voiceChain = buildSpeakerChain(ctx, graph.bus('voice').input);
    this.musicChain = buildSpeakerChain(ctx, graph.bus('music').input);

    this.dryMusic = ctx.createGain();
    this.dryMusic.gain.value = 0;
    this.dryMusic.connect(graph.bus('music').input);

    this.folkDuck = ctx.createGain();
    this.folkDuck.gain.value = 1;
    this.folkGain = ctx.createGain();
    this.folkGain.gain.value = 0;
    this.folkGain.connect(this.folkDuck);
    this.folkDuck.connect(this.musicChain.input);
  }

  get loadedClips(): number {
    return this.loader.loadedCount;
  }

  /** Kick off the (large) folk download. Safe to call before unlock. */
  async preload(): Promise<void> {
    const b = await this.loader.load(FOLK_TRACK);
    if (!b) return;
    this.folkBuffer = b;
    this.startFolkBed();
    void this.warmReactions();
  }

  /**
   * Reactive commentary has to land *now* — a star going up and the
   * commentator arriving half a second later reads as a bug. Decode and PIN
   * one clip from each time-critical bucket so those fire without a fetch;
   * everything else (idle chatter, the long show segments) loads on demand
   * through the LRU, which is fine because nothing is waiting on it.
   */
  private async warmReactions(): Promise<void> {
    const wanted: VoBucket[] = [
      'stationIdent', 'daciaFirstStart',
      'star1', 'star2', 'star3', 'star4', 'star5', 'starCleared',
      'crash', 'bigCrash', 'playerDied', 'missionStart', 'missionComplete', 'police',
    ];
    const seen = new Set<string>();
    for (const b of wanted) {
      const c = bucket(b).find((x) => !x.long && !seen.has(x.file));
      if (!c) continue;
      seen.add(c.file);
      this.loader.pin(c.file);
      await this.loader.load(c.file);
    }
    this.warmed = seen.size;
  }

  /** How many reaction clips are decoded and ready to fire instantly. */
  warmed = 0;

  private startFolkBed(): void {
    if (!this.folkBuffer || this.folkSource) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.folkBuffer;
    s.loop = true;
    s.connect(this.folkGain);
    s.start(0, this.rng.range(0, Math.min(30, this.folkBuffer.duration)));
    this.folkSource = s;
  }

  /**
   * A quiet terrace speaker outside Builders House, so the folk recording is
   * also reachable on foot in free roam — not only from the car.
   */
  installHouseSpeaker(position: THREE.Vector3): boolean {
    if (this.houseSource) return true;
    if (!this.folkBuffer) return false;
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 6;
    p.rolloffFactor = 1.5;
    p.maxDistance = 70;
    if (p.positionX) {
      p.positionX.value = position.x;
      p.positionY.value = position.y + 3;
      p.positionZ.value = position.z;
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void })
        .setPosition(position.x, position.y + 3, position.z);
    }
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const g = this.ctx.createGain();
    g.gain.value = 0.34;
    const s = this.ctx.createBufferSource();
    s.buffer = this.folkBuffer;
    s.loop = true;
    s.connect(lp);
    lp.connect(g);
    g.connect(p);
    p.connect(this.graph.bus('music').input);
    s.start(0, this.rng.range(0, Math.min(60, this.folkBuffer.duration)));
    this.housePanner = p;
    this.houseGain = g;
    this.houseSource = s;
    return true;
  }

  get houseSpeakerLive(): boolean {
    return !!this.houseSource;
  }

  /* ---- station control ---- */

  setStation(s: StationId): void {
    if (s === this.station) return;
    this.station = s;
    this.identDone = false;
    this.segmentsSinceIdent = 99;
    this.events.emit('ui:toast', { text: STATION_LABELS[s], kind: 'info', ms: 1800 });
    if (s === 'off') this.stopVoice();
  }

  next(): StationId {
    const i = STATIONS.indexOf(this.station);
    this.setStation(STATIONS[(i + 1) % STATIONS.length]);
    return this.station;
  }

  /** Power the radio on with the engine. */
  powerOn(): void {
    if (this.powered) return;
    this.powered = true;
    this.identDone = false;
    this.nextChatterAt = this.ctx.currentTime + 1.4;
  }

  powerOff(): void {
    this.powered = false;
    this.stopVoice();
  }

  /* ---- reactive commentary ---- */

  /**
   * Ask the commentator to say something from `b`. Higher priority interrupts
   * a lower-priority line that is already playing.
   */
  say(b: VoBucket, priority = 1): boolean {
    const list = bucket(b);
    if (!list.length) return false;
    const clip = this.pickFresh(b, list);
    if (!clip) return false;
    // Drop anything weaker than what is already queued/playing.
    if (this.voiceSource && priority <= this.currentPriority) {
      if (this.queue.length > 3) return false;
      this.queue.push({ clip, priority, bucket: b });
      this.queue.sort((x, y) => y.priority - x.priority);
      return true;
    }
    void this.playClip(clip, priority, b);
    return true;
  }

  private currentPriority = 0;

  private pickFresh(b: VoBucket, list: Clip[]): Clip | undefined {
    // Walk the bucket round-robin with a small random jump so repeats are rare
    // but the ordering is still deterministic from the seed.
    const start = this.bucketCursor.get(b) ?? this.rng.int(0, list.length);
    for (let i = 0; i < list.length; i++) {
      const c = list[(start + i) % list.length];
      if (!this.history.includes(c.key)) {
        this.bucketCursor.set(b, (start + i + 1) % list.length);
        return c;
      }
    }
    this.bucketCursor.set(b, (start + 1) % list.length);
    return list[start % list.length];
  }

  private remember(key: string): void {
    this.history.push(key);
    if (this.history.length > 14) this.history.shift();
    this.played.set(key, (this.played.get(key) ?? 0) + 1);
  }

  private async playClip(c: Clip, priority: number, b: VoBucket): Promise<void> {
    const buf = await this.loader.load(c.file);
    if (!buf) return;
    // Switching the radio off silences the station, but not the city: the
    // facade-screen reactions (priority >= 2) still get through.
    if (this.station === 'off' && priority < 2) return;

    this.stopVoice();
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.voiceChain.input);
    const now = this.ctx.currentTime;
    s.start(now);
    this.voiceSource = s;
    this.currentPriority = priority;
    // The long "complete" cuts are minutes of talk radio; cap them so they do
    // not block reactive commentary forever.
    const dur = c.long ? Math.min(buf.duration, 52) : buf.duration;
    this.voiceEndsAt = now + dur;
    if (c.long) s.stop(now + dur);
    this.nowPlaying = c.text;
    this.lastClipKey = c.key;
    this.remember(c.key);
    this.segmentsSinceIdent++;

    this.events.emit('ui:subtitle', {
      speaker: 'CE NE ENERVEAZĂ',
      text: c.text,
      ms: Math.round(dur * 1000) + 400,
    });

    s.onended = () => {
      if (this.voiceSource === s) {
        this.voiceSource = null;
        this.currentPriority = 0;
        this.nowPlaying = '';
      }
    };
  }

  private stopVoice(): void {
    if (!this.voiceSource) return;
    try {
      this.voiceSource.onended = null;
      this.voiceSource.stop();
    } catch {
      /* already stopped */
    }
    this.voiceSource = null;
    this.currentPriority = 0;
    this.nowPlaying = '';
  }

  /* ---- afterparty ---- */

  /**
   * `AudioService.setMusic`. 'afterparty' | 'folk' plays the folk recording
   * dry and loud (Act 4 payoff); null returns to the radio.
   */
  setMusic(track: string | null, fadeSeconds = 2): void {
    const t = this.ctx.currentTime;
    if (!track) {
      this.afterparty = false;
      this.dryMusic.gain.setTargetAtTime(0, t, Math.max(0.05, fadeSeconds / 3));
      return;
    }
    this.afterparty = true;
    if (!this.folkBuffer) {
      void this.preload().then(() => {
        if (this.afterparty) this.setMusic(track, fadeSeconds);
      });
      return;
    }
    if (!this.dryMusicSource) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.folkBuffer;
      s.loop = true;
      s.connect(this.dryMusic);
      s.start();
      this.dryMusicSource = s;
    }
    this.dryMusic.gain.setTargetAtTime(0.85, t, Math.max(0.05, fadeSeconds / 3));
    this.events.emit('ui:toast', { text: `♪ ${FOLK_TITLE}`, kind: 'good', ms: 5000 });
  }

  /* ---- per-frame ---- */

  update(dt: number, rc: RadioContext): void {
    const t = this.ctx.currentTime;
    const speaking = !!this.voiceSource && t < this.voiceEndsAt;

    // --- ducking ---
    // Music sits under the commentator by 11 dB and comes back over 0.6 s.
    const targetDuck = speaking ? 1 : 0;
    this.duck += (targetDuck - this.duck) * (1 - Math.exp(-(speaking ? 12 : 2.2) * dt));
    this.folkDuck.gain.setTargetAtTime(1 - this.duck * 0.72, t, speaking ? 0.06 : 0.22);

    // --- routing: cabin vs. on foot ---
    const on = this.powered && rc.powered && this.station !== 'off';
    const cabin = on && rc.inCabin ? 1 : 0;
    const world = on && !rc.inCabin && rc.vehicleDistance < 45
      ? clamp(1 - rc.vehicleDistance / 45, 0, 1) * 0.8
      : 0;
    // Reactions (priority >= 2: stars, crashes, mission beats, the broadcast
    // hijack) also come out of the city's facade screens, so they still land
    // when the player is on foot and nowhere near a car.
    const paLive = !rc.inCabin && world < 0.15 && speaking && this.currentPriority >= 2;
    this.voiceChain.pa.gain.setTargetAtTime(paLive ? 0.55 : 0, t, paLive ? 0.05 : 0.3);
    this.musicChain.pa.gain.setTargetAtTime(0, t, 0.3);

    for (const chain of [this.voiceChain, this.musicChain]) {
      chain.cabin.gain.setTargetAtTime(cabin, t, 0.15);
      chain.world.gain.setTargetAtTime(world, t, 0.15);
      if (rc.vehiclePosition && chain.panner.positionX) {
        chain.panner.positionX.setTargetAtTime(rc.vehiclePosition.x, t, 0.05);
        chain.panner.positionY.setTargetAtTime(rc.vehiclePosition.y + 0.8, t, 0.05);
        chain.panner.positionZ.setTargetAtTime(rc.vehiclePosition.z, t, 0.05);
      }
    }

    // --- music bed level ---
    // Talk station: the folk track runs underneath at a broadcast bed level.
    // Folk station: full. Off: silent.
    const bed = this.station === 'folclor' ? 0.9 : this.station === 'enerveaza' ? 0.62 : 0;
    this.folkGain.gain.setTargetAtTime(on ? bed : 0, t, 0.4);
    if (on && !this.folkSource && this.folkBuffer) this.startFolkBed();

    if (!on) return;

    // --- scheduling ---
    if (speaking) {
      this.nextChatterAt = Math.max(this.nextChatterAt, this.voiceEndsAt);
      return;
    }
    if (this.voiceSource && !speaking) this.stopVoice();

    // Drain the reaction queue first.
    if (this.queue.length) {
      const q = this.queue.shift()!;
      void this.playClip(q.clip, q.priority, q.bucket);
      return;
    }

    if (t < this.nextChatterAt) return;

    // Station ident on power-up and every ~6 segments.
    if (!this.identDone || this.segmentsSinceIdent >= 6) {
      this.identDone = true;
      this.segmentsSinceIdent = 0;
      this.say('stationIdent', 0.5);
      this.nextChatterAt = t + 4;
      return;
    }

    if (this.station === 'folclor') {
      // Music station: keep the talk sparse.
      this.nextChatterAt = t + this.rng.range(55, 95);
      this.say('idle', 0.4);
      return;
    }

    // Talk station: mostly idle chatter, occasionally a long show segment.
    const wantLong = this.rng.next() < 0.12;
    this.say(wantLong ? 'showSegment' : 'idle', 0.4);
    this.nextChatterAt = t + this.rng.range(6, 15);
  }

  dispose(): void {
    this.stopVoice();
    for (const s of [this.folkSource, this.houseSource, this.dryMusicSource]) {
      try { s?.stop(); } catch { /* already stopped */ }
    }
  }
}
