#!/usr/bin/env node
/**
 * Audio verification harness.
 *
 * Drives the running game through `agent-browser` and reads the measurement
 * hooks on `window.__GTA_AUDIO__`. Nothing here plays audio to a human — the
 * browser is always launched with `--mute-audio`; Chrome still renders the
 * whole WebAudio graph, so the AnalyserNode taps behind `levels()`,
 * `centroid()` and `spectrum()` read exactly what the mix would have sent to
 * the speakers.
 *
 *   node tools/audio-probe.mjs <script.js>   # run a probe script, print JSON
 *   node tools/audio-probe.mjs --unlock      # (re)unlock the AudioContext
 *
 * The probe script body is evaluated in the page with `A` (the audio debug
 * API), `D` (`__GTA_DEBUG__`), `w(ms)` and `L()` (levels) in scope, and must
 * assign its result object to `o`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SESSION = 'gta';
const URL_ = 'http://127.0.0.1:5273/?q=high';

function ab(...args) {
  return execFileSync('agent-browser', ['--session', SESSION, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Evaluate in the page. Anything that throws — a page mid-reload, a hook that
 * does not exist yet — comes back as null rather than killing the harness;
 * every caller already has to cope with "not ready yet".
 */
function evalJs(js) {
  let out;
  try {
    out = ab('eval', js);
  } catch {
    return null;
  }
  const line = out.trim().split('\n').pop();
  try {
    return JSON.parse(JSON.parse(line));
  } catch {
    try {
      return JSON.parse(line);
    } catch {
      return line;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureReady() {
  for (let attempt = 0; attempt < 4; attempt++) {
    let st = evalJs("JSON.stringify({d: typeof window.__GTA_DEBUG__, a: typeof window.__GTA_AUDIO__, ready: !!(window.__GTA_AUDIO__&&window.__GTA_AUDIO__.ready())})");
    if (!st || typeof st !== 'object' || st.d !== 'object') {
      ab('--args', '--mute-audio', 'open', URL_);
      await sleep(14000);
      continue;
    }
    if (!st.ready) {
      // The boot overlay covers the canvas until every system has initialised,
      // and a synthetic KeyboardEvent does not count as a user gesture, so we
      // have to wait for a real click target before unlocking.
      for (let i = 0; i < 40; i++) {
        const boot = evalJs("JSON.stringify({ready: !!(window.__GTA_DEBUG__ && window.__GTA_DEBUG__.ready()), boot: !!document.querySelector('#boot')})");
        if (boot && boot.ready && !boot.boot) break;
        await sleep(700);
      }
      try {
        ab('click', 'canvas#viewport');
      } catch {
        ab('click', 'body');
      }
      await sleep(6000);
      st = evalJs("JSON.stringify({ready: !!(window.__GTA_AUDIO__ && window.__GTA_AUDIO__.ready())})");
    }
    if (st.ready) {
      // Let the bank + folk track finish landing.
      evalJs("window.__GTA_AUDIO__.waitReady(15000); 'ok'");
      await sleep(1500);
      return true;
    }
  }
  return false;
}

async function runProbe(body, budgetMs) {
  const wrapped = `
window.__P__ = { __running: true };
(async () => {
  const A = window.__GTA_AUDIO__, D = window.__GTA_DEBUG__;
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const L = () => A.levels();
  const o = window.__P__;
  try { ${body} } catch (e) { o.__error = String(e && e.stack || e); }
  o.__running = false;
})(); 'started'`;
  evalJs(wrapped);
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const r = evalJs('JSON.stringify(window.__P__ || null)');
    if (r && typeof r === 'object' && r.__running === false) return r;
    if (r === null) {
      // Page reloaded under us (HMR). Re-unlock and retry once.
      if (!(await ensureReady())) return { __error: 'page lost' };
      evalJs(wrapped);
    }
  }
  return { __error: 'timeout' };
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node tools/audio-probe.mjs <script.js|--unlock>');
  process.exit(1);
}

const ok = await ensureReady();
if (!ok) {
  console.error('could not unlock the audio context');
  process.exit(1);
}
if (arg === '--unlock') {
  console.log(JSON.stringify(evalJs('JSON.stringify(window.__GTA_AUDIO__.state())'), null, 1));
  process.exit(0);
}

const body = readFileSync(arg, 'utf8');
const budget = Number(process.argv[3] ?? 90000);
const result = await runProbe(body, budget);
console.log(JSON.stringify(result, null, 1));
