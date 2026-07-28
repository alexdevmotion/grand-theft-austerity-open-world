/** Typed, allocation-light event bus shared by every system. */

import type { Vector3 } from 'three';

export interface GameEvents {
  /** Mission / story spine. */
  'mission:advance': { id: string };
  'mission:complete': { id: string };
  'mission:failed': { id: string; reason: string };
  'objective:changed': { title: string; subtitle?: string; target?: Vector3 };

  /** Political Instability — the wanted system. */
  'instability:changed': { stars: number; previous: number };
  'instability:cleared': Record<string, never>;

  /** Player state. */
  'player:enteredVehicle': { vehicleId: string };
  'player:exitedVehicle': { vehicleId: string };
  'player:damaged': { amount: number; health: number };
  'player:died': { cause: string };
  'player:respawned': { position: Vector3 };
  'player:interact': { targetId: string };

  /** World feedback. */
  'vehicle:collision': { vehicleId: string; impulse: number; position: Vector3 };
  'vehicle:destroyed': { vehicleId: string };
  'ped:killed': { position: Vector3 };
  'prop:broken': { kind: string; position: Vector3 };

  /** Side activities & progression. */
  'activity:started': { id: string; kind: string };
  'activity:finished': { id: string; kind: string; score: number; reward: number };
  'progression:xp': { amount: number; total: number; reason: string };
  'progression:levelUp': { level: number; unlock: string };
  'economy:changed': { lei: number; delta: number; reason: string };

  /** Presentation. */
  'ui:toast': { text: string; kind?: 'info' | 'good' | 'bad'; ms?: number };
  'ui:subtitle': { speaker: string; text: string; ms?: number };
  'ui:missionCard': { title: string; subtitle: string };
  'audio:oneShot': { id: string; position?: Vector3; volume?: number };
  'radio:line': { text: string };

  /** Environment. */
  'weather:changed': { preset: string };
  'timeOfDay:changed': { hours: number };
  'broadcast:hijacked': Record<string, never>;
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

export class EventBus {
  private map = new Map<string, Set<(p: unknown) => void>>();

  on<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    let set = this.map.get(key as string);
    if (!set) {
      set = new Set();
      this.map.set(key as string, set);
    }
    set.add(fn as (p: unknown) => void);
    return () => set!.delete(fn as (p: unknown) => void);
  }

  once<K extends keyof GameEvents>(key: K, fn: Handler<K>): () => void {
    const off = this.on(key, ((p: GameEvents[K]) => {
      off();
      fn(p);
    }) as Handler<K>);
    return off;
  }

  emit<K extends keyof GameEvents>(key: K, payload: GameEvents[K]): void {
    const set = this.map.get(key as string);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${String(key)}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
