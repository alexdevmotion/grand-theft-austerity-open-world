const avg = async (n, ms) => {
  let a = 0; let c = 0;
  for (let i = 0; i < n; i++) { await w(ms); a += Math.pow(10, L().ambience.rmsDb / 20); c += A.centroid('ambience'); }
  return { rmsDb: +(20 * Math.log10(a / n)).toFixed(2), centroid: Math.round(c / n) };
};
A.setStation('off');
A.setBusVolume('music', 0); A.setBusVolume('vehicles', 0); A.setBusVolume('sfx', 0);
o.districts = {};
for (const d of ['bulevard', 'centruVechi', 'glassCorporate', 'guvern', 'cartier', 'industrial', 'parc']) {
  A.setAmbience(d, 13, 0);
  await w(4500);
  o.districts[d] = { ...(await avg(8, 200)), mix: JSON.parse(JSON.stringify(A.state().ambienceMix)) };
}
// time of day + rain on the same district
A.setAmbience('bulevard', 13, 0); await w(4500);
o.bulevard_noon_dry = await avg(8, 200);
A.setAmbience('bulevard', 3, 0); await w(4500);
o.bulevard_3am_dry = await avg(8, 200);
A.setAmbience('bulevard', 13, 1); await w(4500);
o.bulevard_noon_rain = await avg(8, 200);
A.clearAmbienceOverride();
A.setBusVolume('music', 0.72); A.setBusVolume('vehicles', 0.9); A.setBusVolume('sfx', 0.95);
A.setStation('enerveaza');
