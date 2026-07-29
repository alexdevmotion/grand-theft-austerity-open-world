/** HUD.
 *  OWNER: UI agent. Must deliver: Crisis Stars, minimap with streets and
 *  waypoints, speedometer, health/armour, mission cards, subtitles, radio
 *  banner, weapon/ability wheel, pause + map screens — all in the game's
 *  magenta/violet broadcast-glitch identity. */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services, type HudService } from '../core/services';
import { PauseMenu } from './pauseMenu';

export class HudSystem implements System, HudService {
  readonly name = 'hud';
  readonly order = 420;

  private root!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private subtitleEl!: HTMLDivElement;
  private starsEl!: HTMLDivElement;
  private speedEl!: HTMLDivElement;
  private ctx!: GameContext;
  private waypoint: THREE.Vector3 | null = null;
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
    this.root.innerHTML = `
      <style>
        .gta-hud { position:absolute; inset:0; font-family:Inter,system-ui,sans-serif; color:#fff; }
        .gta-stars { position:absolute; top:22px; right:26px; font-size:26px; letter-spacing:4px;
          color:#ff3d7f; text-shadow:0 0 14px rgba(255,61,127,.75), 0 2px 4px #000; }
        .gta-speed { position:absolute; bottom:28px; right:30px; text-align:right;
          font-weight:800; font-size:40px; text-shadow:0 2px 10px rgba(0,0,0,.85); line-height:1; }
        .gta-speed small { display:block; font-size:11px; letter-spacing:.28em; font-weight:600; opacity:.75; }
        .gta-toast { position:absolute; top:70px; left:50%; transform:translateX(-50%);
          padding:9px 20px; background:rgba(20,8,32,.82); border-left:3px solid #ff3d7f;
          font-size:14px; letter-spacing:.05em; opacity:0; transition:opacity .25s; }
        .gta-sub { position:absolute; bottom:64px; left:50%; transform:translateX(-50%);
          max-width:min(760px,80vw); text-align:center; font-size:17px; line-height:1.45;
          text-shadow:0 2px 8px #000; opacity:0; transition:opacity .2s; }
        .gta-sub b { color:#ffb454; font-weight:700; }
      </style>
      <div class="gta-hud">
        <div class="gta-stars" id="gta-stars"></div>
        <div class="gta-speed" id="gta-speed" style="display:none"><span>0</span><small>KM/H</small></div>
        <div class="gta-toast" id="gta-toast"></div>
        <div class="gta-sub" id="gta-sub"></div>
      </div>`;
    host.appendChild(this.root);

    this.starsEl = this.root.querySelector('#gta-stars')!;
    this.speedEl = this.root.querySelector('#gta-speed')!;
    this.toastEl = this.root.querySelector('#gta-toast')!;
    this.subtitleEl = this.root.querySelector('#gta-sub')!;

    ctx.events.on('instability:changed', ({ stars }) => {
      this.starsEl.textContent = '★'.repeat(stars) + '☆'.repeat(5 - stars);
    });
    ctx.events.on('ui:toast', ({ text, ms }) => this.toast(text, 'info', ms));
    ctx.events.on('ui:subtitle', ({ speaker, text, ms }) => this.subtitle(speaker, text, ms));

    this.pause.init(ctx);
  }

  private visible = true;

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  private toastTimer = 0;
  toast(text: string, _kind: 'info' | 'good' | 'bad' = 'info', ms = 2600): void {
    if (!text) return;
    this.toastEl.textContent = text;
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

  missionCard(title: string, subtitle: string): void {
    this.toast(`${title} — ${subtitle}`, 'info', 4200);
  }

  setWaypoint(p: THREE.Vector3 | null): void {
    this.waypoint = p;
  }

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
    void this.waypoint;
  }

  dispose(): void {
    this.pause.dispose();
    this.root?.remove();
  }
}
