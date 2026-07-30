const avg = async (n, ms) => {
  let m = 0, a = 0, v = 0;
  for (let i = 0; i < n; i++) {
    await w(ms); const l = L();
    m += Math.pow(10, l.music.rmsDb / 20);
    a += Math.pow(10, l.ambience.rmsDb / 20);
    v += Math.pow(10, l.voice.rmsDb / 20);
  }
  return { music: +(20 * Math.log10(m / n)).toFixed(2),
           amb: +(20 * Math.log10(a / n)).toFixed(2),
           voice: +(20 * Math.log10(v / n)).toFixed(2) };
};
// --- 1. reactions must be audible ON FOOT, through the facade screens ---
o.onFoot_quiet = await avg(8, 200);
A.say('star5', 5);
await w(700);
o.onFoot_reaction = await avg(10, 200);
o.onFoot_clip = A.state().lastClip;
await w(7000);

// --- 2. in the Dacia: the folk bed, and how hard speech ducks it ---
D.giveVehicle('dacia');
await w(4000);
A.setStation('folclor');
await w(6000);
o.car_folkStation = await avg(12, 200);
A.say('star5', 5);
await w(600);
o.car_ducked = await avg(10, 200);
o.duckAmount = A.state().duck;
o.duckedClip = A.state().nowPlaying;
await w(7000);
o.car_recovered = await avg(12, 200);
A.setStation('enerveaza');
await w(2000);
o.car_talkStationBed = await avg(10, 200);
A.setStation('off');
await w(3000);
o.car_radioOff = await avg(10, 200);
A.setStation('enerveaza');

o.musicDuckDb = +(o.car_ducked.music - o.car_folkStation.music).toFixed(2);
o.ambDuckDb = +(o.car_ducked.amb - o.car_folkStation.amb).toFixed(2);
o.voiceRiseOnFootDb = +(o.onFoot_reaction.voice - o.onFoot_quiet.voice).toFixed(2);
