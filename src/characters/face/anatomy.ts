/**
 * ANATOMY — the authored sculpt that sits on top of the landmark fit.
 *
 * WHY THIS FILE EXISTS.
 *
 * The fitted head was, by measurement, a faithful reconstruction of MediaPipe's
 * 478-point cloud — and that is precisely the problem. That cloud is a smooth
 * *proxy* surface. It carries where the features are, but almost none of the
 * relief that makes a face read as bone under skin: no supraorbital shelf, no
 * zygomatic arch, no sub-malar hollow, no gonial angle, no chin button, no alar
 * crease, no nasolabial fold, no temporal flattening. Reproduce it exactly and
 * you get exactly what it describes: a smooth egg with a soft ridge down the
 * middle. In profile that ridge photographs as a nose; head-on there is not one
 * shadow boundary anywhere on the face, and the cranium — a bare ellipsoid with
 * nothing carved out of it — reads as a balloon with a small face painted on.
 *
 * So the fit supplies IDENTITY (this man's proportions) and this file supplies
 * ANATOMY (that he is made of a skull). Both are needed. The sculpt is scaled by
 * the same fitted-space unit as everything else, so it rides the fit rather than
 * fighting it, and it is symmetric by construction — `headMesh.ts` applies its
 * own deterministic asymmetry afterwards.
 *
 * Units: fitted-face units throughout. 1.0 = forehead-to-chin, about 0.182 m at
 * head scale, so 0.010 here is 1.8 mm on the rendered head. Every magnitude
 * below was chosen from an anthropometric figure in millimetres and divided by
 * 182 — the first pass was authored by eye and came out three to four times too
 * deep, which turned the nose into a thin twisted rope with a spiral in it.
 * Relief on a face is small: an alar crease is 2-3 mm, not 9.
 *
 * OWNER: characters agent.
 */

/* ------------------------------------------------------------------ */
/* Landmarks of the mean face, in fitted units                         */
/* ------------------------------------------------------------------ */

/**
 * Measured off the fitted clouds (see `tools/facefit/out/faces.json`). These are
 * the anchors every sculpt term is positioned against, so a term never drifts
 * off the feature it is supposed to be carving.
 */
export const A = {
  /** Eyeball centre. */
  eyeX: 0.178, eyeY: 0.004,
  /** Outer canthus. */
  canthusX: 0.252,
  /** Brow ridge. */
  browY: 0.085,
  /** Nose. */
  noseTipY: -0.228, noseTipZ: 0.258,
  alaX: 0.112, alaY: -0.250,
  subnasaleY: -0.262,
  /** Mouth. */
  lipY: -0.385, lipLineY: -0.398, mouthCornerX: 0.150,
  /** Chin and jaw. */
  chinY: -0.674, gonialX: 0.352, gonialY: -0.360,
  /** Widest point of the face (zygion) and the temple above it. */
  zygionX: 0.398, zygionY: -0.070,
  templeX: 0.408, templeY: 0.140,
} as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function g1(v: number, c: number, w: number): number {
  const u = (v - c) / w;
  return Math.exp(-u * u);
}

function g2(x: number, cx: number, wx: number, y: number, cy: number, wy: number): number {
  const ux = (x - cx) / wx;
  const uy = (y - cy) / wy;
  return Math.exp(-(ux * ux + uy * uy));
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  let t = len2 > 1e-9 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ex * t);
  const dy = py - (ay + ey * t);
  return Math.sqrt(dx * dx + dy * dy);
}

/* ------------------------------------------------------------------ */
/* Strengths                                                           */
/* ------------------------------------------------------------------ */

export interface SculptOptions {
  /** 0..1 — how deep the age creases are cut. */
  age: number;
  /** Extra brow-ridge projection, on top of the anatomical default. */
  browPush: number;
  /** Extra jaw width. */
  jawPush: number;
  /** Global multiplier, so a build can be compared against the raw fit. */
  strength?: number;
}

export interface Sculpt {
  /** dx, dy, dz in fitted units. */
  dx: number; dy: number; dz: number;
}

/* ------------------------------------------------------------------ */
/* The sculpt                                                          */
/* ------------------------------------------------------------------ */

/**
 * Anatomical displacement at a fitted-space surface point.
 *
 * `front` is max(0, cos(azimuth)) — 1 dead ahead, 0 at the ears — and `side` is
 * the signed left/right, so a term can be authored once and mirrored.
 *
 * The terms are ordered the way a sculptor blocks a head in: skull mass first,
 * then the bony landmarks, then the soft features, then the creases. Nothing
 * here moves a feature to a new place; it only gives the feature the relief the
 * landmark cloud does not carry.
 */
export function sculpt(
  x: number, y: number, z: number, front: number, opts: SculptOptions, out: Sculpt,
): Sculpt {
  const k = opts.strength ?? 1;
  const ax = Math.abs(x);
  const side = x >= 0 ? 1 : -1;
  let dx = 0, dy = 0, dz = 0;

  /* ---------------------------------------------------------------- *
   * 1. CRANIAL MASS — stop the skull being a balloon.
   *
   * A bare ellipsoid has no temporal fossa, so the widest part of the head
   * sits above the ears instead of at the cheekbones, which is the single
   * biggest reason the render read as a bobblehead. Squeeze the temples and
   * the upper parietal in, and flatten the back.
   * ---------------------------------------------------------------- */

  // Temporal fossa: the flat plate of bone above the zygomatic arch.
  const temporal = g2(ax, A.templeX, 0.150, y, A.templeY, 0.190) * smooth(0.16, 0.30, ax);
  dx -= side * 0.052 * temporal;

  // Upper parietal: a real skull narrows toward the crown; an ellipsoid does
  // not narrow nearly fast enough.
  const parietal = smooth(0.18, 0.52, y) * smooth(0.14, 0.30, ax);
  dx -= side * 0.055 * parietal;
  dy -= 0.030 * smooth(0.30, 0.58, y);

  // Occiput: pull the back of the head in and give it a flat, slightly angled
  // plane instead of a hemisphere.
  const occ = smooth(-0.10, -0.34, z) * smooth(-0.10, 0.30, y);
  dz += 0.052 * occ;

  // The back of the skull also sits lower than the crown of an ellipsoid.
  dy -= 0.030 * smooth(-0.18, -0.42, z) * smooth(0.20, 0.55, y);

  /* ---------------------------------------------------------------- *
   * 2. BONY LANDMARKS OF THE FACE
   * ---------------------------------------------------------------- */

  // Supraorbital ridge: a shelf over each eye, heaviest at the inner third,
  // fading out over the temple. This is what puts the eyes in shadow.
  const browRidge = g2(ax, 0.150, 0.130, y, A.browY, 0.055) * front;
  dz += (0.021 + opts.browPush * 1.1) * browRidge;
  // and the shelf overhangs — the skin under it falls away.
  dy += 0.007 * browRidge;

  // Glabella: the bridge between the brows is slightly recessed relative to
  // the two ridges, which is what makes them read as two ridges.
  const glabella = g2(ax, 0, 0.045, y, A.browY + 0.010, 0.048) * front;
  dz -= 0.009 * glabella;

  // Frontal eminences: two soft domes on the forehead above the brow.
  const eminence = g2(ax, 0.130, 0.110, y, 0.250, 0.095) * front;
  dz += 0.009 * eminence;

  // Zygomatic arch / cheekbone: the widest point of the face, running from
  // under the outer canthus back toward the ear.
  const cheekBone = Math.exp(-Math.pow(
    segDist(ax, y, 0.250, -0.075, A.zygionX, -0.040) / 0.085, 2));
  dx += side * 0.020 * cheekBone;
  dz += 0.016 * cheekBone * front;

  // Sub-malar hollow: the plane under the cheekbone. Without it a cheek is a
  // continuous convex sweep and there is no cheekbone at all, only a fat face.
  const subMalar = g2(ax, 0.268, 0.110, y, -0.235, 0.105) * front;
  dz -= 0.019 * subMalar;
  dx -= side * 0.009 * subMalar;

  // Mandible: the gonial angle and the jawline edge. A jaw has a corner.
  const ramus = g2(ax, A.gonialX, 0.115, y, A.gonialY, 0.130);
  dx += side * (0.017 + opts.jawPush * 0.7) * ramus;
  // The jawline itself: a crisp edge, with the underside falling away sharply.
  const jawEdge = Math.exp(-Math.pow(
    segDist(ax, y, 0.070, -0.640, A.gonialX + 0.02, -0.330) / 0.060, 2));
  dz += 0.013 * jawEdge * front;
  dy += 0.009 * jawEdge;
  // Under-jaw shelf: everything below the jawline retreats, so the jaw casts.
  const underJaw = smooth(-0.50, -0.70, y) * smooth(0.05, 0.22, ax) * front;
  dz -= 0.017 * underJaw;

  // Chin button: the mental protuberance, with a crease above it.
  const chin = g2(ax, 0, 0.115, y, A.chinY + 0.055, 0.075) * front;
  dz += 0.017 * chin;
  const mentolabial = g2(ax, 0, 0.130, y, A.chinY + 0.165, 0.032) * front;
  dz -= 0.011 * mentolabial;

  /* ---------------------------------------------------------------- *
   * 3. THE NOSE — the feature that has to read head-on.
   *
   * The fit gives a smooth ramp from the midline out to the cheek with no
   * boundary anywhere, which is why the nose was invisible from the front
   * however good the profile looked. A nose reads frontally because of three
   * shadow lines: the alar crease down each side, the undercut beneath the
   * tip, and the nostrils. None of them were in the cloud.
   * ---------------------------------------------------------------- */

  // Dorsum: narrow the bridge and give it a defined ridge.
  const dorsum = g2(ax, 0, 0.075, y, -0.080, 0.150) * front;
  dz += 0.009 * dorsum * (1 - smooth(0.045, 0.115, ax));
  dx -= side * 0.013 * dorsum * smooth(0.030, 0.110, ax);

  // Alar crease: the groove that separates the wing of the nose from the
  // cheek. This is THE line that says "nose" in flat frontal light, and it has
  // to sit OUTSIDE the wing — the fitted ala is at |x| ~ 0.11, so a crease
  // authored at 0.10 carves the nose in half instead of detaching it.
  const alarCrease = Math.exp(-Math.pow(
    segDist(ax, y, 0.118, -0.155, A.alaX + 0.048, A.alaY - 0.008) / 0.024, 2)) * front;
  dz -= 0.015 * alarCrease;

  // Ala: the wing itself, a rounded lobe that has to sit proud of the crease.
  const ala = g2(ax, A.alaX - 0.010, 0.048, y, A.alaY + 0.004, 0.038) * front;
  dz += 0.012 * ala;
  dx += side * 0.005 * ala;

  // Undercut beneath the tip: the nose base angles back up toward the lip, so
  // the tip casts a shadow onto the philtrum. A nose without this is a lump.
  const base = g2(ax, 0, 0.092, y, A.subnasaleY - 0.004, 0.028) * front;
  dz -= 0.020 * base;
  dy -= 0.005 * base;

  // Nostrils: two dark pits inside the base, cut in as real geometry so they
  // survive any lighting.
  const nostril = g2(ax, 0.056, 0.028, y, A.subnasaleY + 0.002, 0.020) * front;
  dz -= 0.023 * nostril;

  // Columella: the small ridge between them, so the base is not one hollow.
  const columella = g2(ax, 0, 0.020, y, A.subnasaleY + 0.006, 0.030) * front;
  dz += 0.011 * columella;

  /* ---------------------------------------------------------------- *
   * 4. MOUTH
   * ---------------------------------------------------------------- */

  // Philtrum: two ridges with a groove between them.
  const philtrumGroove = g2(ax, 0, 0.018, y, -0.330, 0.038) * front;
  dz -= 0.008 * philtrumGroove;
  const philtrumRidge = g2(ax, 0.030, 0.016, y, -0.330, 0.038) * front;
  dz += 0.007 * philtrumRidge;

  // Vermilion: the lips stand proud of the surrounding skin, and the lip line
  // between them is cut.
  const lipMass = g2(ax, 0, 0.135, y, A.lipY - 0.008, 0.048) * front;
  dz += 0.014 * lipMass;
  const lipLine = g2(ax, 0, 0.130, y, A.lipLineY, 0.011) * front;
  dz -= 0.016 * lipLine;

  // Mouth corners tuck back into the face rather than ending in mid-air.
  const corner = g2(ax, A.mouthCornerX, 0.045, y, A.lipLineY, 0.040) * front;
  dz -= 0.013 * corner;

  /* ---------------------------------------------------------------- *
   * 5. CREASES — the age lines. Scaled by `age` so the younger cast
   *    members do not inherit the hero's face.
   * ---------------------------------------------------------------- */

  const age = smooth(0.15, 0.85, opts.age);

  // Nasolabial fold: ala to just outside the mouth corner.
  const naso = Math.exp(-Math.pow(
    segDist(ax, y, A.alaX + 0.020, A.alaY - 0.010, A.mouthCornerX + 0.048, A.lipLineY - 0.045) / 0.030, 2)) * front;
  dz -= 0.017 * naso * (0.35 + 0.65 * age);

  // Orbital rim: the eye sits in a socket, not on a wall. Recess the skin
  // around the globe so the lids have somewhere to sit.
  const orbit = g2(ax, A.eyeX, 0.105, y, A.eyeY - 0.012, 0.070) * front;
  dz -= 0.015 * orbit;

  // Tear trough / lower lid shadow, which deepens with age.
  const trough = g2(ax, A.eyeX - 0.018, 0.085, y, A.eyeY - 0.072, 0.026) * front;
  dz -= 0.008 * trough * (0.4 + 0.6 * age);

  out.dx = dx * k;
  out.dy = dy * k;
  out.dz = dz * k;
  return out;
}
