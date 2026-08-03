/**
 * FRONT-END COPY — every word the boot sequence, the loading panels and the
 * credits put on screen, as data.
 *
 * Kept out of `frontEnd.ts` so the wording can be reviewed, translated and
 * unit-tested without touching the DOM code, and so the loading screen can be
 * proved to cover all four acts of `docs/STORY.md`.
 */

import type { HintId } from './bindings';

export interface LoadPanel {
  /** "01" … "04" — the panel index the reference front-end prints. */
  readonly index: string;
  /** Act name, English, as the reference strap reads. */
  readonly act: string;
  /** Two-line headline, `<br>` allowed. */
  readonly headline: string;
  /** One paragraph of body copy. */
  readonly body: string;
  /** Romanian flavour line under the progress bar, when the loader is quiet. */
  readonly status: string;
  /**
   * Controls taught while this panel holds. The loading screen used to be pure
   * story, so a player who pressed START never learned which key walks — the
   * key list was two menu pages away and entirely opt-in. Each panel now shows
   * a few bindings, resolved from the live key tables rather than typed here.
   */
  readonly hints: readonly HintId[];
}

/**
 * The four story panels. Panel 01 is verbatim the reference front-end at
 * `docs/reference/menu/title-screen.html`; 02–04 continue the acts from
 * `docs/STORY.md` in the same voice.
 */
export const LOAD_PANELS: readonly LoadPanel[] = [
  {
    index: '01',
    act: 'THE HOUSE UNDER SIEGE',
    headline: 'They closed the House.<br />They forgot about the builders.',
    body:
      'Recover the last server. Find the bootstrapped Dacia. Keep the ecosystem alive.',
    status: 'SE SIGILEAZĂ CASA CONSTRUCTORILOR',
    hints: ['move', 'look', 'interact'],
  },
  {
    index: '02',
    act: 'BOOTSTRAP RESISTANCE',
    headline: 'A yellow Dacia,<br />and half a city that still answers.',
    body:
      'Traversează Bucureștiul, adună constructorii, ia stickul cu dovezi de la Recorder și acreditările de emisie de la Nicușor LAN.',
    status: 'SE ADUNĂ CONSTRUCTORII',
    hints: ['drive', 'steer', 'handbrake'],
  },
  {
    index: '03',
    act: 'TERM SHEET FOR THE REPUBLIC',
    headline: 'The president has a speech.<br />You have the truth on a stick.',
    body:
      'Ajungi la turnul de emisie și înlocuiești discursul național al lui Georgescu cu ce s-a întâmplat de fapt la Casa Constructorilor.',
    status: 'SE CALIBREAZĂ TRANSMISIUNEA',
    hints: ['sprint', 'map', 'radioNext'],
  },
  {
    index: '04',
    act: 'EXIT THROUGH THE GIFT SHOP',
    headline: 'Five stars of instability,<br />one door left to open.',
    body:
      'Supraviețuiește întoarcerii, sparge baricada Ministerului și intră pe jos în holul Casei Constructorilor. Muzica începe doar după aceea.',
    status: 'MINISTERUL DE-ACCELERĂRII SE MOBILIZEAZĂ',
    hints: ['punch', 'aim', 'pause'],
  },
];

/** Seconds each loading panel holds before the next one crossfades in. */
export const PANEL_SECONDS = 4.6;

/**
 * Which panel is on screen `t` seconds into the loading phase. Panels rotate
 * and then hold on the last one — the four acts are a sequence, not a loop, so
 * a slow load must not spoil act IV and then rewind to act I.
 */
export function panelAt(t: number, count = LOAD_PANELS.length): number {
  if (!(t > 0)) return 0;
  const i = Math.floor(t / PANEL_SECONDS);
  return i >= count ? count - 1 : i;
}

/* ------------------------------------------------------------------ */
/* Credits                                                             */
/* ------------------------------------------------------------------ */

export interface CreditBlock {
  readonly role: string;
  readonly lines: readonly string[];
}

export const CREDITS: readonly CreditBlock[] = [
  { role: 'UN JOC', lines: ['B★ BUILDERSTAR GAMES'] },
  {
    role: 'ÎN ROLURILE PRINCIPALE',
    lines: [
      'Ilie Bolojan-Agatinei — constructorul care nu se oprește',
      'George Georgescu — președintele de pe ecrane',
      'Ministerul De-Accelerării Naționale — sistemul',
      'Recorder — curierul de dovezi',
      'Nicușor LAN — infrastructura',
      'Ce Ne Enervează — vocea de la radio',
      'Constructorii Bucureștiului — mulțimea',
    ],
  },
  {
    role: 'ORAȘUL',
    lines: [
      'București, generat procedural peste date stradale reale',
      '© OpenStreetMap contributors · ODbL 1.0',
      'Centrul Vechi · Bulevard · Corporate · Guvern',
      'Cartier · Industrial · Parc',
    ],
  },
  {
    role: 'CONSTRUIT CU',
    lines: [
      'three.js · Rapier · Vite · TypeScript',
      'Geometrie în cod. Texturi generate. Shadere inline.',
      'Niciun asset descărcat.',
    ],
  },
  {
    role: 'MUZICĂ',
    lines: ['„Fecioreasca de pe Mureș” — Dumitru Fărcaș'],
  },
  {
    role: 'MULȚUMIRI',
    lines: [
      'Tuturor celor care mai construiesc ceva aici.',
      '„La naiba, iar o luăm de la capăt.”',
    ],
  },
];

/** Footnote under the controls list — it explains why the list is trustworthy. */
export const GROUP_ORDER_NOTE =
  'Citite direct din harta de input a jocului, tastă cu tastă, nu dintr-o listă scrisă de mână. ' +
  'Dacă o tastă se schimbă în cod, se schimbă și aici.';

/* ------------------------------------------------------------------ */
/* First-run card                                                      */
/* ------------------------------------------------------------------ */

/**
 * The card shown once the curtain clears on a first run. The loading panels
 * teach three keys at a time and only if the player reads them; this is the
 * safety net for someone who pressed START and is now standing in București.
 */
export const FIRST_RUN_HINTS: readonly HintId[] = [
  'move',
  'look',
  'sprint',
  'interact',
  'drive',
  'handbrake',
  'map',
  'pause',
];

export const FIRST_RUN_TITLE = 'COMENZI';
export const FIRST_RUN_KICKER = 'PRIMA TURĂ';
export const FIRST_RUN_DISMISS = 'ORICE TASTĂ SAU CLIC — LISTA COMPLETĂ ÎN MENIUL DE PAUZĂ';
/** Seconds the card stays up if the player never touches anything. */
export const FIRST_RUN_SECONDS = 14;

/**
 * Shown only to a player with nothing to continue — a returning player who
 * picks START already knows how to walk, and CONTINUE never gets the card.
 */
export function showsFirstRunCard(mode: 'new' | 'continue', canContinue: boolean): boolean {
  return mode === 'new' && !canContinue;
}

/** Menu row identifiers, in on-screen order. */
export type MenuId = 'start' | 'continue' | 'controls' | 'audio' | 'credits';

export interface MenuItemDef {
  readonly id: MenuId;
  readonly label: string;
  /** Yellow sub-label revealed under the selected item. */
  readonly sub: string;
}

export const MENU_ITEMS: readonly MenuItemDef[] = [
  { id: 'start', label: 'START', sub: 'THE LAST SERVER' },
  { id: 'continue', label: 'CONTINUE', sub: 'RELUĂM DE UNDE AM RĂMAS' },
  { id: 'controls', label: 'CONTROLS', sub: 'TASTE ȘI MOUSE' },
  { id: 'audio', label: 'SETTINGS', sub: 'SUNET ȘI IMAGINE' },
  { id: 'credits', label: 'CREDITS', sub: 'CINE A CONSTRUIT ASTA' },
];

/**
 * Move the highlight by `dir`, skipping items that are not selectable (a
 * CONTINUE with nothing to continue). Wraps, and returns `from` when nothing in
 * the row can be selected at all.
 */
export function stepSelection(from: number, dir: number, enabled: readonly boolean[]): number {
  const n = enabled.length;
  if (n === 0) return from;
  for (let i = 1; i <= n; i++) {
    const idx = (((from + dir * i) % n) + n) % n;
    if (enabled[idx]) return idx;
  }
  return from;
}
