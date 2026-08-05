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
    status: 'SE SIGILEAZĂ CASA BUILDERILOR',
  },
  {
    index: '02',
    act: 'BOOTSTRAP RESISTANCE',
    headline: 'A yellow Dacia,<br />and half a city that still answers.',
    body:
      'Traversează Bucureștiul, adună builderii, ia stickul cu dovezi de la Recorder și acreditările de emisie de la Nicușor LAN.',
    status: 'SE ADUNĂ BUILDERII',
  },
  {
    index: '03',
    act: 'TERM SHEET FOR THE REPUBLIC',
    headline: 'The president has a speech.<br />You have the truth on a stick.',
    body:
      'Ajungi la turnul de emisie și înlocuiești discursul național al lui Georgescu cu ce s-a întâmplat de fapt la Casa Builderilor.',
    status: 'SE CALIBREAZĂ TRANSMISIUNEA',
  },
  {
    index: '04',
    act: 'EXIT THROUGH THE GIFT SHOP',
    headline: 'Five stars of instability,<br />one door left to open.',
    body:
      'Supraviețuiește întoarcerii, sparge baricada Ministerului și intră pe jos în holul Casei Builderilor. Muzica începe doar după aceea.',
    status: 'MINISTERUL DE-ACCELERĂRII SE MOBILIZEAZĂ',
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
      'Ilie Bolojan-Agatinei — builderul care nu se oprește',
      'George Georgescu — președintele de pe ecrane',
      'Ministerul De-Accelerării Naționale — sistemul',
      'Recorder — curierul de dovezi',
      'Nicușor LAN — infrastructura',
      'Ce Ne Enervează — vocea de la radio',
      'Builderii Bucureștiului — mulțimea',
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
/* Launch curtain                                                      */
/* ------------------------------------------------------------------ */

/**
 * Controls printed on the STARTING GAME curtain — the two seconds between
 * pressing START and standing in București. That wait used to show a progress
 * bar and nothing else, which made it the last chance to read the keys and the
 * one place a new player was guaranteed to be looking.
 */
export const LAUNCH_HINTS: readonly HintId[] = [
  'move',
  'look',
  'sprint',
  'interact',
  'drive',
  'handbrake',
  'map',
  'pause',
];

export const LAUNCH_HINTS_TITLE = 'COMENZI';

/**
 * Shown only to a player with nothing to continue — a returning player who
 * picks START already knows how to walk, and CONTINUE never gets the guide.
 */
export function showsWalkthrough(mode: 'new' | 'continue', canContinue: boolean): boolean {
  return mode === 'new' && !canContinue;
}

/** Menu row identifiers, in on-screen order. */
export type MenuId = 'start' | 'continue' | 'controls' | 'audio' | 'language' | 'credits';

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
  // The row label is deliberately the English word in both languages: a player
  // who cannot read the current language has to be able to find this one.
  { id: 'language', label: 'LANGUAGE', sub: 'ROMÂNĂ SAU ENGLEZĂ' },
  { id: 'credits', label: 'CREDITS', sub: 'CINE A CONSTRUIT ASTA' },
];

/** Title-screen banner when the front-end detects a phone / coarse pointer. */
export const MOBILE_NOTICE = {
  kicker: 'DESKTOP ONLY',
  body: 'Open this in a browser on a computer — it will not run on a phone.',
} as const;

/**
 * Whether a main-menu row can be activated. START / CONTINUE need a desktop
 * browser; CONTINUE also needs a resumable save.
 */
export function menuItemEnabled(
  id: MenuId,
  opts: { canContinue: boolean; mobile: boolean },
): boolean {
  if (id === 'start') return !opts.mobile;
  if (id === 'continue') return !opts.mobile && opts.canContinue;
  return true;
}

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
