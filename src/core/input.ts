/** Unified keyboard / mouse / gamepad input with pointer-lock camera look. */

export interface InputAxes {
  /** -1..1, strafe left/right (A/D). */
  moveX: number;
  /** -1..1, forward/back (W/S). */
  moveY: number;
  /** Accumulated mouse delta since last frame, in radians-ish units. */
  lookX: number;
  lookY: number;
  /** Vehicle: -1 (full brake/reverse) .. 1 (full throttle). */
  throttle: number;
  /** Vehicle: -1 (left) .. 1 (right). */
  steer: number;
}

export type ActionName =
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'interact'
  | 'handbrake'
  | 'horn'
  | 'aim'
  | 'fire'
  | 'punch'
  | 'exitVehicle'
  | 'cameraSwitch'
  | 'map'
  | 'pause'
  | 'radioNext'
  | 'lookBehind'
  | 'photoMode';

const KEY_ACTIONS: Record<string, ActionName> = {
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyE: 'interact',
  KeyF: 'interact',
  KeyH: 'horn',
  KeyQ: 'punch',
  KeyV: 'cameraSwitch',
  KeyM: 'map',
  KeyR: 'radioNext',
  KeyP: 'photoMode',
  Escape: 'pause',
  KeyX: 'pause',
  KeyB: 'lookBehind',
};

/**
 * The movement axes, as the keys `update()` really reads. Exported so the
 * loading screen and the first-run card can teach movement without a live
 * `Input` to probe — `update()` reads this same table, so the two cannot drift.
 */
export const MOVE_KEYS: Record<'forward' | 'back' | 'left' | 'right', readonly string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};

/** Handbrake is Space while driving — see `Input.handbrake`. */
export const HANDBRAKE_KEY = 'Space';

/** Every key bound to `a`, in declaration order. The map itself stays private. */
export function keysForAction(a: ActionName): string[] {
  return Object.keys(KEY_ACTIONS).filter((code) => KEY_ACTIONS[code] === a);
}

export class Input {
  readonly axes: InputAxes = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, throttle: 0, steer: 0 };

  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  private actionsDown = new Set<ActionName>();
  private actionsPressed = new Set<ActionName>();
  private mouseButtons = new Set<number>();
  private mousePressed = new Set<number>();
  private accumLookX = 0;
  private accumLookY = 0;
  private gamepadIndex: number | null = null;

  /** Sensitivity, radians per pixel. */
  lookSensitivity = 0.0022;
  invertY = false;
  /** True while pointer is locked to the canvas. */
  pointerLocked = false;
  enabled = true;

  private el: HTMLElement;
  private disposers: Array<() => void> = [];

  constructor(el: HTMLElement) {
    this.el = el;
    this.bind();
  }

  private bind(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Let the browser keep F-keys and devtools shortcuts.
      if (e.code.startsWith('F') && e.code.length <= 3) return;
      this.down.add(e.code);
      this.pressedThisFrame.add(e.code);
      const a = KEY_ACTIONS[e.code];
      if (a) {
        this.actionsDown.add(a);
        this.actionsPressed.add(a);
      }
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.down.delete(e.code);
      this.releasedThisFrame.add(e.code);
      const a = KEY_ACTIONS[e.code];
      if (a) this.actionsDown.delete(a);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked) return;
      this.accumLookX += e.movementX * this.lookSensitivity;
      this.accumLookY += e.movementY * this.lookSensitivity * (this.invertY ? -1 : 1);
    };
    const onMouseDown = (e: MouseEvent) => {
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
      // Left click is the attack button: it fires when armed and throws a
      // punch when not, so both actions are raised and the player system
      // picks whichever applies.
      if (e.button === 0) {
        this.actionsDown.add('fire');
        this.actionsDown.add('punch');
        this.actionsPressed.add('fire');
        this.actionsPressed.add('punch');
      }
      if (e.button === 2) this.actionsDown.add('aim');
    };
    const onMouseUp = (e: MouseEvent) => {
      this.mouseButtons.delete(e.button);
      if (e.button === 0) {
        this.actionsDown.delete('fire');
        this.actionsDown.delete('punch');
      }
      if (e.button === 2) this.actionsDown.delete('aim');
    };
    const onCtx = (e: Event) => e.preventDefault();
    const onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.el;
    };
    const onBlur = () => {
      this.down.clear();
      this.actionsDown.clear();
      this.mouseButtons.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onBlur);
    this.el.addEventListener('contextmenu', onCtx);
    document.addEventListener('pointerlockchange', onLockChange);

    this.disposers.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      this.el.removeEventListener('contextmenu', onCtx);
      document.removeEventListener('pointerlockchange', onLockChange);
    });
  }

  requestPointerLock(): void {
    if (!this.pointerLocked) void this.el.requestPointerLock?.();
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  /** Call once per frame BEFORE systems read input. */
  update(): void {
    const gp = this.pollGamepad();

    if (!this.enabled) {
      this.axes.moveX = this.axes.moveY = this.axes.lookX = this.axes.lookY = 0;
      this.axes.throttle = this.axes.steer = 0;
      return;
    }

    const axis = (pos: readonly string[], neg: readonly string[]): number =>
      (pos.some((c) => this.isDown(c)) ? 1 : 0) - (neg.some((c) => this.isDown(c)) ? 1 : 0);
    const kx = axis(MOVE_KEYS.right, MOVE_KEYS.left);
    const ky = axis(MOVE_KEYS.forward, MOVE_KEYS.back);

    this.axes.moveX = gp ? clampUnit(kx + gp.lx) : kx;
    this.axes.moveY = gp ? clampUnit(ky - gp.ly) : ky;
    this.axes.steer = this.axes.moveX;
    this.axes.throttle = gp ? clampUnit(ky + gp.rt - gp.lt) : ky;

    this.axes.lookX = this.accumLookX + (gp ? gp.rx * 0.055 : 0);
    this.axes.lookY = this.accumLookY + (gp ? gp.ry * 0.055 * (this.invertY ? -1 : 1) : 0);
    this.accumLookX = 0;
    this.accumLookY = 0;
  }

  /** Call once per frame AFTER systems read input. */
  postUpdate(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.actionsPressed.clear();
    this.mousePressed.clear();
  }

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }
  wasPressed(code: string): boolean {
    return this.enabled && this.pressedThisFrame.has(code);
  }
  /** Actions held down by the debug harness during automated playtests. */
  readonly forcedActions = new Set<ActionName>();

  action(a: ActionName): boolean {
    return this.enabled && (this.actionsDown.has(a) || this.forcedActions.has(a));
  }
  actionPressed(a: ActionName): boolean {
    return this.enabled && this.actionsPressed.has(a);
  }
  mouseDown(button = 0): boolean {
    return this.enabled && this.mouseButtons.has(button);
  }
  mouseClicked(button = 0): boolean {
    return this.enabled && this.mousePressed.has(button);
  }
  /** Handbrake is Space while driving — resolved by the vehicle system. */
  get handbrake(): boolean {
    return this.isDown(HANDBRAKE_KEY) || (this.enabled && this.forcedActions.has('handbrake'));
  }

  private pollGamepad(): { lx: number; ly: number; rx: number; ry: number; lt: number; rt: number } | null {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        this.gamepadIndex = p.index;
        break;
      }
    }
    if (!pad) return null;
    const dz = (v: number) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
    if (pad.buttons[0]?.pressed) this.actionsDown.add('jump');
    else this.actionsDown.delete('jump');
    if (pad.buttons[2]?.pressed) this.actionsDown.add('interact');
    else this.actionsDown.delete('interact');
    return {
      lx: dz(pad.axes[0] ?? 0),
      ly: dz(pad.axes[1] ?? 0),
      rx: dz(pad.axes[2] ?? 0),
      ry: dz(pad.axes[3] ?? 0),
      lt: pad.buttons[6]?.value ?? 0,
      rt: pad.buttons[7]?.value ?? 0,
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
