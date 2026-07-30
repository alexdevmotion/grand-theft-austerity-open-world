D.giveVehicle('dacia');
await w(4500);
A.setStation('enerveaza');
o.state = { houseSpeaker: A.state().houseSpeaker, warmed: A.state().clipsWarmed, loaded: A.state().clipsLoaded };

const buckets = ['stationIdent','police','star1','star2','star3','star4','star5','starCleared',
  'crash','bigCrash','pedHit','playerHurt','playerDied','missionStart','missionComplete','missionFailed',
  'activityStart','activityWin','activityLose','broadcast','daciaFirstStart','rain','idle','showSegment'];
o.bucketPlayed = {};
for (const b of buckets) {
  const before = A.state().lastClip;
  const t0 = performance.now();
  A.say(b, 9);
  let changed = false, latency = -1;
  for (let i = 0; i < 30; i++) {
    await w(40);
    if (A.state().lastClip !== before) { changed = true; latency = Math.round(performance.now() - t0); break; }
  }
  await w(600);
  const s = A.state();
  o.bucketPlayed[b] = { clip: s.lastClip, subtitle: s.nowPlaying, changed, latencyMs: latency,
                        voiceDb: +L().voice.rmsDb.toFixed(2) };
  for (let i = 0; i < 70 && A.state().duck > 0.15; i++) await w(100);
  await w(150);
}
const usage = A.clipUsage();
o.totalClips = usage.length;
o.playedCount = usage.filter((c) => c.plays > 0).length;
o.unassigned = usage.filter((c) => c.buckets.length === 0).map((c) => c.key);
