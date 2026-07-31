/**
 * THE PROBE-GROUP REGRESSION BAN.
 *
 * `physics.ts` carries a long comment about the worst silent bug this project
 * has had: every ray and shape cast in the game was built with
 * `groups(CG.SENSOR, ...)`, no solid collider lists SENSOR in its filter, and
 * so EVERY PROBE MATCHED NOTHING. For weeks. A ray that hits nothing looks
 * exactly like a ray over a hole, so the footing code, the foot IK and the
 * camera clearance all behaved like a world made of air and nobody could see
 * why. The comment explains it beautifully and stops nothing.
 *
 * This does. Two layers:
 *
 *   SOURCE BAN   nothing outside physics.ts may build a query filter with
 *                SENSOR membership. The compiler cannot catch it — both
 *                helpers return a plain `number` — so the source is scanned.
 *   ARITHMETIC   `probeGroups` and `groups` are pinned to the exact bit layout
 *                Rapier tests, with the failing case spelled out, so the
 *                reason for the ban survives even if the comment is deleted.
 *
 * The live counterpart — a real probe fired into a real world at a real road
 * point — is in `src/world/worldTruth.test.ts`, because it needs a city.
 *
 * OWNER: truth-assertion agent.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CG, GROUP, capsuleRestHeight, groups, probeGroups, CHARACTER_SKIN } from './physics';

/* ------------------------------------------------------------------ */
/* Bit layout                                                          */
/* ------------------------------------------------------------------ */

/** Rapier's own test, both directions. This is the rule the bug broke. */
function interacts(a: number, b: number): boolean {
  const aMembership = a >>> 16, aFilter = a & 0xffff;
  const bMembership = b >>> 16, bFilter = b & 0xffff;
  return (aMembership & bFilter) !== 0 && (bMembership & aFilter) !== 0;
}

describe('collision group arithmetic', () => {
  test('groups() packs (membership << 16) | filter', () => {
    expect(groups(0xabcd, 0x1234)).toBe(0xabcd1234 | 0);
    expect(groups(CG.STATIC, CG.VEHICLE)).toBe(((CG.STATIC << 16) | CG.VEHICLE) | 0);
  });

  test('probeGroups() belongs to every group and filters to what it wants', () => {
    const g = probeGroups(CG.STATIC | CG.TERRAIN);
    expect(g >>> 16).toBe(0xffff);
    expect(g & 0xffff).toBe(CG.STATIC | CG.TERRAIN);
  });

  test('a probe built with probeGroups() interacts with every solid collider', () => {
    const probe = probeGroups(
      CG.STATIC | CG.TERRAIN | CG.PROP | CG.VEHICLE | CG.CHARACTER | CG.PLAYER | CG.DEBRIS,
    );
    for (const [name, g] of Object.entries(GROUP)) {
      if (name === 'sensor') continue;
      expect(`${name}: ${interacts(probe, g) ? 'visible' : 'INVISIBLE to the probe'}`)
        .toBe(`${name}: visible`);
    }
  });

  /**
   * THE ORIGINAL BUG, as arithmetic — and why it was so hard to see.
   *
   * A probe whose MEMBERSHIP is CG.SENSOR is tested against each collider's own
   * filter. `ALL_SOLID` does not include SENSOR, so the first half of Rapier's
   * two-way test fails against THE WORLD — every building, kerb, plaza slab,
   * prop and piece of terrain. It does NOT fail against vehicles, characters
   * and the player, whose filters are `ALL_SOLID | CG.SENSOR` so that trigger
   * volumes can see them.
   *
   * So the broken probe was not dead. It could see moving actors and could
   * never see the ground. Every footing query came back empty while the
   * occasional query that mattered less came back fine, which reads as "the
   * world has no floor", not as "the query is misconfigured".
   */
  test('a SENSOR-membership probe cannot see the world, only the actors in it', () => {
    const broken = groups(CG.SENSOR, 0xffff);
    // The world: invisible. This is the ground the footing probes needed.
    for (const name of ['staticWorld', 'terrain', 'prop', 'debris'] as const) {
      expect(`${name}: ${interacts(broken, GROUP[name])}`).toBe(`${name}: false`);
    }
    // The actors: visible, because their filters admit sensors on purpose.
    for (const name of ['vehicle', 'character', 'player'] as const) {
      expect(`${name}: ${interacts(broken, GROUP[name])}`).toBe(`${name}: true`);
    }
    // And a real sensor volume still works, which is why the helper is not
    // simply "never mention SENSOR".
    expect(interacts(GROUP.sensor, GROUP.player)).toBe(true);
    expect(interacts(GROUP.sensor, GROUP.vehicle)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Source ban                                                          */
/* ------------------------------------------------------------------ */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const SRC = join(import.meta.dir, '..');
/** The one file allowed to name SENSOR in a group expression. */
const OWNER = join(SRC, 'physics', 'physics.ts');

describe('probe-group regression ban', () => {
  test('nothing outside physics.ts builds a query filter with SENSOR membership', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === OWNER || file.endsWith('.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        // `groups(CG.SENSOR, ...)` as the FIRST argument is the defect. A
        // collider that legitimately belongs to the sensor group builds itself
        // from `GROUP.sensor`, which is defined in physics.ts and exempt.
        if (/\bgroups\s*\(\s*CG\.SENSOR\b/.test(line)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * QUARANTINE — one raw `groups(...)` query filter is still in the tree.
   *
   * `src/ai/police.ts:343` builds its line-of-sight ray as
   * `groups(CG.VEHICLE, CG.STATIC)`. It happens to work, and only by accident:
   * it needs every static collider's filter (`ALL_SOLID`) to keep listing
   * CG.VEHICLE. Tighten `ALL_SOLID` for any reason and that ray silently starts
   * matching nothing, every sight line becomes clear, and the police can see
   * you through buildings — the same class of failure, with a different bit.
   *
   * The correct form is `probeGroups(CG.STATIC)`; `src/ai/traffic.ts` has been
   * converted. police.ts belongs to the police agent, so it is listed rather
   * than changed. SHRINK THIS LIST, NEVER GROW IT.
   */
  const RAW_QUERY_FILTER_ALLOWLIST = ['ai/police.ts'];

  test('every raycast filter in the codebase comes from probeGroups or GROUP', () => {
    // A raw `groups(...)` handed to a QUERY is the shape of the original bug,
    // whatever membership it names: a query filter must be promiscuous in
    // membership, and only `probeGroups` guarantees that.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === OWNER || file.endsWith('.test.ts')) continue;
      const rel = file.slice(SRC.length + 1);
      if (RAW_QUERY_FILTER_ALLOWLIST.includes(rel)) continue;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\b(raycast|castShape|intersectionWith|castRay)\s*\([^)]*[^e]\bgroups\s*\(/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the allowlist is not stale — every entry still contains the thing it excuses', () => {
    // An allowlist entry that no longer matches anything is a lie about the
    // state of the codebase, so it has to expire on its own.
    for (const rel of RAW_QUERY_FILTER_ALLOWLIST) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      const hits = text.split('\n').filter(
        (l) => /\b(raycast|castShape|intersectionWith|castRay)\s*\([^)]*[^e]\bgroups\s*\(/.test(l),
      );
      expect(`${rel}: ${hits.length} raw query filters`).not.toBe(`${rel}: 0 raw query filters`);
    }
  });

  test('the scanner can actually see the thing it bans', () => {
    // A source scan that matches nothing because its regex is wrong is exactly
    // the kind of lie this file exists to prevent, so it is tested too.
    const bad = '  const hit = phys.raycast(o, d, 5, groups(CG.SENSOR, CG.STATIC));';
    expect(/\bgroups\s*\(\s*CG\.SENSOR\b/.test(bad)).toBe(true);
    expect(/\b(raycast|castShape|intersectionWith|castRay)\s*\([^)]*\bgroups\s*\(/.test(bad)).toBe(true);
    const good = '  const hit = phys.raycast(o, d, 5, probeGroups(CG.STATIC | CG.TERRAIN));';
    expect(/\bgroups\s*\(\s*CG\.SENSOR\b/.test(good)).toBe(false);
    expect(/\b(raycast|castShape|intersectionWith|castRay)\s*\([^)]*[^e]\bgroups\s*\(/.test(good)).toBe(false);
  });

  test('physics.ts still documents why, because the ban is meaningless without it', () => {
    const text = readFileSync(OWNER, 'utf8');
    expect(text).toContain('probeGroups');
    expect(text).toContain('CG.SENSOR');
    expect(text.toLowerCase()).toContain('matched nothing');
  });
});

/* ------------------------------------------------------------------ */
/* The other half of the same disaster: capsule footing                */
/* ------------------------------------------------------------------ */

describe('capsule rest height', () => {
  test('the soles sit one skin above the surface, never in it', () => {
    const half = 0.62, radius = 0.32;
    const y = capsuleRestHeight(3.5, half, radius);
    const soles = y - half - radius;
    expect(soles).toBeCloseTo(3.5 + CHARACTER_SKIN, 12);
    expect(soles).toBeGreaterThan(3.5);
    // 2 cm at a 1.8 m stature is a shoe sole, not a levitation.
    expect(soles - 3.5).toBeLessThanOrEqual(0.03);
  });

  test('it is exactly linear in the surface it is given', () => {
    const a = capsuleRestHeight(0, 0.62, 0.32);
    const b = capsuleRestHeight(10, 0.62, 0.32);
    expect(b - a).toBeCloseTo(10, 12);
  });
});
