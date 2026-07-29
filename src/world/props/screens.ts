/**
 * Facade SCREENS — the story-critical prop.
 *
 * Every large screen in the city carries the same state broadcast: George
 * Georgescu's portrait, a lower-third strap and a scrolling ticker. That is
 * exactly what the reference frame shows on the tower's curtain wall, and it
 * is the one piece of dressing that has to be animated.
 *
 * One canvas is repainted at ~12 Hz and shared by every screen, so the whole
 * network costs one texture upload and one draw call.
 *
 * OWNER: props / street-dressing agent.
 */

import * as THREE from 'three';
import { PAL } from '../../render/materials';

const W = 1024;
const H = 512;

const TICKER = [
  'GUVERNUL ANUNȚĂ PLANUL NAȚIONAL DE AUSTERITATE  ●  ',
  'CONSTRUCȚIILE CONTINUĂ ÎN CIUDA PROTESTELOR  ●  ',
  'B★ BUILDERSTAR SEMNEAZĂ CONTRACTUL SECOLULUI  ●  ',
  'MINISTERUL: „TOTUL ESTE SUB CONTROL"  ●  ',
  'PIAȚA CONSTITUȚIEI ÎNCHISĂ PÂNĂ LA NOI ORDINE  ●  ',
].join('');

const STRAPS = [
  'GEORGE GEORGESCU · PREȘEDINTELE CONSILIULUI',
  'ÎN DIRECT · PALATUL PARLAMENTULUI',
  'DECLARAȚIE DE PRESĂ · ORDINE ȘI BETON',
  'EXCLUSIV · PLANUL NAȚIONAL 2031',
];

export interface ScreenPlacement {
  x: number;
  y: number;
  z: number;
  /** Metres. */
  w: number;
  h: number;
  /** Facing direction. */
  nx: number;
  nz: number;
}

/**
 * The shared broadcast. `mesh` is a single InstancedMesh covering every screen
 * placed in the world.
 */
export class BroadcastScreens {
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshBasicMaterial;
  mesh: THREE.InstancedMesh | null = null;

  private readonly g: CanvasRenderingContext2D;
  private t = 0;
  private repaintAccum = 0;
  private placements: ScreenPlacement[] = [];

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('[props] 2D canvas unavailable for screens');
    this.g = g;
    this.paint(0);

    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.needsUpdate = true;

    // Screens are light sources, not lit surfaces: an unlit material is both
    // cheaper and correct, and keeps them readable against the sunset.
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      toneMapped: true,
      side: THREE.FrontSide,
    });
    this.material.name = 'gta:screens';
  }

  add(p: ScreenPlacement): void {
    this.placements.push(p);
  }

  get count(): number {
    return this.placements.length;
  }

  build(): THREE.InstancedMesh | null {
    const n = this.placements.length;
    if (!n) return null;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.InstancedMesh(geo, this.material, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = this.placements[i];
      q.setFromAxisAngle(up, Math.atan2(p.nx, p.nz));
      pos.set(p.x, p.y, p.z);
      scl.set(p.w, p.h, 1);
      mesh.setMatrixAt(i, m.compose(pos, q, scl));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'props-screens';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.computeBoundingSphere();
    this.mesh = mesh;
    return mesh;
  }

  update(dt: number): void {
    this.t += dt;
    this.repaintAccum += dt;
    // 12 Hz. A 1024x512 upload every frame is a megabyte of PCI traffic for
    // detail nobody can read at that rate.
    if (this.repaintAccum < 1 / 12) return;
    this.repaintAccum = 0;
    this.paint(this.t);
    this.texture.needsUpdate = true;
  }

  /* ---------------- painting ---------------- */

  private paint(t: number): void {
    const g = this.g;
    // Cycle: 7 s portrait, 2.2 s full-screen slogan.
    const cycle = t % 9.2;
    const slogan = cycle > 7.0;

    const grd = g.createLinearGradient(0, 0, W * 0.4, H);
    grd.addColorStop(0, '#2a0f45');
    grd.addColorStop(0.55, '#4a1550');
    grd.addColorStop(1, '#12071f');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);

    if (slogan) this.paintSlogan(t);
    else this.paintPortrait(t);

    this.paintStrap(t);
    this.paintFurniture(t);
  }

  private paintPortrait(t: number): void {
    const g = this.g;
    // Slow push-in, so the screen is visibly moving even in a still frame.
    const k = 1 + 0.045 * Math.sin(t * 0.4);
    const cx = W * 0.62;
    const cy = H * 0.56 * k;
    const r = H * 0.30 * k;

    // Studio backdrop glow.
    const halo = g.createRadialGradient(cx, cy - r * 0.4, r * 0.2, cx, cy, r * 3.2);
    halo.addColorStop(0, 'rgba(255,120,180,0.5)');
    halo.addColorStop(1, 'rgba(20,6,40,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);

    // Shoulders.
    g.fillStyle = '#17121f';
    g.beginPath();
    g.ellipse(cx, cy + r * 2.3, r * 2.1, r * 1.35, 0, 0, Math.PI * 2);
    g.fill();
    // Head.
    g.fillStyle = '#c99878';
    g.beginPath();
    g.ellipse(cx, cy, r * 0.82, r * 1.02, 0, 0, Math.PI * 2);
    g.fill();
    // Hair.
    g.fillStyle = '#6f6b74';
    g.beginPath();
    g.ellipse(cx, cy - r * 0.62, r * 0.88, r * 0.5, 0, Math.PI, Math.PI * 2);
    g.fill();
    // Features.
    g.fillStyle = 'rgba(24,14,22,0.8)';
    g.fillRect(cx - r * 0.46, cy - r * 0.14, r * 0.34, r * 0.09);
    g.fillRect(cx + r * 0.12, cy - r * 0.14, r * 0.34, r * 0.09);
    g.fillRect(cx - r * 0.24, cy + r * 0.44, r * 0.48, r * 0.07);
    g.fillStyle = 'rgba(90,50,50,0.5)';
    g.beginPath();
    g.ellipse(cx, cy + r * 0.16, r * 0.14, r * 0.22, 0, 0, Math.PI * 2);
    g.fill();
    // Collar + tie.
    g.fillStyle = '#efe9df';
    g.beginPath();
    g.moveTo(cx - r * 0.62, cy + r * 1.28);
    g.lineTo(cx, cy + r * 1.75);
    g.lineTo(cx + r * 0.62, cy + r * 1.28);
    g.lineTo(cx, cy + r * 1.18);
    g.closePath();
    g.fill();
    g.fillStyle = '#9c1626';
    g.beginPath();
    g.moveTo(cx - r * 0.13, cy + r * 1.5);
    g.lineTo(cx + r * 0.13, cy + r * 1.5);
    g.lineTo(cx + r * 0.2, cy + r * 3.0);
    g.lineTo(cx - r * 0.2, cy + r * 3.0);
    g.closePath();
    g.fill();
    // Warm rim light on the sunset side.
    g.strokeStyle = 'rgba(255,158,96,0.85)';
    g.lineWidth = 7;
    g.beginPath();
    g.ellipse(cx, cy, r * 0.82, r * 1.02, 0, Math.PI * 0.12, Math.PI * 0.88);
    g.stroke();

    // Left-hand caption block.
    g.fillStyle = 'rgba(10,4,20,0.55)';
    g.fillRect(0, H * 0.16, W * 0.4, H * 0.42);
    g.fillStyle = '#ffd9a0';
    g.textAlign = 'left';
    g.font = 'bold 58px ui-sans-serif, system-ui, sans-serif';
    g.fillText('GEORGE', 42, H * 0.28);
    g.fillText('GEORGESCU', 42, H * 0.40);
    g.font = '26px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = '#ff9ad0';
    g.fillText('CONSILIUL NAȚIONAL AL CONSTRUCȚIILOR', 42, H * 0.50);
  }

  private paintSlogan(t: number): void {
    const g = this.g;
    const pulse = 0.6 + 0.4 * Math.sin(t * 6.0);
    g.textAlign = 'center';
    g.fillStyle = `rgba(255,47,142,${(0.18 + pulse * 0.18).toFixed(3)})`;
    g.fillRect(0, H * 0.24, W, H * 0.44);
    g.fillStyle = '#ffe9c0';
    g.font = 'bold 96px ui-sans-serif, system-ui, sans-serif';
    g.fillText('ORDINE', W / 2, H * 0.40);
    g.font = 'bold 70px ui-sans-serif, system-ui, sans-serif';
    g.fillText('MUNCĂ · BETON', W / 2, H * 0.56);
    g.font = '30px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = '#ffb3dd';
    g.fillText('PLANUL NAȚIONAL DE AUSTERITATE 2031', W / 2, H * 0.66);
  }

  private paintStrap(t: number): void {
    const g = this.g;
    // Lower third.
    g.fillStyle = 'rgba(8,3,18,0.85)';
    g.fillRect(0, H * 0.72, W, H * 0.14);
    g.fillStyle = '#ff2f8e';
    g.fillRect(0, H * 0.72, W * 0.012, H * 0.14);
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = 'bold 34px ui-sans-serif, system-ui, sans-serif';
    g.fillText(STRAPS[Math.floor(t / 4.6) % STRAPS.length], 34, H * 0.795);

    // Ticker.
    g.fillStyle = 'rgba(255,47,142,0.92)';
    g.fillRect(0, H * 0.87, W, H * 0.1);
    g.fillStyle = '#12061c';
    g.font = 'bold 30px ui-sans-serif, system-ui, sans-serif';
    const scroll = (t * 130) % (TICKER.length * 15);
    g.save();
    g.beginPath();
    g.rect(0, H * 0.87, W, H * 0.1);
    g.clip();
    g.fillText(TICKER, W - scroll, H * 0.925);
    g.fillText(TICKER, W - scroll + TICKER.length * 15, H * 0.925);
    g.restore();
  }

  private paintFurniture(t: number): void {
    const g = this.g;
    // Station bug.
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.font = 'bold 30px ui-sans-serif, system-ui, sans-serif';
    g.fillText('★ NAȚIONAL', W - 210, 52);
    // LIVE dot.
    if (Math.floor(t * 1.4) % 2 === 0) {
      g.fillStyle = '#ff2020';
      g.beginPath();
      g.arc(W - 236, 44, 9, 0, Math.PI * 2);
      g.fill();
    }
    // Scanlines + a rolling interference band: what makes it read as a screen.
    g.globalAlpha = 0.16;
    g.fillStyle = '#000000';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
    g.globalAlpha = 1;
    const band = ((t * 90) % (H + 200)) - 100;
    const bg = g.createLinearGradient(0, band - 60, 0, band + 60);
    bg.addColorStop(0, 'rgba(255,255,255,0)');
    bg.addColorStop(0.5, 'rgba(255,220,255,0.10)');
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = bg;
    g.fillRect(0, band - 60, W, 120);
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh?.geometry.dispose();
  }
}

/** Colour of the spill a screen throws onto the facade around it. */
export const SCREEN_SPILL = PAL.builderMagenta;
