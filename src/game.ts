/**
 * Game assembly. This is the ONE place where concrete systems are wired.
 *
 * Add a system here, in dependency order. Systems talk to each other only
 * through `Services` (see src/core/services.ts), never by direct import.
 */

import * as THREE from 'three';
import { Engine } from './core/engine';
import { PhysicsWorld } from './physics/physics';
import { createRenderer, detectQuality, type Quality } from './render/renderer';
import { PostFXSystem } from './render/postfx';
import { SkySystem } from './render/sky';
import { LightingSystem } from './render/lighting';
import { CitySystem } from './world/city';
import { PropsSystem } from './world/props';
import { VehicleSystem } from './vehicles/vehicleSystem';
import { TrafficSystem } from './ai/traffic';
import { PedSystem } from './ai/peds';
import { PoliceSystem } from './ai/police';
import { PlayerSystem } from './gameplay/player';
import { CameraSystem } from './gameplay/cameraSystem';
import { WantedSystem } from './gameplay/wanted';
import { MissionSystem } from './gameplay/missions';
import { ActivitySystem } from './gameplay/activities';
import { ProgressionSystem } from './gameplay/progression';
import { HudSystem } from './ui/hud';
import { AudioSystem } from './audio/audioSystem';
import { WeatherSystem } from './world/weather';
import { DebugSystem } from './core/debug';
import { MenuSystem } from './ui/menu/menuSystem';
import { MinimapSystem } from './ui/map/minimapSystem';
import { InteriorSystem } from './world/interiors/interiorSystem';

export interface GameHandle {
  engine: Engine;
  start(): void;
  stop(): void;
  dispose(): void;
}

export async function createGame(
  canvas: HTMLCanvasElement,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<GameHandle> {
  const params = new URLSearchParams(location.search);
  const quality = (params.get('q') as Quality | null) ?? detectQuality();

  const renderer = createRenderer(canvas, quality);
  const engine = new Engine(canvas, renderer);

  engine.scene.background = new THREE.Color(0x0b0716);

  engine
    // --- foundation ---------------------------------------------------
    .add(new PhysicsWorld())              // 50
    // --- world --------------------------------------------------------
    .add(new SkySystem())                 // 10
    .add(new LightingSystem())            // 12
    .add(new WeatherSystem())             // 14
    .add(new CitySystem())                // 20
    .add(new PropsSystem())               // 30
    .add(new InteriorSystem())            // 25
    // --- simulation ---------------------------------------------------
    .add(new VehicleSystem())             // 110
    .add(new PedSystem())                 // 120
    .add(new TrafficSystem())             // 130
    .add(new PoliceSystem())              // 140
    // --- gameplay -----------------------------------------------------
    .add(new PlayerSystem())              // 200
    .add(new WantedSystem())              // 210
    .add(new ProgressionSystem())         // 215
    .add(new MissionSystem())             // 220
    .add(new ActivitySystem())            // 230
    .add(new CameraSystem())              // 300
    // --- presentation --------------------------------------------------
    .add(new AudioSystem())               // 410
    .add(new HudSystem())                 // 420
    .add(new MinimapSystem())             // 425
    .add(new MenuSystem())                // 430
    .add(new DebugSystem())               // 990
    .add(new PostFXSystem(quality));      // 900

  await engine.initSystems(onProgress);

  return {
    engine,
    start: () => engine.start(),
    stop: () => engine.stop(),
    dispose: () => engine.dispose(),
  };
}
