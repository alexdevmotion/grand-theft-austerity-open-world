/** Audio.
 *  OWNER: audio agent. Must deliver procedural engine notes bound to RPM,
 *  tyre squeal, collisions, sirens, footsteps, rain, city ambience, radio
 *  stations with Romanian chatter, and music stings for mission beats.
 *  All synthesized with the WebAudio API — no external asset downloads. */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services, type AudioService } from '../core/services';

export class AudioSystem implements System, AudioService {
  readonly name = 'audio';
  readonly order = 410;

  private _ctx: AudioContext | null = null;
  private _ready = false;
  private listener: THREE.Object3D | null = null;
  masterVolume = 0.8;

  get ready(): boolean {
    return this._ready;
  }

  init(ctx: GameContext): void {
    ctx.provide(Services.Audio, this);
    // Browsers require a gesture; unlock on first click/keypress.
    const unlock = () => {
      void this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  async unlock(): Promise<void> {
    if (this._ready) return;
    this._ctx = new AudioContext();
    await this._ctx.resume();
    this._ready = true;
  }

  oneShot(_id: string, _position?: THREE.Vector3, _volume?: number): void {
    /* audio agent implements */
  }
  bindEngine(_vehicleId: string, _obj: THREE.Object3D): void {
    /* audio agent implements */
  }
  unbindEngine(_vehicleId: string): void {
    /* audio agent implements */
  }
  setMusic(_track: string | null, _fadeSeconds?: number): void {
    /* audio agent implements */
  }
  setListener(obj: THREE.Object3D): void {
    this.listener = obj;
  }

  dispose(): void {
    void this.listener;
    void this._ctx?.close();
  }
}
