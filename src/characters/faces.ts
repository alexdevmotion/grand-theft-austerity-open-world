/**
 * FACES — procedural face painting and head UV projection.
 *
 * Every character's head is unwrapped with a warped cylindrical projection into
 * the right half of the appearance atlas (u 0.5..1.0). The projection gives the
 * front of the face ~60% of the available width so eyes, brows and mouth read
 * at gameplay distance, while the back of the skull is squeezed into the edges
 * (where it is hair or shadow anyway).
 *
 * Nothing here is a digital double of any real person — features are sampled
 * from a deterministic parameter space.
 *
 * OWNER: characters agent.
 */

import type { Rng } from '../core/rng';

/** Warp exponent: <1 gives the front of the face more texture width. */
const WARP = 0.55;

/**
 * Head UV: `theta` is the angle around the head (0 = straight ahead, +PI/2 =
 * character's left), `t` is 0 at the crown and 1 at the chin.
 *
 * The face lives in the atlas square x 128..256 / y 0..128 (a 256x256 atlas),
 * i.e. u 0.5..1.0 and v 0.5..1.0 in three.js UV space, so it stays square.
 * Returns three.js UV (origin bottom-left).
 */
export function headUv(theta: number, t: number, out: { u: number; v: number }): void {
  let s = theta / Math.PI;
  if (s > 1) s -= 2;
  if (s < -1) s += 2;
  const w = Math.sign(s) * Math.pow(Math.abs(s), WARP);
  out.u = 0.5 + 0.25 * (1 + w);
  out.v = 1 - t * 0.5;
}

export interface FaceParams {
  /** 0 young .. 1 weathered. Drives wrinkles, eye bags, jowls. */
  age: number;
  browHeight: number;   // 0..1
  browThick: number;    // 0..1
  eyeSpacing: number;   // 0..1
  eyeSize: number;      // 0..1
  noseWidth: number;    // 0..1
  noseLength: number;   // 0..1
  mouthWidth: number;   // 0..1
  lipFull: number;      // 0..1
  jaw: number;          // 0..1 narrow..square
  stubble: number;      // 0..1
  beard: number;        // 0 none, 1 full
  brow: number;         // brow darkness
  eyeColor: number;     // hex
  /** Deep-set tired eyes + heavy brow. The hero is defined by this. */
  tired: number;
  cheek: number;
  /** 0..1 lipstick / makeup presence. */
  makeup: number;
  freckles: number;
}

export function rollFace(rng: Rng, opts: { female: boolean; age?: number }): FaceParams {
  const age = opts.age ?? rng.range(0.12, 0.85);
  return {
    age,
    browHeight: rng.next(),
    browThick: opts.female ? rng.range(0, 0.45) : rng.range(0.35, 1),
    eyeSpacing: rng.next(),
    eyeSize: opts.female ? rng.range(0.4, 1) : rng.range(0.2, 0.8),
    noseWidth: rng.next(),
    noseLength: rng.next(),
    mouthWidth: rng.next(),
    lipFull: opts.female ? rng.range(0.4, 1) : rng.range(0.1, 0.65),
    jaw: opts.female ? rng.range(0, 0.5) : rng.range(0.35, 1),
    stubble: opts.female ? 0 : rng.range(0, 0.9),
    beard: opts.female ? 0 : rng.bool(0.28) ? rng.range(0.4, 1) : 0,
    brow: rng.range(0.5, 1),
    eyeColor: rng.pick([0x4a3826, 0x2e2018, 0x5a6a52, 0x3f5a70, 0x6b5236]),
    tired: rng.range(0, 0.7),
    cheek: rng.next(),
    makeup: opts.female && rng.bool(0.55) ? rng.range(0.3, 1) : 0,
    freckles: rng.bool(0.18) ? rng.range(0.2, 0.8) : 0,
  };
}

/** Ilie Bolojan-Agatinei: mid-fifties, heavy brow, permanently exhausted. */
export const HERO_FACE: FaceParams = {
  age: 0.62,
  browHeight: 0.24,
  browThick: 0.88,
  eyeSpacing: 0.46,
  eyeSize: 0.42,
  noseWidth: 0.58,
  noseLength: 0.66,
  mouthWidth: 0.52,
  lipFull: 0.3,
  jaw: 0.82,
  stubble: 0.72,
  beard: 0.55,
  brow: 0.95,
  eyeColor: 0x3a2a1c,
  tired: 0.95,
  cheek: 0.35,
  makeup: 0,
  freckles: 0,
};

/**
 * Neutral base parameters for the crowd imposter atlas. The live renderer
 * derives several readable identities from this baseline while preserving the
 * same landmark proportions as fitted actor heads.
 */
export const CROWD_FACE: FaceParams = {
  age: 0.38,
  browHeight: 0.5,
  browThick: 0.55,
  eyeSpacing: 0.5,
  eyeSize: 0.55,
  noseWidth: 0.5,
  noseLength: 0.5,
  mouthWidth: 0.5,
  lipFull: 0.4,
  jaw: 0.5,
  stubble: 0,
  beard: 0,
  brow: 0.85,
  eyeColor: 0x3a2a1c,
  tired: 0.35,
  cheek: 0.3,
  makeup: 0,
  freckles: 0,
};

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the features land inside the face square, as fractions of it.
 *
 * `paintFace` is the only thing that draws them and this is the only thing
 * that decides where — so a test can ask "does the head geometry actually put
 * a visible, front-facing surface under the eye landmark" without owning a
 * copy of the numbers that would drift the moment the face is retouched.
 *
 * Horizontal is measured from the centre of the square (0.5), vertical from
 * the crown (0) to below the chin (1), matching `headUv`'s `t`.
 */
export interface FaceLandmarks {
  yHair: number; yBrow: number; yEye: number;
  yNose: number; yMouth: number; yChin: number;
  /** Eye centre offset from the midline, in square fractions. */
  eyeDx: number;
  eyeRx: number;
  eyeRy: number;
  /** Half-width of the front of the face in the square: theta = ±55°. */
  faceHalf: number;
}

export function faceLandmarks(f: FaceParams): FaceLandmarks {
  return {
    // Matched to the geometry: the hair shell meets the skull at ~0.33 from the
    // crown, the eye line sits at half the jaw-to-crown span.
    yHair: 0.300 + f.browHeight * 0.035,
    yBrow: 0.458 + f.browHeight * 0.028,
    yEye: 0.516,
    yNose: 0.618 + f.noseLength * 0.035,
    yMouth: 0.735 + f.lipFull * 0.012,
    yChin: 0.918,
    eyeDx: (0.052 + f.eyeSpacing * 0.018) * 2,
    eyeRx: (0.030 + f.eyeSize * 0.010) * 2,
    eyeRy: (0.012 + f.eyeSize * 0.006) * 2 * (1 - f.tired * 0.28),
    faceHalf: 0.25 * Math.pow(55 / 180, WARP) * 2,
  };
}

/** The landmarks the crowd's shared imposter face is painted with. */
export const FACE_LANDMARKS: FaceLandmarks = faceLandmarks(CROWD_FACE);

function rgb(hex: number, a = 1): string {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
}

function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    ((ar + (br - ar) * t) << 16) |
    ((ag + (bg - ag) * t) << 8) |
    (ab + (bb - ab) * t)
  ) & 0xffffff;
}

export interface FaceTonePalette {
  /** Wide, translucent form shadow used across the brow and face sides. */
  shadow: number;
  /** Strongest broad shadow used in sockets and under the jaw. */
  deep: number;
  /** Narrow landmark ink for lids, nostrils and the mouth crease. */
  feature: number;
  blush: number;
}

/**
 * Baked tones for the procedural crowd face.
 *
 * These textures are still lit by the scene. The previous broad shadows mixed
 * 42-60% toward near-black, which meant the darkest supported complexion had
 * only 27% of its base luminance left before sunlight, ambient light and tone
 * mapping were applied. In the close-up QA fixture the entire face therefore
 * collapsed into one black mass even though the hands remained readable.
 *
 * Keep broad form at a reflectance the live light rig can model, then reserve
 * the old dark range for narrow landmarks. This preserves skin hue and facial
 * contrast without emissive fill, extra geometry, materials or draw calls.
 */
export function faceTonePalette(skin: number): FaceTonePalette {
  return {
    shadow: mixHex(skin, 0x2a1420, 0.26),
    deep: mixHex(skin, 0x180a14, 0.38),
    feature: mixHex(skin, 0x180a14, 0.64),
    blush: mixHex(skin, 0xc4564e, 0.3),
  };
}

/**
 * Paint a face into the square region (x0,y0,size). Coordinates inside follow
 * `headUv`: horizontal centre = straight ahead, vertical 0 = crown, 1 = chin.
 */
export function paintFace(
  g: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  size: number,
  f: FaceParams,
  skin: number,
  hair: number,
  rng: Rng,
): void {
  const S = size;
  const cx = x0 + S * 0.5;
  const P = (u: number, v: number): [number, number] => [x0 + S * u, y0 + S * v];
  const L = faceLandmarks(f);
  // Half-width of the visible front of the face in atlas units (theta = +-55deg).
  const faceHalf = L.faceHalf;
  const { shadow, deep, feature, blush } = faceTonePalette(skin);

  /* base skin with vertical shading */
  const grad = g.createLinearGradient(0, y0, 0, y0 + S);
  grad.addColorStop(0, rgb(mixHex(skin, 0xffffff, 0.06)));
  grad.addColorStop(0.42, rgb(skin));
  grad.addColorStop(0.78, rgb(mixHex(skin, 0xd08a70, 0.12)));
  grad.addColorStop(1, rgb(shadow));
  g.fillStyle = grad;
  g.fillRect(x0, y0, S, S);

  /* sides of the head darken toward the back */
  const side = g.createLinearGradient(x0, 0, x0 + S, 0);
  side.addColorStop(0, rgb(deep, 0.95));
  side.addColorStop(0.16, rgb(shadow, 0.5));
  side.addColorStop(0.36, rgb(shadow, 0.0));
  side.addColorStop(0.64, rgb(shadow, 0.0));
  side.addColorStop(0.84, rgb(shadow, 0.5));
  side.addColorStop(1, rgb(deep, 0.95));
  g.fillStyle = side;
  g.fillRect(x0, y0, S, S);

  /* skin grain */
  for (let i = 0; i < 900; i++) {
    const u = rng.next();
    const v = rng.next();
    const a = rng.range(0.02, 0.07);
    g.fillStyle = rng.bool() ? rgb(0xffffff, a * 0.6) : rgb(deep, a);
    const [px, py] = P(u, v);
    g.fillRect(px, py, 1.4, 1.4);
  }

  if (f.freckles > 0) {
    for (let i = 0; i < 60 * f.freckles; i++) {
      const u = 0.5 + (rng.next() - 0.5) * faceHalf * 1.1;
      const v = 0.5 + rng.range(-0.06, 0.16);
      const [px, py] = P(u, v);
      g.fillStyle = rgb(mixHex(skin, 0x7a4a2a, 0.55), rng.range(0.15, 0.4));
      g.beginPath();
      g.arc(px, py, rng.range(0.8, 1.8), 0, 7);
      g.fill();
    }
  }

  /* ---- landmark heights (fraction of the crown->chin span) ---- */
  const { yHair, yBrow, yEye, yNose, yMouth, yChin, eyeDx, eyeRx, eyeRy } = L;

  /* ---- brow ridge shading (the tired, heavy look) ---- */
  const ridge = g.createLinearGradient(0, y0 + S * (yBrow - 0.05), 0, y0 + S * (yEye + 0.05));
  ridge.addColorStop(0, rgb(shadow, 0.0));
  ridge.addColorStop(0.5, rgb(shadow, 0.30 + f.tired * 0.28));
  ridge.addColorStop(1, rgb(shadow, 0.0));
  g.fillStyle = ridge;
  g.fillRect(cx - S * faceHalf, y0 + S * (yBrow - 0.05), S * faceHalf * 2, S * 0.1);

  /* ---- eye sockets ---- */
  for (const s of [-1, 1]) {
    const ex = cx + s * S * eyeDx;
    const ey = y0 + S * yEye;
    const rx = S * eyeRx;
    const ry = S * eyeRy;

    // socket shadow
    const sock = g.createRadialGradient(ex, ey + ry * 0.2, 1, ex, ey, rx * 2.3);
    sock.addColorStop(0, rgb(deep, 0.42 + f.tired * 0.24));
    sock.addColorStop(1, rgb(deep, 0));
    g.fillStyle = sock;
    g.beginPath();
    g.ellipse(ex, ey, rx * 2.3, rx * 2.0, 0, 0, 7);
    g.fill();

    // sclera
    g.fillStyle = rgb(mixHex(0xe8e0dc, skin, 0.18));
    g.beginPath();
    g.ellipse(ex, ey, rx, ry, 0, 0, 7);
    g.fill();

    // iris + pupil
    const irisR = ry * 0.98;
    g.fillStyle = rgb(f.eyeColor);
    g.beginPath();
    g.arc(ex + s * rx * 0.03, ey, irisR, 0, 7);
    g.fill();
    g.fillStyle = rgb(mixHex(f.eyeColor, 0x000000, 0.7));
    g.beginPath();
    g.arc(ex + s * rx * 0.03, ey, irisR * 0.46, 0, 7);
    g.fill();
    g.fillStyle = rgb(0xffffff, 0.85);
    g.beginPath();
    g.arc(ex + s * rx * 0.03 - irisR * 0.3, ey - irisR * 0.32, irisR * 0.24, 0, 7);
    g.fill();

    // Upper lid line + lash. Also thickened: at 0.004 of the square this was a
    // sub-pixel stroke by the time the head reached the screen, so the eye lost
    // its top edge and the sclera bled into the lid — a pale oval with two
    // slightly darker smudges, which is the "blank oval" reading.
    g.strokeStyle = rgb(feature, 0.95);
    g.lineWidth = Math.max(1.5, S * (0.0065 + f.makeup * 0.005));
    g.beginPath();
    g.ellipse(ex, ey, rx * 1.02, ry * 1.02, 0, Math.PI * 1.02, Math.PI * 1.98);
    g.stroke();

    // lower lid / eye bag
    g.strokeStyle = rgb(shadow, 0.25 + f.tired * 0.45);
    g.lineWidth = Math.max(1, S * 0.0035);
    g.beginPath();
    g.ellipse(ex, ey + ry * 0.55, rx * 0.95, ry * 0.9, 0, 0.15, Math.PI - 0.15);
    g.stroke();
    if (f.tired > 0.45 || f.age > 0.5) {
      g.strokeStyle = rgb(shadow, 0.18 + f.tired * 0.22);
      g.beginPath();
      g.ellipse(ex, ey + ry * 1.35, rx * 1.0, ry * 1.1, 0, 0.2, Math.PI - 0.2);
      g.stroke();
    }
  }

  /* ---- brows ----
   *
   * THE CROWD'S FACES READ AS BLANK OVALS AT CONVERSATION DISTANCE, and the
   * brows are most of why. Everything else on this face — sockets, lids, lips,
   * nostrils — is drawn dark against skin; the brows were drawn in a colour
   * mixed only 35% toward black from the character's HAIR, at 0.55-0.95 alpha,
   * in a band 1-2 px tall on a 128 px face square. A blond or grey-haired ped
   * therefore had brows a shade or two off their own forehead, which at the
   * ~40 screen pixels a head covers at three metres is nothing at all.
   *
   * Brows are the highest-contrast feature on a human face after the eyes, and
   * they are the one that survives longest as a face shrinks — which is exactly
   * the range this atlas exists to serve. So: mixed 62% to a near-black brown
   * rather than 35%, drawn opaque, and given real height. `browThick` still
   * varies them; what is gone is the option of a brow you cannot see. */
  const browCol = mixHex(hair, 0x14100a, 0.62);
  for (const s of [-1, 1]) {
    const ex = cx + s * S * eyeDx;
    const by = y0 + S * yBrow;
    const bw = S * eyeRx * (1.34 + f.browThick * 0.28);
    const bh = S * (0.013 + f.browThick * 0.014);
    g.fillStyle = rgb(browCol, 0.86 + f.brow * 0.14);
    g.beginPath();
    g.moveTo(ex - s * bw, by + bh * 0.9);
    g.quadraticCurveTo(ex, by - bh * (0.9 + f.tired * 0.5), ex + s * bw, by + bh * 0.2);
    g.quadraticCurveTo(ex, by + bh * (1.4 - f.tired * 0.3), ex - s * bw, by + bh * 0.9);
    g.fill();
    // A second, softer pass under the head of the brow: real brows are densest
    // at the inner end, and one flat quad reads as a sticker.
    g.fillStyle = rgb(browCol, 0.5);
    g.beginPath();
    g.ellipse(ex - s * bw * 0.45, by + bh * 0.35, bw * 0.42, bh * 0.75, 0, 0, 7);
    g.fill();
  }

  /* ---- nose ---- */
  {
    const nw = S * (0.020 + f.noseWidth * 0.014) * 2;
    const ny = y0 + S * yNose;
    // bridge highlight
    const bri = g.createLinearGradient(cx - nw, 0, cx + nw, 0);
    bri.addColorStop(0, rgb(shadow, 0.35));
    bri.addColorStop(0.45, rgb(0xffffff, 0.10));
    bri.addColorStop(0.62, rgb(0xffffff, 0.05));
    bri.addColorStop(1, rgb(shadow, 0.35));
    g.fillStyle = bri;
    g.fillRect(cx - nw, y0 + S * (yBrow + 0.01), nw * 2, S * (yNose - yBrow));
    // nostrils + tip shadow
    g.fillStyle = rgb(feature, 0.55);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * nw * 0.62, ny, nw * 0.26, nw * 0.16, s * 0.3, 0, 7);
      g.fill();
    }
    g.fillStyle = rgb(shadow, 0.35);
    g.beginPath();
    g.ellipse(cx, ny + nw * 0.16, nw * 0.95, nw * 0.30, 0, 0, Math.PI);
    g.fill();
  }

  /* ---- mouth ---- */
  {
    const mw = S * (0.030 + f.mouthWidth * 0.014) * 2;
    const my = y0 + S * yMouth;
    const lipH = S * (0.006 + f.lipFull * 0.010);
    const lipCol = f.makeup > 0
      ? mixHex(0xb04a56, skin, 0.25 * (1 - f.makeup))
      : mixHex(skin, 0x8e4a4a, 0.42);
    g.fillStyle = rgb(lipCol, 0.9);
    g.beginPath();
    g.moveTo(cx - mw, my);
    g.quadraticCurveTo(cx - mw * 0.45, my - lipH * 1.5, cx, my - lipH * 0.55);
    g.quadraticCurveTo(cx + mw * 0.45, my - lipH * 1.5, cx + mw, my);
    g.quadraticCurveTo(cx, my + lipH * 2.1, cx - mw, my);
    g.fill();
    g.strokeStyle = rgb(feature, 0.6);
    g.lineWidth = Math.max(1, S * 0.0035);
    g.beginPath();
    g.moveTo(cx - mw, my);
    g.quadraticCurveTo(cx, my + lipH * 0.55, cx + mw, my);
    g.stroke();
  }

  /* ---- jaw / chin shading ---- */
  {
    const jg = g.createLinearGradient(0, y0 + S * (yMouth + 0.03), 0, y0 + S);
    jg.addColorStop(0, rgb(shadow, 0));
    jg.addColorStop(0.55, rgb(shadow, 0.18 + f.jaw * 0.12));
    jg.addColorStop(1, rgb(deep, 0.75));
    g.fillStyle = jg;
    g.fillRect(x0, y0 + S * (yMouth + 0.03), S, S * (1 - yMouth - 0.03));
    // chin crease
    g.fillStyle = rgb(shadow, 0.2 + f.jaw * 0.2);
    g.beginPath();
    g.ellipse(cx, y0 + S * yChin, S * 0.028 * (0.7 + f.jaw), S * 0.016, 0, 0, 7);
    g.fill();
  }

  /* ---- cheekbones ---- */
  for (const s of [-1, 1]) {
    const px = cx + s * S * faceHalf * 0.62;
    const py = y0 + S * (yNose - 0.02);
    const cg = g.createRadialGradient(px, py, 1, px, py, S * 0.075);
    cg.addColorStop(0, rgb(blush, 0.10 + f.cheek * 0.16 + f.makeup * 0.18));
    cg.addColorStop(1, rgb(blush, 0));
    g.fillStyle = cg;
    g.beginPath();
    g.arc(px, py, S * 0.075, 0, 7);
    g.fill();
  }

  /* ---- nasolabial folds + forehead lines with age ---- */
  if (f.age > 0.32) {
    const w = (f.age - 0.32) / 0.68;
    g.strokeStyle = rgb(shadow, 0.16 + w * 0.26);
    g.lineWidth = Math.max(1, S * 0.0032);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * S * 0.030, y0 + S * (yNose + 0.005));
      g.quadraticCurveTo(
        cx + s * S * 0.058, y0 + S * (yMouth - 0.005),
        cx + s * S * 0.046, y0 + S * (yMouth + 0.026),
      );
      g.stroke();
    }
    for (let i = 0; i < 3; i++) {
      const ly = y0 + S * (yHair + 0.055 + i * 0.032);
      g.strokeStyle = rgb(shadow, (0.10 + w * 0.20) * (1 - i * 0.22));
      g.beginPath();
      g.moveTo(cx - S * faceHalf * 0.62, ly + S * 0.006);
      g.quadraticCurveTo(cx, ly - S * 0.008, cx + S * faceHalf * 0.62, ly + S * 0.006);
      g.stroke();
    }
    // glabellar (frown) lines — the permanent scowl
    if (f.tired > 0.4) {
      g.strokeStyle = rgb(shadow, 0.18 + f.tired * 0.22);
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + s * S * 0.010, y0 + S * (yBrow - 0.012));
        g.lineTo(cx + s * S * 0.014, y0 + S * (yBrow - 0.048));
        g.stroke();
      }
    }
  }

  /* ---- stubble / beard ---- */
  if (f.stubble > 0.02 || f.beard > 0) {
    const beardCol = mixHex(hair, 0x2b2018, 0.3);
    const density = 1200 * (f.stubble * 0.45 + f.beard * 0.75);
    for (let i = 0; i < density; i++) {
      const u = 0.5 + (rng.next() - 0.5) * faceHalf * 1.9;
      const t = rng.next();
      // Beard region: below the cheekbones, widening toward the jaw.
      const v = yNose + 0.020 + t * (0.255 + f.beard * 0.045);
      if (v > 0.975) continue;
      const centreDist = Math.abs(u - 0.5) / (faceHalf * 0.95);
      if (centreDist > 1.0) continue;
      // Carve out the lips so the mouth still reads.
      if (Math.abs(v - yMouth) < 0.020 && Math.abs(u - 0.5) < 0.046) continue;
      const a = (0.07 + f.beard * 0.34) * (1 - centreDist * 0.4) * rng.range(0.5, 1.15);
      g.fillStyle = rgb(beardCol, Math.min(0.75, a));
      const [px, py] = P(u, v);
      g.fillRect(px, py, 1.4, 1.4);
    }
    // moustache
    if (f.beard > 0.3) {
      g.fillStyle = rgb(beardCol, 0.42 + f.beard * 0.25);
      g.beginPath();
      g.ellipse(cx, y0 + S * (yMouth - 0.030), S * 0.040, S * 0.011, 0, 0, 7);
      g.fill();
    }
  }

  /* ---- ears ---- */
  for (const s of [-1, 1]) {
    // theta = +-82 degrees
    const w = Math.pow(82 / 180, WARP);
    const u = 0.5 + s * 0.5 * w;
    const [px, py] = P(u, yEye + 0.055);
    g.fillStyle = rgb(mixHex(skin, 0xd08060, 0.18), 0.9);
    g.beginPath();
    g.ellipse(px, py, S * 0.020, S * 0.042, 0, 0, 7);
    g.fill();
    g.strokeStyle = rgb(feature, 0.6);
    g.lineWidth = Math.max(1, S * 0.003);
    g.beginPath();
    g.ellipse(px, py, S * 0.011, S * 0.026, 0, 0, 7);
    g.stroke();
  }

  /* ---- hairline / scalp so a bald or receding head still reads ---- */
  {
    const hg = g.createLinearGradient(0, y0, 0, y0 + S * (yHair + 0.05));
    hg.addColorStop(0, rgb(mixHex(skin, hair, 0.35), 0.55));
    hg.addColorStop(0.7, rgb(mixHex(skin, hair, 0.2), 0.25));
    hg.addColorStop(1, rgb(hair, 0));
    g.fillStyle = hg;
    g.fillRect(x0, y0, S, S * (yHair + 0.05));
  }
}
