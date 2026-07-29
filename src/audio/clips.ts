/**
 * VOICE CLIP REGISTRY — *Ce Ne Enervează* on the Dacia's radio.
 *
 * `manifest.json` indexes 79 real recordings from the show. This file assigns
 * every one of them to one or more contexts so nothing sits on disk unused,
 * and gives each a subtitled Romanian line (docs/STORY.md: "Subtitles stay on
 * for every spoken and radio joke").
 *
 * Clip keys are `<group>/<numeric prefix>`:
 *   i55 = ce-ne-enerveaza-55-intro-clips
 *   m55 = ce-ne-enerveaza-55-matze-clips
 *   m61 = ce-ne-enerveaza-61-matze-clips
 *   i0  = ce-ne-enerveaza-intro-clips
 *
 * `clips.test.ts` asserts the assignment is total: every manifest entry lands
 * in at least one bucket, and every bucket key resolves to a real file.
 */

import manifest from './manifest.json';

export interface ManifestEntry {
  file: string;
  phrase: string;
}

const GROUP_ALIAS: Record<string, string> = {
  'ce-ne-enerveaza-55-intro-clips': 'i55',
  'ce-ne-enerveaza-55-matze-clips': 'm55',
  'ce-ne-enerveaza-61-matze-clips': 'm61',
  'ce-ne-enerveaza-intro-clips': 'i0',
};

export interface Clip {
  key: string;
  file: string;
  phrase: string;
  /** Subtitle line, with diacritics. */
  text: string;
  /** Rough length hint in seconds (the "complete" cuts are minutes long). */
  long: boolean;
}

/* ------------------------------------------------------------------ */
/* Buckets                                                             */
/* ------------------------------------------------------------------ */

export type VoBucket =
  | 'stationIdent'    // station opener, played when the radio comes on
  | 'showSegment'     // the three long "complete" cuts — full talk blocks
  | 'idle'            // free-roam chatter between music
  | 'police'          // played while a pursuit is live
  | 'star1' | 'star2' | 'star3' | 'star4' | 'star5'
  | 'starCleared'
  | 'crash'
  | 'bigCrash'
  | 'pedHit'
  | 'playerHurt'
  | 'playerDied'
  | 'missionStart'
  | 'missionComplete'
  | 'missionFailed'
  | 'activityStart'
  | 'activityWin'
  | 'activityLose'
  | 'broadcast'       // Act 3 — the hijacked national address
  | 'daciaFirstStart' // the cough-and-catch on the very first ignition
  | 'rain';

/**
 * The assignment table. Read it as "which clips can the commentator say here".
 * Clips deliberately appear in more than one bucket where the phrase fits.
 */
export const VO_BUCKETS: Record<VoBucket, string[]> = {
  stationIdent: ['i55/01', 'i55/12', 'i55/13', 'i0/01'],

  showSegment: ['i55/00', 'm55/00', 'm61/00'],

  idle: [
    'i55/02', 'i55/03', 'i55/04', 'i55/05', 'i55/06', 'i55/09', 'i55/10',
    'i55/11', 'i55/16', 'i55/17', 'i55/18',
    'm55/02', 'm55/03', 'm55/04', 'm55/05', 'm55/06', 'm55/11', 'm55/12',
    'm55/14', 'm55/17', 'm55/18',
    'm61/01', 'm61/02', 'm61/03', 'm61/05', 'm61/07', 'm61/08', 'm61/10',
    'm61/11', 'm61/13', 'm61/14', 'm61/15', 'm61/16', 'm61/19', 'm61/20',
    'i0/05', 'i0/06', 'i0/07', 'i0/08', 'i0/12',
  ],

  police: ['m61/21'],

  // Escalation. The angrier the phrase, the higher the star.
  star1: ['i55/19', 'i0/09'],
  star2: ['m61/06', 'm61/21'],
  star3: ['i55/20', 'i0/10', 'm55/16'],
  star4: ['i55/14', 'i0/03', 'm61/12'],
  star5: ['i55/08', 'i55/22', 'i0/14'],
  starCleared: ['m55/08', 'm61/09'],

  crash: ['i55/21', 'm55/19', 'm61/04', 'i0/13'],
  bigCrash: ['m55/16'],
  pedHit: ['i55/14', 'i0/03'],
  playerHurt: ['m61/09', 'i0/13'],
  playerDied: ['i55/22', 'm61/04'],

  missionStart: ['m55/01', 'm55/13', 'm55/15', 'm55/18', 'i55/10', 'm61/14'],
  missionComplete: ['i55/07', 'i55/15', 'i55/17', 'i0/04'],
  missionFailed: ['m55/19', 'm61/04'],

  activityStart: ['m61/17', 'm61/18'],
  activityWin: ['m55/08', 'i55/15', 'i55/07'],
  activityLose: ['m55/19'],

  broadcast: ['i55/13', 'm55/07', 'm55/09', 'm55/10', 'm55/12', 'm55/15', 'i0/02', 'i0/11'],

  daciaFirstStart: ['m61/20'],

  rain: ['i0/07', 'i0/14'],
};

/* ------------------------------------------------------------------ */
/* Subtitles                                                           */
/* ------------------------------------------------------------------ */

/** Romanian subtitle per clip key. Falls back to the manifest phrase. */
const SUBTITLES: Record<string, string> = {
  'i55/00': 'Ediție specială. Ce ne enervează astăzi?',
  'i55/01': 'Salutare, patrioți! Treziți-vă!',
  'i55/02': 'Ca un copil bătut de ambii părinți.',
  'i55/03': 'Părinte unu și părinte doi.',
  'i55/04': 'Iar părinții divorțează.',
  'i55/05': 'Pe cine iubești mai mult?',
  'i55/06': 'Pe asistenta socială.',
  'i55/07': 'Da.',
  'i55/08': 'Altă guvernare de rahat.',
  'i55/09': 'Ați venit cu caii?',
  'i55/10': 'Grindeanu salvator, Bolojan reformist.',
  'i55/11': 'Interesul mărei.',
  'i55/12': 'Salut, eu sunt Mihai Radu.',
  'i55/13': 'Stimați tovarăși, prieteni, cetățeni!',
  'i55/14': 'Mă, nenorociților! Mă, jafelor!',
  'i55/15': 'Exact.',
  'i55/16': 'Avem o vacă.',
  'i55/17': 'Aduce roadă, Doamne ajută.',
  'i55/18': 'Nici anul viitor — euro din buzunar.',
  'i55/19': 'Ce este cu această debandadă?',
  'i55/20': 'Armata, domnule!',
  'i55/21': 'Vă place? Nu vreau.',
  'i55/22': 'Aici nu se mai poate trăi.',

  'm55/00': 'Și acum, pe îndelete: mațele problemei.',
  'm55/01': 'Să nu uităm cine suntem.',
  'm55/02': 'Întrebarea roșie.',
  'm55/03': 'Unde suntem? La PSD.',
  'm55/04': 'Mici și bere.',
  'm55/05': 'După fumul de la grătare.',
  'm55/06': 'Vrem să trăim și noi săraci.',
  'm55/07': 'Globalist puppets.',
  'm55/08': 'Stabilitate și rezultate.',
  'm55/09': 'Simion nu bate palma cu PSD.',
  'm55/10': 'George Simion, păpușa.',
  'm55/11': 'Pișpirică-tiripirică.',
  'm55/12': 'Marionete masonice.',
  'm55/13': 'Formula este una simplă.',
  'm55/14': 'Poate românii uită.',
  'm55/15': 'Ea este țara mea.',
  'm55/16': 'Mai multe explozii!',
  'm55/17': 'Milioane de cozonaci.',
  'm55/18': 'Societatea s-a schimbat.',
  'm55/19': 'Eu rămân tâmpit.',

  'm61/00': 'Mațele ediției — pe larg.',
  'm61/01': 'A venit vacanța.',
  'm61/02': 'Am uitat de fotbalul nostru.',
  'm61/03': 'Mircea, Brâncoveanu, Țepeș, Ștefan.',
  'm61/04': 'Suntem niște catastrofe.',
  'm61/05': 'Le vreau pe ele.',
  'm61/06': 'Trebuie să fim atenți — pericol!',
  'm61/07': 'Ne vreau pe ele.',
  'm61/08': 'Suntem latini, creativi.',
  'm61/09': 'Pauză, că-mi bate inima.',
  'm61/10': 'Nu putem fi olandezi, nemți, belgieni.',
  'm61/11': 'Nu putem fi nordici.',
  'm61/12': 'Cu bolovani, topoare, furci!',
  'm61/13': 'De la băutură.',
  'm61/14': 'Țara lui Eminescu.',
  'm61/15': 'Criticilor mei — flori de-șarte.',
  'm61/16': 'Mintea înseamnă mentalul.',
  'm61/17': 'Repetiție.',
  'm61/18': 'Tic-tac.',
  'm61/19': 'Repetiție: biserică, clasă, rugăciune.',
  'm61/20': 'Danemarca se numea Dacia.',
  'm61/21': 'Circulați, vă rog!',

  'i0/01': 'Salut, eu sunt Mihai Radu.',
  'i0/02': 'Stimați tovarăși, prieteni, cetățeni!',
  'i0/03': 'Mă, nenorociților! Mă, jafelor!',
  'i0/04': 'Exact.',
  'i0/05': 'Avem o vacă — Dumnezeu să ne ajute.',
  'i0/06': 'Aduce roadă, Doamne ajută.',
  'i0/07': 'Nici anul viitor nu va fi simplu.',
  'i0/08': 'Vrea să-mi extragă euro din buzunar.',
  'i0/09': 'Ce este cu această debandadă?',
  'i0/10': 'Mă duc să mă fac armată.',
  'i0/11': 'Domnule Georgescu…',
  'i0/12': 'Vă place cum arată?',
  'i0/13': 'Nu vreau!',
  'i0/14': 'Aici nu se mai poate trăi.',
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

function titleise(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1) + '.';
}

function buildRegistry(): Map<string, Clip> {
  const out = new Map<string, Clip>();
  const voice = manifest.voice as Record<string, ManifestEntry[]>;
  for (const [group, entries] of Object.entries(voice)) {
    const alias = GROUP_ALIAS[group];
    if (!alias) continue;
    for (const e of entries) {
      const base = e.file.split('/').pop() ?? '';
      const num = base.slice(0, 2);
      const key = `${alias}/${num}`;
      out.set(key, {
        key,
        file: e.file,
        phrase: e.phrase,
        text: SUBTITLES[key] ?? titleise(e.phrase),
        long: /-complete\.mp3$/.test(base),
      });
    }
  }
  return out;
}

export const CLIPS: ReadonlyMap<string, Clip> = buildRegistry();

/** The folk track. Story: it starts the Builders House afterparty. */
export const FOLK_TRACK = manifest.music[0].file;
export const FOLK_TITLE = 'Fecioreasca de pe Mureș — Dumitru Fărcaș';

export function clip(key: string): Clip | undefined {
  return CLIPS.get(key);
}

/** Resolve a bucket to its clips, skipping anything the manifest lacks. */
export function bucket(b: VoBucket): Clip[] {
  const out: Clip[] = [];
  for (const k of VO_BUCKETS[b]) {
    const c = CLIPS.get(k);
    if (c) out.push(c);
  }
  return out;
}

/** Every clip key that appears in at least one bucket. */
export function assignedKeys(): Set<string> {
  const s = new Set<string>();
  for (const list of Object.values(VO_BUCKETS)) for (const k of list) s.add(k);
  return s;
}

/** Which buckets a clip is used in — powers the `__GTA_AUDIO__.clipUsage()` hook. */
export function bucketsFor(key: string): VoBucket[] {
  const out: VoBucket[] = [];
  for (const [b, list] of Object.entries(VO_BUCKETS) as [VoBucket, string[]][]) {
    if (list.includes(key)) out.push(b);
  }
  return out;
}
