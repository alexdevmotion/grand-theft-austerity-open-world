/**
 * PAUSE MENU — Escape freezes the sim, unlocks the pointer and puts a real
 * menu on screen: Resume / Save / Settings / Controls.
 *
 * OWNED BY: the UI agent. It used to be a field on `HudSystem`, because the
 * engine decided what survived a pause from `order >= 400` and the HUD was the
 * nearest thing that qualified. `System.ticksWhenPaused` says it directly now,
 * so this is a registered system that declares the one property it actually
 * needs and lives at its own order.
 *
 * CONTROLS PAGE — WHY IT IS PROBED, NOT TYPED OUT
 * -----------------------------------------------
 * A hardcoded copy of the key map is a lie waiting to happen: rebind a key in
 * `src/core/input.ts` and the help screen quietly starts telling the player the
 * wrong thing. `KEY_ACTIONS` is module-private there, so this file recovers the
 * real map the only honest way available from outside: it synthesises a
 * keydown for every candidate key against the live `Input` instance and records
 * which action (and which movement axis) actually lit up. What you see on the
 * controls page is therefore what the game will really do.
 *
 * The one thing still declared here is the human-readable label per action —
 * and `ACTION_LABELS` is typed `Record<ActionName, ...>`, so adding an action
 * to `ActionName` fails `tsc` until it has a label. The list cannot drift.
 */

import type { GameContext, System } from '../core/engine';
import type { ActionName } from '../core/input';
import { Services, type RenderService } from '../core/services';
import { num, onLangChange, t, tp } from '../core/i18n';

type Quality = 'low' | 'medium' | 'high' | 'ultra';

const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];
const QUALITY_LABELS: Record<Quality, string> = {
  low: 'SCĂZUT',
  medium: 'MEDIU',
  high: 'ÎNALT',
  ultra: 'ULTRA',
};

/** Human labels. Exhaustive by construction — a new ActionName breaks tsc. */
const ACTION_LABELS: Record<ActionName, string | null> = {
  jump: 'Sari',
  sprint: 'Fugi',
  crouch: 'Ghemuit',
  interact: 'Interacționează / urcă în mașină',
  handbrake: 'Frână de mână',
  horn: 'Claxon',
  aim: 'Ochește',
  fire: 'Trage',
  punch: 'Lovește',
  exitVehicle: 'Coboară din mașină',
  cameraSwitch: 'Schimbă camera',
  map: 'Hartă',
  pause: 'Pauză / meniu',
  radioNext: 'Postul următor',
  lookBehind: 'Privește în spate',
  photoMode: 'Mod foto',
};

const ALL_ACTIONS = Object.keys(ACTION_LABELS) as ActionName[];

/** Every key the probe tries. Anything bound outside this set is not a key. */
const PROBE_KEYS: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 26; i++) out.push(`Key${String.fromCharCode(65 + i)}`);
  for (let i = 0; i < 10; i++) out.push(`Digit${i}`);
  out.push(
    'Space', 'Enter', 'Tab', 'Escape', 'Backquote', 'Backspace',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Comma', 'Period', 'Slash', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
  );
  return out;
})();

const KEY_GLYPHS: Record<string, string> = {
  Space: 'SPAȚIU',
  Escape: 'ESC',
  Enter: 'ENTER',
  Tab: 'TAB',
  Backquote: '`',
  Backspace: '⌫',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'SHIFT DR.',
  ControlLeft: 'CTRL',
  ControlRight: 'CTRL DR.',
  AltLeft: 'ALT',
  AltRight: 'ALT DR.',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Mouse0: 'CLIC STÂNGA',
  Mouse1: 'CLIC MIJLOC',
  Mouse2: 'CLIC DREAPTA',
};

function glyph(code: string): string {
  return t(KEY_GLYPHS[code] ?? code.replace(/^(Key|Digit)/, ''));
}

interface BindingRow {
  label: string;
  keys: string[];
}

interface StoredSettings {
  quality?: Quality;
  masterVolume?: number;
  lookSensitivity?: number;
  invertY?: boolean;
}

const STORAGE_KEY = 'gta.settings.v1';

type Page = 'main' | 'settings' | 'controls';

export class PauseMenu implements System {
  readonly name = 'pauseMenu';
  /** Presentation band, just behind the HUD it draws over. */
  readonly order = 440;
  /** The whole point of this system: it is what you use once the world stops. */
  readonly ticksWhenPaused = true;

  private ctx!: GameContext;
  private root!: HTMLDivElement;
  private bodyEl!: HTMLDivElement;
  private crumbEl!: HTMLDivElement;
  private open = false;
  private saveFlash = 0;
  private page: Page = 'main';
  private selected = 0;
  /** True while synthetic key/mouse events are being fired at `Input`. */
  private probing = false;
  private bindings: BindingRow[] | null = null;
  private disposers: Array<() => void> = [];
  private time = 0;

  get isOpen(): boolean {
    return this.open;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;

    const host = document.getElementById('ui-root')!;
    this.root = document.createElement('div');
    this.root.className = 'gta-pause';
    this.root.innerHTML = TEMPLATE;
    host.appendChild(this.root);

    this.bodyEl = this.root.querySelector('.pm-body')!;
    this.crumbEl = this.root.querySelector('.pm-crumb')!;
    this.root.style.display = 'none';

    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    window.addEventListener('keydown', onKey, true);
    this.disposers.push(() => window.removeEventListener('keydown', onKey, true));

    // The probe result caches the labels it read, so a language switch has to
    // drop it — otherwise CONTROLS keeps showing whichever language was on
    // screen the first time the page was opened.
    this.disposers.push(
      onLangChange(() => {
        this.bindings = null;
        this.paintChrome();
        if (this.open) this.render();
      }),
    );

    this.paintChrome();
    this.applyStored();
  }

  /** The parts of `TEMPLATE` that are copy rather than layout. */
  private paintChrome(): void {
    const set = (sel: string, text: string): void => {
      const el = this.root.querySelector<HTMLElement>(sel);
      if (el) el.textContent = text;
    };
    set('.pm-eyebrow', t('B★ BUILDERSTAR GAMES — TRANSMISIUNE ÎNTRERUPTĂ'));
    set('.pm-foot', t('ESC ÎNAPOI · ↑ ↓ NAVIGARE · ← → MODIFICĂ · ENTER SELECTEAZĂ'));
    const title = this.root.querySelector<HTMLElement>('.pm-title');
    if (title) {
      // The chromatic-aberration ghost is `content: attr(data-text)`, so the
      // attribute has to move with the text or the two layers disagree.
      title.textContent = t('PAUZĂ');
      title.dataset.text = t('PAUZĂ');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Open / close                                                      */
  /* ---------------------------------------------------------------- */

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.page = 'main';
    this.selected = 0;
    this.saveFlash = 0;
    // Opening the menu is the moment a player expects their run to be safe.
    // Write BEFORE pausing, so `playSeconds` and the world state are the ones
    // they were actually at.
    this.autosave();
    this.ctx.time.paused = true;
    // The pointer must come back or the menu is unusable. Escape already
    // releases the lock in every browser; this covers the programmatic path.
    this.ctx.input.exitPointerLock();
    // Stop gameplay reading the keyboard while the menu owns it. The menu runs
    // off its own capture-phase listener, so it still works with input off.
    this.ctx.input.enabled = false;
    this.root.style.display = '';
    this.root.classList.add('pm-in');
    this.render();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('pm-in');
    this.root.style.display = 'none';
    this.ctx.time.paused = false;
    this.ctx.input.enabled = true;
    this.persist();
  }

  /* ---------------------------------------------------------------- */
  /* Saving                                                            */
  /* ---------------------------------------------------------------- */

  /** Quiet write on open — never blocks, never complains. */
  private autosave(): void {
    try {
      this.ctx.tryGet(Services.Save)?.save('auto');
    } catch (err) {
      console.warn('[pause] autosave failed:', err);
    }
  }

  /** The explicit SALVEAZĂ row: same write, with feedback. */
  private saveNow(): void {
    const save = this.ctx.tryGet(Services.Save);
    if (!save) {
      this.saveFlash = -1;
      this.render();
      return;
    }
    try {
      save.save('manual');
      this.saveFlash = 1;
    } catch {
      this.saveFlash = -1;
    }
    this.render();
  }

  private saveLabel(): string {
    if (this.saveFlash > 0) return t('progres salvat');
    if (this.saveFlash < 0) return t('salvarea nu este disponibilă');
    const slot = this.ctx.tryGet(Services.Save)?.peek();
    if (!slot) return t('scrie progresul în browser');
    return tp('nivel {level} · {lei} lei · {mins} min', {
      level: slot.level,
      lei: num(Math.round(slot.lei)),
      mins: Math.floor(slot.playSeconds / 60),
    });
  }

  /** Called every frame by the engine, paused or not. */
  update(dt: number, _ctx?: GameContext): void {
    // Escape only ever *opens* the menu from here; once it is up this class
    // owns the key on its own capture-phase listener, with gameplay input off.
    if (!this.open && this.ctx?.input.actionPressed('pause')) this.show();
    if (!this.open) return;
    this.time += dt;
    // Cheap broadcast flicker on the title, driven off wall time so it keeps
    // moving with the simulation stopped.
    const t = this.root.querySelector<HTMLElement>('.pm-title');
    if (t) t.style.setProperty('--pm-jit', `${Math.sin(this.time * 21.0) * Math.sin(this.time * 3.1) * 2.2}px`);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root?.remove();
  }

  /* ---------------------------------------------------------------- */
  /* Settings plumbing                                                 */
  /* ---------------------------------------------------------------- */

  private get render$(): RenderService | undefined {
    return this.ctx.tryGet(Services.Render);
  }

  private get quality(): Quality {
    return this.render$?.quality ?? 'high';
  }

  private setQuality(q: Quality): void {
    const r = this.render$;
    if (!r) return;
    if (r.quality !== q) r.setQuality(q);
    this.persist();
  }

  private get masterVolume(): number {
    return this.ctx.tryGet(Services.Audio)?.masterVolume ?? 1;
  }

  private setMasterVolume(v: number): void {
    const a = this.ctx.tryGet(Services.Audio);
    if (a) a.masterVolume = clamp01(v);
  }

  private applyStored(): void {
    let s: StoredSettings = {};
    try {
      s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as StoredSettings;
    } catch {
      s = {};
    }
    if (s.masterVolume !== undefined) this.setMasterVolume(s.masterVolume);
    if (s.lookSensitivity !== undefined) {
      this.ctx.input.lookSensitivity = clamp(s.lookSensitivity, 0.0004, 0.0075);
    }
    if (s.invertY !== undefined) this.ctx.input.invertY = !!s.invertY;
    // Quality was restored before renderer/world initialisation by createGame.
  }

  private persist(): void {
    const s: StoredSettings = {
      quality: this.quality,
      masterVolume: this.masterVolume,
      lookSensitivity: this.ctx.input.lookSensitivity,
      invertY: this.ctx.input.invertY,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* private mode — settings just do not survive the session */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  private onKeyDown(e: KeyboardEvent): void {
    // Ignore the events this menu fires at Input while reading the key map.
    if (this.probing || !e.isTrusted) return;
    if (!this.open) return;

    const rows = this.rowCount();
    switch (e.code) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (this.page === 'main') this.close();
        else this.goto('main');
        return;
      case 'ArrowUp':
      case 'KeyW':
        e.preventDefault();
        this.selected = (this.selected - 1 + rows) % rows;
        this.render();
        return;
      case 'ArrowDown':
      case 'KeyS':
        e.preventDefault();
        this.selected = (this.selected + 1) % rows;
        this.render();
        return;
      case 'ArrowLeft':
      case 'KeyA':
        e.preventDefault();
        this.nudge(-1);
        return;
      case 'ArrowRight':
      case 'KeyD':
        e.preventDefault();
        this.nudge(1);
        return;
      case 'Enter':
      case 'Space':
        e.preventDefault();
        this.activate();
        return;
      default:
    }
  }

  private rowCount(): number {
    if (this.page === 'main') return 4;
    if (this.page === 'settings') return 5;
    return 1;
  }

  private goto(p: Page): void {
    this.page = p;
    this.selected = 0;
    this.render();
  }

  private activate(): void {
    if (this.page === 'main') {
      if (this.selected === 0) this.close();
      else if (this.selected === 1) this.saveNow();
      else if (this.selected === 2) this.goto('settings');
      else this.goto('controls');
      return;
    }
    if (this.page === 'settings') {
      if (this.selected === 3) {
        this.ctx.input.invertY = !this.ctx.input.invertY;
        this.persist();
        this.render();
      } else if (this.selected === 4) {
        this.goto('main');
      }
      return;
    }
    this.goto('main');
  }

  /** Left/right on the selected settings row. */
  private nudge(dir: number): void {
    if (this.page !== 'settings') return;
    switch (this.selected) {
      case 0: {
        const i = QUALITIES.indexOf(this.quality);
        this.setQuality(QUALITIES[clamp(i + dir, 0, QUALITIES.length - 1)]);
        break;
      }
      case 1:
        this.setMasterVolume(this.masterVolume + dir * 0.05);
        break;
      case 2:
        this.ctx.input.lookSensitivity = clamp(
          this.ctx.input.lookSensitivity + dir * 0.0003, 0.0004, 0.0075,
        );
        break;
      case 3:
        this.ctx.input.invertY = dir > 0;
        break;
      default:
        return;
    }
    this.persist();
    this.render();
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  private render(): void {
    this.crumbEl.textContent = t(
      this.page === 'main' ? 'MENIU' : this.page === 'settings' ? 'MENIU / SETĂRI' : 'MENIU / COMENZI',
    );
    this.paintChrome();

    if (this.page === 'main') this.bodyEl.innerHTML = this.mainHtml();
    else if (this.page === 'settings') this.bodyEl.innerHTML = this.settingsHtml();
    else this.bodyEl.innerHTML = this.controlsHtml();

    this.bodyEl.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
      const i = Number(el.dataset.row);
      el.addEventListener('mouseenter', () => {
        this.selected = i;
        this.syncSelection();
      });
      el.addEventListener('click', (ev) => {
        const hit = ev.target as HTMLElement;
        this.selected = i;
        const step = hit.dataset.step;
        if (step) this.nudgeRow(i, Number(step));
        else this.activate();
      });
    });

    this.bodyEl.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((el) => {
      el.addEventListener('input', () => {
        const i = Number(el.dataset.rowInput);
        this.selected = i;
        if (i === 1) this.setMasterVolume(Number(el.value) / 100);
        if (i === 2) this.ctx.input.lookSensitivity = Number(el.value) / 1e6;
        this.persist();
        this.refreshValues();
      });
    });

    this.syncSelection();
  }

  private nudgeRow(row: number, dir: number): void {
    this.selected = row;
    this.nudge(dir);
  }

  private syncSelection(): void {
    this.bodyEl.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
      el.classList.toggle('is-sel', Number(el.dataset.row) === this.selected);
    });
  }

  private refreshValues(): void {
    const v = this.bodyEl.querySelector<HTMLElement>('[data-val="vol"]');
    if (v) v.textContent = `${Math.round(this.masterVolume * 100)}%`;
    const s = this.bodyEl.querySelector<HTMLElement>('[data-val="sens"]');
    if (s) s.textContent = sensLabel(this.ctx.input.lookSensitivity);
  }

  private mainHtml(): string {
    const items = [
      [t('REIA JOCUL'), t('înapoi în București')],
      [t('SALVEAZĂ'), this.saveLabel()],
      [t('SETĂRI'), t('imagine, sunet, mouse')],
      [t('COMENZI'), t('toate tastele')],
    ];
    return `<div class="pm-list">${items
      .map(
        ([t, s], i) => `<button class="pm-item${i === 1 && this.saveFlash > 0 ? ' pm-ok' : ''}" data-row="${i}">
            <span class="pm-item-t">${t}</span><span class="pm-item-s">${s}</span>
          </button>`,
      )
      .join('')}</div>`;
  }

  private settingsHtml(): string {
    const q = this.quality;
    const seg = QUALITIES.map(
      (k) => `<span class="pm-seg${k === q ? ' on' : ''}" data-step="${QUALITIES.indexOf(k) - QUALITIES.indexOf(q)}">${t(QUALITY_LABELS[k])}</span>`,
    ).join('');
    const vol = Math.round(this.masterVolume * 100);
    const sens = Math.round(this.ctx.input.lookSensitivity * 1e6);
    const inv = this.ctx.input.invertY;
    return `<div class="pm-list">
      <div class="pm-row" data-row="0">
        <span class="pm-lab">${t('Calitate imagine')}</span>
        <span class="pm-ctl pm-segs">${seg}</span>
      </div>
      <div class="pm-row" data-row="1">
        <span class="pm-lab">${t('Volum principal')}</span>
        <span class="pm-ctl"><input type="range" min="0" max="100" step="1" value="${vol}" data-row-input="1"><b data-val="vol">${vol}%</b></span>
      </div>
      <div class="pm-row" data-row="2">
        <span class="pm-lab">${t('Sensibilitate mouse')}</span>
        <span class="pm-ctl"><input type="range" min="400" max="7500" step="50" value="${sens}" data-row-input="2"><b data-val="sens">${sensLabel(this.ctx.input.lookSensitivity)}</b></span>
      </div>
      <div class="pm-row" data-row="3">
        <span class="pm-lab">${t('Inversează axa Y')}</span>
        <span class="pm-ctl pm-segs"><span class="pm-seg${inv ? '' : ' on'}" data-step="-1">${t('NU')}</span><span class="pm-seg${inv ? ' on' : ''}" data-step="1">${t('DA')}</span></span>
      </div>
      <button class="pm-item pm-back" data-row="4"><span class="pm-item-t">${t('ÎNAPOI')}</span></button>
    </div>`;
  }

  private controlsHtml(): string {
    const rows = this.readBindings();
    const cells = rows
      .map(
        (r) => `<div class="pm-key">
            <span class="pm-key-k">${r.keys.map((k) => `<kbd>${k}</kbd>`).join('')}</span>
            <span class="pm-key-l">${r.label}</span>
          </div>`,
      )
      .join('');
    return `<div class="pm-keys">${cells}</div>
      <div class="pm-note">${t('Citite direct din harta de input a jocului — nu dintr-o listă scrisă de mână.')}</div>
      <button class="pm-item pm-back" data-row="0"><span class="pm-item-t">${t('ÎNAPOI')}</span></button>`;
  }

  /* ---------------------------------------------------------------- */
  /* Binding discovery                                                 */
  /* ---------------------------------------------------------------- */

  private readBindings(): BindingRow[] {
    if (this.bindings) return this.bindings;
    const input = this.ctx.input;
    const wasEnabled = input.enabled;
    this.probing = true;
    input.enabled = true;

    const byAction = new Map<ActionName, string[]>();
    const byMove = new Map<string, string[]>();
    let handbrakeKeys: string[] = [];

    // Whatever is already "held" (a stuck key, the debug harness's forced
    // actions) must not be attributed to every key we try.
    const baseline = new Set<ActionName>(ALL_ACTIONS.filter((a) => input.action(a)));
    const baseHandbrake = input.handbrake;

    const record = (code: string): void => {
      for (const a of ALL_ACTIONS) {
        if (baseline.has(a)) continue;
        if (!input.action(a)) continue;
        const list = byAction.get(a) ?? [];
        if (!list.includes(code)) list.push(code);
        byAction.set(a, list);
      }
      if (!baseHandbrake && input.handbrake && !handbrakeKeys.includes(code)) {
        handbrakeKeys = [...handbrakeKeys, code];
      }
    };

    for (const code of PROBE_KEYS) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      record(code);
      // Movement is resolved inside Input.update(), not through the action map.
      input.update();
      const { moveX, moveY } = input.axes;
      if (moveY > 0.5) pushKey(byMove, 'forward', code);
      else if (moveY < -0.5) pushKey(byMove, 'back', code);
      if (moveX > 0.5) pushKey(byMove, 'right', code);
      else if (moveX < -0.5) pushKey(byMove, 'left', code);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    }

    for (const button of [0, 1, 2]) {
      window.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
      record(`Mouse${button}`);
      window.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
    }

    // Leave the axes as we found them.
    input.update();
    input.enabled = wasEnabled;
    this.probing = false;

    const out: BindingRow[] = [];
    const move = (id: string, label: string): void => {
      const keys = byMove.get(id);
      if (keys?.length) out.push({ label: t(label), keys: keys.map(glyph) });
    };
    move('forward', 'Înainte');
    move('back', 'Înapoi');
    move('left', 'Stânga');
    move('right', 'Dreapta');
    out.push({ label: t('Privește'), keys: ['MOUSE'] });

    for (const a of ALL_ACTIONS) {
      const label = ACTION_LABELS[a];
      if (!label) continue;
      const keys = byAction.get(a);
      if (!keys?.length) continue;
      if (a === 'handbrake' && handbrakeKeys.length) continue;
      out.push({ label: t(label), keys: keys.map(glyph) });
    }
    if (handbrakeKeys.length) {
      out.push({ label: t(ACTION_LABELS.handbrake ?? 'Frână de mână'), keys: handbrakeKeys.map(glyph) });
    }

    this.bindings = out;
    return out;
  }
}

function pushKey(map: Map<string, string[]>, id: string, code: string): void {
  const list = map.get(id) ?? [];
  if (!list.includes(code)) list.push(code);
  map.set(id, list);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function sensLabel(s: number): string {
  return (s * 1000).toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Markup + style                                                      */
/* ------------------------------------------------------------------ */

const TEMPLATE = `
<style>
  .gta-pause {
    position:absolute; inset:0; pointer-events:auto; z-index:40;
    font-family:Inter,system-ui,sans-serif; color:#f6e8ff;
    background:
      radial-gradient(ellipse at 50% 40%, rgba(94,26,120,.55) 0%, rgba(14,6,26,.86) 55%, rgba(6,3,12,.95) 100%);
    backdrop-filter:blur(7px) saturate(1.15);
    display:grid; place-items:center; overflow:hidden;
  }
  .gta-pause::before {
    content:''; position:absolute; inset:-10%;
    background:repeating-linear-gradient(0deg, rgba(255,61,127,.10) 0 1px, transparent 1px 3px);
    mix-blend-mode:screen; pointer-events:none; animation:pm-roll 7s linear infinite;
  }
  .gta-pause::after {
    content:''; position:absolute; left:0; right:0; height:120px;
    background:linear-gradient(180deg, transparent, rgba(255,61,127,.10), transparent);
    pointer-events:none; animation:pm-band 5.5s linear infinite;
  }
  @keyframes pm-roll { to { transform:translateY(3px); } }
  @keyframes pm-band { 0% { top:-20%; } 100% { top:110%; } }

  .gta-pause .pm-panel {
    position:relative; width:min(760px, 88vw); max-height:86vh; overflow:auto;
    padding:30px 34px 24px; background:linear-gradient(180deg, rgba(24,9,40,.92), rgba(11,5,20,.94));
    border:1px solid rgba(255,61,127,.32);
    box-shadow:0 0 0 1px rgba(162,92,255,.16), 0 30px 90px rgba(0,0,0,.7), inset 0 0 80px rgba(123,63,212,.14);
    clip-path:polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px));
    transform:translateY(10px); opacity:0; transition:transform .18s ease, opacity .18s ease;
  }
  .gta-pause.pm-in .pm-panel { transform:none; opacity:1; }
  .gta-pause .pm-eyebrow { font-size:10px; letter-spacing:.42em; color:#ff9c3f; font-weight:700; }
  .gta-pause .pm-title {
    margin:6px 0 2px; font-size:clamp(32px,5.6vw,58px); font-weight:800; letter-spacing:.08em; line-height:1;
    background:linear-gradient(180deg,#ffd9a0 0%,#ff7ac2 55%,#a25cff 100%);
    -webkit-background-clip:text; background-clip:text; color:transparent;
    position:relative; --pm-jit:0px;
  }
  .gta-pause .pm-title::after {
    content:attr(data-text); position:absolute; left:var(--pm-jit); top:0;
    color:#00e5ff; mix-blend-mode:screen; opacity:.35; -webkit-text-fill-color:#00e5ff;
  }
  .gta-pause .pm-crumb { font-size:10px; letter-spacing:.34em; color:#b48ede; margin-bottom:18px; }
  .gta-pause .pm-rule { height:1px; background:linear-gradient(90deg,#ff3d7f,#a25cff,transparent); margin:0 0 18px; }

  .gta-pause .pm-list { display:flex; flex-direction:column; gap:6px; }
  .gta-pause .pm-item, .gta-pause .pm-row {
    display:flex; align-items:center; gap:16px; width:100%; text-align:left;
    padding:13px 16px; background:rgba(255,255,255,.028); border:0;
    border-left:3px solid transparent; color:inherit; font:inherit; cursor:pointer;
    transition:background .12s, border-color .12s, transform .12s;
  }
  .gta-pause .pm-item-t { font-size:17px; font-weight:800; letter-spacing:.13em; }
  .gta-pause .pm-item-s { font-size:11px; letter-spacing:.16em; color:#9d86bb; margin-left:auto; }
  .gta-pause .pm-lab { font-size:13px; letter-spacing:.09em; font-weight:600; min-width:190px; }
  .gta-pause .pm-ctl { display:flex; align-items:center; gap:12px; margin-left:auto; }
  .gta-pause .pm-ctl b { font-size:12px; letter-spacing:.1em; color:#ffb454; min-width:46px; text-align:right; }
  .gta-pause .is-sel {
    background:linear-gradient(90deg, rgba(255,61,127,.22), rgba(123,63,212,.10) 60%, transparent);
    border-left-color:#ff3d7f; transform:translateX(3px);
  }
  .gta-pause .pm-back { margin-top:12px; }
  .gta-pause .pm-ok .pm-item-s { color:#4ad6a0; }
  .gta-pause .pm-ok { border-left-color:#4ad6a0; }

  .gta-pause .pm-segs { display:flex; gap:4px; }
  .gta-pause .pm-seg {
    padding:6px 11px; font-size:10.5px; letter-spacing:.16em; font-weight:700;
    background:rgba(255,255,255,.05); color:#c3ade0; border:1px solid transparent;
  }
  .gta-pause .pm-seg.on { background:#ff3d7f; color:#180520; border-color:#ff9ec4; }

  .gta-pause input[type=range] {
    -webkit-appearance:none; appearance:none; width:190px; height:3px; background:#3d2359; outline:none;
  }
  .gta-pause input[type=range]::-webkit-slider-thumb {
    -webkit-appearance:none; width:13px; height:17px; background:#ff3d7f; cursor:pointer;
    box-shadow:0 0 10px rgba(255,61,127,.8);
  }
  .gta-pause input[type=range]::-moz-range-thumb {
    width:13px; height:17px; border:0; background:#ff3d7f; cursor:pointer;
  }

  .gta-pause .pm-keys {
    display:grid; grid-template-columns:repeat(auto-fill, minmax(320px,1fr)); gap:2px 22px;
  }
  .gta-pause .pm-key { display:flex; align-items:center; gap:12px; padding:7px 4px; border-bottom:1px solid rgba(255,255,255,.05); }
  .gta-pause .pm-key-k { display:flex; gap:4px; min-width:132px; }
  .gta-pause .pm-key-l { font-size:12.5px; color:#d9c8ee; }
  .gta-pause kbd {
    font:700 10px/1 ui-monospace,monospace; letter-spacing:.08em; padding:6px 7px;
    background:rgba(162,92,255,.16); border:1px solid rgba(255,61,127,.35); color:#ffd9f0;
  }
  .gta-pause .pm-note { margin-top:14px; font-size:10.5px; letter-spacing:.12em; color:#8b76a8; }
  .gta-pause .pm-foot { margin-top:20px; font-size:10px; letter-spacing:.26em; color:#7f6b9c; }
</style>
<div class="pm-panel">
  <div class="pm-eyebrow">B★ BUILDERSTAR GAMES — TRANSMISIUNE ÎNTRERUPTĂ</div>
  <h1 class="pm-title" data-text="PAUZĂ">PAUZĂ</h1>
  <div class="pm-crumb">MENIU</div>
  <div class="pm-rule"></div>
  <div class="pm-body"></div>
  <div class="pm-foot">ESC ÎNAPOI · ↑ ↓ NAVIGARE · ← → MODIFICĂ · ENTER SELECTEAZĂ</div>
</div>`;
