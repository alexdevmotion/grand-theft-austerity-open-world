/**
 * THE QUALITY MENU MUST NOT BE A PLACEBO.
 *
 * Two independent ways for a graphics setting to do nothing, both of which
 * shipped here:
 *
 *   1. A FIELD WITH NO READER. `QualitySettings` advertised `motionBlur`,
 *      `depthOfField`, `volumetricLight`, `ssaoHalfRes` and `rainParticles`.
 *      Nothing in the codebase ever read any of them. The menu moved, the
 *      table changed, and not one pixel did.
 *   2. A READER THAT ONLY RUNS ONCE. City draw distance, prop cut-offs and the
 *      ped and traffic budgets were each snapshotted at init by six separate
 *      `detectQuality()` calls, while `setQuality` rebuilt only the post chain
 *      and the pixel ratio. Switching ultra -> low left 120 pedestrians, 72
 *      cars, a 1.6 km draw distance and 4096-pixel cascades exactly where they
 *      were, so the tier the player chose bought them nothing but a slightly
 *      cheaper post stack.
 *
 * This file makes both impossible: every field must be read somewhere, and
 * every field that is snapshotted must be re-applied through
 * `onQualityChange`. Both checks are SOURCE SCANS, deliberately — a runtime
 * check would need the whole game booted with a GPU, and the question here is
 * about the code, not about a frame.
 *
 * OWNER: truth-assertion agent.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  QUALITY, applyQuality, onQualityChange, qualityConsumerNames, resetQualityConsumers,
  type Quality, type QualitySettings,
} from './renderer';

const SRC = join(import.meta.dir, '..');
const RENDERER = join(SRC, 'render', 'renderer.ts');
const TIERS: Quality[] = ['low', 'medium', 'high', 'ultra'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip comments before scanning.
 *
 * Without this the scan reads prose. This file's own subject matter is
 * `detectQuality` and `QualitySettings`, so the comments explaining the bug
 * mention every symbol being counted — and a scanner that counts its own
 * documentation is precisely the sort of measurement this agent exists to
 * distrust.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every non-test source file except the one that DEFINES the tiers. */
function consumerFiles(): Array<{ rel: string; text: string }> {
  return sourceFiles(SRC)
    .filter((f) => f !== RENDERER)
    .map((f) => ({ rel: f.slice(SRC.length + 1), text: stripComments(readFileSync(f, 'utf8')) }));
}

const FIELDS = Object.keys(QUALITY.high) as Array<keyof QualitySettings>;

/* ================================================================== */
/* 1. Every field has a reader                                         */
/* ================================================================== */

describe('every QualitySettings field is actually consumed', () => {
  test('the tier table and the interface have not drifted apart', () => {
    // All four tiers must declare exactly the same keys, or a tier silently
    // inherits `undefined` for whatever it forgot.
    for (const t of TIERS) {
      expect(`${t}: ${Object.keys(QUALITY[t]).sort().join(',')}`)
        .toBe(`${t}: ${FIELDS.slice().sort().join(',')}`);
    }
    expect(FIELDS.length).toBeGreaterThan(8);
  });

  test('no field is a placebo', () => {
    const files = consumerFiles();
    const orphans: string[] = [];
    const readers = new Map<keyof QualitySettings, string[]>();
    for (const field of FIELDS) {
      // A consumer reads it as `.field` off a settings object.
      const re = new RegExp(`\\.\\s*${field}\\b`);
      const found = files.filter((f) => re.test(f.text)).map((f) => f.rel);
      readers.set(field, found);
      if (found.length === 0) orphans.push(field);
    }
    for (const [field, who] of readers) {
      console.log(`[quality] ${String(field).padEnd(24)} read by ${who.length ? who.join(', ') : 'NOBODY'}`);
    }
    expect(orphans).toEqual([]);
  });

  test('the fields that were removed have not crept back without a reader', () => {
    // Named explicitly so that re-adding one is a conscious act with a consumer
    // attached. See the comment above `QualitySettings` for where each of these
    // effects actually lives.
    const removed = ['motionBlur', 'depthOfField', 'ssaoHalfRes', 'volumetricLight', 'rainParticles'];
    for (const name of removed) expect(FIELDS).not.toContain(name as keyof QualitySettings);
  });
});

/* ================================================================== */
/* 2. Every snapshotted field is re-applied on a tier change           */
/* ================================================================== */

describe('setQuality re-applies what init snapshotted', () => {
  /**
   * Fields consumed by a system that keeps its own derived copy. These are the
   * ones that used to be frozen at init; each must be named in an
   * `onQualityChange(...)` field list somewhere.
   *
   * The post chain's own fields (pixelRatioCap, ssao, bloom, msaa,
   * screenSpaceReflections) are not here: `PostFXSystem.setQuality` rebuilds
   * the whole chain from `QUALITY[q]` on every change, so they are re-read by
   * construction.
   */
  const MUST_RE_APPLY: Array<keyof QualitySettings> = [
    'cityDrawDistance', 'entityDrawDistance', 'maxPeds', 'maxTraffic',
    'shadowDistance', 'shadowCascades', 'shadowMapSize',
  ];

  /** Field names appearing inside an `onQualityChange(name, [...])` call. */
  function declaredReApplied(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const { rel, text } of consumerFiles()) {
      const re = /onQualityChange\(\s*'([^']+)'\s*,\s*\[([^\]]*)\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const fields = m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
        for (const f of fields) {
          const list = out.get(f) ?? [];
          list.push(`${rel} (${m[1]})`);
          out.set(f, list);
        }
      }
    }
    return out;
  }

  test('every snapshotted field is registered with onQualityChange', () => {
    const declared = declaredReApplied();
    for (const [f, who] of declared) console.log(`[quality] ${f.padEnd(24)} re-applied by ${who.join(', ')}`);
    const frozen = MUST_RE_APPLY.filter((f) => !declared.has(f));
    expect(frozen).toEqual([]);
  });

  test('nothing declares a field that does not exist', () => {
    for (const f of declaredReApplied().keys()) {
      expect(`declared: ${f}`).toBe(`declared: ${FIELDS.includes(f as keyof QualitySettings) ? f : 'NO SUCH FIELD'}`);
    }
  });

  test('PostFXSystem.setQuality calls applyQuality — the other half of the fix', () => {
    const postfx = readFileSync(join(SRC, 'render', 'postfx.ts'), 'utf8');
    const body = postfx.slice(postfx.indexOf('setQuality(q: Quality)'));
    expect(body.slice(0, 600)).toContain('applyQuality(q)');
  });

  test('the six independent detectQuality() snapshots are still bounded', () => {
    // detectQuality() is a hardware guess and belongs at STARTUP only. Every
    // extra call site is another place a tier can be frozen; they are counted
    // so a seventh cannot appear unnoticed.
    const callers = consumerFiles()
      .filter((f) => /\bdetectQuality\s*\(/.test(f.text))
      .map((f) => f.rel)
      .sort();
    console.log(`[quality] detectQuality() called in: ${callers.join(', ')}`);
    expect(callers.length).toBeLessThanOrEqual(6);
    // ...and every one of them must also register for changes, or it is a
    // snapshot again.
    const declaredIn = new Set<string>();
    for (const { rel, text } of consumerFiles()) {
      if (/onQualityChange\(/.test(text)) declaredIn.add(rel);
    }
    const snapshotOnly = callers.filter((c) => c !== 'game.ts' && !declaredIn.has(c));
    expect(snapshotOnly).toEqual([]);
  });
});

/* ================================================================== */
/* 3. The registry itself                                              */
/* ================================================================== */

describe('the quality consumer registry', () => {
  afterEach(() => resetQualityConsumers());

  test('applyQuality calls every consumer with the right settings', () => {
    resetQualityConsumers();
    const seen: Array<[string, Quality, number]> = [];
    onQualityChange('a', ['maxPeds'], (q, s) => seen.push(['a', q, s.maxPeds]));
    onQualityChange('b', ['maxTraffic'], (q, s) => seen.push(['b', q, s.maxTraffic]));
    expect(applyQuality('low')).toBe(2);
    expect(seen).toEqual([
      ['a', 'low', QUALITY.low.maxPeds],
      ['b', 'low', QUALITY.low.maxTraffic],
    ]);
  });

  test('re-registering the same name replaces it instead of stacking', () => {
    // A system that re-inits must not leave a closure over its dead self
    // behind, still writing to a disposed object every time the menu moves.
    resetQualityConsumers();
    let calls = 0;
    onQualityChange('city', ['cityDrawDistance'], () => { calls++; });
    onQualityChange('city', ['cityDrawDistance'], () => { calls++; });
    expect(applyQuality('high')).toBe(1);
    expect(calls).toBe(1);
  });

  test('one consumer throwing does not stop the rest', () => {
    resetQualityConsumers();
    let reached = false;
    let logged = '';
    const realError = console.error;
    console.error = (...a: unknown[]) => { logged = String(a[0]); };
    try {
      onQualityChange('bad', ['maxPeds'], () => { throw new Error('boom'); });
      onQualityChange('good', ['maxTraffic'], () => { reached = true; });
      expect(applyQuality('medium')).toBe(1);
    } finally {
      console.error = realError;
    }
    expect(reached).toBe(true);
    // ...and it says WHICH one, or a menu that half-works is a mystery.
    expect(logged).toContain('bad');
  });

  test('unsubscribing removes the consumer', () => {
    resetQualityConsumers();
    const off = onQualityChange('x', ['maxPeds'], () => {});
    expect(applyQuality('low')).toBe(1);
    off();
    expect(applyQuality('low')).toBe(0);
  });

  test('the registry reports who reads what', () => {
    resetQualityConsumers();
    onQualityChange('peds', ['maxPeds', 'entityDrawDistance'], () => {});
    const by = qualityConsumerNames();
    expect(by.get('maxPeds')).toEqual(['peds']);
    expect(by.get('entityDrawDistance')).toEqual(['peds']);
    expect(by.get('maxTraffic')).toBeUndefined();
  });
});

/* ================================================================== */
/* 4. The tiers mean something                                         */
/* ================================================================== */

describe('the tiers are ordered', () => {
  const ASCENDING: Array<keyof QualitySettings> = [
    'pixelRatioCap', 'shadowMapSize', 'shadowCascades', 'shadowDistance',
    'entityDrawDistance', 'cityDrawDistance', 'maxPeds', 'maxTraffic',
  ];

  test('every numeric field is monotonically non-decreasing low -> ultra', () => {
    for (const f of ASCENDING) {
      const seq = TIERS.map((t) => QUALITY[t][f] as number);
      for (let i = 1; i < seq.length; i++) {
        expect(`${String(f)} ${TIERS[i - 1]}->${TIERS[i]}: ${seq[i - 1]} -> ${seq[i]}`)
          .toBe(`${String(f)} ${TIERS[i - 1]}->${TIERS[i]}: ${seq[i - 1]} -> ${Math.max(seq[i - 1], seq[i])}`);
      }
    }
  });

  test('every boolean field is monotonically non-weakening low -> ultra', () => {
    const flags: Array<keyof QualitySettings> = ['ssao', 'bloom', 'screenSpaceReflections'];
    for (const f of flags) {
      let on = false;
      for (const t of TIERS) {
        const v = QUALITY[t][f] as boolean;
        if (on && !v) throw new Error(`${String(f)} switches back off at ${t}`);
        on = on || v;
      }
      // A flag that is never on anywhere is another kind of placebo.
      expect(`${String(f)} enabled somewhere: ${on}`).toBe(`${String(f)} enabled somewhere: true`);
    }
  });

  test('low is materially cheaper than ultra, not cosmetically', () => {
    expect(QUALITY.low.maxPeds * 3).toBeLessThanOrEqual(QUALITY.ultra.maxPeds);
    expect(QUALITY.low.maxTraffic * 3).toBeLessThanOrEqual(QUALITY.ultra.maxTraffic);
    expect(QUALITY.low.cityDrawDistance * 3).toBeLessThanOrEqual(QUALITY.ultra.cityDrawDistance);
  });
});
