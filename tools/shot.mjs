#!/usr/bin/env node
/**
 * Screenshot / playtest harness.
 *
 * Drives the running game through `window.__GTA_DEBUG__` and captures framed
 * stills that visual critics compare against docs/reference/*.png, plus
 * behavioural traces that gameplay critics judge.
 *
 * Usage:
 *   node tools/shot.mjs                       # capture the standard shot list
 *   node tools/shot.mjs --shots hero,street   # only these shots
 *   node tools/shot.mjs --drive               # 20s automated driving trace
 *   node tools/shot.mjs --out tools/out/round3 --session gta
 *
 * Requires the dev server on http://127.0.0.1:5273 and `agent-browser`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const SESSION = arg('session', 'gta');
const OUT = resolve(arg('out', 'tools/out'));
const URL_ = arg('url', 'http://127.0.0.1:5273/?q=ultra');
const ONLY = arg('shots', '').split(',').filter(Boolean);

mkdirSync(OUT, { recursive: true });

const ab = (...args) => {
  try {
    return execFileSync('agent-browser', ['--session', SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    }).trim();
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(`agent-browser ${args.join(' ')} failed: ${out || err.message}`);
  }
};

/** Run JS in the page and JSON-parse the result. */
const evalJson = (expr) => {
  const raw = ab('eval', `JSON.stringify(${expr})`);
  // agent-browser echoes the JSON string, sometimes quoted.
  const cleaned = raw.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return { __raw: raw };
    }
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The standard shot list.
 *
 * `hero` deliberately reproduces the reference frame's composition: a low
 * three-quarter view of the glass tower at Builders House with the wet street
 * running to the horizon and the sun behind the building.
 */
const SHOTS = [
  {
    name: 'hero',
    note: 'Reference-matched: glass tower, wet street, sunset behind, Dacia in frame.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.goTo('buildersHouse');
      D.giveVehicle('dacia');
      D.setCamera(-166, 2.4, 176, -184, 12, 150, 42);
    })()`,
  },
  {
    name: 'street',
    note: 'Eye-level street view down a boulevard — traffic, peds, wet reflections.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.goTo('buildersHouse');
      D.setCamera(-160, 1.7, 150, -60, 6, 150, 58);
    })()`,
  },
  {
    name: 'skyline',
    note: 'Elevated wide — city density, silhouette variety, sky and cloud deck.',
    setup: `(() => { window.__GTA_DEBUG__.setCamera(-420, 145, 420, 0, 20, 0, 48); })()`,
  },
  {
    name: 'plaza',
    note: 'Government broadcast plaza — political screens, crowd, architecture.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.goTo('broadcastPlaza');
      D.setCamera(440, 4.0, 210, 460, 22, 184, 50);
    })()`,
  },
  {
    name: 'parliament',
    note: 'Palace of Parliament axis — the landmark that says Bucharest.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.setCamera(-560, 26, -320, -860, 40, -740, 44);
    })()`,
  },
  {
    name: 'chase',
    note: 'Third-person driving at speed with police response at 3 stars.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.goTo('buildersHouse');
      D.giveVehicle('dacia');
      D.releaseCamera();
      D.setInput({ throttle: 1, steer: 0.12 });
      if (window.__GTA_DEBUG__.stats) {}
    })()`,
    settle: 4200,
    teardown: `window.__GTA_DEBUG__.clearInput()`,
  },
  {
    name: 'onfoot',
    note: 'Third-person on-foot gameplay framing — character, pavement, crowd.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.releaseCamera();
      D.goTo('buildersHouse');
      D.setInput({ moveY: 1 });
    })()`,
    settle: 2600,
    teardown: `window.__GTA_DEBUG__.clearInput()`,
  },
  {
    name: 'night',
    note: 'Night pass — street lighting, headlights, neon, window emissives.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.setTimeOfDay(23.2); D.setWeather('night');
      D.goTo('buildersHouse');
      D.setCamera(-160, 1.9, 152, -60, 7, 150, 55);
    })()`,
  },
  {
    name: 'rain',
    note: 'Storm pass — rain, puddles, reflections, reduced visibility.',
    setup: `(() => {
      const D = window.__GTA_DEBUG__;
      D.setTimeOfDay(19.4); D.setWeather('stormRain');
      D.setCamera(-160, 1.9, 152, -60, 7, 150, 55);
    })()`,
  },
];

async function ensurePage() {
  ab('set', 'viewport', '1920', '1080');
  ab('open', URL_);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const r = evalJson(`(window.__GTA_DEBUG__ ? window.__GTA_DEBUG__.ready() : false)`);
    if (r === true) return;
  }
  const fatal = evalJson(`((document.getElementById('fatal')||{}).textContent||'').slice(0,1500)`);
  throw new Error(`game never became ready. fatal=${JSON.stringify(fatal)}`);
}

async function captureShots() {
  const results = [];
  const list = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.name)) : SHOTS;

  for (const shot of list) {
    ab('eval', shot.setup);
    await sleep(shot.settle ?? 1400);
    const stats = evalJson('window.__GTA_DEBUG__.stats()');
    const file = `${OUT}/${shot.name}.png`;
    ab('screenshot', file);
    if (shot.teardown) ab('eval', shot.teardown);
    // Reset scripted camera + weather between shots.
    ab('eval', `(() => { const D = window.__GTA_DEBUG__; D.releaseCamera(); D.clearInput(); })()`);
    results.push({ shot: shot.name, note: shot.note, file, stats });
    console.log(`✓ ${shot.name.padEnd(11)} ${file}  fps=${(stats.fps ?? 0).toFixed(0)} draws=${stats.drawCalls} tris=${((stats.triangles ?? 0) / 1000).toFixed(0)}k peds=${stats.peds} traffic=${stats.traffic}`);
  }
  return results;
}

/** Automated driving trace: proves the car actually goes where it's pointed. */
async function driveTrace() {
  ab('eval', `(() => {
    const D = window.__GTA_DEBUG__;
    D.releaseCamera(); D.goTo('buildersHouse'); D.giveVehicle('dacia');
    window.__TRACE__ = [];
    window.__TRACE_T__ = setInterval(() => {
      const s = D.stats();
      window.__TRACE__.push({ t: performance.now(), pos: s.playerPos, fps: s.fps, inVehicle: s.inVehicle });
    }, 250);
  })()`);

  const script = [
    { ms: 3000, input: { throttle: 1, steer: 0 }, label: 'straight-line acceleration' },
    { ms: 2500, input: { throttle: 1, steer: -0.8 }, label: 'hard left' },
    { ms: 2500, input: { throttle: 1, steer: 0.8 }, label: 'hard right' },
    { ms: 1500, input: { throttle: -1, steer: 0 }, label: 'braking' },
    { ms: 2000, input: { throttle: 1, steer: 0 }, label: 'recover and go' },
  ];
  const phases = [];
  for (const step of script) {
    ab('eval', `window.__GTA_DEBUG__.setInput(${JSON.stringify(step.input)})`);
    await sleep(step.ms);
    const stats = evalJson('window.__GTA_DEBUG__.stats()');
    phases.push({ label: step.label, input: step.input, stats });
    console.log(`  · ${step.label.padEnd(28)} pos=${stats.playerPos.map((v) => v.toFixed(1)).join(',')} fps=${stats.fps.toFixed(0)}`);
  }
  ab('eval', `window.__GTA_DEBUG__.clearInput(); clearInterval(window.__TRACE_T__);`);
  const trace = evalJson('window.__TRACE__');
  ab('screenshot', `${OUT}/drive-end.png`);
  return { phases, samples: Array.isArray(trace) ? trace.length : 0, trace };
}

(async () => {
  await ensurePage();
  const report = { url: URL_, when: new Date().toISOString(), shots: [], drive: null };
  report.shots = await captureShots();
  if (flag('drive')) {
    console.log('— driving trace —');
    report.drive = await driveTrace();
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\nreport → ${OUT}/report.json`);
})().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
