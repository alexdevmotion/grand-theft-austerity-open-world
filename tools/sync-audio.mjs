#!/usr/bin/env node
/**
 * Copy the voice and music assets from the concept repo into public/audio/.
 *
 * These are third-party recordings (a Romanian satirical show, and a folk
 * recording) held as prototype reference only. They are deliberately NOT in
 * git — see docs/reference/ATTRIBUTION.md — so this script restores them on a
 * fresh clone. Everything else in the game is procedural.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SRC = process.env.GTA_ASSET_SRC
  ?? join(homedir(), 'pers/pax-ai-game-jam-boilerplate/output/reference-assets/audio');
const DST = 'public/audio';

const VOICE_SETS = [
  'ce-ne-enerveaza-55-intro-clips',
  'ce-ne-enerveaza-55-matze-clips',
  'ce-ne-enerveaza-61-matze-clips',
  'ce-ne-enerveaza-intro-clips',
];

/**
 * The second batch, which ships with a manifest and real Romanian transcripts
 * per clip — far more useful than the slug-only sets above, because a line can
 * be matched to a game context by what it actually says.
 * Source: <concept repo>/output/reference-assets/audio/ce-ne-enerveaza-new/
 * Extraction script: <concept repo>/scripts/audio/extract-ce-ne-enerveaza-library.ts
 */
const NEW_SET = {
  dir: 'ce-ne-enerveaza-new',
  from: 'ce-ne-enerveaza-new/clips',
  episodes: ['episode-50', 'episode-52', 'episode-54', 'episode-57'],
  manifest: 'manifest.json',
};
const MUSIC = ['fecioreasca-de-pe-mures-dumitru-farcas.mp3'];

if (!existsSync(SRC)) {
  console.error(`✗ source not found: ${SRC}\n  set GTA_ASSET_SRC to the concept repo's audio directory.`);
  process.exit(1);
}

let n = 0;
for (const set of VOICE_SETS) {
  const from = join(SRC, set);
  if (!existsSync(from)) { console.warn(`· skipped missing set ${set}`); continue; }
  await mkdir(join(DST, 'vo', set), { recursive: true });
  for (const f of (await readdir(from)).filter((f) => f.endsWith('.mp3'))) {
    await cp(join(from, f), join(DST, 'vo', set, f));
    n++;
  }
}
// Second batch: episode subdirectories plus the source manifest.
const newFrom = join(SRC, NEW_SET.from);
if (existsSync(newFrom)) {
  for (const ep of NEW_SET.episodes) {
    const from = join(newFrom, ep);
    if (!existsSync(from)) { console.warn(`· skipped missing ${ep}`); continue; }
    await mkdir(join(DST, 'vo', NEW_SET.dir, ep), { recursive: true });
    for (const f of (await readdir(from)).filter((f) => f.endsWith('.mp3'))) {
      await cp(join(from, f), join(DST, 'vo', NEW_SET.dir, ep, f));
      n++;
    }
  }
  const man = join(newFrom, NEW_SET.manifest);
  if (existsSync(man)) await cp(man, join(DST, 'vo', NEW_SET.dir, 'source-manifest.json'));
} else {
  console.warn(`· skipped missing set ${NEW_SET.dir}`);
}

await mkdir(join(DST, 'music'), { recursive: true });
for (const f of MUSIC) {
  if (!existsSync(join(SRC, f))) { console.warn(`· skipped missing ${f}`); continue; }
  await cp(join(SRC, f), join(DST, 'music', f));
  n++;
}
console.log(`✓ ${n} audio files synced into ${DST}`);
