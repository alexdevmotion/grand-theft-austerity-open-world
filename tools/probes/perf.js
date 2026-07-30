// FPS and audio CPU cost, with everything running.
const fpsRun = async (label, n) => {
  const s = [];
  for (let i = 0; i < n; i++) { await w(400); s.push(D.fps()); }
  s.sort((a, b) => a - b);
  return { label, median: +s[Math.floor(n / 2)].toFixed(2), min: +s[0].toFixed(2), max: +s[n - 1].toFixed(2) };
};
await w(3000);
o.idle_onFoot = await fpsRun('onFoot', 15);
o.idle_audioMs = { avg: A.state().updateMs, peak: A.state().updateMsPeak };
o.idle_stats = D.stats();

D.giveVehicle('dacia');
await w(3500);
D.setInput({ throttle: 1, steer: 0.1 });
await w(4000);
o.driving = await fpsRun('driving', 15);
o.driving_audioMs = { avg: A.state().updateMs, peak: A.state().updateMsPeak };

// worst case again, now with the trimmed bus headroom
D.setWeather('stormRain');
A.setAmbience('bulevard', 21, 1);
A.forceSiren(3, 5, 26);
A.emit('instability:changed', { stars: 5, previous: 4 });
await w(3000);
A.resetPeaks();
const P = () => { const p = D.stats().playerPos; return [p[0], p[1] + 1, p[2]]; };
const trace = [];
for (let i = 0; i < 20; i++) {
  if (i % 3 === 0) {
    A.emit('vehicle:collision', { vehicleId: 'x', impulse: 500000, position: P() });
    A.emit('prop:broken', { kind: 'glass-window', position: P() });
  }
  if (i === 9) A.emit('vehicle:destroyed', { vehicleId: 'x' });
  await w(320);
  const l = L();
  trace.push({ t: +(i * 0.32).toFixed(2), masterHold: +l.master.holdPeakDb.toFixed(2),
               masterRms: +l.master.rmsDb.toFixed(2), red: +A.state().limiterReductionDb.toFixed(2), fps: +D.fps().toFixed(1) });
}
const l = L();
o.worst = {
  peaks: Object.fromEntries(Object.keys(l).map((k) => [k, +l[k].holdPeakDb.toFixed(2)])),
  rms: Object.fromEntries(Object.keys(l).map((k) => [k, +l[k].rmsDb.toFixed(2)])),
  audioMs: { avg: A.state().updateMs, peak: A.state().updateMsPeak },
  fpsMedian: +trace.map((r) => r.fps).sort((a, b) => a - b)[10].toFixed(2),
  maxHold: Math.max(...trace.map((r) => r.masterHold)),
  maxReduction: Math.min(...trace.map((r) => r.red)),
  sirens: A.state().sirens.length, voices: A.state().engineVoices.length, slots: A.state().oneShotSlots,
};
D.clearInput(); D.setWeather('clearSunset'); A.clearAmbienceOverride();
