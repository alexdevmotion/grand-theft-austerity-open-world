/**
 * One civilian driver.
 *
 * Owns a route through the lane graph, a lane within it, and the behaviours
 * that make a street look inhabited rather than animated: car-following with a
 * real time gap, overtaking things that have stopped, giving way at junctions,
 * obeying lights, leaning on the horn, and getting out of the player's way —
 * or failing to, and being hit.
 */

import * as THREE from 'three';
import type { Rng } from '../../core/rng';
import type { VehicleClass } from '../../core/services';
import { Driver, type ControllableVehicle, approachSpeed, cornerSpeed, wrapAngle } from './driver';
import { TRAM_LANE, TrafficGraph, type LaneEdge } from './roadGraph';
import { JunctionControl, bidScore } from './junctions';
import { findLead, footprint, type SensorField } from './sensors';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

interface Waypoint {
  x: number;
  z: number;
  /** Direction of travel leaving this waypoint. */
  hx: number;
  hz: number;
  /** Length of the segment leaving this waypoint. */
  len: number;
  /** Turn severity at this waypoint, radians. */
  turn: number;
}

export type AgentMood = 'cruise' | 'panic' | 'pulledOver' | 'wrecked';

export class TrafficAgent {
  readonly driver: Driver;
  readonly id: string;

  /** Current directed edge and lane. */
  edge: number;
  lane: number;
  /** Planned continuations: [next, next+1]. */
  private plan: number[] = [];
  private planLanes: number[] = [];

  private wps: Waypoint[] = [];
  private wi = 0;

  mood: AgentMood = 'cruise';
  panicTime = 0;
  private pullOverSide = 0;
  private hornCooldown = 0;
  private indicator: -1 | 0 | 1 | 2 = 0;
  private laneChangeCooldown = 0;
  private impatience = 0;
  /** Node whose crossing we currently hold. */
  private heldNode = -1;
  /** Seconds since spawn; used to keep freshly spawned cars polite. */
  age = 0;
  /** Set when the route runs out or the vehicle is beyond saving. */
  retire = false;
  private reanchorTime = 0;
  private scratch: number[] = [];

  /** Cached this step for the traffic system's reporting. */
  lastTargetSpeed = 0;
  /** Why this driver is not moving — the first thing to look at when a street
   *  jams. 'go' when nothing is holding it up. */
  stopReason: 'go' | 'light' | 'giveWay' | 'queue' | 'pulledOver' = 'go';

  /** Per-driver temperament, fixed at spawn. Deterministic. */
  readonly speedBias: number;

  constructor(
    readonly vehicle: ControllableVehicle,
    private graph: TrafficGraph,
    edge: number,
    lane: number,
    private rng: Rng,
  ) {
    this.id = vehicle.id;
    this.driver = new Driver(vehicle);
    this.edge = edge;
    this.lane = lane;
    this.speedBias = rng.range(0.78, 1.06);
    this.replan(true);
  }

  get kind(): VehicleClass {
    return this.vehicle.kind;
  }

  /** Keep the permanent way extending after its driver leaves. The vehicle
   * owns this route-only callback; it never runs NPC controls or reservations. */
  handoverRailRoute(): void {
    if (this.kind !== 'tram' || !this.vehicle.setRailPath) return;
    const graph = this.graph;
    const vehicle = this.vehicle;
    const predecessors = new Map<number, number>();
    for (const edge of graph.edges) {
      if (edge.tramStraight >= 0 && !predecessors.has(edge.tramStraight)) {
        predecessors.set(edge.tramStraight, edge.index);
      }
    }
    let current = this.edge;
    const points = (): Array<{ x: number; z: number }> => {
      const behind = predecessors.get(current);
      const edges = behind === undefined ? [current] : [behind, current];
      let tail = current;
      for (let i = 0; i < 2; i++) {
        tail = graph.edges[tail].tramStraight;
        if (tail < 0) break;
        edges.push(tail);
      }
      return edges.flatMap((index, i) => [
        ...(i ? graph.laneJoinPath(graph.edges[edges[i - 1]], TRAM_LANE, graph.edges[index], TRAM_LANE) ?? [] : []),
        ...(graph.lanePath(graph.edges[index], TRAM_LANE) ?? []),
      ]);
    };
    const scratch = new THREE.Vector3();
    const distance = (edge: number): number => graph.closestLanePoint(
      graph.edges[edge], TRAM_LANE, vehicle.position.x, vehicle.position.z, scratch,
    ).distance;
    vehicle.setRailPath!(points(), () => {
      const ahead = graph.edges[current].tramStraight;
      const behind = predecessors.get(current);
      const here = distance(current);
      if (ahead >= 0 && distance(ahead) + 0.1 < here) {
        // Reversing through a merge retraces the track we arrived on.
        predecessors.set(ahead, current);
        current = ahead;
      } else if (behind !== undefined && distance(behind) + 0.1 < here) {
        current = behind;
      } else return null;
      return points();
    });
  }

  private e(i: number): LaneEdge {
    return this.graph.edges[i];
  }

  /* ------------------------------------------------------------------ */
  /* routing                                                             */
  /* ------------------------------------------------------------------ */

  private pickNext(from: number, fromLane: number): { edge: number; lane: number } | null {
    const e = this.e(from);
    if (this.kind === 'tram') {
      // The road's straightest continuation can be plain asphalt while the
      // permanent way bends. Follow only the continuation verified against the
      // rendered rails; off the end of the wire, retire.
      const s = e.tramStraight;
      if (s < 0) return null;
      return { edge: s, lane: TRAM_LANE };
    }
    if (!e.next.length) return null;

    const weights: number[] = [];
    for (const nIdx of e.next) {
      const n = this.e(nIdx);
      const turn = this.graph.turnAngle(e, n);
      // Straight on is by far the most likely; bigger roads pull more traffic.
      let w = turn < 0.35 ? 6.0 : turn < 1.2 ? 1.6 : 0.9;
      w *= 0.55 + n.rank * 0.55;
      // Long vehicles avoid tight turns onto side streets.
      if ((this.kind === 'bus' || this.kind === 'truck') && turn > 1.2 && n.rank === 0) w *= 0.15;
      weights.push(w);
    }
    const chosen = this.rng.weighted(e.next, weights);
    const n = this.e(chosen);
    const turn = this.graph.turnAngle(e, n);
    const cross = e.ux * n.uz - e.uz * n.ux;
    let lane: number;
    if (turn < 0.35) lane = Math.min(fromLane === TRAM_LANE ? 0 : fromLane, n.lanes - 1);
    else if (cross > 0) lane = n.lanes - 1;       // right turn: hug the kerb
    else lane = 0;                                 // left turn: inside lane
    return { edge: chosen, lane: Math.max(0, lane) };
  }

  /** Rebuild the plan and the waypoint polyline. */
  private replan(full: boolean): void {
    if (full) {
      this.plan.length = 0;
      this.planLanes.length = 0;
    }
    let tailEdge = this.plan.length ? this.plan[this.plan.length - 1] : this.edge;
    let tailLane = this.planLanes.length ? this.planLanes[this.planLanes.length - 1] : this.lane;
    let guard = 0;
    while (this.plan.length < 2 && guard++ < 6) {
      const nxt = this.pickNext(tailEdge, tailLane);
      if (!nxt) break;
      this.plan.push(nxt.edge);
      this.planLanes.push(nxt.lane);
      tailEdge = nxt.edge;
      tailLane = nxt.lane;
    }
    this.rebuildWaypoints();
  }

  private rebuildWaypoints(): void {
    const wps: Waypoint[] = [];
    const push = (x: number, z: number): void => {
      const last = wps[wps.length - 1];
      if (last && Math.hypot(last.x - x, last.z - z) < 0.6) return;
      wps.push({ x, z, hx: 0, hz: 1, len: 0, turn: 0 });
    };
    const pushLane = (edge: LaneEdge, lane: number): void => {
      const rail = this.graph.lanePath(edge, lane);
      if (rail?.length) {
        for (const p of rail) push(p.x, p.z);
        return;
      }
      this.graph.laneEntry(edge, lane, _a);
      push(_a.x, _a.z);
      this.graph.laneExit(edge, lane, _a);
      push(_a.x, _a.z);
    };

    const e0 = this.e(this.edge);
    pushLane(e0, this.lane);

    let prev = e0;
    let prevLane = this.lane;
    for (let k = 0; k < this.plan.length; k++) {
      const n = this.e(this.plan[k]);
      const nLane = this.planLanes[k];
      const railJoin = this.graph.laneJoinPath(prev, prevLane, n, nLane);
      if (railJoin?.length) {
        for (const p of railJoin) push(p.x, p.z);
      } else {
        this.graph.cornerPoint(prev, prevLane, n, nLane, _b);
        push(_b.x, _b.z);
      }
      pushLane(n, nLane);
      prev = n;
      prevLane = nLane;
    }

    for (let i = 0; i < wps.length - 1; i++) {
      const dx = wps[i + 1].x - wps[i].x;
      const dz = wps[i + 1].z - wps[i].z;
      const l = Math.max(1e-4, Math.hypot(dx, dz));
      wps[i].hx = dx / l;
      wps[i].hz = dz / l;
      wps[i].len = l;
    }
    if (wps.length >= 2) {
      const last = wps[wps.length - 1];
      last.hx = wps[wps.length - 2].hx;
      last.hz = wps[wps.length - 2].hz;
    }
    for (let i = 1; i < wps.length - 1; i++) {
      const dot = wps[i - 1].hx * wps[i].hx + wps[i - 1].hz * wps[i].hz;
      wps[i].turn = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    }
    this.wps = wps;
    this.wi = 0;
    if (this.kind === 'tram') this.vehicle.setRailPath?.(wps);
  }

  /* ------------------------------------------------------------------ */
  /* path following                                                      */
  /* ------------------------------------------------------------------ */

  /** Advance the polyline cursor and return the signed cross-track error. */
  private track(px: number, pz: number): number {
    let cross = 0;
    while (this.wi < this.wps.length - 1) {
      const w = this.wps[this.wi];
      const t = ((px - w.x) * w.hx + (pz - w.z) * w.hz) / Math.max(0.2, w.len);
      if (t > 1) { this.wi++; continue; }
      // Positive when we sit to the LEFT of the path; the driver's Stanley
      // term steers right to null it out.
      cross = (px - w.x) * w.hz - (pz - w.z) * w.hx;
      return cross;
    }
    const w = this.wps[Math.max(0, this.wps.length - 1)];
    if (w) cross = (px - w.x) * w.hz - (pz - w.z) * w.hx;
    return cross;
  }

  /** Point `dist` metres further along the polyline, plus its heading. */
  private lookahead(px: number, pz: number, dist: number, out: THREE.Vector3): number {
    let i = this.wi;
    if (i >= this.wps.length - 1) {
      const w = this.wps[this.wps.length - 1];
      if (!w) { out.set(px, 0, pz); return 0; }
      out.set(w.x + w.hx * dist, 0, w.z + w.hz * dist);
      return Math.atan2(w.hx, w.hz);
    }
    const w0 = this.wps[i];
    let along = (px - w0.x) * w0.hx + (pz - w0.z) * w0.hz;
    let remain = dist;
    while (i < this.wps.length - 1) {
      const w = this.wps[i];
      const left = w.len - along;
      if (remain <= left) {
        const s = along + remain;
        out.set(w.x + w.hx * s, 0, w.z + w.hz * s);
        return Math.atan2(w.hx, w.hz);
      }
      remain -= Math.max(0, left);
      along = 0;
      i++;
    }
    const w = this.wps[this.wps.length - 1];
    out.set(w.x + w.hx * remain, 0, w.z + w.hz * remain);
    return Math.atan2(w.hx, w.hz);
  }

  /** Distance along the path to the next corner, and how sharp it is. */
  private nextCorner(px: number, pz: number): { dist: number; turn: number } {
    let i = this.wi;
    if (i >= this.wps.length - 1) return { dist: Infinity, turn: 0 };
    const w0 = this.wps[i];
    let d = Math.max(0, w0.len - ((px - w0.x) * w0.hx + (pz - w0.z) * w0.hz));
    for (i = this.wi + 1; i < this.wps.length; i++) {
      if (this.wps[i].turn > 0.16) return { dist: d, turn: this.wps[i].turn };
      d += this.wps[i].len;
      if (d > 90) break;
    }
    return { dist: Infinity, turn: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* per-step                                                            */
  /* ------------------------------------------------------------------ */

  /** Distance from the vehicle to the mouth of the junction it is approaching. */
  distanceToJunction(): number {
    const e = this.e(this.edge);
    const off = this.graph.laneOffset(e, this.lane);
    const ax = e.ex + e.rx * off;
    const az = e.ez + e.rz * off;
    const along = (this.vehicle.position.x - ax) * e.ux + (this.vehicle.position.z - az) * e.uz;
    return e.length - along;
  }

  /** Sensing pass — runs for every agent before anyone acts. */
  bid(junctions: JunctionControl): void {
    if (this.mood === 'pulledOver' || this.retire) return;
    const e = this.e(this.edge);
    const d = this.distanceToJunction() - footprint(this.kind)[0] - 1.4;
    if (d > 34 || d < -2) return;
    junctions.bid(e.to, this.id, bidScore(e.rank, d, Math.abs(this.vehicle.speed)));
  }

  update(
    dt: number,
    field: SensorField,
    junctions: JunctionControl,
    events: { horn(x: number, z: number): void },
  ): void {
    const v = this.vehicle;
    this.age += dt;
    this.hornCooldown = Math.max(0, this.hornCooldown - dt);
    this.laneChangeCooldown = Math.max(0, this.laneChangeCooldown - dt);
    this.driver.sense(dt);

    if (v.isWrecked) {
      this.mood = 'wrecked';
      v.setControls(0, 0, true);
      if (this.heldNode >= 0) { junctions.release(this.heldNode, this.id); this.heldNode = -1; }
      return;
    }

    let px = v.position.x;
    let pz = v.position.z;
    const speed = v.speed;
    const halfLen = footprint(this.kind)[0];
    const guidedTram = this.kind === 'tram' && !!v.setRailPath;

    /* ---- advance the route when we cross into the next edge ---- */
    if (this.plan.length) {
      const n = this.e(this.plan[0]);
      const nLane = this.planLanes[0];
      const off = this.graph.laneOffset(n, nLane);
      const ax = n.ex + n.rx * off;
      const az = n.ez + n.rz * off;
      const along = (px - ax) * n.ux + (pz - az) * n.uz;
      const lateral = Math.abs((px - ax) * n.rx + (pz - az) * n.rz);
      // Crossing an infinite entry plane is insufficient on turns: an entire
      // incoming lane can already lie beyond it, far from the next street.
      if (along > -0.5 && lateral < 4 && this.distanceToJunction() < 1) {
        this.edge = this.plan.shift()!;
        this.lane = this.planLanes.shift()!;
        this.replan(false);
      }
    } else if (this.distanceToJunction() < -4) {
      this.retire = true;
      return;
    }
    const e = this.e(this.edge);
    if (this.heldNode >= 0) {
      const along = (px - e.ex) * e.ux + (pz - e.ez) * e.uz;
      if (e.from === this.heldNode && along > halfLen + 1) {
        junctions.release(this.heldNode, this.id);
        this.heldNode = -1;
      } else {
        junctions.refresh(this.heldNode, this.id);
      }
    }

    /* ---- path ---- */
    let cross = this.track(px, pz);
    // Shunted off the road, flipped, or picked up by the vehicle system's stuck
    // rescue: find whatever lane we are actually in rather than trying to drive
    // back to one 40 m away through a building.
    const tramLost = this.kind === 'tram' && (
      Math.abs(cross) > 2 || this.laneError > THREE.MathUtils.degToRad(12)
    );
    if (!guidedTram && (tramLost || Math.abs(cross) > 22)) {
      this.reanchorTime += dt;
      if (this.reanchorTime > (this.kind === 'tram' ? 0.25 : 0.5)) {
        this.reanchorTime = 0;
        const found = this.kind === 'tram'
          ? this.graph.nearestTramLane(px, pz, this.driver.heading, this.scratch)
          : this.graph.nearestLane(px, pz, this.driver.heading, this.scratch);
        if (found) {
          if (this.heldNode >= 0) { junctions.release(this.heldNode, this.id); this.heldNode = -1; }
          this.edge = found.edge;
          this.lane = found.lane;
          this.replan(true);
          if (this.kind === 'tram') {
            // A rail vehicle cannot steer back from a collision as though it
            // were a bus. Re-seat its bogie centre on the exact rendered track,
            // pass ground height (VehicleHandle adds ride height itself), and
            // reset yaw to the local tangent. This is a bounded derailment
            // recovery, not a per-frame kinematic animation.
            const pose = this.graph.closestLanePoint(
              this.e(this.edge), TRAM_LANE, px, pz, _a,
            );
            v.teleport(_a, pose.heading);
            px = v.position.x;
            pz = v.position.z;
          }
          cross = this.track(px, pz);
        } else {
          this.retire = true;
          return;
        }
      }
    } else {
      this.reanchorTime = 0;
    }
    const absSpeed = Math.abs(speed);
    const look = THREE.MathUtils.clamp(5.5 + absSpeed * 0.85, 6, 26);

    /* ---- speed budget ---- */
    const roadLimit = this.classLimit(e);
    let target = roadLimit;

    // Corner ahead.
    const corner = this.nextCorner(px, pz);
    if (corner.dist < 90) {
      const vc = cornerSpeed(this.driver.tuning, corner.turn, 9);
      target = Math.min(target, approachSpeed(vc, Math.max(0, corner.dist - 3), this.driver.tuning.brake));
    }

    // Car in front.
    const lead = findLead(field, this.id, px, pz, this.driver.heading, halfLen,
      Math.max(16, absSpeed * 2.6 + 12), 1.5);
    let leadGap = Infinity;
    let leadIsPlayer = false;
    let emergency = false;
    if (lead.obstacle) {
      leadGap = lead.gap;
      leadIsPlayer = lead.obstacle.isPlayer;
      const desired = this.driver.tuning.minGap + Math.max(0, speed) * this.driver.tuning.headway;
      const follow = lead.speed + (leadGap - desired) / 1.15;
      target = Math.min(target, Math.max(0, follow));
      if (leadGap < desired * 0.55) {
        target = Math.min(target, Math.max(0, lead.speed - 1.5));
        emergency = leadGap < 2.4;
      }
    }

    /* ---- junction ---- */
    const dJunc = this.distanceToJunction() - halfLen - 1.4;
    let mustStop = false;
    let stoppedBySignal = false;
    const crossing = this.heldNode === e.to && dJunc < 0;
    if (!crossing && this.distanceToJunction() > -halfLen && dJunc < 70 && this.mood !== 'pulledOver') {
      const sig = junctions.signal(e.to, e.axisX);
      const stopDist = (speed * speed) / (2 * this.driver.tuning.brake);
      if (sig === 'red') mustStop = true;
      else if (sig === 'amber' && dJunc > stopDist * 0.85 + 1.5) mustStop = true;
      stoppedBySignal = mustStop;
      // Reservations also protect a green phase from a vehicle still clearing
      // the box, and separate opposing turns within the same signal phase.
      if (!mustStop && this.heldNode !== e.to && !junctions.mayEnter(e.to, this.id, this.edge)) mustStop = true;
      // Never enter a junction we cannot clear.
      if (!mustStop && lead.obstacle && leadGap < 4 && dJunc < 6) mustStop = true;

      if (mustStop) {
        if (this.heldNode === e.to && dJunc >= 0) {
          junctions.release(this.heldNode, this.id);
          this.heldNode = -1;
        }
        target = Math.min(target, approachSpeed(0, Math.max(0, dJunc), this.driver.tuning.brake));
      } else if (dJunc < 16) {
        // Refresh every step: a claim that lapses mid-crossing lets someone
        // else into the box with us.
        junctions.claim(e.to, this.id, this.edge);
        this.heldNode = e.to;
      }
    }

    /* ---- panic / pull over ---- */
    if (this.panicTime > 0 && !guidedTram) {
      this.panicTime -= dt;
      if (this.mood === 'cruise') {
        this.mood = 'panic';
        this.pullOverSide = 1;
        this.indicator = 2;
      }
      if (this.mood === 'panic') {
        // Get out of the lane and stop against the kerb.
        const outer = Math.max(0, e.lanes - 1);
        if (this.lane !== outer && this.lane !== TRAM_LANE) {
          this.lane = outer;
          this.rebuildWaypoints();
        }
        target = Math.min(target, absSpeed > 6 ? 6 : 2.5);
        if (absSpeed < 1.6 && this.age > 1) this.mood = 'pulledOver';
      }
      if (this.hornCooldown <= 0 && this.rng.bool(0.02)) {
        this.hornCooldown = 2.2;
        events.horn(px, pz);
      }
    } else if (this.mood === 'panic' || this.mood === 'pulledOver') {
      this.mood = 'cruise';
      this.indicator = 0;
      this.pullOverSide = 0;
    }

    if (this.mood === 'pulledOver') {
      this.driver.halt(dt);
      this.applyLights();
      this.lastTargetSpeed = 0;
      this.stopReason = 'pulledOver';
      return;
    }

    /* ---- overtaking a stopped obstruction ---- */
    if (
      this.laneChangeCooldown <= 0 && e.lanes > 1 && this.lane !== TRAM_LANE &&
      lead.obstacle && leadGap < 14 && Math.abs(lead.speed) < 1.2 && !mustStop && dJunc > 22
    ) {
      const to = this.lane > 0 ? this.lane - 1 : Math.min(e.lanes - 1, this.lane + 1);
      if (to !== this.lane && this.laneClear(field, e, to)) {
        this.indicator = to < this.lane ? -1 : 1;
        this.lane = to;
        this.laneChangeCooldown = 4.5;
        this.rebuildWaypoints();
        cross = this.track(px, pz);
      } else {
        this.laneChangeCooldown = 1.2;
      }
    } else if (this.indicator === -1 || this.indicator === 1) {
      if (Math.abs(cross) < 0.9) this.indicator = 0;
    }

    // Route rebuilding uses the shared point scratch space, so sample the
    // actual aim after any lane change or pull-over has rebuilt the path.
    const pathHeading = this.lookahead(px, pz, look, _a);

    /* ---- reaction to the player ---- */
    if (leadIsPlayer && leadGap < 16) {
      target = Math.min(target, Math.max(0, lead.speed * 0.85));
      if (leadGap < 8) emergency = true;
      if (this.hornCooldown <= 0) {
        this.hornCooldown = 1.6 + this.rng.next() * 1.5;
        events.horn(px, pz);
      }
      // Swerve: nudge the aim point away from whichever side the player is on.
      const dodge = lead.lateral > 0 ? -1 : 1;
      if (!guidedTram) {
        _a.x += this.driver.forwardZ * dodge * Math.min(2.4, 14 / Math.max(2, leadGap));
        _a.z -= this.driver.forwardX * dodge * Math.min(2.4, 14 / Math.max(2, leadGap));
      }
    }

    /* ---- impatience: horn at whatever is blocking us ---- */
    if (leadGap < 7 && absSpeed < 1.2 && !mustStop) {
      this.impatience += dt;
      if (this.impatience > 4.5 && this.hornCooldown <= 0) {
        this.hornCooldown = 9 + this.rng.next() * 6;
        this.impatience = 0;
        events.horn(px, pz);
      }
    } else {
      this.impatience = Math.max(0, this.impatience - dt);
    }

    this.stopReason = mustStop
      ? (stoppedBySignal ? 'light' : 'giveWay')
      : target < 1 ? 'queue' : 'go';

    // Kerb-side offset while pulled over / panicking.
    // The steering controller uses positive cross-track to the left.
    const extraCross = -this.pullOverSide * 1.7;
    if (guidedTram && !this.plan.length) {
      const remaining = this.distanceToJunction() - halfLen;
      target = Math.min(target, approachSpeed(0, Math.max(0, remaining - 0.25), this.driver.tuning.brake));
      if (remaining < 0.6 && absSpeed < 0.3) this.retire = true;
    }
    this.lastTargetSpeed = target;

    this.driver.drive(dt, _a.x, _a.z, target, pathHeading, {
      crossTrack: cross - extraCross,
      emergency,
      allowReverse: this.kind !== 'tram' && !mustStop && !lead.obstacle,
    });
    this.applyLights();
  }

  private applyLights(): void {
    this.vehicle.setIndicator?.(this.indicator);
  }

  private classLimit(e: LaneEdge): number {
    let v = e.speed;
    switch (this.kind) {
      case 'bus': v = Math.min(v, 13.5); break;
      case 'truck': v = Math.min(v, 14.5); break;
      case 'tram': v = Math.min(v, 12.5); break;
      case 'van': v = Math.min(v, 16.5); break;
      case 'dacia': v = Math.min(v, 18.5); break;
      default: break;
    }
    // A little spread so a queue does not move as one rigid block.
    return v * this.speedBias;
  }

  private laneClear(field: SensorField, e: LaneEdge, lane: number): boolean {
    const off = this.graph.laneOffset(e, lane) - this.graph.laneOffset(e, this.lane);
    const px = this.vehicle.position.x + e.rx * off;
    const pz = this.vehicle.position.z + e.rz * off;
    let clear = true;
    field.forEachNear(px, pz, 16, (o) => {
      if (!clear || o.id === this.id) return;
      const dx = o.x - px;
      const dz = o.z - pz;
      const along = dx * this.driver.forwardX + dz * this.driver.forwardZ;
      const lat = dx * this.driver.forwardZ - dz * this.driver.forwardX;
      if (Math.abs(lat) < 2.0 && along > -9 && along < 16) clear = false;
    });
    return clear;
  }

  /** Angle between our heading and the lane we are supposed to be in. */
  get laneError(): number {
    const e = this.e(this.edge);
    const pose = this.graph.closestLanePoint(
      e, this.lane, this.vehicle.position.x, this.vehicle.position.z, _b,
    );
    return Math.abs(wrapAngle(pose.heading - this.driver.heading));
  }

  releaseAll(junctions: JunctionControl): void {
    junctions.forget(this.id);
    this.heldNode = -1;
  }
}
