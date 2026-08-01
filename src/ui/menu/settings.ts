/**
 * SETTINGS BRIDGE — the front-end's AUDIO / IMAGE page, wired to the real
 * services and to the same storage slot the pause menu uses.
 *
 * Everything here goes through the seam: `RenderService.setQuality`,
 * `AudioService.masterVolume`, `Input.lookSensitivity`, `Input.invertY`. Nothing
 * is mirrored in a local field, so a value changed in the pause menu is already
 * correct the next time this page opens, and vice versa.
 *
 * STORAGE. `src/ui/pauseMenu.ts` and this page share the `gta.settings.v1`
 * slot. `createGame` restores its quality field before renderer/world init;
 * the pause menu restores the remaining input and audio values later. This
 * keeps the two menus in sync without rebuilding an already-created world on
 * every reload.
 */

import type { GameContext } from '../../core/engine';
import { Services, type RenderService } from '../../core/services';
import { QUALITIES, isQuality, type Quality } from '../../render/renderer';

export { QUALITIES, type Quality };

export const QUALITY_LABELS: Record<Quality, string> = {
  low: 'SCĂZUT',
  medium: 'MEDIU',
  high: 'ÎNALT',
  ultra: 'ULTRA',
};

/** Same key and shape as `src/ui/pauseMenu.ts`. Do not fork it. */
export const STORAGE_KEY = 'gta.settings.v1';

export const SENS_MIN = 0.0004;
export const SENS_MAX = 0.0075;

interface StoredSettings {
  quality?: Quality;
  masterVolume?: number;
  lookSensitivity?: number;
  invertY?: boolean;
}

export function storedQuality(raw: string | null): Quality | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredSettings;
    return isQuality(value?.quality) ? value.quality : null;
  } catch {
    return null;
  }
}

export function loadStoredQuality(storage?: Pick<Storage, 'getItem'>): Quality | null {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    return source ? storedQuality(source.getItem(STORAGE_KEY)) : null;
  } catch {
    return null;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** "2.20" — sensitivity in the same units the pause menu prints. */
export function sensLabel(s: number): string {
  return (s * 1000).toFixed(2);
}

/** Step a quality tier without falling off either end. */
export function stepQuality(q: Quality, dir: number): Quality {
  const i = QUALITIES.indexOf(q);
  return QUALITIES[clamp((i < 0 ? 2 : i) + dir, 0, QUALITIES.length - 1)];
}

export class Settings {
  constructor(private readonly ctx: GameContext) {}

  private get render(): RenderService | undefined {
    return this.ctx.tryGet(Services.Render);
  }

  get quality(): Quality {
    return this.render?.quality ?? 'high';
  }

  setQuality(q: Quality): void {
    const r = this.render;
    if (!r) return;
    if (r.quality !== q) r.setQuality(q);
    this.persist();
  }

  get masterVolume(): number {
    return this.ctx.tryGet(Services.Audio)?.masterVolume ?? 0.8;
  }

  setMasterVolume(v: number): void {
    const a = this.ctx.tryGet(Services.Audio);
    if (a) a.masterVolume = clamp01(v);
    this.persist();
  }

  get lookSensitivity(): number {
    return this.ctx.input.lookSensitivity;
  }

  setLookSensitivity(v: number): void {
    this.ctx.input.lookSensitivity = clamp(v, SENS_MIN, SENS_MAX);
    this.persist();
  }

  get invertY(): boolean {
    return this.ctx.input.invertY;
  }

  setInvertY(b: boolean): void {
    this.ctx.input.invertY = b;
    this.persist();
  }

  /** Audio is only allowed to make a sound after a real gesture. */
  async unlockAudio(): Promise<void> {
    try {
      await this.ctx.tryGet(Services.Audio)?.unlock();
    } catch {
      /* a blocked AudioContext must not stop the game starting */
    }
  }

  persist(): void {
    const s: StoredSettings = {
      quality: this.quality,
      masterVolume: this.masterVolume,
      lookSensitivity: this.lookSensitivity,
      invertY: this.invertY,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* private mode */
    }
  }
}
