/**
 * Junction control: signal phases where the city marked a traffic light, and
 * priority give-way plus a one-claim-at-a-time reservation everywhere else.
 *
 * The reservation is what actually stops cars driving through each other at a
 * crossroads. Every vehicle that wants to enter a junction bids for it; the
 * highest bid wins the node for as long as it takes to cross, and everyone else
 * holds at the stop line. Bids are scored by road rank first (a side street
 * gives way to a boulevard) and then by who is closest to the line, which is
 * exactly how an unsignalled Bucharest junction behaves.
 */

import type { RoadNode } from '../../core/services';

export type Signal = 'green' | 'amber' | 'red';

/** Full signal cycle, seconds. */
const PERIOD = 26;
const X_GREEN = 11.0;
const X_AMBER = 12.6;
const Z_GREEN = 24.0;

interface Claim {
  /** Same-approach vehicles may follow; each keeps the crossing until its rear clears. */
  edge: number;
  holders: Map<string, number>;
}

export class JunctionControl {
  private claims = new Map<number, Claim>();
  private bids = new Map<number, { bidder: string; score: number }>();
  private lit: boolean[] = [];
  private offset: number[] = [];
  private clock = 0;

  constructor(nodes: ReadonlyArray<RoadNode>) {
    for (let i = 0; i < nodes.length; i++) {
      this.lit.push(nodes[i].hasTrafficLight);
      // Deterministic per-node phase offset so the whole city does not blink in
      // unison — that reads as a single machine rather than a street network.
      this.offset.push(((i * 7919) % 1000) / 1000 * PERIOD);
    }
  }

  hasLight(node: number): boolean {
    return this.lit[node] ?? false;
  }

  /** Signal facing an approach that runs along world X (or along Z). */
  signal(node: number, axisX: boolean): Signal {
    if (!this.lit[node]) return 'green';
    const t = (this.clock + this.offset[node]) % PERIOD;
    if (axisX) {
      if (t < X_GREEN) return 'green';
      if (t < X_AMBER) return 'amber';
      return 'red';
    }
    if (t < X_AMBER) return 'red';
    if (t < Z_GREEN) return 'green';
    return 'amber';
  }

  /** Seconds until this approach turns green again (0 when it already is). */
  redRemaining(node: number, axisX: boolean): number {
    if (!this.lit[node]) return 0;
    const t = (this.clock + this.offset[node]) % PERIOD;
    if (axisX) return t < X_AMBER ? 0 : PERIOD - t;
    return t < X_AMBER ? X_AMBER - t : 0;
  }

  /* ---------------- reservations ---------------- */

  /**
   * Register interest in crossing `node`. Higher `score` wins. Called during
   * the sensing pass; `winner()` is read during the acting pass, so within one
   * fixed step every contender sees the same decision.
   */
  bid(node: number, bidder: string, score: number): void {
    const cur = this.bids.get(node);
    if (!cur || score > cur.score) this.bids.set(node, { bidder, score });
  }

  /**
   * True when `bidder` may cross `node`. A vehicle arriving on the same
   * approach as the current holder is allowed to follow it through — without
   * that, every unsignalled crossroads meters traffic one car at a time and the
   * whole city crawls.
   */
  mayEnter(node: number, bidder: string, edge: number): boolean {
    const held = this.claims.get(node);
    if (held) return held.holders.has(bidder) || held.edge === edge;
    if (this.hasLight(node)) return true;
    const win = this.bids.get(node);
    return !win || win.bidder === bidder;
  }

  /** Take (or refresh) the node. Lapses if the winner never actually arrives. */
  claim(node: number, bidder: string, edge: number): void {
    const held = this.claims.get(node);
    if (held && held.edge !== edge) return;
    if (held) { held.holders.set(bidder, 5); return; }
    this.claims.set(node, { edge, holders: new Map([[bidder, 5]]) });
  }

  /** Keep an occupied crossing reserved, even after its entrance is behind us. */
  refresh(node: number, bidder: string): void {
    const held = this.claims.get(node);
    if (held?.holders.has(bidder)) held.holders.set(bidder, 5);
  }

  release(node: number, bidder: string): void {
    const held = this.claims.get(node);
    if (!held) return;
    held.holders.delete(bidder);
    if (!held.holders.size) this.claims.delete(node);
  }

  /** Drop every claim held by a vehicle that has just been despawned. */
  forget(bidder: string): void {
    for (const node of this.claims.keys()) this.release(node, bidder);
  }

  update(dt: number): void {
    this.clock += dt;
    for (const [node, c] of this.claims) {
      for (const [bidder, ttl] of c.holders) {
        if (ttl <= dt) c.holders.delete(bidder);
        else c.holders.set(bidder, ttl - dt);
      }
      if (!c.holders.size) this.claims.delete(node);
    }
    this.bids.clear();
  }

  get activeClaims(): number {
    return this.claims.size;
  }
}

/**
 * Bid score for an approach. Rank dominates so a boulevard always beats a side
 * street; within a rank the vehicle nearest the line goes first, and a vehicle
 * already rolling beats one stopped, which breaks four-way deadlocks.
 */
export function bidScore(rank: number, distanceToLine: number, speed: number): number {
  return rank * 1000 - Math.min(60, distanceToLine) * 10 + Math.min(8, speed);
}
