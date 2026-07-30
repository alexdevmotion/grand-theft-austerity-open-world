// Worst case the brief asks for: five-star chase, in the rain, with a crash.
const P = () => { const p = D.stats().playerPos; return [p[0], p[1] + 1, p[2]]; };
const peaks = () => { const l = L(); const r = {}; for (const k of Object.keys(l)) r[k] = +l[k].holdPeakDb.toFixed(2); return r; };

D.giveVehicle('dacia');
await w(3500);
D.setWeather('stormRain');
A.setAmbience('bulevard', 21, 1);
A.setStation('enerveaza');
await w(5000);

// baseline
A.resetPeaks(); await w(2000);
o.calm = { peaks: peaks(), masterRms: +L().master.rmsDb.toFixed(2), reduction: A.state().limiterReductionDb };

// full chaos
A.forceSiren(3, 5, 20);
A.emit('instability:changed', { stars: 5, previous: 4 });
D.setInput({ throttle: 1, steer: 0.15 });
await w(2500);
A.resetPeaks();
const trace = [];
for (let i = 0; i < 18; i++) {
  // a crash every ~1.2 s, at the worst impulse the vehicle system can produce
  if (i % 4 === 0) {
    A.emit('vehicle:collision', { vehicleId: 'x', impulse: 500000, position: P() });
    A.emit('prop:broken', { kind: 'glass-window', position: P() });
  }
  if (i === 8) A.emit('vehicle:destroyed', { vehicleId: 'x' });
  if (i === 12) A.emit('ped:killed', { position: P() });
  await w(300);
  const l = L();
  trace.push({ t: +(i * 0.3).toFixed(1), master: +l.master.rmsDb.toFixed(2), hold: +l.master.holdPeakDb.toFixed(2),
               red: +A.state().limiterReductionDb.toFixed(2) });
}
o.chaos = { peaks: peaks(), masterRms: +L().master.rmsDb.toFixed(2), reduction: A.state().limiterReductionDb, trace };
o.chaosState = { sirens: A.state().sirens.length, voices: A.state().engineVoices.length, slots: A.state().oneShotSlots, duck: A.state().duck };
D.clearInput();
D.setWeather('clearSunset');
A.clearAmbienceOverride();
await w(1500);
o.fps = Math.round(D.fps());
