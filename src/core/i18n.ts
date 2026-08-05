/**
 * LANGUAGE — Romanian is the source, English is a translation of it.
 *
 * WHY THE KEYS ARE THE ROMANIAN SENTENCES
 * ---------------------------------------
 * Every string in this game was authored in Romanian, in place, in the data
 * table that owns it: the acts in `src/content/story.ts`, the stalls in
 * `src/gameplay/activities.ts`, the rap sheet in `src/gameplay/wanted.ts`. A
 * key-based catalogue would have meant inventing a name for each of those and
 * editing forty files to use it, which is forty chances to typo a key into a
 * blank label. So the Romanian sentence IS the key: the tables stay exactly as
 * written, and `t()` is applied at the handful of places where a string finally
 * reaches the screen.
 *
 * The consequence is the safe one. A sentence with no entry in the catalogue
 * falls through as Romanian rather than as `missing.key.42` — the game is never
 * unreadable, only untranslated, and `npm test` pins the sentences that matter.
 *
 * WHAT IS NOT TRANSLATED
 * ----------------------
 * The audio. Every recording under `public/audio/` is Romanian and stays
 * Romanian; only the *subtitles* over it move. `src/audio/clips.ts` phrases are
 * transcripts of real *Ce Ne Enervează* cuts, so their English entries are
 * subtitles for that Romanian speech, not a dub.
 *
 * SWITCHING AT RUNTIME
 * --------------------
 * The title screen offers LANGUAGE and the pause menu inherits the choice.
 * Anything that redraws from data every frame (the HUD panels, the map) is
 * translated on the spot and needs nothing. Anything drawn once (the menu
 * pages, the credits) subscribes through `onLangChange`.
 */

import { EN } from '../content/i18n/en';

export type Lang = 'ro' | 'en';

export const LANGUAGES = ['ro', 'en'] as const satisfies readonly Lang[];

/** Endonyms — a language picker that names languages in the language you do not speak is useless. */
export const LANG_LABELS: Record<Lang, string> = {
  ro: 'ROMÂNĂ',
  en: 'ENGLISH',
};

/** Shares the `gta.*` namespace with the settings and save slots. */
export const LANG_STORAGE_KEY = 'gta.lang.v1';

/** The language the game was authored in, and the fallback for everything. */
export const DEFAULT_LANG: Lang = 'ro';

/** `null` for Romanian: the source needs no lookup table. */
const CATALOGUES: Record<Lang, Readonly<Record<string, string>> | null> = {
  ro: null,
  en: EN,
};

const LOCALES: Record<Lang, string> = {
  ro: 'ro-RO',
  en: 'en-GB',
};

export function isLang(v: unknown): v is Lang {
  return v === 'ro' || v === 'en';
}

/** Reads a stored value without trusting it — an old or hand-edited slot is just `null`. */
export function parseLang(raw: string | null): Lang | null {
  return isLang(raw) ? raw : null;
}

export function loadStoredLang(storage?: Pick<Storage, 'getItem'>): Lang | null {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    return source ? parseLang(source.getItem(LANG_STORAGE_KEY)) : null;
  } catch {
    return null;
  }
}

let current: Lang = loadStoredLang() ?? DEFAULT_LANG;

const listeners = new Set<(l: Lang) => void>();

export function lang(): Lang {
  return current;
}

/** BCP 47 tag for `toLocaleString` — thousands separators differ, and lei are read in both. */
export function locale(): string {
  return LOCALES[current];
}

/**
 * Switch language and tell everyone who draws once. Setting the language it is
 * already on is a no-op, so a menu that re-affirms the current row does not
 * rebuild every page in the front-end.
 */
export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, next);
  } catch {
    /* private mode — the choice just does not survive the session */
  }
  // `<html lang>` matters for screen readers and for the browser's own
  // hyphenation. Guarded on `documentElement` rather than on `document`: the
  // test runner provides a partial `document` with no element tree, and a
  // language switch must not throw there — a throw here would leave `current`
  // updated but every subscriber un-notified.
  const root = typeof document === 'undefined' ? null : document.documentElement;
  if (root) root.lang = next;
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch (err) {
      // One broken subscriber must not stop the rest of the UI re-rendering.
      console.warn('[i18n] language listener failed:', err);
    }
  }
}

/** Subscribe to language changes. Returns the unsubscribe. */
export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate one authored Romanian string.
 *
 * Identity on Romanian, and identity on anything the catalogue has never heard
 * of — a proper noun (`Dacia`, `Nicușor LAN`), a number, or a sentence nobody
 * has translated yet.
 */
export function t(source: string): string {
  const table = CATALOGUES[current];
  if (!table) return source;
  return table[source] ?? source;
}

/**
 * Translate a template and fill it in. Placeholders are `{name}`:
 *
 *     tp('Nu ai {cost} lei', { cost: 42 })
 *
 * Interpolated sentences cannot be looked up after the fact — `Nu ai 42 lei`
 * is not a key anyone can write a translation for — so the *template* is the
 * key and the values are substituted into whichever language came back. That
 * also lets a translation move the placeholder, which English frequently must.
 */
export function tp(source: string, params: Readonly<Record<string, string | number>>): string {
  return fill(t(source), params);
}

/** Substitution alone, for a template that is already in the right language. */
export function fill(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

/** Locale-aware thousands separators: `1.234` in Romanian, `1,234` in English. */
export function num(n: number): string {
  return n.toLocaleString(locale());
}
