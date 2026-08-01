/**
 * Game assembly. This is the ONE place where concrete systems are wired.
 *
 * Add a system here, in dependency order. Systems talk to each other only
 * through `Services` (see src/core/services.ts), never by direct import.
 *
 * THIS FILE WAS FROZEN AND IS NOT ANY MORE
 * ----------------------------------------
 * The freeze was a merge-conflict policy for a parallel fan-out, and it long
 * outlived the fan-out. What it actually produced was a second, undocumented
 * seam: things that should have been systems became fields on whichever system
 * happened to be registered near them — the interaction registry, the cast
 * director and Builders House hung off `MissionSystem`; the pause menu hung off
 * `HudSystem`; the front-end mounted its DOM at *module import time* because
 * its init order was too late to be useful. Every one of those is a system in
 * its own right now, registered here, with an order that means one thing.
 *
 * ORDER MEANS SEQUENCE, AND NOTHING ELSE. What survives a pause is
 * `System.ticksWhenPaused`, declared by the system or stated here for systems
 * whose own file is owned elsewhere. It used to be inferred from `order >= 400`,
 * which is why the menu had to live at 430 whether it belonged there or not.
 */

import * as THREE from 'three';
import { Engine } from './core/engine';
import { PhysicsWorld } from './physics/physics';
import { createRenderer, detectQuality, isQuality } from './render/renderer';
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
import { InteractionSystem } from './gameplay/interaction';
import { CastDirector } from './gameplay/cast';
import { BuildersHouseSystem } from './gameplay/buildersHouse';
import { MissionSystem } from './gameplay/missions';
import { ActivitySystem } from './gameplay/activities';
import { ProgressionSystem } from './gameplay/progression';
import { SaveSystem } from './core/save';
import { HudSystem } from './ui/hud';
import { PauseMenu } from './ui/pauseMenu';
import { AudioSystem } from './audio/audioSystem';
import { WeatherSystem } from './world/weather';
import { DebugSystem } from './core/debug';
import { MenuSystem } from './ui/menu/menuSystem';
import { MinimapSystem } from './ui/map/minimapSystem';
import { InteriorSystem } from './world/interiors/interiorSystem';
import { Services } from './core/services';
import { loadStoredQuality } from './ui/menu/settings';

export interface GameHandle {
  engine: Engine;
  start(): void;
  stop(): void;
  dispose(): void;
}

/**
 * Systems whose files are owned by other areas but which must keep ticking
 * with the world stopped. Declared here rather than edited into their files;
 * when an owner adds `readonly ticksWhenPaused = true` themselves, delete the
 * entry — the two agree, so neither is load-bearing on its own.
 *
 *   audio    the bus has to duck and fade while a menu is up
 *   minimap  it is visible behind the pause overlay
 *   postfx   the frame is still being composited; a paused post chain is a
 *            frozen, ungraded image under a blurred menu
 */
const PAUSED = { ticksWhenPaused: true } as const;

export async function createGame(
  canvas: HTMLCanvasElement,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<GameHandle> {
  const params = new URLSearchParams(location.search);
  const queryQuality = params.get('q');
  const quality = isQuality(queryQuality)
    ? queryQuality
    : loadStoredQuality() ?? detectQuality();

  const renderer = createRenderer(canvas, quality);
  const engine = new Engine(canvas, renderer);
  const postfx = new PostFXSystem(quality);

  // Publish the chosen startup tier before world systems initialise. Several
  // of them size pools and draw distances during init, while PostFX itself is
  // deliberately initialised last.
  engine.provide(Services.Render, postfx);

  engine.scene.background = new THREE.Color(0x0b0716);

  engine
    // --- boot ------------------------------------------------------------
    .add(new DebugSystem())               // 1    synthetic input, harness hooks
    .add(new MenuSystem())                // 2    front-end: covers the WHOLE load
    .add(new PhysicsWorld())              // 5    the world is built into it
    // --- world -----------------------------------------------------------
    .add(new SkySystem())                 // 10
    .add(new LightingSystem())            // 12
    .add(new WeatherSystem())             // 14
    .add(new CitySystem())                // 20
    .add(new InteriorSystem())            // 25
    .add(new PropsSystem())               // 30
    // --- simulation ------------------------------------------------------
    .add(new VehicleSystem())             // 110
    .add(new PedSystem())                 // 120
    .add(new TrafficSystem())             // 130
    .add(new PoliceSystem())              // 140
    // --- gameplay --------------------------------------------------------
    .add(new PlayerSystem())              // 200
    .add(new WantedSystem())              // 210
    .add(new ProgressionSystem())         // 215
    .add(new InteractionSystem())         // 216  the ONE "press E" registry
    .add(new CastDirector())              // 217  Nicușor, Alex, the builders
    .add(new BuildersHouseSystem())       // 218  Act IV's interior + its doorway
    .add(new MissionSystem())             // 220  fills 216/217 in its init
    .add(new ActivitySystem())            // 230
    .add(new SaveSystem())                // 260  reads everything above
    .add(new CameraSystem())              // 300
    // --- presentation ----------------------------------------------------
    .add(new AudioSystem(), PAUSED)       // 410
    .add(new HudSystem())                 // 420
    .add(new MinimapSystem(), PAUSED)     // 425
    .add(new PauseMenu())                 // 440
    .add(postfx, PAUSED);                 // 900

  await engine.initSystems(onProgress);

  return {
    engine,
    start: () => engine.start(),
    stop: () => engine.stop(),
    dispose: () => engine.dispose(),
  };
}
