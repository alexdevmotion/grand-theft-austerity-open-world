/** HUD.
 *
 *  The broadcast-glitch identity of the game, in DOM over the canvas:
 *  Crisis Stars, speedometer, mission card, objective panel with its
 *  countdown, an activity panel with its clock and score, a screen-space
 *  waypoint that turns into an edge arrow when the target is behind you,
 *  subtitles, the radio strap, and the money / level / XP readout.
 *
 *  WHERE THE NUMBERS COME FROM. Everything that *happens* arrives on the
 *  event bus (`objective:changed`, `ui:missionCard`, `progression:xp`,
 *  `economy:changed`, `radio:line`). Everything that *counts down* is read
 *  once a frame from `src/gameplay/hudState.ts`, because a 60 Hz countdown is
 *  not an event and `HudService` (frozen) has no setter for one.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services, type HudService } from '../core/services';
import { PauseMenu } from './pauseMenu';
import { activityHud, missionHud } from '../gameplay/hudState';

const _wp = new THREE.Vector3();
const _cam = new THREE.Vector3();

export class HudSystem implements System, HudService {
  readonly name = 'hud';
  readonly order = 420;

  private root!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private subtitleEl!: HTMLDivElement;
  private starsEl!: HTMLDivElement;
  private speedEl!: HTMLDivElement;
  private cardEl!: HTMLDivElement;
  private objEl!: HTMLDivElement;
  private actEl!: HTMLDivElement;
  private wpEl!: HTMLDivElement;
  private radioEl!: HTMLDivElement;
  private statsEl!: HTMLDivElement;
  private ctx!: GameContext;
  private waypoint: THREE.Vector3 | null = null;

  private objTitle = '';
  private objHint = '';
  private lei = 0;
  private xpFlash = 0;

  /**
   * The pause screen lives here rather than as its own System because the
   * engine only ticks systems with `order >= 400` while `time.paused` is true.
   * The HUD is 420, so hanging the menu off it is what keeps it alive — and
   * able to read Escape again — once the world has stopped.
   */
  private pause = new PauseMenu();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Hud, this);

    const host = document.getElementById('ui-root')!;
    this.root = document.createElement('div');
    this.root.innerHTML = TEMPLATE;
    host.appendChild(this.root);

    this.starsEl = this.root.querySelector('#gta-stars')!;
    this.speedEl = this.root.querySelector('#gta-speed')!;
    this.toastEl = this.root.querySelector('#gta-toast')!;
    this.subtitleEl = this.root.querySelector('#gta-sub')!;
    this.cardEl = this.root.querySelector('#gta-card')!;
    this.objEl = this.root.querySelector('#gta-obj')!;
    this.actEl = this.root.querySelector('#gta-act')!;
    this.wpEl = this.root.querySelector('#gta-wp')!;
    this.radioEl = this.root.querySelector('#gta-radio')!;
    this.statsEl = this.root.querySelector('#gta-stats')!;

    ctx.events.on('instability:changed', ({ stars, previous }) => {
      this.starsEl.innerHTML =
        `<span class="on">${'★'.repeat(stars)}</span><span class="off">${'☆'.repeat(5 - stars)}</span>`;
      if (stars > previous) {
        this.starsEl.classList.remove('pulse');
        void this.starsEl.offsetWidth;
        this.starsEl.classList.add('pulse');
      }
    });
    ctx.events.on('ui:toast', ({ text, kind, ms }) => this.toast(text, kind ?? 'info', ms));
    ctx.events.on('ui:subtitle', ({ speaker, text, ms }) => this.subtitle(speaker, text, ms));
    ctx.events.on('ui:missionCard', ({ title, subtitle }) => this.missionCard(title, subtitle));

    ctx.events.on('objective:changed', ({ title, subtitle }) => {
      this.objTitle = title;
      this.objHint = subtitle ?? '';
    });

    // Police dispatch and the story both write here; nothing rendered it.
    ctx.events.on('radio:line', ({ text }) => this.radioLine(text));

    ctx.events.on('economy:changed', ({ lei }) => {
      this.lei = lei;
    });
    ctx.events.on('progression:xp', () => {
      this.xpFlash = 1;
    });

    this.pause.init(ctx);
  }

  private visible = true;

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  /* ---------------------------------------------------------------- */
  /* HudService                                                        */
  /* ---------------------------------------------------------------- */

  private toastTimer = 0;
  toast(text: string, kind: 'info' | 'good' | 'bad' = 'info', ms = 2600): void {
    if (!text) return;
    this.toastEl.textContent = text;
    this.toastEl.className = `gta-toast ${kind}`;
    this.toastEl.style.opacity = '1';
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.style.opacity = '0'), ms);
  }

  private subTimer = 0;
  subtitle(speaker: string, text: string, ms = 3800): void {
    this.subtitleEl.innerHTML = speaker ? `<b>${speaker}:</b> ${text}` : text;
    this.subtitleEl.style.opacity = '1';
    window.clearTimeout(this.subTimer);
    this.subTimer = window.setTimeout(() => (this.subtitleEl.style.opacity = '0'), ms);
  }

  private cardTimer = 0;
  missionCard(title: string, subtitle: string): void {
    this.cardEl.innerHTML = `<h2>${title}</h2><p>${subtitle}</p>`;
    this.cardEl.classList.remove('show');
    void this.cardEl.offsetWidth;
    this.cardEl.classList.add('show');
    window.clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => this.cardEl.classList.remove('show'), 4600);
  }

  setWaypoint(p: THREE.Vector3 | null): void {
    this.waypoint = p ? p.clone() : null;
    if (!p && this.wpEl) this.wpEl.style.display = 'none';
  }

  private radioTimer = 0;
  private radioLine(text: string): void {
    if (!text) return;
    this.radioEl.innerHTML = `<i>RADIO</i> ${text}`;
    this.radioEl.style.opacity = '1';
    window.clearTimeout(this.radioTimer);
    this.radioTimer = window.setTimeout(() => (this.radioEl.style.opacity = '0'), 5200);
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  update(dt: number): void {
    // Escape only ever *opens* the menu from here: once it is up the menu owns
    // the key on its own capture-phase listener, with gameplay input disabled.
    if (!this.pause.isOpen && this.ctx.input.actionPressed('pause')) this.pause.show();
    this.pause.update(dt);
    this.root.style.display = this.pause.isOpen || !this.visible ? 'none' : '';
    if (this.pause.isOpen) return;

    const player = this.ctx.tryGet(Services.Player);
    const veh = player?.inVehicle;
    if (veh) {
      this.speedEl.style.display = '';
      const kmh = Math.abs(veh.speed) * 3.6;
      this.speedEl.querySelector('span')!.textContent = String(Math.round(kmh));
    } else {
      this.speedEl.style.display = 'none';
    }

    this.drawObjective();
    this.drawActivity();
    this.drawWaypoint(player?.position ?? null);
    this.drawStats(dt);
  }

  private drawObjective(): void {
    if (missionHud.failed) {
      this.objEl.style.display = '';
      this.objEl.className = 'gta-obj failed';
      this.objEl.innerHTML =
        '<h3>MISIUNE EȘUATĂ</h3>' +
        `<p>${missionHud.failed}</p>` +
        '<small>Marcajul de reluare te așteaptă.</small>';
      return;
    }
    if (!missionHud.active) {
      this.objEl.style.display = 'none';
      return;
    }
    this.objEl.style.display = '';
    this.objEl.className = 'gta-obj';
    const time = missionHud.timeLeft !== null
      ? `<em class="${missionHud.timeLeft < 15 ? 'hot' : ''}">${fmtTime(missionHud.timeLeft)}</em>`
      : '';
    const hold = missionHud.hold > 0
      ? `<div class="bar"><i style="width:${Math.round(missionHud.hold * 100)}%"></i></div>`
      : '';
    this.objEl.innerHTML =
      `<h3>${missionHud.title} <small>${missionHud.step}/${missionHud.steps}</small></h3>` +
      `<p>${missionHud.objective || this.objTitle}${time}</p>` +
      `<small>${missionHud.hint || this.objHint}</small>${hold}`;
  }

  private drawActivity(): void {
    if (activityHud.result) {
      this.actEl.style.display = '';
      this.actEl.className = `gta-act ${activityHud.resultGood ? 'good' : 'bad'}`;
      this.actEl.innerHTML = `<h3>${activityHud.result}</h3>`;
      return;
    }
    if (!activityHud.active) {
      this.actEl.style.display = 'none';
      return;
    }
    this.actEl.style.display = '';
    this.actEl.className = 'gta-act';
    this.actEl.innerHTML =
      `<h3>${activityHud.kind} <small>${activityHud.progress}</small></h3>` +
      `<p>${activityHud.name}<em class="${activityHud.timeLeft < 15 ? 'hot' : ''}">` +
      `${fmtTime(activityHud.timeLeft)}</em></p>` +
      `<small>${activityHud.score} puncte</small>`;
  }

  /**
   * The waypoint, projected. On screen it is a diamond with the distance under
   * it; off screen (including behind you) it becomes an arrow pinned to the
   * edge of the frame, pointing the way — which is the only part of a waypoint
   * that matters while you are driving.
   */
  private drawWaypoint(playerPos: THREE.Vector3 | null): void {
    const wp = this.waypoint;
    if (!wp || !playerPos) {
      this.wpEl.style.display = 'none';
      return;
    }
    const cam = this.ctx.camera;
    const w = this.ctx.canvas.clientWidth || window.innerWidth;
    const h = this.ctx.canvas.clientHeight || window.innerHeight;

    _wp.copy(wp).setY(wp.y + 1.8);
    _cam.copy(_wp).applyMatrix4(cam.matrixWorldInverse);
    const inFront = _cam.z < -0.2;

    _wp.project(cam);
    let sx = (_wp.x * 0.5 + 0.5) * w;
    let sy = (-_wp.y * 0.5 + 0.5) * h;
    if (!inFront) {
      // Behind the camera the perspective divide mirrors the point; flip it
      // back so the arrow points AT the target rather than away from it.
      sx = w - sx;
      sy = h - sy;
    }

    const m = 46;
    const clampedX = Math.max(m, Math.min(w - m, sx));
    const clampedY = Math.max(m, Math.min(h - m, sy));
    const edge = !inFront || clampedX !== sx || clampedY !== sy;
    const dist = Math.round(Math.hypot(wp.x - playerPos.x, wp.z - playerPos.z));

    this.wpEl.style.display = '';
    this.wpEl.style.left = `${clampedX}px`;
    this.wpEl.style.top = `${clampedY}px`;
    if (edge) {
      const ang = Math.atan2(sy - h / 2, sx - w / 2) * (180 / Math.PI) + 90;
      this.wpEl.innerHTML = `<b style="display:block;transform:rotate(${ang}deg)">▲</b><u>${dist} m</u>`;
      this.wpEl.className = 'gta-wp edge';
    } else {
      this.wpEl.innerHTML = `<b>◆</b><u>${dist} m</u>`;
      this.wpEl.className = 'gta-wp';
    }
  }

  private drawStats(dt: number): void {
    const prog = this.ctx.tryGet(Services.Progression);
    const player = this.ctx.tryGet(Services.Player);
    if (player) this.lei = player.lei;
    const level = prog?.level ?? 1;
    // `levelProgress` is on the concrete system rather than the frozen
    // interface; fall back to an empty bar if a stub is ever installed.
    const p = (prog as unknown as { levelProgress?: { into: number; span: number } })?.levelProgress;
    const pct = p ? Math.max(0, Math.min(100, (p.into / p.span) * 100)) : 0;
    this.xpFlash = Math.max(0, this.xpFlash - dt * 2);

    const hp = player ? Math.round((player.health / Math.max(1, player.maxHealth)) * 100) : 100;
    this.statsEl.innerHTML =
      `<div class="row"><span class="lv">NIV ${level}</span>` +
      `<span class="lei">${Math.round(this.lei).toLocaleString('ro-RO')} lei</span></div>` +
      `<div class="xp"><i style="width:${pct.toFixed(1)}%;opacity:${(0.65 + this.xpFlash * 0.35).toFixed(2)}"></i></div>` +
      `<div class="hp"><i style="width:${hp}%"></i></div>`;
  }

  dispose(): void {
    this.pause.dispose();
    this.root?.remove();
  }
}

function fmtTime(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */

const TEMPLATE = `
  <style>
    .gta-hud { position:absolute; inset:0; font-family:Inter,system-ui,sans-serif; color:#fff;
      pointer-events:none; }
    .gta-stars { position:absolute; top:22px; right:26px; font-size:26px; letter-spacing:4px; }
    .gta-stars .on { color:#ff3d7f; text-shadow:0 0 14px rgba(255,61,127,.75), 0 2px 4px #000; }
    .gta-stars .off { color:rgba(255,255,255,.22); text-shadow:0 2px 4px #000; }
    .gta-stars.pulse { animation:gtaStar .5s ease-out; }
    @keyframes gtaStar { 0%{transform:scale(1.5);filter:brightness(2.4)} 100%{transform:scale(1)} }

    .gta-speed { position:absolute; bottom:28px; right:30px; text-align:right;
      font-weight:800; font-size:40px; text-shadow:0 2px 10px rgba(0,0,0,.85); line-height:1; }
    .gta-speed small { display:block; font-size:11px; letter-spacing:.28em; font-weight:600; opacity:.75; }

    .gta-toast { position:absolute; top:70px; left:50%; transform:translateX(-50%);
      padding:9px 20px; background:rgba(20,8,32,.86); border-left:3px solid #ff3d7f;
      font-size:14px; letter-spacing:.05em; opacity:0; transition:opacity .25s; }
    .gta-toast.good { border-left-color:#4ad6a0; }
    .gta-toast.bad { border-left-color:#ff5a4a; }

    .gta-sub { position:absolute; bottom:64px; left:50%; transform:translateX(-50%);
      max-width:min(760px,80vw); text-align:center; font-size:17px; line-height:1.45;
      text-shadow:0 2px 8px #000; opacity:0; transition:opacity .2s; }
    .gta-sub b { color:#ffb454; font-weight:700; }

    .gta-card { position:absolute; top:24%; left:50%; transform:translateX(-50%) translateY(10px);
      text-align:center; opacity:0; transition:opacity .4s, transform .4s; }
    .gta-card.show { opacity:1; transform:translateX(-50%) translateY(0); }
    .gta-card h2 { margin:0; font-size:34px; font-weight:800; letter-spacing:.04em;
      color:#fff; text-shadow:0 0 26px rgba(255,61,127,.8), 0 3px 10px #000; }
    .gta-card p { margin:6px 0 0; font-size:15px; letter-spacing:.12em; text-transform:uppercase;
      color:#e2c9ff; text-shadow:0 2px 8px #000; }

    .gta-obj, .gta-act { position:absolute; left:26px; min-width:230px; max-width:340px;
      padding:10px 14px; background:linear-gradient(90deg,rgba(18,8,30,.9),rgba(18,8,30,.32));
      border-left:3px solid #ff3d7f; }
    .gta-obj { top:96px; }
    .gta-act { top:222px; border-left-color:#7b3fd4; }
    .gta-obj.failed { border-left-color:#ff5a4a; }
    .gta-act.good { border-left-color:#4ad6a0; }
    .gta-act.bad { border-left-color:#ff5a4a; }
    .gta-obj h3, .gta-act h3 { margin:0 0 4px; font-size:11px; letter-spacing:.2em;
      text-transform:uppercase; color:#ff9ec4; font-weight:700; }
    .gta-act h3 { color:#c3a2ff; }
    .gta-obj h3 small, .gta-act h3 small { float:right; opacity:.6; letter-spacing:.1em; }
    .gta-obj p, .gta-act p { margin:0; font-size:15px; font-weight:600; line-height:1.3;
      text-shadow:0 2px 6px #000; }
    .gta-obj em, .gta-act em { float:right; font-style:normal; font-variant-numeric:tabular-nums;
      opacity:.85; margin-left:10px; }
    .gta-obj em.hot, .gta-act em.hot { color:#ff5a4a; opacity:1; }
    .gta-obj small, .gta-act small { display:block; margin-top:3px; font-size:12px; opacity:.62; }
    .gta-obj .bar { margin-top:6px; height:3px; background:rgba(255,255,255,.16); }
    .gta-obj .bar i { display:block; height:100%; background:#ff3d7f; }

    .gta-wp { position:absolute; transform:translate(-50%,-50%); text-align:center;
      color:#ff3d7f; text-shadow:0 0 12px rgba(255,61,127,.9), 0 2px 5px #000; }
    .gta-wp b { display:block; font-size:20px; line-height:1; }
    .gta-wp u { display:block; margin-top:2px; font-size:11px; font-weight:700;
      letter-spacing:.08em; text-decoration:none; color:#fff; }
    .gta-wp.edge b { font-size:26px; }

    .gta-radio { position:absolute; bottom:118px; left:50%; transform:translateX(-50%);
      max-width:min(700px,78vw); padding:6px 16px; background:rgba(10,4,18,.82);
      border-left:3px solid #4ad6c4; font-size:14px; opacity:0; transition:opacity .25s; }
    .gta-radio i { font-style:normal; font-weight:800; letter-spacing:.18em; font-size:10px;
      color:#4ad6c4; margin-right:10px; }

    .gta-stats { position:absolute; left:26px; bottom:28px; width:196px; }
    .gta-stats .row { display:flex; justify-content:space-between; align-items:baseline;
      font-size:13px; text-shadow:0 2px 6px #000; }
    .gta-stats .lv { font-weight:800; letter-spacing:.14em; color:#c3a2ff; font-size:11px; }
    .gta-stats .lei { font-weight:800; font-size:17px; font-variant-numeric:tabular-nums; }
    .gta-stats .xp, .gta-stats .hp { margin-top:5px; height:3px; background:rgba(255,255,255,.14); }
    .gta-stats .xp i { display:block; height:100%; background:#c3a2ff; }
    .gta-stats .hp i { display:block; height:100%; background:#4ad6a0; }
  </style>
  <div class="gta-hud">
    <div class="gta-stars" id="gta-stars"><span class="off">☆☆☆☆☆</span></div>
    <div class="gta-speed" id="gta-speed" style="display:none"><span>0</span><small>KM/H</small></div>
    <div class="gta-toast" id="gta-toast"></div>
    <div class="gta-sub" id="gta-sub"></div>
    <div class="gta-card" id="gta-card"></div>
    <div class="gta-obj" id="gta-obj" style="display:none"></div>
    <div class="gta-act" id="gta-act" style="display:none"></div>
    <div class="gta-wp" id="gta-wp" style="display:none"></div>
    <div class="gta-radio" id="gta-radio"></div>
    <div class="gta-stats" id="gta-stats"></div>
  </div>`;
