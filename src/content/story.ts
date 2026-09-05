/**
 * THE CAMPAIGN — four acts, as data.
 *
 * `docs/STORY.md` is the spec; this is that spec in the shape
 * `src/gameplay/missionState.ts` can execute. Keeping it as data rather than
 * code means the acts can be reordered, retimed and rewritten without touching
 * the runtime, and the runtime can be tested without the acts.
 *
 * Everything spoken is Romanian and subtitled. Each line explicitly declares
 * whether it belongs when an objective begins or after its interaction is
 * completed, so characters answer the player's actions instead of talking
 * over them.
 */

import type { MissionDef, Vec3Lite } from '../gameplay/missionState';
import {
  LOBBY_DOOR_OUTSIDE,
  LOBBY_RECEPTION,
  PLACES,
} from './places';

const at = (p: { x: number; z: number }, y = 0): Vec3Lite => ({ x: p.x, y, z: p.z });

/* ------------------------------------------------------------------ */
/* Act I — Ordin de Evacuare                                           */
/* ------------------------------------------------------------------ */

const ACT1: MissionDef = {
  id: 'act1_evacuare',
  act: 1,
  title: 'Ordin de Evacuare',
  brief: 'Ministerul sigilează Casa Builderilor.',
  startAt: at(PLACES.buildersForecourt),
  startLabel: 'Vorbește cu builderii',
  rewardXp: 320,
  rewardLei: 900,
  objectives: [
    {
      id: 'brief',
      title: 'Vorbește cu builderii',
      hint: 'Ministerul a lipit ordinul pe ușă.',
      trigger: { kind: 'interact', at: at(PLACES.buildersForecourt), label: 'Vorbește cu builderii', radius: 3.6 },
      onFoot: true,
      xp: 40,
      sayAt: 'complete',
      say: [
        { speaker: 'Builder', text: 'Ilie! Au sigilat clădirea. Ordin de evacuare, semnat azi-dimineață.', delayMs: 200, ms: 4200 },
        { speaker: 'Ilie', text: 'La naiba, iar o luăm de la capăt.', delayMs: 4400, ms: 3600 },
        { speaker: 'Builder', text: 'Serverul comunității e încă înăuntru. Dacă îl iau ei, s-a terminat.', delayMs: 8100, ms: 4600 },
      ],
    },
    {
      id: 'server',
      title: 'Ia serverul comunității',
      hint: 'Lângă scara de incendiu, în curte.',
      trigger: { kind: 'interact', at: at(PLACES.serverRack), label: 'Ia serverul comunității', radius: 3.4 },
      onFoot: true,
      stars: 1,
      timeLimit: 150,
      xp: 60,
      sayAt: 'complete',
      say: [
        { speaker: 'Ilie', text: 'Un rack, patruzeci de kilograme și toată munca noastră pe el.', delayMs: 300, ms: 4000 },
      ],
    },
    {
      id: 'load',
      title: 'Încarcă serverul în Dacia',
      hint: 'Dacia e la bordură, în fața curții.',
      trigger: { kind: 'board', at: at(PLACES.daciaSlot), radius: 26 },
      timeLimit: 120,
      xp: 60,
      sayAt: 'enter',
      say: [
        { speaker: 'Radio', text: 'Ministerul De-Accelerării Naționale anunță o operațiune de ordine în zona Casa Builderilor.', delayMs: 400, ms: 5200 },
      ],
    },
    {
      id: 'escape',
      title: 'Ieși din cordonul Ministerului',
      hint: 'Trei sute de metri și nu te uita în oglindă.',
      trigger: { kind: 'flee', from: at(PLACES.buildersForecourt), distance: 300 },
      inVehicle: true,
      timeLimit: 180,
      xp: 80,
      sayAt: 'enter',
      say: [
        { speaker: 'Ilie', text: 'Tușește, dar merge. Ca toată țara.', delayMs: 900, ms: 3600 },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Act II — Bootstrap Resistance                                       */
/* ------------------------------------------------------------------ */

const ACT2: MissionDef = {
  id: 'act2_bootstrap',
  act: 2,
  title: 'Bootstrap Resistance',
  brief: 'Traversează orașul. Adună dovezile și acreditările.',
  requires: 'act1_evacuare',
  startAt: at(PLACES.buildersForecourt),
  startLabel: 'Pornește rezistența',
  rewardXp: 520,
  rewardLei: 1400,
  objectives: [
    {
      id: 'toRecorder',
      title: 'Ajungi la Piața Victoriei',
      hint: 'Operativul Recorder te așteaptă la predare.',
      trigger: { kind: 'reach', at: at(PLACES.recorderDrop), radius: 26 },
      timeLimit: 300,
      xp: 60,
      sayAt: 'enter',
      say: [
        { speaker: 'Recorder', text: 'Sunt în piață. Am filmat tot ce au făcut la sigilare. Vino singur.', delayMs: 300, ms: 4600 },
      ],
    },
    {
      id: 'evidence',
      title: 'Ia stickul cu dovezi de la Alex Need-Aid',
      hint: 'Pe jos. Nu opri motorul lângă el.',
      trigger: { kind: 'interact', at: at(PLACES.recorderDrop), label: 'Vorbește cu Alex Need-Aid', radius: 3.6 },
      onFoot: true,
      stars: 2,
      xp: 90,
      sayAt: 'complete',
      say: [
        { speaker: 'Alex Need-Aid', text: 'Patru ore de material brut. Semnături, ordine, numele tuturor.', delayMs: 300, ms: 4400 },
        { speaker: 'Alex Need-Aid', text: 'Dacă difuzezi asta, nu mai ai unde să te întorci. Știi, da?', delayMs: 4700, ms: 4200 },
        { speaker: 'Ilie', text: 'Mă întorc exact acolo de unde m-au dat afară.', delayMs: 9000, ms: 4000 },
      ],
    },
    {
      id: 'toNicusor',
      title: 'Ajungi la Curtea Startup',
      hint: 'Nicușor LAN are ruta și acreditările.',
      trigger: { kind: 'reach', at: at(PLACES.nicusorCourtyard), radius: 26 },
      timeLimit: 300,
      xp: 60,
    },
    {
      id: 'credentials',
      title: 'Ia acreditările de emisie de la Nicușor LAN',
      hint: 'Pe jos, în curte.',
      trigger: { kind: 'interact', at: at(PLACES.nicusorCourtyard), label: 'Vorbește cu Nicușor LAN', radius: 3.6 },
      onFoot: true,
      stars: 3,
      xp: 90,
      sayAt: 'complete',
      say: [
        { speaker: 'Nicușor LAN', text: 'Fibra intră pe sub piață. Turnul are un singur router și parola e din 2011.', delayMs: 300, ms: 4800 },
        { speaker: 'Nicușor LAN', text: 'Ți-am scris ruta. Nu intra pe bulevard, au filtru la kilometrul doi.', delayMs: 5100, ms: 4800 },
      ],
    },
    {
      id: 'shake',
      title: 'Scapă de Minister',
      hint: 'Zero stele și te lasă în pace.',
      trigger: { kind: 'escape' },
      timeLimit: 240,
      xp: 120,
      sayAt: 'enter',
      say: [
        { speaker: 'Nicușor LAN', text: 'Ai Ministerul în coadă. Rupe contactul și sună-mă când ai zero stele.', delayMs: 300, ms: 4400 },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Act III — Term Sheet for the Republic                               */
/* ------------------------------------------------------------------ */

const ACT3: MissionDef = {
  id: 'act3_termsheet',
  act: 3,
  title: 'Term Sheet for the Republic',
  brief: 'Înlocuiește discursul național al lui Georgescu.',
  requires: 'act2_bootstrap',
  startAt: at(PLACES.buildersForecourt),
  startLabel: 'Pregătește emisia',
  rewardXp: 700,
  rewardLei: 2200,
  startStars: 1,
  objectives: [
    {
      id: 'toBroadcast',
      title: 'Ajungi la Piața Transmisiunii',
      hint: 'Discursul intră în direct în opt minute.',
      trigger: { kind: 'reach', at: at(PLACES.broadcastSite), radius: 30 },
      stars: 2,
      timeLimit: 360,
      xp: 90,
      sayAt: 'enter',
      say: [
        { speaker: 'Georgescu', text: 'Builderii independenți destabilizează națiunea. Statul construiește singur.', delayMs: 500, ms: 5200 },
        { speaker: 'Ilie', text: 'Omul ăsta n-a pus o cărămidă în viața lui.', delayMs: 5600, ms: 3800 },
      ],
    },
    {
      id: 'hijack',
      title: 'Preia turnul de emisie',
      hint: 'Server + dovezi + acreditări. Pe jos, la bază.',
      trigger: { kind: 'interact', at: at(PLACES.broadcastSite), label: 'Preia emisia națională', radius: 4.2 },
      onFoot: true,
      hijack: true,
      xp: 200,
      sayAt: 'complete',
      say: [
        { speaker: 'Nicușor LAN', text: 'Ești pe fibră. Ai treizeci de secunde de tăcere și pe urmă ești tu în direct.', delayMs: 300, ms: 4800 },
      ],
    },
    {
      id: 'hold',
      title: 'Ține emisia patruzeci de secunde',
      hint: 'Nu părăsi piața.',
      trigger: { kind: 'hold', at: at(PLACES.broadcastSite), radius: 55, seconds: 40 },
      stars: 4,
      timeLimit: 150,
      xp: 220,
      sayAt: 'enter',
      say: [
        { speaker: 'Ilie', text: 'Bună seara. Nu suntem instabilitate. Suntem întreținerea.', delayMs: 600, ms: 5200 },
        { speaker: 'Radio', text: 'Toate ecranele orașului au trecut pe altceva. Nimeni nu știe pe ce.', delayMs: 6200, ms: 5000 },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Act IV — Exit Through the Gift Shop                                 */
/* ------------------------------------------------------------------ */

const ACT4: MissionDef = {
  id: 'act4_giftshop',
  act: 4,
  title: 'Exit Through the Gift Shop',
  brief: 'Întoarce-te acasă prin tot ce are Ministerul.',
  requires: 'act3_termsheet',
  startAt: at(PLACES.broadcastSite),
  startLabel: 'Pornește întoarcerea',
  rewardXp: 1500,
  rewardLei: 5000,
  startStars: 5,
  objectives: [
    {
      id: 'return',
      title: 'Întoarce-te la Casa Builderilor',
      hint: 'Cinci stele. Tot orașul te caută.',
      trigger: { kind: 'reach', at: at(PLACES.buildersForecourt), radius: 40 },
      stars: 5,
      timeLimit: 300,
      xp: 220,
      sayAt: 'enter',
      say: [
        { speaker: 'Radio', text: 'Instabilitate politică maximă. Toate unitățile, pe bulevardul central.', delayMs: 400, ms: 5000 },
      ],
    },
    {
      id: 'barricade',
      title: 'Sparge baricada Ministerului',
      hint: 'Pe jos, în curte.',
      trigger: { kind: 'interact', at: at(PLACES.barricade), label: 'Sparge baricada', radius: 4.4 },
      onFoot: true,
      timeLimit: 180,
      xp: 160,
      sayAt: 'complete',
      say: [
        { speaker: 'Ilie', text: 'Bare de oțel și o hârtie A4. Ghici care ține.', delayMs: 300, ms: 4000 },
      ],
    },
    {
      id: 'enter',
      title: 'Intră în Casa Builderilor',
      hint: 'Pe ușa pietonală. Mașina rămâne afară.',
      trigger: { kind: 'interact', at: at(LOBBY_DOOR_OUTSIDE), label: 'Intră în Casa Builderilor', radius: 4.0 },
      onFoot: true,
      timeLimit: 180,
      xp: 160,
      sayAt: 'complete',
      say: [
        { speaker: 'Ilie', text: 'Aceeași ușă. De data asta o deschid eu.', delayMs: 400, ms: 4000 },
      ],
    },
    {
      id: 'liberate',
      title: 'Eliberează Casa Builderilor',
      hint: 'La recepție, în hol.',
      trigger: { kind: 'interact', at: at(LOBBY_RECEPTION), label: 'Eliberează Casa Builderilor', radius: 4.6 },
      onFoot: true,
      xp: 400,
      sayAt: 'complete',
      say: [
        { speaker: 'Ilie', text: 'Aprindeți luminile. Deschideți ușile. Chemați pe toată lumea.', delayMs: 500, ms: 4600 },
        { speaker: 'Builder', text: 'S-a întors! Puneți muzica!', delayMs: 5200, ms: 3800 },
      ],
    },
  ],
};

export const CAMPAIGN: MissionDef[] = [ACT1, ACT2, ACT3, ACT4];

export const CAMPAIGN_BY_ID: ReadonlyMap<string, MissionDef> = new Map(
  CAMPAIGN.map((m) => [m.id, m]),
);

/** Level names for the progression banner — startup ladder, played straight. */
export const LEVEL_NAMES = [
  '', 'Idee', 'Runway', 'Tracțiune', 'Seria A', 'Scale-up', 'Unicorn',
  'IPO', 'Monopol', 'Fond suveran', 'Legendă',
];
