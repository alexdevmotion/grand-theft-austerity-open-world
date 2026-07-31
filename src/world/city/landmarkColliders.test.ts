/**
 * The Builders House entrance, as assertions.
 *
 * The doorway has two jobs that pull against each other, and both are silent
 * failures in a screenshot: a person must get through (Act IV ends inside the
 * lobby, so a sealed door makes the campaign unfinishable) and the Dacia must
 * not (the whole point of a shell with one pedestrian opening). The 0.5 m post
 * between the two leaves is what reconciles them — and it used to be extruded
 * from the pavement to the roof, 82 m of collider standing in mid-air above the
 * lintel of an elevation that is one continuous glass wall.
 *
 * `interiors.test.ts` already guards `shellBoxes` itself. This guards what the
 * CITY actually registers, which is `shellBoxes` after `cappedShell` has been
 * over it.
 */

import { describe, expect, test } from 'bun:test';
import { Rng } from '../../core/rng';
import { DetailBuilder, FacadeBuilder, SurfaceBuilder } from './builders';
import { buildBuildersHouse, type LandmarkSink } from './landmarks';
import { BUILDERS_LOBBY } from '../interiors/defs';
import { DOORWAY, TOWER, TOWER_SOUTH_Z } from '../../content/places';

type Box = { x: number; z: number; hx: number; hz: number; h: number };

/** Ground-anchored boxes: y is inside when 0 <= y <= h. */
function hits(boxes: Box[], x: number, y: number, z: number): boolean {
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

describe('Builders House entrance mullion', () => {
  const built = buildBuildersHouse(sink(), new Rng('mullion'));
  // Just inside the south wall's outer face, on the door centreline.
  const doorZ = TOWER_SOUTH_Z + BUILDERS_LOBBY.wallT / 2;

  test('the door post is there at head height — the Dacia still cannot fit', () => {
    expect(hits(built.boxes, DOORWAY.x, 1.6, doorZ)).toBe(true);
  });

  test('the door post stops at the lintel instead of running to the roof', () => {
    expect(hits(built.boxes, DOORWAY.x, DOORWAY.height + 0.5, doorZ)).toBe(false);
    expect(hits(built.boxes, DOORWAY.x, TOWER.h / 2, doorZ)).toBe(false);
    expect(hits(built.boxes, DOORWAY.x, TOWER.h - 1, doorZ)).toBe(false);
  });

  test('both leaves are still open at head height', () => {
    const leafOffset = (DOORWAY.width + BUILDERS_LOBBY.door.mullion) / 4;
    expect(hits(built.boxes, DOORWAY.x - leafOffset, 1.6, doorZ)).toBe(false);
    expect(hits(built.boxes, DOORWAY.x + leafOffset, 1.6, doorZ)).toBe(false);
  });

  test('nothing else about the shell moved: the walls still reach the roof', () => {
    // North elevation, opposite the door.
    const backZ = TOWER.cz + TOWER.d / 2 - BUILDERS_LOBBY.wallT / 2;
    expect(hits(built.boxes, TOWER.cx, TOWER.h - 1, backZ)).toBe(true);
    // The jambs either side of the doorway, in the south elevation.
    const jambX = TOWER.cx + DOORWAY.width / 2 + 2;
    expect(hits(built.boxes, jambX, TOWER.h - 1, doorZ)).toBe(true);
  });

  test('only the mullion was capped — every other box in the wall is full height', () => {
    // The travertine flank is a separate mass at 0.86 of the tower, so scope
    // this to the south elevation the doorway is cut into.
    const wall = built.boxes.filter((b) => Math.abs(b.z - doorZ) < 1e-6);
    expect(wall.length).toBeGreaterThan(2); // two leaves' jambs + the mullion
    const short = wall.filter((b) => b.h < TOWER.h - 1e-6);
    expect(short.length).toBe(1);
    expect(short[0].h).toBeCloseTo(DOORWAY.height, 6);
    expect(short[0].hx * 2).toBeCloseTo(BUILDERS_LOBBY.door.mullion, 6);
    expect(short[0].x).toBeCloseTo(DOORWAY.x, 6);
  });
});
