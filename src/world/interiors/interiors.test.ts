/**
 * The promises interiors make to the rest of the game, as assertions.
 *
 * Every one of these has a failure mode that is invisible in a screenshot and
 * fatal in play: a doorway a car can drive through, a wall with a gap in it, a
 * room with no floor, or — the one that started all this — a Builders House
 * whose lobby cannot be entered, which silently makes Act IV unfinishable.
 */

import { describe, expect, test } from 'bun:test';
import { Rng } from '../../core/rng';
import { DetailBuilder, FacadeBuilder, SurfaceBuilder } from '../city/builders';
import { buildBuildersHouse, PLAZAS, buildPlaza, type LandmarkSink } from '../city/landmarks';
import { LOBBY, TOWER, TOWER_SOUTH_Z } from '../../content/places';
import { BLOCKERS, INTERIORS, INTERIOR_VOIDS } from './defs';
import {
  MAX_LEAF, doorCentre, doorInside, doorNormal, doorOutside, entryAnchor, floorSlab, innerHalf,
  leafWidth, shellBoxes, type ShellBox, type ShellSpec,
} from './shell';
import { fitLobby } from './lobby';
import { fitRecorder } from './recorder';
import { fitStudio } from './studio';
import { fitBar, fitBlockHall, fitShop } from './ambient';

/** Body width of the Dacia 1300, which must never fit through a doorway. */
const CAR_WIDTH = 1.52;
/** A player capsule is 0.32 m in radius; this is the clearance he needs. */
const PERSON_WIDTH = 0.9;

function hits(boxes: ShellBox[], x: number, y: number, z: number): boolean {
  return boxes.some(
    (b) => Math.abs(x - b.x) <= b.hx && Math.abs(z - b.z) <= b.hz && y >= 0 && y <= b.h,
  );
}

function sink(): LandmarkSink {
  const f = new FacadeBuilder();
  const s = new SurfaceBuilder();
  const d = new DetailBuilder();
  return { facade: () => f, surf: () => s, detail: () => d };
}

describe('doorways', () => {
  for (const spec of INTERIORS) {
    test(`${spec.id}: a person fits and the Dacia does not`, () => {
      const leaf = leafWidth(spec.door);
      expect(leaf).toBeGreaterThanOrEqual(PERSON_WIDTH);
      expect(leaf).toBeLessThanOrEqual(MAX_LEAF);
      expect(leaf).toBeLessThan(CAR_WIDTH);
    });

    test(`${spec.id}: the doorway is actually a hole in the shell`, () => {
      const boxes = shellBoxes(spec);
      const n = doorNormal(spec.door);
      const c = doorCentre(spec);
      // Walk the centre of one leaf from outside to inside at head height.
      const off = spec.door.mullion > 0 ? (spec.door.mullion + leafWidth(spec.door)) / 2 : 0;
      const px = c.x + (n.x === 0 ? off : 0);
      const pz = c.z + (n.x === 0 ? 0 : off);
      for (let t = -3; t <= 3; t += 0.25) {
        const x = px + n.x * t;
        const z = pz + n.z * t;
        expect(hits(boxes, x, spec.floorY + 1.0, z)).toBe(false);
      }
    });

    test(`${spec.id}: the walls are solid everywhere else`, () => {
      const boxes = shellBoxes(spec);
      const y = spec.floorY + 1.0;
      const { hx, hz } = innerHalf(spec);
      // Sample each elevation just inside its outer face, skipping the bay the
      // door is in.
      const insetX = spec.w / 2 - spec.wallT / 2;
      const insetZ = spec.d / 2 - spec.wallT / 2;
      let sampled = 0;
      for (let u = -0.9; u <= 0.9; u += 0.1) {
        const along = { x: spec.cx + u * hx, z: spec.cz + u * hz };
        const near = Math.abs(u * hx - spec.door.offset) < spec.door.width;
        const nearZ = Math.abs(u * hz - spec.door.offset) < spec.door.width;
        if (!(spec.door.side === 'north' && near)) {
          expect(hits(boxes, along.x, y, spec.cz + insetZ)).toBe(true);
          sampled++;
        }
        if (!(spec.door.side === 'south' && near)) {
          expect(hits(boxes, along.x, y, spec.cz - insetZ)).toBe(true);
        }
        if (!(spec.door.side === 'east' && nearZ)) {
          expect(hits(boxes, spec.cx + insetX, y, along.z)).toBe(true);
        }
        if (!(spec.door.side === 'west' && nearZ)) {
          expect(hits(boxes, spec.cx - insetX, y, along.z)).toBe(true);
        }
      }
      expect(sampled).toBeGreaterThan(4);
    });

    test(`${spec.id}: the centre of the room is open`, () => {
      const boxes = shellBoxes(spec);
      expect(hits(boxes, spec.cx, spec.floorY + 1.0, spec.cz)).toBe(false);
    });

    test(`${spec.id}: standing spots either side of the door are clear`, () => {
      const boxes = shellBoxes(spec);
      const inside = doorInside(spec, 2.6);
      const outside = doorOutside(spec, 2.6);
      expect(hits(boxes, inside.x, spec.floorY + 1.0, inside.z)).toBe(false);
      expect(hits(boxes, outside.x, spec.floorY + 1.0, outside.z)).toBe(false);
    });

    test(`${spec.id}: has a floor under the whole room`, () => {
      const f = floorSlab(spec);
      const { hx, hz } = innerHalf(spec);
      expect(f.top).toBeCloseTo(spec.floorY, 6);
      expect(f.x0).toBeLessThanOrEqual(spec.cx - hx);
      expect(f.x1).toBeGreaterThanOrEqual(spec.cx + hx);
      expect(f.z0).toBeLessThanOrEqual(spec.cz - hz);
      expect(f.z1).toBeGreaterThanOrEqual(spec.cz + hz);
    });

    test(`${spec.id}: the room has usable proportions`, () => {
      const { hx, hz } = innerHalf(spec);
      expect(hx).toBeGreaterThan(2);
      expect(hz).toBeGreaterThan(2);
      expect(spec.ceilingY - spec.floorY).toBeGreaterThan(2.4);
      expect(spec.massH).toBeGreaterThan(spec.ceilingY);
    });
  }
});

/**
 * WHERE A PLAYER WHO HAS JUST WALKED IN IS PUT.
 *
 * The playtest reported `enter('broadcastStudio')` dropping the player at
 * 438 / 167.4 "outside the shell, hanging over a void". The point was in fact
 * inside the room — 2.6 m inside the door, which `doorInside` was being asked
 * for — but the chase camera booms about five metres BEHIND the player, so at
 * 2.6 m the lens was two and a half metres outside the building and the frame
 * was of the facade and the sky. These pin the anchor that replaced it.
 */
describe('entry anchors', () => {
  /** Roughly how far behind the player the third-person boom sits. */
  const BOOM = 5.0;

  for (const spec of INTERIORS) {
    test(`${spec.id}: the anchor is inside the room, clear of the walls`, () => {
      const a = entryAnchor(spec);
      const { hx, hz } = innerHalf(spec);
      expect(Math.abs(a.x - spec.cx)).toBeLessThanOrEqual(hx - 0.99);
      expect(Math.abs(a.z - spec.cz)).toBeLessThanOrEqual(hz - 0.99);
      expect(hits(shellBoxes(spec), a.x, spec.floorY + 1.0, a.z)).toBe(false);
    });

    test(`${spec.id}: it faces into the room, not back out of the door`, () => {
      const a = entryAnchor(spec);
      const n = doorNormal(spec.door);
      // Facing vector for a yaw where 0 rad is +Z.
      const fx = Math.sin(a.yaw);
      const fz = Math.cos(a.yaw);
      expect(fx * n.x + fz * n.z).toBeLessThan(-0.99);
    });

    test(`${spec.id}: it stands back far enough for the camera boom`, () => {
      const a = entryAnchor(spec);
      const c = doorCentre(spec);
      const n = doorNormal(spec.door);
      // How deep into the room the anchor is, measured along the door normal.
      const depth = (c.x - a.x) * n.x + (c.z - a.z) * n.z;
      expect(depth).toBeGreaterThanOrEqual(2.2);
      // In a room that can afford it, the whole boom fits inside.
      const room = n.x === 0 ? innerHalf(spec).hz * 2 : innerHalf(spec).hx * 2;
      if (room > 20) expect(depth).toBeGreaterThan(BOOM);
    });

    /**
     * The boom must not run down the one line through the wall that has a
     * hole in it, or the camera leaves the building through the front door.
     */
    test(`${spec.id}: the anchor is off the door centreline`, () => {
      const a = entryAnchor(spec);
      const c = doorCentre(spec);
      const n = doorNormal(spec.door);
      // Lateral distance from the door axis.
      const lateral = n.x === 0 ? Math.abs(a.x - c.x) : Math.abs(a.z - c.z);
      expect(lateral).toBeGreaterThan(spec.door.width / 2);
    });

    test(`${spec.id}: nothing solid is standing on the anchor`, () => {
      const a = entryAnchor(spec);
      const { hx, hz } = innerHalf(spec);
      for (const bl of BLOCKERS[spec.id] ?? []) {
        const cx = spec.cx + (bl.ax ?? 0) * hx + (bl.dx ?? 0);
        const cz = spec.cz + (bl.az ?? 0) * hz + (bl.dz ?? 0);
        const on = Math.abs(a.x - cx) < bl.hx + 0.4 && Math.abs(a.z - cz) < bl.hz + 0.4;
        expect(`${spec.id}:${on}`).toBe(`${spec.id}:false`);
      }
    });
  }

  test('the broadcast studio no longer spawns you in the doorway', () => {
    const studio = INTERIORS.find((s) => s.id === 'broadcastStudio')!;
    const a = entryAnchor(studio);
    // The reported bad spot, and the distance it was from the room.
    expect(Math.hypot(a.x - 438, a.z - 167.4)).toBeGreaterThan(3);
  });
});

describe('furniture colliders', () => {
  for (const spec of INTERIORS) {
    test(`${spec.id}: blockers stay inside the room and clear of the door`, () => {
      const list = BLOCKERS[spec.id] ?? [];
      const { hx, hz } = innerHalf(spec);
      const inside = doorInside(spec, 1.6);
      for (const bl of list) {
        const cx = spec.cx + (bl.ax ?? 0) * hx + (bl.dx ?? 0);
        const cz = spec.cz + (bl.az ?? 0) * hz + (bl.dz ?? 0);
        expect(Math.abs(cx - spec.cx) - bl.hx).toBeLessThanOrEqual(hx + 0.6);
        expect(Math.abs(cz - spec.cz) - bl.hz).toBeLessThanOrEqual(hz + 0.6);
        // Nothing may stand in the doorway.
        const blocksDoor =
          Math.abs(inside.x - cx) < bl.hx + 0.4 && Math.abs(inside.z - cz) < bl.hz + 0.4;
        expect(blocksDoor).toBe(false);
      }
    });
  }
});

describe('placement', () => {
  test('every footprint is inside a void with margin', () => {
    for (const spec of INTERIORS) {
      if (spec.id === 'buildersLobby') continue; // covered by the BUILDERS void
      const covered = INTERIOR_VOIDS.some(
        (v) =>
          v.x0 <= spec.cx - spec.w / 2 - 1 && v.x1 >= spec.cx + spec.w / 2 + 1 &&
          v.z0 <= spec.cz - spec.d / 2 - 1 && v.z1 >= spec.cz + spec.d / 2 + 1,
      );
      expect(`${spec.id}:${covered}`).toBe(`${spec.id}:true`);
    }
  });

  test('interiors do not overlap each other', () => {
    for (let i = 0; i < INTERIORS.length; i++) {
      for (let j = i + 1; j < INTERIORS.length; j++) {
        const a = INTERIORS[i];
        const b = INTERIORS[j];
        const overlap =
          Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cz - b.cz) < (a.d + b.d) / 2;
        expect(`${a.id}/${b.id}:${overlap}`).toBe(`${a.id}/${b.id}:false`);
      }
    }
  });
});

describe('Builders House', () => {
  const built = buildBuildersHouse(sink(), new Rng('test'));

  test('the tower is a shell with a doorway, not a solid block', () => {
    // Solid at the back, open at the door.
    expect(hits(built.boxes, TOWER.cx, 2, TOWER.cz + TOWER.d / 2 - 0.4)).toBe(true);
    expect(hits(built.boxes, TOWER.cx + 1.6, 2, TOWER_SOUTH_Z + 0.4)).toBe(false);
    // And still solid 40 m up, which is what stops the city seeing through it.
    expect(hits(built.boxes, TOWER.cx, 40, TOWER.cz + TOWER.d / 2 - 0.4)).toBe(true);
  });

  test('the lobby floor is registered as walkable ground', () => {
    const floor = built.slabs.find((s) => Math.abs(s.top - LOBBY.floorY) < 1e-6);
    expect(floor).toBeDefined();
    expect(floor!.x0).toBeLessThan(TOWER.cx);
    expect(floor!.x1).toBeGreaterThan(TOWER.cx);
  });

  test('the entrance landing meets the lobby floor', () => {
    const landing = built.slabs.find(
      (s) => Math.abs(s.top - LOBBY.floorY) < 1e-6 && s.z1 <= TOWER_SOUTH_Z + 0.5 && s.z0 < TOWER_SOUTH_Z,
    );
    expect(landing).toBeDefined();
  });

  test('the forecourt is still there', () => {
    expect(built.slabs.some((s) => Math.abs(s.top - 0.17) < 1e-6)).toBe(true);
  });
});

describe('landmark table', () => {
  test('every enterable interior has a landmark entry', () => {
    for (const spec of INTERIORS) {
      if (spec.id === 'buildersLobby' || spec.id === 'broadcastStudio') continue;
      expect(PLAZAS.some((p) => p.id === spec.id)).toBe(true);
    }
    expect(PLAZAS.some((p) => p.kind === 'broadcast')).toBe(true);
  });

  test('every landmark builds and returns colliders and a floor', () => {
    for (const p of PLAZAS) {
      const r = buildPlaza(sink(), p, new Rng(`t:${p.id}`));
      expect(r.id).toBe(p.id);
      expect(r.slabs.length).toBeGreaterThan(0);
      if (p.kind && p.kind !== 'plaza') expect(r.boxes.length).toBeGreaterThan(3);
    }
  });
});

describe('fitouts', () => {
  const cases: Array<[string, (b: DetailBuilder, s: ShellSpec, r: Rng) => unknown]> = [
    ['cornerShop', fitShop],
    ['buildersBar', fitBar],
    ['blockHall', fitBlockHall],
    ['recorderNewsroom', fitRecorder],
  ];
  for (const [id, fit] of cases) {
    test(`${id} builds geometry and light anchors`, () => {
      const spec = INTERIORS.find((s) => s.id === id)!;
      const b = new DetailBuilder();
      const anchors = fit(b, spec, new Rng(id)) as unknown[];
      expect(b.triangles).toBeGreaterThan(300);
      expect(anchors.length).toBeGreaterThan(0);
    });
  }

  test('the lobby builds in both states and the party is brighter', () => {
    const spec = INTERIORS.find((s) => s.id === 'buildersLobby')!;
    const sealedB = new DetailBuilder();
    const sealed = fitLobby(sealedB, spec, new Rng('a'), 'sealed');
    const freeB = new DetailBuilder();
    const free = fitLobby(freeB, spec, new Rng('a'), 'liberated');
    expect(sealedB.triangles).toBeGreaterThan(500);
    expect(freeB.triangles).toBeGreaterThan(500);
    const sum = (l: Array<{ intensity: number }>): number =>
      l.reduce((a, x) => a + x.intensity, 0);
    expect(sum(free)).toBeGreaterThan(sum(sealed));
  });

  test('the studio builds in both states', () => {
    const spec = INTERIORS.find((s) => s.id === 'broadcastStudio')!;
    for (const state of ['regime', 'hijacked'] as const) {
      const b = new DetailBuilder();
      const anchors = fitStudio(b, spec, new Rng('s'), state);
      expect(b.triangles).toBeGreaterThan(1000);
      expect(anchors.length).toBeGreaterThan(4);
    }
  });

  test('nothing is built outside its own room', () => {
    for (const spec of INTERIORS) {
      const b = new DetailBuilder();
      const fit = {
        buildersLobby: (bb: DetailBuilder) => fitLobby(bb, spec, new Rng('x'), 'sealed'),
        recorderNewsroom: (bb: DetailBuilder) => fitRecorder(bb, spec, new Rng('x')),
        broadcastStudio: (bb: DetailBuilder) => fitStudio(bb, spec, new Rng('x'), 'regime'),
        cornerShop: (bb: DetailBuilder) => fitShop(bb, spec, new Rng('x')),
        buildersBar: (bb: DetailBuilder) => fitBar(bb, spec, new Rng('x')),
        blockHall: (bb: DetailBuilder) => fitBlockHall(bb, spec, new Rng('x')),
      }[spec.id]!;
      fit(b);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < b.pos.length; i += 3) {
        minX = Math.min(minX, b.pos[i]);
        maxX = Math.max(maxX, b.pos[i]);
        maxY = Math.max(maxY, b.pos[i + 1]);
        minZ = Math.min(minZ, b.pos[i + 2]);
        maxZ = Math.max(maxZ, b.pos[i + 2]);
      }
      // A metre of slop for door leaves standing in the reveal.
      expect(minX).toBeGreaterThan(spec.cx - spec.w / 2 - 1.2);
      expect(maxX).toBeLessThan(spec.cx + spec.w / 2 + 1.2);
      expect(minZ).toBeGreaterThan(spec.cz - spec.d / 2 - 1.2);
      expect(maxZ).toBeLessThan(spec.cz + spec.d / 2 + 1.2);
      expect(maxY).toBeLessThan(spec.ceilingY + 1.0);
    }
  });
});
