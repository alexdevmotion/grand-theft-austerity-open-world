/**
 * THE FRONT-END — studio sting, panelled loading screen, title screen, main
 * menu and its pages. Everything the player sees before București does.
 *
 * SHAPE OF THE BOOT SEQUENCE
 * --------------------------
 *   install()   at module load, before `createGame()` runs. The overlay must be
 *               on screen for the *whole* load, and `MenuSystem.init` only runs
 *               at order 430 — i.e. after the city, the traffic and the peds
 *               have already been built. So the DOM is mounted here and the
 *               system attaches to it later.
 *   attach()    from `MenuSystem.init`: freezes the world, takes the keyboard
 *               off gameplay, hides the HUD, and wires the pages to the real
 *               services.
 *   startGame() the hand-off: curtain down, world unpaused, HUD back, overlay
 *               removed. From then on the front-end costs nothing — the root is
 *               `display:none` and its own rAF is cancelled.
 *
 * HOW IT COOPERATES WITH index.html
 * ---------------------------------
 * `index.html` owns `#boot`, and `main.ts` drives it from
 * `createGame(onProgress)`. Neither file is mine to edit, and neither needs to
 * change: `#boot` sits at z-index 100 and this overlay at 150, so the plain boot
 * card is simply behind the good one. Real progress is read off it with a
 * MutationObserver — the bar's inline width is the percentage, the status line
 * is the Romanian copy `main.ts` already writes, and the `hidden` class landing
 * on `#boot` is the signal that every system finished initialising.
 *
 * WHY IT IS SKIPPED UNDER AUTOMATION
 * ----------------------------------
 * `tools/shot.mjs` and every verification agent drive `__GTA_DEBUG__` and
 * screenshot the world. A title screen would cover every one of those captures.
 * So the front-end stands down when `navigator.webdriver` is set (that is true
 * in the headless Chrome the harness uses and false in a real browser), and
 * `?menu=1` forces it back on so the front-end itself can be verified.
 * `?nomenu` / `?menu=0` turns it off explicitly.
 */

import type { GameContext } from '../../core/engine';
import { Services } from '../../core/services';
import artUrl from '../../../docs/reference/house-under-siege-duo.png';
import { FRONT_END_CSS } from './style';
import {
  LANGUAGES,
  LANG_LABELS,
  lang,
  setLang,
  t,
  tp,
  type Lang,
} from '../../core/i18n';
import { studioMark } from './mark';
import {
  LOAD_PANELS,
  MENU_ITEMS,
  MOBILE_NOTICE,
  PANEL_SECONDS,
  CREDITS,
  GROUP_ORDER_NOTE,
  LAUNCH_HINTS,
  LAUNCH_HINTS_TITLE,
  menuItemEnabled,
  panelAt,
  showsWalkthrough,
  stepSelection,
  type MenuId,
} from './panels';
import {
  GROUP_TITLES,
  hintRows,
  readBindings,
  type BindGroup,
  type BindingGroups,
  type HintRow,
} from './bindings';
import {
  QUALITIES,
  QUALITY_LABELS,
  SENS_MAX,
  SENS_MIN,
  Settings,
  clamp,
  clamp01,
  sensLabel,
  stepQuality,
  type Quality,
} from './settings';
import {
  describeSession,
  emptySession,
  isResumable,
  loadSession,
  saveSession,
  type SessionRecord,
} from './session';

type Phase = 'sting' | 'load' | 'title' | 'ingame';
type Page = 'main' | 'controls' | 'audio' | 'language' | 'credits';

/** Seconds the studio sting plays before the loading screen takes over. */
const STING_SECONDS = 4.0;
/** Minimum time the loading panels stay up, so panel 01 can be read. */
const LOAD_MIN_SECONDS = 2.6;
const LOAD_MIN_SECONDS_FAST = 1.8;
/** Progress never shows 100% until the loader really says it is done. */
const PROGRESS_CAP = 96;

export class FrontEnd {
  private root!: HTMLDivElement;
  private ctx: GameContext | null = null;
  private settings: Settings | null = null;

  private phase: Phase = 'sting';
  private page: Page = 'main';
  private phaseT = 0;
  private raf = 0;
  private lastNow = 0;

  /** Raised around the synthetic events the controls probe fires. */
  probing = false;

  private targetPct = 0;
  private shownPct = 0;
  private loadComplete = false;
  private completeAtLoadStart = false;
  private statusText = '';
  private panelIndex = -1;

  private selected = 0;
  private pageRow = 0;
  private bindings: BindingGroups | null = null;
  private session: SessionRecord | null = null;
  private playSeconds = 0;
  private saveTimer = 0;
  private starting = false;
  private launchPct = 0;
  /** Latched at START, before the save slot is cleared. */
  private firstRun = false;
  /** Verification only: hold the current phase instead of advancing. */
  private frozen = false;
  /** Phones / coarse-pointer devices: START and CONTINUE stay locked. */
  private mobile = false;

  private els!: {
    sting: HTMLElement;
    load: HTMLElement;
    title: HTMLElement;
    loadCopy: HTMLElement;
    loadChip: HTMLElement;
    loadHead: HTMLElement;
    loadBody: HTMLElement;
    status: HTMLElement;
    bar: HTMLElement;
    pct: HTMLElement;
    items: HTMLElement[];
    mobileNotice: HTMLElement;
    pageTitle: HTMLElement;
    pageCrumb: HTMLElement;
    pageBody: HTMLElement;
    pageFoot: HTMLElement;
    launchStatus: HTMLElement;
    launchBar: HTMLElement;
    launchPct: HTMLElement;
    launchKeys: HTMLElement;
  };

  private disposers: Array<() => void> = [];

  /* ---------------------------------------------------------------- */
  /* Mounting                                                         */
  /* ---------------------------------------------------------------- */

  install(): void {
    const style = document.createElement('style');
    style.textContent = FRONT_END_CSS;
    document.head.appendChild(style);

    this.mobile = isMobileClient();
    this.root = document.createElement('div');
    this.root.className = 'gta-fe';
    if (this.mobile) this.root.classList.add('is-mobile');
    this.root.style.setProperty('--fe-art', `url(${artUrl})`);
    this.root.innerHTML = this.template();
    document.body.appendChild(this.root);

    const q = <T extends HTMLElement>(sel: string): T => this.root.querySelector<T>(sel)!;
    this.els = {
      sting: q('.fe-sting'),
      load: q('.fe-load'),
      title: q('.fe-title'),
      loadCopy: q('.fe-load-copy'),
      loadChip: q('.fe-load-chip'),
      loadHead: q('.fe-load-head'),
      loadBody: q('.fe-load-body'),
      status: q('.fe-load-status'),
      bar: q('.fe-bar i'),
      pct: q('.fe-load-pct'),
      items: Array.from(this.root.querySelectorAll<HTMLElement>('.fe-item')),
      mobileNotice: q('.fe-mobile-notice'),
      pageTitle: q('.fe-page-title'),
      pageCrumb: q('.fe-page-crumb'),
      pageBody: q('.fe-page-body'),
      pageFoot: q('.fe-page-foot'),
      launchStatus: q('.fe-launch-status'),
      launchBar: q('.fe-launch-bar i'),
      launchPct: q('.fe-launch-pct'),
      launchKeys: q('.fe-launch-keys'),
    };

    this.els.mobileNotice.hidden = !this.mobile;
    this.paintStaticCopy();
    this.session = loadSession();
    this.setPanel(0);
    this.bindMenuMouse();
    this.observeBoot();

    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    window.addEventListener('keydown', onKey, true);
    this.disposers.push(() => window.removeEventListener('keydown', onKey, true));

    const onClick = (e: MouseEvent) => {
      if (this.phase === 'sting' && e.isTrusted) this.skipSting();
    };
    this.root.addEventListener('mousedown', onClick);

    // Phase 1 begins the moment the page paints.
    this.els.sting.classList.add('fe-on');
    this.lastNow = performance.now();
    this.tick(this.lastNow);

    this.installDebugHook();
  }

  /** Wire the pages to the live services and freeze the world. */
  attach(ctx: GameContext): void {
    this.ctx = ctx;
    this.settings = new Settings(ctx);
    if (this.phase !== 'ingame') {
      ctx.time.paused = true;
      ctx.input.enabled = false;
      ctx.tryGet(Services.Hud)?.setVisible(false);
    }
    this.syncMenu();
    // A page opened before the services existed (only reachable from the
    // verification hook) would be stuck on its placeholder — rebuild it now
    // that the real input map and settings are available.
    if (this.page !== 'main') this.openPage(this.page);
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                            */
  /* ---------------------------------------------------------------- */

  private tick = (now: number): void => {
    const dt = Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.update(dt);
    if (this.phase !== 'ingame') this.raf = requestAnimationFrame(this.tick);
  };

  private update(dt: number): void {
    this.phaseT += dt;

    if (this.phase === 'sting') {
      if (!this.frozen && this.phaseT >= STING_SECONDS) this.goLoad();
      return;
    }

    if (this.phase === 'load') {
      const target = this.loadComplete ? 100 : Math.min(this.targetPct, PROGRESS_CAP);
      // Ease toward the real number: a bar that jumps between systems reads as
      // a fake bar, and a bar that never quite fills reads as a hung load.
      this.shownPct += (target - this.shownPct) * Math.min(1, dt * (this.loadComplete ? 5.5 : 2.6));
      if (this.loadComplete && target - this.shownPct < 0.4) this.shownPct = target;
      this.paintProgress();

      const i = panelAt(this.phaseT);
      if (i !== this.panelIndex) this.setPanel(i);

      const minHold = this.completeAtLoadStart ? LOAD_MIN_SECONDS_FAST : LOAD_MIN_SECONDS;
      if (!this.frozen && this.loadComplete && this.phaseT >= minHold && this.shownPct >= 99.5) this.goTitle();
      return;
    }

    if (this.phase === 'title') {
      if (this.page === 'credits') {
        const body = this.els.pageBody;
        const max = body.scrollHeight - body.clientHeight;
        if (max > 4) {
          body.scrollTop = body.scrollTop + dt * 26 >= max ? 0 : body.scrollTop + dt * 26;
        }
      }
      return;
    }
  }

  /** Called by `MenuSystem.update` once the game is running, to keep the save. */
  updateInGame(dt: number): void {
    if (this.phase !== 'ingame' || !this.ctx) return;
    this.playSeconds += dt;
    this.saveTimer += dt;
    if (this.saveTimer < 5) return;
    this.saveTimer = 0;
    this.writeSession();
  }

  /**
   * The poller. It used to *build* the record here out of whatever the seam
   * would tell it — act id, act title, level, lei — and that was the whole save
   * system. `Services.Save` owns the record now (`src/core/save.ts`), including
   * XP, unlocks, discovered landmarks, position, heading, time of day and
   * weather. This keeps the front-end's own copy fresh so the CONTINUE row can
   * describe the slot without touching storage on every frame.
   */
  private writeSession(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const save = ctx.tryGet(Services.Save);
    if (!save) return;
    this.session = save.save('front-end');
  }

  /* ---------------------------------------------------------------- */
  /* Phase transitions                                               */
  /* ---------------------------------------------------------------- */

  private skipSting(): void {
    if (this.phase !== 'sting') return;
    this.goLoad();
  }

  private goLoad(): void {
    this.phase = 'load';
    this.phaseT = 0;
    this.completeAtLoadStart = this.loadComplete;
    this.els.sting.classList.remove('fe-on');
    this.els.load.classList.add('fe-on');
    this.setPanel(0);
  }

  private goTitle(): void {
    this.phase = 'title';
    this.phaseT = 0;
    this.page = 'main';
    this.els.load.classList.remove('fe-on');
    this.els.title.classList.add('fe-on');
    const flags = this.enabledFlags();
    const prefer = this.canContinue() ? 1 : 0;
    this.selected = flags[prefer] ? prefer : stepSelection(prefer, 1, flags);
    this.syncMenu();
  }

  /* ---------------------------------------------------------------- */
  /* Loading screen                                                   */
  /* ---------------------------------------------------------------- */

  private observeBoot(): void {
    const boot = document.getElementById('boot');
    const fill = document.getElementById('boot-fill');
    const status = document.getElementById('boot-status');
    if (!boot || !fill || !status) {
      // No boot card to read (a test page, a future index.html). Fall back to a
      // slow crawl so the bar is never dead, and let `attach()` finish it.
      this.targetPct = 90;
      return;
    }

    const readFill = () => {
      const w = parseFloat((fill as HTMLElement).style.width);
      if (Number.isFinite(w)) this.targetPct = clamp(w, 0, 100);
    };
    const readStatus = () => {
      const s = (status.textContent ?? '').trim();
      if (s) this.statusText = s;
    };
    const readDone = () => {
      if (boot.classList.contains('hidden')) this.loadComplete = true;
    };
    readFill();
    readStatus();

    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.target === fill) readFill();
        else if (r.target === boot) readDone();
        else readStatus();
      }
      this.paintProgress();
    });
    obs.observe(fill, { attributes: true, attributeFilter: ['style'] });
    obs.observe(boot, { attributes: true, attributeFilter: ['class'] });
    obs.observe(status, { childList: true, characterData: true, subtree: true });
    this.disposers.push(() => obs.disconnect());
  }

  private paintProgress(): void {
    const pct = this.loadComplete ? Math.max(this.shownPct, 0) : Math.min(this.shownPct, PROGRESS_CAP);
    this.els.bar.style.width = `${pct.toFixed(1)}%`;
    this.els.pct.textContent = `${Math.round(pct)}%`;
    const line = this.loadComplete
      ? t('GATA — BUCUREȘTI ONLINE')
      : t(this.statusText || LOAD_PANELS[Math.max(0, this.panelIndex)]?.status || 'SE ÎNCARCĂ BUCUREȘTIUL');
    if (this.els.status.dataset.line !== line) {
      this.els.status.dataset.line = line;
      this.els.status.textContent = line;
    }
  }

  private setPanel(i: number): void {
    const p = LOAD_PANELS[clamp(i, 0, LOAD_PANELS.length - 1)];
    if (!p) return;
    this.panelIndex = i;
    this.els.loadChip.textContent = `${p.index} / 0${LOAD_PANELS.length} — ${p.act}`;
    this.els.loadHead.innerHTML = p.headline;
    this.els.loadBody.textContent = t(p.body);
    // Restart the crossfade: reflow between remove and add or the class never
    // re-triggers the animation.
    this.els.loadCopy.classList.remove('fe-swap');
    void this.els.loadCopy.offsetWidth;
    this.els.loadCopy.classList.add('fe-swap');
  }

  /* ---------------------------------------------------------------- */
  /* Menu                                                             */
  /* ---------------------------------------------------------------- */

  private canContinue(): boolean {
    return isResumable(this.session);
  }

  private enabledFlags(): boolean[] {
    return MENU_ITEMS.map((m) =>
      menuItemEnabled(m.id, { canContinue: this.canContinue(), mobile: this.mobile }),
    );
  }

  private bindMenuMouse(): void {
    this.els.items.forEach((el, i) => {
      el.addEventListener('mouseenter', () => {
        if (this.phase !== 'title') return;
        this.selected = i;
        this.syncMenu();
      });
      el.addEventListener('click', () => {
        if (this.phase !== 'title') return;
        this.selected = i;
        this.syncMenu();
        this.activate();
      });
    });
  }

  private syncMenu(): void {
    const flags = this.enabledFlags();
    this.els.items.forEach((el, i) => {
      el.classList.toggle('is-sel', i === this.selected);
      el.classList.toggle('is-off', !flags[i]);
      const item = MENU_ITEMS[i];
      const sub = el.querySelector('.fe-item-sub');
      if (!sub || !item) return;
      if (item.id === 'continue') {
        sub.textContent = this.mobile ? MOBILE_NOTICE.kicker : describeSession(this.session);
      } else if (item.id === 'start' && this.mobile) {
        sub.textContent = MOBILE_NOTICE.kicker;
      } else {
        sub.textContent = t(item.sub);
      }
    });
  }

  private move(dir: number): void {
    this.selected = stepSelection(this.selected, dir, this.enabledFlags());
    this.syncMenu();
  }

  private activate(): void {
    const item = MENU_ITEMS[this.selected];
    if (!item) return;
    if (!menuItemEnabled(item.id, { canContinue: this.canContinue(), mobile: this.mobile })) {
      return;
    }
    switch (item.id) {
      case 'start':
        this.startGame('new');
        return;
      case 'continue':
        this.startGame('continue');
        return;
      case 'controls':
        this.openPage('controls');
        return;
      case 'audio':
        this.openPage('audio');
        return;
      case 'language':
        this.openPage('language');
        return;
      case 'credits':
        this.openPage('credits');
        return;
      default:
        return;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pages                                                            */
  /* ---------------------------------------------------------------- */

  private openPage(p: Page): void {
    this.page = p;
    this.pageRow = 0;
    this.els.title.classList.toggle('has-page', p !== 'main');
    if (p === 'main') return;

    const back = t(this.mobile ? 'TAP ÎNAPOI' : 'ESC ÎNAPOI');
    const meta: Record<Exclude<Page, 'main'>, { title: string; crumb: string; foot: string }> = {
      controls: {
        title: t('COMENZI'),
        crumb: t('MENIU / COMENZI'),
        foot: back,
      },
      audio: {
        title: t('SUNET ȘI IMAGINE'),
        crumb: t('MENIU / SETTINGS'),
        foot: this.mobile ? tp('TAP RÂND · {back}', { back }) : t('↑ ↓ RÂND · ← → MODIFICĂ · ESC ÎNAPOI'),
      },
      language: {
        title: 'LANGUAGE',
        crumb: t('MENIU / LIMBĂ'),
        foot: this.mobile ? tp('TAP RÂND · {back}', { back }) : t('↑ ↓ RÂND · ENTER ALEGE · ESC ÎNAPOI'),
      },
      credits: {
        title: t('CREDITS'),
        crumb: t('MENIU / CREDITS'),
        foot: back,
      },
    };
    const m = meta[p];
    this.els.pageTitle.textContent = m.title;
    this.els.pageCrumb.textContent = m.crumb;
    this.els.pageFoot.textContent = m.foot;

    if (p === 'controls') this.els.pageBody.innerHTML = this.controlsHtml();
    else if (p === 'audio') this.els.pageBody.innerHTML = this.audioHtml();
    else if (p === 'language') this.els.pageBody.innerHTML = this.languageHtml();
    else this.els.pageBody.innerHTML = this.creditsHtml();

    this.els.pageBody.scrollTop = 0;
    this.bindPageMouse();
    this.bindPageFoot();
    this.syncPageRows();
  }

  private closePage(): void {
    this.page = 'main';
    this.els.title.classList.remove('has-page');
    this.syncMenu();
  }

  private pageRowCount(): number {
    if (this.page === 'audio') return 5;
    // One row per language, plus BACK.
    if (this.page === 'language') return LANGUAGES.length + 1;
    if (this.page === 'controls' || this.page === 'credits') return 1;
    return 0;
  }

  private bindPageFoot(): void {
    const foot = this.els.pageFoot;
    foot.style.cursor = this.mobile ? 'pointer' : '';
    foot.onclick = this.mobile
      ? () => {
          if (this.page !== 'main') this.closePage();
        }
      : null;
  }

  private bindPageMouse(): void {
    this.els.pageBody.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
      const i = Number(el.dataset.row);
      el.addEventListener('mouseenter', () => {
        this.pageRow = i;
        this.syncPageRows();
      });
      el.addEventListener('click', (ev) => {
        this.pageRow = i;
        const step = (ev.target as HTMLElement).dataset.step;
        const jump = (ev.target as HTMLElement).dataset.set;
        if (jump !== undefined) this.setRow(i, Number(jump));
        else if (step !== undefined) this.nudge(Number(step));
        else this.activateRow();
        this.syncPageRows();
      });
    });
  }

  private syncPageRows(): void {
    this.els.pageBody.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
      el.classList.toggle('is-sel', Number(el.dataset.row) === this.pageRow);
    });
  }

  private controlsHtml(): string {
    const ctx = this.ctx;
    if (!ctx) return `<p class="fe-note">${t('Comenzile apar după ce jocul termină de încărcat.')}</p>`;
    this.bindings ??= readBindings(ctx.input, this);
    const order: BindGroup[] = ['foot', 'vehicle', 'system'];
    const groups = order
      .map((g) => {
        const rows = this.bindings![g];
        if (!rows.length) return '';
        const cells = rows
          .map(
            (r) => `<div class="fe-key">
              <span class="fe-key-k">${r.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}</span>
              <span class="fe-key-l">${escapeHtml(r.label)}</span>
            </div>`,
          )
          .join('');
        return `<div class="fe-group"><h4>${t(GROUP_TITLES[g])}</h4><div class="fe-keys">${cells}</div></div>`;
      })
      .join('');
    return `${groups}
      <p class="fe-note">${t(GROUP_ORDER_NOTE)}</p>
      <div class="fe-row" data-row="0"><span class="fe-row-t">${t('ÎNAPOI')}</span></div>`;
  }

  private audioHtml(): string {
    const s = this.settings;
    if (!s) return `<p class="fe-note">${t('Setările apar după ce jocul termină de încărcat.')}</p>`;
    const vol = Math.round(s.masterVolume * 100);
    const q = s.quality;
    const sens = s.lookSensitivity;
    const inv = s.invertY;
    const segs = QUALITIES.map(
      (k) =>
        `<span class="fe-seg${k === q ? ' on' : ''}" data-set="${QUALITIES.indexOf(k)}">${t(QUALITY_LABELS[k])}</span>`,
    ).join('');
    return `
      <div class="fe-row" data-row="0">
        <span class="fe-row-lab">${t('Volum principal')}</span>
        <span class="fe-row-ctl">
          <span class="fe-meter" data-meter="vol"><i style="width:${vol}%"></i><s style="left:${vol}%"></s></span>
          <b data-val="vol">${vol}%</b>
        </span>
      </div>
      <div class="fe-row" data-row="1">
        <span class="fe-row-lab">${t('Calitate imagine')}</span>
        <span class="fe-row-ctl fe-segs" data-segs="quality">${segs}</span>
      </div>
      <div class="fe-row" data-row="2">
        <span class="fe-row-lab">${t('Sensibilitate mouse')}</span>
        <span class="fe-row-ctl">
          <span class="fe-meter" data-meter="sens"><i style="width:${sensPct(sens)}%"></i><s style="left:${sensPct(sens)}%"></s></span>
          <b data-val="sens">${sensLabel(sens)}</b>
        </span>
      </div>
      <div class="fe-row" data-row="3">
        <span class="fe-row-lab">${t('Inversează axa Y')}</span>
        <span class="fe-row-ctl fe-segs" data-segs="invert">
          <span class="fe-seg${inv ? '' : ' on'}" data-set="0">${t('NU')}</span>
          <span class="fe-seg${inv ? ' on' : ''}" data-set="1">${t('DA')}</span>
        </span>
      </div>
      <div class="fe-row" data-row="4"><span class="fe-row-t">${t('ÎNAPOI')}</span></div>
      <p class="fe-note">${t(
        'Volumul merge în mixerul jocului, calitatea reconstruiește lanțul de post-procesare, iar ' +
          'sensibilitatea și axa Y sunt cele pe care le citește camera. Aceleași setări apar și în meniul de pauză.',
      )}</p>`;
  }

  /**
   * THE LANGUAGE PAGE.
   *
   * Both options are always written in their own language — a player who
   * landed on the wrong one has to be able to recognise the way out. The
   * change applies the moment a row is chosen, so the page under the cursor
   * is the proof that it worked.
   */
  private languageHtml(): string {
    const active = lang();
    const rows = LANGUAGES.map(
      (code, i) => `<div class="fe-row" data-row="${i}">
        <span class="fe-row-lab">${escapeHtml(LANG_LABELS[code])}</span>
        <span class="fe-row-ctl fe-segs">
          <span class="fe-seg${code === active ? ' on' : ''}" data-set="${i}">${code === active ? '✓' : '·'}</span>
        </span>
      </div>`,
    ).join('');
    return `${rows}
      <div class="fe-row" data-row="${LANGUAGES.length}"><span class="fe-row-t">${t('ÎNAPOI')}</span></div>
      <p class="fe-note">${t(
        'Jocul se traduce pe loc — meniul, interfața, misiunile și subtitrările. ' +
          'Vocile și muzica rămân în română, pentru că sunt înregistrări reale.',
      )}</p>`;
  }

  /**
   * Switch, then rebuild everything already on screen. The main menu rows, the
   * loading strap and this page were all painted once, in the old language.
   * `bindings` is dropped too: it caches the labels the probe read.
   */
  private chooseLanguage(next: Lang): void {
    if (next === lang()) return;
    setLang(next);
    this.bindings = null;
    this.paintStaticCopy();
    this.syncMenu();
    this.paintProgress();
    this.setPanel(Math.max(0, this.panelIndex));
    this.openPage('language');
  }

  private creditsHtml(): string {
    const blocks = CREDITS.map(
      (b) => `<div class="fe-credit-block"><h5>${escapeHtml(t(b.role))}</h5>
        <p>${b.lines.map((l) => escapeHtml(t(l))).join('<br />')}</p></div>`,
    ).join('');
    return `<div class="fe-credits">${blocks}
      <div class="fe-credit-end">B★ BUILDERSTAR GAMES · BUCUREȘTI</div></div>
      <div class="fe-row" data-row="0"><span class="fe-row-t">${t('ÎNAPOI')}</span></div>`;
  }

  private refreshAudioValues(): void {
    const s = this.settings;
    if (!s || this.page !== 'audio') return;
    const vol = Math.round(s.masterVolume * 100);
    this.setMeter('vol', vol, `${vol}%`);
    this.setMeter('sens', sensPct(s.lookSensitivity), sensLabel(s.lookSensitivity));
    const q = s.quality;
    this.els.pageBody.querySelectorAll<HTMLElement>('[data-segs="quality"] .fe-seg').forEach((el, i) => {
      el.classList.toggle('on', QUALITIES[i] === q);
    });
    this.els.pageBody.querySelectorAll<HTMLElement>('[data-segs="invert"] .fe-seg').forEach((el, i) => {
      el.classList.toggle('on', (i === 1) === s.invertY);
    });
  }

  private setMeter(name: string, pct: number, label: string): void {
    const m = this.els.pageBody.querySelector<HTMLElement>(`[data-meter="${name}"]`);
    if (m) {
      const fill = m.querySelector<HTMLElement>('i');
      const knob = m.querySelector<HTMLElement>('s');
      if (fill) fill.style.width = `${pct}%`;
      if (knob) knob.style.left = `${pct}%`;
    }
    const v = this.els.pageBody.querySelector<HTMLElement>(`[data-val="${name}"]`);
    if (v) v.textContent = label;
  }

  /** Left/right on the selected settings row. */
  private nudge(dir: number): void {
    if (this.page === 'language') {
      const i = LANGUAGES.indexOf(lang());
      const next = LANGUAGES[clamp(i + dir, 0, LANGUAGES.length - 1)];
      if (next) this.chooseLanguage(next);
      return;
    }
    const s = this.settings;
    if (!s || this.page !== 'audio') return;
    switch (this.pageRow) {
      case 0:
        s.setMasterVolume(s.masterVolume + dir * 0.05);
        break;
      case 1:
        s.setQuality(stepQuality(s.quality, dir));
        break;
      case 2:
        s.setLookSensitivity(s.lookSensitivity + dir * 0.0003);
        break;
      case 3:
        s.setInvertY(dir > 0);
        break;
      default:
        return;
    }
    this.refreshAudioValues();
  }

  /** Absolute click on a segment. */
  private setRow(row: number, value: number): void {
    if (this.page === 'language') {
      const picked = LANGUAGES[value];
      if (picked) this.chooseLanguage(picked);
      return;
    }
    const s = this.settings;
    if (!s) return;
    if (row === 1) s.setQuality(QUALITIES[clamp(value, 0, QUALITIES.length - 1)] as Quality);
    if (row === 3) s.setInvertY(value === 1);
    this.refreshAudioValues();
  }

  private activateRow(): void {
    if (this.page === 'language') {
      const picked = LANGUAGES[this.pageRow];
      if (picked) this.chooseLanguage(picked);
      else this.closePage();
      return;
    }
    if (this.page === 'audio') {
      if (this.pageRow === 3) {
        this.settings?.setInvertY(!this.settings.invertY);
        this.refreshAudioValues();
        return;
      }
      if (this.pageRow === 4) this.closePage();
      return;
    }
    this.closePage();
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                         */
  /* ---------------------------------------------------------------- */

  private onKeyDown(e: KeyboardEvent): void {
    if (this.probing || !e.isTrusted) return;
    if (this.phase === 'ingame' || this.starting) return;
    // F-keys stay with the browser and the debug overlay.
    if (e.code.startsWith('F') && e.code.length <= 3) return;

    if (this.phase === 'sting') {
      e.preventDefault();
      this.skipSting();
      return;
    }
    if (this.phase === 'load') {
      e.preventDefault();
      return;
    }

    if (this.page !== 'main') {
      const rows = this.pageRowCount();
      switch (e.code) {
        case 'Escape':
        case 'Backspace':
          stop(e);
          this.closePage();
          return;
        case 'ArrowUp':
        case 'KeyW':
          stop(e);
          this.pageRow = (this.pageRow - 1 + rows) % rows;
          this.syncPageRows();
          return;
        case 'ArrowDown':
        case 'KeyS':
          stop(e);
          this.pageRow = (this.pageRow + 1) % rows;
          this.syncPageRows();
          return;
        case 'ArrowLeft':
        case 'KeyA':
          stop(e);
          this.nudge(-1);
          return;
        case 'ArrowRight':
        case 'KeyD':
          stop(e);
          this.nudge(1);
          return;
        case 'Enter':
        case 'Space':
          stop(e);
          this.activateRow();
          return;
        default:
          return;
      }
    }

    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
      case 'ArrowUp':
      case 'KeyW':
        stop(e);
        this.move(-1);
        return;
      case 'ArrowRight':
      case 'KeyD':
      case 'ArrowDown':
      case 'KeyS':
      case 'Tab':
        stop(e);
        this.move(1);
        return;
      case 'Enter':
      case 'Space':
      case 'NumpadEnter':
        stop(e);
        this.activate();
        return;
      default:
        return;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Hand-off                                                         */
  /* ---------------------------------------------------------------- */

  private startGame(mode: 'new' | 'continue'): void {
    if (this.mobile || this.starting) return;
    this.starting = true;
    // Decide now: `enterWorld` clears the slot on a new game, so by the time the
    // curtain lifts `canContinue()` can no longer tell a first run apart.
    this.firstRun = showsWalkthrough(mode, this.canContinue());
    this.paintLaunchKeys();
    this.setLaunchProgress(10, mode === 'continue' ? 'SE DESCHIDE DOSARUL SALVAT' : 'SE PREGĂTEȘTE UN DOSAR NOU');

    // Still inside the gesture that triggered this — the only moment the
    // browser will let an AudioContext start.
    void Promise.resolve(this.settings?.unlockAudio()).then(() => {
      this.setLaunchProgress(32, 'SE DESCHIDE RADIOUL');
    });

    this.root.classList.add('is-starting');

    const resumeAt = window.setTimeout(() => this.enterWorld(mode), 1150);
    const readyAt = window.setTimeout(() => this.setLaunchProgress(100, 'GATA — BUCUREȘTI ONLINE'), 1900);
    const fadeAt = window.setTimeout(() => {
      this.root.style.transition = 'opacity .55s ease';
      this.root.style.opacity = '0';
    }, 2050);
    const goneAt = window.setTimeout(() => this.finish(mode), 2500);
    this.disposers.push(() => {
      clearTimeout(resumeAt);
      clearTimeout(readyAt);
      clearTimeout(fadeAt);
      clearTimeout(goneAt);
    });
  }

  private enterWorld(mode: 'new' | 'continue'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.setLaunchProgress(58, 'SE PORNEȘTE BUCUREȘTIUL');
    const handoff = worldHandoffPolicy('under-curtain');
    ctx.time.paused = handoff.paused;
    ctx.input.enabled = handoff.inputEnabled;
    ctx.tryGet(Services.Hud)?.setVisible(true);

    const save = ctx.tryGet(Services.Save);

    if (mode === 'continue' && isResumable(this.session)) {
      // CONTINUE actually continues now: acts finished, XP, level, unlocks,
      // discovered landmarks, lei, where you stood and what time it was.
      try {
        save?.restore(this.session);
        this.playSeconds = this.session.playSeconds;
      } catch (err) {
        // A slot from an older build must never strand the player on a black
        // screen — drop into the world as a new game instead.
        console.warn('[front-end] resume failed, starting fresh:', err);
      }
    } else if (mode === 'new') {
      this.playSeconds = 0;
      save?.clear();
      this.session = emptySession();
    }

    this.setLaunchProgress(78, mode === 'continue' ? 'SE RESTABILEȘTE POZIȚIA' : 'SE AȘAZĂ MISIUNEA');
    // Two frames prove the renderer has presented the resumed world rather
    // than merely accepting the state change on the main thread.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.setLaunchProgress(92, 'ULTIMELE VERIFICĂRI'));
    });
  }

  private finish(mode: 'new' | 'continue'): void {
    this.setLaunchProgress(100, 'GATA — BUCUREȘTI ONLINE');
    this.phase = 'ingame';
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.root.classList.add('is-gone');
    this.root.classList.remove('is-starting');
    this.root.style.opacity = '';

    const ctx = this.ctx;
    if (ctx) {
      const handoff = worldHandoffPolicy('interactive');
      ctx.time.paused = handoff.paused;
      ctx.input.enabled = handoff.inputEnabled;
    }

    // Presentation that explains the opening belongs AFTER the curtain. A
    // card emitted from enterWorld() sits hidden beneath the remaining one
    // second of menu fade, which is precisely how the old start lost its story.
    // `firstRun` travels with the event: the walkthrough system in
    // `src/ui/walkthrough.ts` owns the in-world coaching, and only the
    // front-end knows whether this player has ever played.
    ctx?.events.emit('game:started', { mode, firstRun: this.firstRun });
    ctx?.tryGet(Services.Hud)?.toast('Clic pentru a prinde mouse-ul', 'info', 4000);
  }

  /**
   * The keys, on the STARTING GAME curtain. This is the two seconds every
   * player stares at on their way into the world — a better place for a control
   * list than the boot panels, which are story, or a menu page nobody opens.
   */
  private paintLaunchKeys(): void {
    const rows = hintRows(LAUNCH_HINTS);
    if (!rows.length) {
      this.els.launchKeys.innerHTML = '';
      return;
    }
    this.els.launchKeys.innerHTML =
      `<p class="fe-launch-keys-t">${t(LAUNCH_HINTS_TITLE)}</p><div class="fe-launch-keys-g">${hintChips(rows)}</div>`;
  }

  private setLaunchProgress(pct: number, status: string): void {
    const next = launchProgress(this.launchPct, pct);
    if (next === this.launchPct && pct < this.launchPct) return;
    this.launchPct = next;
    this.els.launchBar.style.transform = `scaleX(${(next / 100).toFixed(3)})`;
    this.els.launchPct.textContent = `${next}%`;
    this.els.launchStatus.textContent = t(status);
    this.els.launchBar.parentElement?.setAttribute('aria-valuenow', String(next));
  }

  /**
   * Copy that lives in `template()` rather than in a render method.
   *
   * `data-copy` is the authored Romanian; the element's text is whatever that
   * translates to right now. Keeping the source on the attribute means this can
   * run again after a language switch without the markup having to be rebuilt,
   * and `data-copy-aria` does the same for the labels only a screen reader
   * sees.
   */
  private paintStaticCopy(): void {
    this.root.querySelectorAll<HTMLElement>('[data-copy]').forEach((el) => {
      el.textContent = t(el.dataset.copy ?? '');
    });
    this.root.querySelectorAll<HTMLElement>('[data-copy-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.dataset.copyAria ?? ''));
    });
    const hint = this.root.querySelector<HTMLElement>('.fe-hint');
    if (hint) {
      hint.innerHTML =
        `<kbd>←</kbd><kbd>→</kbd> ${t('NAVIGARE')} · ` +
        `<kbd>ENTER</kbd> ${t('SELECTEAZĂ')} · <kbd>ESC</kbd> ${t('ÎNAPOI')}`;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Debug hook                                                       */
  /* ---------------------------------------------------------------- */

  private installDebugHook(): void {
    (window as unknown as { __GTA_MENU__: unknown }).__GTA_MENU__ = {
      state: () => ({
        phase: this.phase,
        page: this.page,
        selected: MENU_ITEMS[this.selected]?.id ?? null,
        pageRow: this.pageRow,
        progress: Math.round(this.shownPct),
        panel: this.panelIndex,
        complete: this.loadComplete,
        launchProgress: this.launchPct,
        canContinue: this.canContinue(),
        firstRun: this.firstRun,
        mobile: this.mobile,
      }),
      /** Jump the sting/loading wait — for screenshots, not for players. */
      skip: () => {
        if (this.phase === 'sting') this.skipSting();
        else if (this.phase === 'load') {
          this.loadComplete = true;
          this.shownPct = 100;
          this.goTitle();
        }
      },
      select: (id: MenuId) => {
        const i = MENU_ITEMS.findIndex((m) => m.id === id);
        if (i >= 0) {
          this.selected = i;
          this.syncMenu();
        }
      },
      open: (p: Page) => {
        if (this.phase !== 'title') return;
        if (p === 'main') this.closePage();
        else this.openPage(p);
      },
      activate: () => this.activate(),
      start: () => this.startGame('new'),
      panel: (i: number) => {
        // Move the clock too, or the next frame's schedule undoes this.
        this.phaseT = i * PANEL_SECONDS + 0.25;
        this.setPanel(i);
      },
      /** Hold the phase so a screenshot can catch it. Verification only. */
      freeze: (on = true) => {
        this.frozen = on;
      },
      /** Jump straight to a phase, without waiting for the real load. */
      phase: (p: Phase) => {
        if (p === 'load' && this.phase === 'sting') this.goLoad();
        else if (p === 'title' && this.phase !== 'title') {
          if (this.phase === 'sting') this.goLoad();
          this.goTitle();
        }
      },
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root?.remove();
  }

  /* ---------------------------------------------------------------- */
  /* Markup                                                           */
  /* ---------------------------------------------------------------- */

  private template(): string {
    const stars = '<i>★</i>'.repeat(5);
    const items = MENU_ITEMS.map(
      (m) =>
        `<button class="fe-item" type="button" data-id="${m.id}">
          <span class="fe-item-t">${m.label}</span><span class="fe-item-sub">${escapeHtml(m.sub)}</span>
        </button>`,
    ).join('');

    return `
<section class="fe-phase fe-sting" aria-label="Builderstar Games">
  <div class="fe-scan"></div>
  <div class="fe-vig"></div>
  <div class="fe-grain"></div>
  <div class="fe-sting-inner">
    ${studioMark('fe-sting')}
    <div class="fe-sting-flash"></div>
    <div class="fe-sting-tri"></div>
    <p class="fe-sting-presents" data-copy="PREZINTĂ"></p>
  </div>
  <p class="fe-skip" data-copy="ORICE TASTĂ PENTRU A SĂRI"></p>
</section>

<section class="fe-phase fe-load" data-copy-aria="Se încarcă">
  <div class="fe-artwrap"><div class="fe-art"></div></div>
  <div class="fe-wash"></div>
  <div class="fe-bloom"></div>
  <div class="fe-scan"></div>
  <div class="fe-vig"></div>
  <div class="fe-grain"></div>
  <div class="fe-load-mark">${studioMark('fe-load')}</div>
  <div class="fe-load-copy">
    <p class="fe-chip fe-load-chip"></p>
    <h2 class="fe-load-head"></h2>
    <p class="fe-load-body"></p>
  </div>
  <div class="fe-load-foot">
    <span class="fe-load-status"></span>
    <span class="fe-bar"><i></i><b></b><u style="left:25%"></u><u style="left:50%"></u><u style="left:75%"></u></span>
    <span class="fe-load-pct">0%</span>
  </div>
</section>

<section class="fe-phase fe-title" aria-label="Grand Theft Austerity">
  <div class="fe-artwrap"><div class="fe-art"></div></div>
  <div class="fe-wash"></div>
  <div class="fe-bloom"></div>
  <div class="fe-scan"></div>
  <div class="fe-band"></div>
  <div class="fe-vig"></div>
  <div class="fe-grain"></div>
  <div class="fe-tri"></div>
  <div class="fe-studio">${studioMark('fe-title')}</div>

  <div class="fe-lockup">
    <p class="fe-loc">BUCUREȘTI</p>
    <h1><span>GRAND</span><span>THEFT</span><span class="fe-aust">AUSTERITY</span></h1>
    <p class="fe-tag">TAKE BACK THE HOUSE</p>
  </div>

  <nav class="fe-menu" data-copy-aria="Meniu principal">${items}</nav>
  <p class="fe-mobile-notice" role="status" hidden>
    <span class="fe-mobile-kicker">${MOBILE_NOTICE.kicker}</span>
    <span class="fe-mobile-body">${MOBILE_NOTICE.body}</span>
  </p>
  <p class="fe-hint"></p>

  <aside class="fe-crisis" aria-label="Political instability">
    <span>POLITICAL INSTABILITY</span><b>${stars}</b>
  </aside>
  <p class="fe-edition">A BUILDERSTAR HACKATHON PROTOTYPE</p>

  <div class="fe-scrim"></div>
  <div class="fe-page" role="dialog">
    <p class="fe-page-eyebrow">B★ BUILDERSTAR GAMES</p>
    <h3 class="fe-page-title"></h3>
    <p class="fe-page-crumb"></p>
    <div class="fe-page-rule"></div>
    <div class="fe-page-body"></div>
    <p class="fe-page-foot"></p>
  </div>
</section>

<div class="fe-curtain">
  <div class="fe-launch" role="status" aria-live="polite">
    <p class="fe-launch-kicker">STARTING GAME</p>
    <p class="fe-launch-status" data-copy="SE PREGĂTEȘTE DOSARUL"></p>
    <div class="fe-launch-progress">
      <span class="fe-launch-bar" role="progressbar" data-copy-aria="Progres pornire joc" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></span>
      <span class="fe-launch-pct">0%</span>
    </div>
    <div class="fe-launch-keys" data-copy-aria="Comenzi"></div>
  </div>
</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Install gate                                                        */
/* ------------------------------------------------------------------ */

export interface FrontEndGate {
  /** Should the front-end mount at all? */
  on: boolean;
  why: string;
}

export type WorldHandoffPhase = 'under-curtain' | 'interactive';

/** The world may render beneath the fade, but gameplay starts after it clears. */
export function worldHandoffPolicy(phase: WorldHandoffPhase): {
  paused: boolean;
  inputEnabled: boolean;
} {
  return { paused: false, inputEnabled: phase === 'interactive' };
}

/** Launch milestones may resolve out of order (notably AudioContext unlock). */
export function launchProgress(previous: number, next: number): number {
  return Math.max(clamp(previous, 0, 100), clamp(Math.round(next), 0, 100));
}

/**
 * Pure so it can be unit-tested: automation gets the world, players get the
 * front-end, and `?menu=1` overrides everything for verification.
 */
export function frontEndGate(search: string, webdriver: boolean): FrontEndGate {
  const p = new URLSearchParams(search);
  const forced = (p.get('menu') ?? '').toLowerCase();
  if (forced === '1' || forced === 'on' || forced === 'full') return { on: true, why: 'forced by ?menu=1' };
  if (forced === '0' || forced === 'off' || p.has('nomenu') || p.has('shot')) {
    return { on: false, why: 'disabled by query' };
  }
  if (webdriver) return { on: false, why: 'automation (navigator.webdriver)' };
  return { on: true, why: 'player' };
}

export interface MobileClientHints {
  /** `navigator.userAgentData.mobile` when the browser exposes it. */
  userAgentDataMobile?: boolean;
  /** `matchMedia('(pointer: coarse)')`. */
  coarsePointer?: boolean;
  /** Raw UA string fallback for older mobile browsers. */
  userAgent?: string;
}

/**
 * Phones (and coarse-pointer handhelds) cannot drive the keyboard/mouse game.
 * Pure so the menu lock can be unit-tested without a DOM.
 */
export function isMobileClient(hints: MobileClientHints = browserMobileHints()): boolean {
  if (hints.userAgentDataMobile === true) return true;
  if (hints.userAgentDataMobile === false) return false;
  if (hints.coarsePointer) return true;
  const ua = hints.userAgent ?? '';
  return /iPhone|iPod|Android.+Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

function browserMobileHints(): MobileClientHints {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  return {
    userAgentDataMobile: nav.userAgentData?.mobile,
    coarsePointer: typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches,
    userAgent: nav.userAgent,
  };
}

let instance: FrontEnd | null = null;

/** Mount the front-end unless this page is an automated capture. */
export function installFrontEnd(): FrontEnd | null {
  if (instance) return instance;
  if (typeof document === 'undefined') return null;
  const gate = frontEndGate(location.search, navigator.webdriver === true);
  if (!gate.on) return null;
  instance = new FrontEnd();
  instance.install();
  return instance;
}

/* ------------------------------------------------------------------ */

function stop(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/** `<kbd>` chips for a row of hints — used by the loader and the first-run card. */
function hintChips(rows: readonly HintRow[]): string {
  return rows
    .map(
      (r) => `<span class="fe-hint-key">
        <span class="fe-hint-k">${r.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}</span>
        <span class="fe-hint-l">${escapeHtml(r.label)}</span>
      </span>`,
    )
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

export function sensPct(s: number): number {
  return Math.round(clamp01((s - SENS_MIN) / (SENS_MAX - SENS_MIN)) * 100);
}
