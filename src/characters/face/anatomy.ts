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
 * The base ellipsoid's vertical axis, in fitted units.
 *
 * `headMesh.SKULL` is built from this rather than the other way round: terms
 * here that have to move a vertex *outward* — squaring the cranial vault, in
 * particular — need the axis to push away from, and anatomy cannot import
 * headMesh without a cycle.
 */
export const SKULL_AXIS = { x: 0.006, z: -0.290 } as const;

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

/**
 * THE MIDLINE, AND WHY IT NEEDS ITS OWN PAIR OF PRIMITIVES.
 *
 * Every lateral term in this file is authored once against `ax = |x|` and then
 * mirrored, which is the only sane way to sculpt a symmetric face. But `|x|` has
 * a CORNER at x = 0, and so does any function of it whose centre is not on the
 * midline: `g2(|x|, 0.150, ...)` — the brow ridge — is a smooth hill in `ax` and
 * a sharp V in `x`. Sum a dozen of those and the head's midline stops being a
 * rounded dorsum and becomes a knife edge, from the crown to the chin.
 *
 * That is invisible in the geometry and lethal downstream. `computeCurvature` in
 * `headMesh.ts` estimates curvature as -(d.n)/len^2, which for a corner of slope
 * s evaluates to s/len — it DIVERGES as the grid gets finer. And `azimuthCols`
 * puts its single largest density peak at azimuth 0, so the columns straddling
 * the midline are 1.45 mm apart against up to 16 mm on the cheek. The finest
 * sampling on the head lands exactly on the corner, the estimator reports 60-360
 * 1/m against +/-10 on the neighbouring columns, and the two consumers of that
 * attribute turn it into pixels: it is the SSS LUT's curvature axis, and
 * `cav -= max(0, -k) * 0.010` reads the negative ring that flanks every spike.
 * The result is a dark stripe one vertex wide running from between the brows,
 * down the nose bridge, to the philtrum. That stripe is a rendering artifact of
 * a C1 discontinuity; it is not anatomy, and no amount of tuning the nose fixes
 * it, because the terms drawing it are the brow ridge and the frown crease.
 *
 * This is the THIRD midline seam found in this codebase and it is the same bug
 * each time — a term written in |x| and re-signed without being made smooth
 * through zero. The first was a hard `x >= 0 ? +a : -a` in the asymmetry (a C0
 * step). The second was triplanar blending on abs(n.x) (a C0 step in the blend
 * weight). This one is C1 — a corner, not a step — which is exactly why it
 * survived both earlier fixes: nothing was discontinuous, only non-
 * differentiable, and curvature is precisely the operator that turns
 * non-differentiable into unbounded.
 *
 * So: `sabs` replaces `Math.abs` and `ssign` replaces the `x >= 0 ? 1 : -1`
 * selector, everywhere in the sculpt.
 */

/**
 * Smooth absolute value. Equals |x| to within 1% beyond about 3k, is exactly 0
 * at x = 0 so midline-centred terms keep their value, and turns a rounded corner
 * of radius ~k instead of a cusp.
 *
 * `MIDLINE_K` is 0.012 fitted units — 2.3 mm, so the crest is rounded over about
 * 4.5 mm. That is not a fudge factor: a real nasal dorsum has a crest radius of
 * two to three millimetres, and a real glabella more. The old code was asking
 * for a radius of zero.
 */
const MIDLINE_K = 0.012;

function sabs(x: number): number {
  return Math.sqrt(x * x + MIDLINE_K * MIDLINE_K) - MIDLINE_K;
}

/**
 * Smooth left/right selector: -1 and +1 away from the midline, passing through
 * zero at it rather than stepping across it.
 *
 * A term of the form `dx -= side * A * f(ax)` is a statement about pulling both
 * halves of the face toward the midline. Where f(0) is not zero — `alarNarrow`
 * is 0.086 there, worth 0.72 mm of x each way — a hard `side` makes the two
 * halves cross over, folding the surface along the midline. The pull has to
 * vanish at the midline, and this is what makes it.
 */
function ssign(x: number): number {
  return x / Math.sqrt(x * x + MIDLINE_K * MIDLINE_K);
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
  // Both smoothed through the midline — see the note above `sabs`. Using
  // `Math.abs` and a hard sign here is what drew the nose-bridge stripe.
  const ax = sabs(x);
  const side = ssign(x);
  let dx = 0, dy = 0, dz = 0;

  /* ---------------------------------------------------------------- *
   * 1. CRANIAL MASS — stop the skull being a balloon.
   *
   * A bare ellipsoid has no temporal fossa, so the widest part of the head
   * sits above the ears instead of at the cheekbones, which is the single
   * biggest reason the render read as a bobblehead. Squeeze the temples and
   * flatten the back.
   *
   * THE VAULT. The previous pass narrowed the upper parietal hard (-0.055) and
   * trimmed only 0.030 off the crown, which produced precisely the wrong shape:
   * an egg, tapering to a dome above the brow. That is where the remaining
   * "oversized head" reading came from — not from the head's total height,
   * which `measureProportions` has pinned at 1/7.5 all along, but from how
   * much of that height was bare cranium. The reference skull is LOW and
   * FLAT-TOPPED, with near-vertical parietal walls meeting the vault at a
   * rounded corner, so the vault is cut by 0.105 and the narrowing is mostly
   * withdrawn. `HEAD_SCALE_TRIM` in `headMesh.ts` was raised to compensate, so
   * the head keeps its 1/7.5 and the height released by the vault goes into
   * the face — which is the whole point. `vaultOverHead` and `crownFlatness`
   * in `checks.ts` hold both halves of that in place.
   * ---------------------------------------------------------------- */

  // Temporal fossa: the flat plate of bone above the zygomatic arch.
  const temporal = g2(ax, A.templeX, 0.150, y, A.templeY, 0.190) * smooth(0.16, 0.30, ax);
  dx -= side * 0.052 * temporal;

  /* Bitemporal narrowing, and it exists because of the vault cut below.
   *
   * Cutting the vault shortens the head, so `HEAD_SCALE_TRIM` has to rise to
   * keep it at 1/7.5 — and that scales BREADTH up with it, taking the head from
   * 153 mm across (right) to 165 (9% over an adult male's 152). Shrinking the
   * base ellipsoid does not fix it: at eye level the surface is pulled onto the
   * landmark cloud rather than onto the ellipsoid, so `SKULL.rx` barely moves
   * the number. The correction has to be a proportional pull toward the
   * midline. Proportional, so the cheekbone and gonial relief authored below
   * survive as relief and only the overall breadth comes down — which is also
   * why it doubles as most of the fix for "too fleshy and rounded" head-on. */
  dx -= side * ax * 0.070 * (1 - smooth(-0.50, -0.70, y));

  /* Vault height: take the crown down.
   *
   * A male vertex sits about 90 mm above glabella on a 232 mm head — 0.39 of
   * head height, and the reference frame measures the same. The ellipsoid was
   * at 0.384, so height was never the main error: `crownFlatness` was, at 0.456
   * against a real vault's 0.7-plus. This cut takes 0.384 to 0.350, slightly
   * under the anatomical figure and deliberately so, because the last of the
   * "oversized" reading lives in the last few millimetres of bare forehead.
   * `vaultSquare` below is the term doing the real work. Cutting deeper than
   * this buys nothing and costs the forehead, which is where the frown lives. */
  dy -= 0.058 * smooth(0.20, 0.56, y);

  /* Squaring the vault. Lowering a dome leaves a lower dome, which is why
   * `crownFlatness` is measured separately from `vaultOverHead` — the ellipsoid
   * scored 0.47 there, meaning the skull had shrunk to half its width by the
   * time it reached the crown. A real vault holds its parietal walls almost
   * vertical and turns a rounded corner into a broad flat top. So the top of
   * the skull is pushed radially OUTWARD from the axis, strongest for the
   * vertices nearest it — which are exactly the ones an ellipsoid pinches. */
  const hx = x - SKULL_AXIS.x;
  const hz = z - SKULL_AXIS.z;
  const hr = Math.hypot(hx, hz) || 1e-6;
  const vaultSquare = smooth(0.16, 0.50, y) * (1 - smooth(0.20, 0.44, hr));
  dx += (hx / hr) * 0.115 * vaultSquare;
  dz += (hz / hr) * 0.115 * vaultSquare;

  // Parietal walls: a skull does narrow toward the crown, but only slightly,
  // and the parietal eminence is a real outward boss just above the temporal
  // fossa. Together they are what make the vault read square rather than domed.
  const parietal = smooth(0.34, 0.58, y) * smooth(0.14, 0.30, ax);
  dx -= side * 0.014 * parietal;
  const eminenceP = g2(ax, 0.330, 0.145, y, 0.290, 0.150);
  dx += side * 0.018 * eminenceP;

  // The corner where the wall turns into the vault: sharpen it, so the top is
  // a plane with edges instead of a continuous curve.
  const vaultCorner = g2(ax, 0.255, 0.150, y, 0.455, 0.095);
  dy -= 0.018 * vaultCorner;

  // Occiput: pull the back of the head in and give it a flat, slightly angled
  // plane instead of a hemisphere.
  const occ = smooth(-0.10, -0.34, z) * smooth(-0.10, 0.30, y);
  dz += 0.052 * occ;

  // The back of the skull also sits lower than the crown of an ellipsoid.
  dy -= 0.030 * smooth(-0.18, -0.42, z) * smooth(0.20, 0.55, y);

  // Preserve the measured cranial envelope while limiting relief added on top
  // of the photographed landmark fit. Full-strength generic cheek/nose carving
  // added roughly 13 mm to the dorsum and overwhelmed individual anatomy.
  const cranialY = dy, cranialZ = dz;
  const facialRelief = 0.55;

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

  /* THE LEAN MIDFACE.
   *
   * The reference is a weathered man in his late forties with taut skin over
   * bone: the zygomatic arch throws a hard edge, the plane under it falls away
   * into a real hollow, and the masseter picks the volume back up at the jaw.
   * The previous magnitudes (cheekbone +0.020, hollow -0.019) were about half
   * what it takes for that to survive a low key light — the cheek came out as
   * one continuous convex sweep, which is what "fleshy" means geometrically.
   * These are still anthropometric: a zygomatic arch stands 5–6 mm proud of the
   * temporal plane and a sub-malar hollow is 6–7 mm deep, which is 0.031 and
   * 0.036 in fitted units. */

  // Zygomatic arch / cheekbone: the widest point of the face, running from
  // under the outer canthus back toward the ear.
  const cheekBone = Math.exp(-Math.pow(
    segDist(ax, y, 0.242, -0.082, A.zygionX, -0.038) / 0.072, 2));
  dx += side * 0.031 * cheekBone;
  dz += 0.026 * cheekBone * front;
  // The arch has a lower EDGE, not just a bulge: the surface drops away
  // immediately beneath it. Without the edge the bone has no shadow line.
  const archEdge = Math.exp(-Math.pow(
    segDist(ax, y, 0.238, -0.135, A.zygionX - 0.01, -0.098) / 0.030, 2)) * front;
  dz -= 0.009 * archEdge;

  // Sub-malar hollow: the plane under the cheekbone. Without it a cheek is a
  // continuous convex sweep and there is no cheekbone at all, only a fat face.
  const subMalar = g2(ax, 0.252, 0.098, y, -0.238, 0.098) * front;
  dz -= 0.036 * subMalar;
  dx -= side * 0.020 * subMalar;

  // Buccal corridor: the hollow continues round the side of the face between
  // the arch and the mandible, which is what gives a lean man his profile.
  const buccal = g2(ax, 0.330, 0.090, y, -0.215, 0.120) * (1 - front * 0.35);
  dx -= side * 0.015 * buccal;

  /* Lower-cheek narrowing. The fitted clouds put the widest point of the face
   * at MOUTH level, which is an infant's proportion and a heavy man's — on an
   * adult male the widest point is the zygion, at eye level, and everything
   * below it tapers. Front-on this was the last thing still reading as "fleshy
   * and rounded": the silhouette bulged outboard of the ears at the mouth and
   * came back in at the temples, which is exactly backwards. Taking 6 mm out
   * of the mid-jaw leaves the gonial corner and the cheekbone untouched, so the
   * jaw keeps its heaviness and only stops being a balloon.
   *
   * IT DID NOT WORK, and the reason is measurable rather than aesthetic. Slice
   * the built head at fractions of its own height above the chin and the widths
   * came out 0.138 / 0.164 / 0.1675 / 0.156 / 0.155 / 0.160 / 0.140 at 0.10 to
   * 0.58 — the maximum is at 0.26, which is MOUTH level, and it is 4.7% wider
   * than the eye line. The paragraph above describes the right fix and then
   * applies a third of it, because the term that actually sets the width in
   * that band is not this one, it is the gonial `ramus` push below, which adds
   * 0.069 outward at y = -0.36 and sits directly inside the same band. Taking
   * 6 mm out here while adding 12 mm there nets out as a wider jaw.
   *
   * All three lower-face terms are re-balanced together, with the profile
   * re-measured after: the widest point has to move to the eye line and the
   * silhouette has to taper monotonically below it. That is what "narrow face"
   * means as a number, and the immersion review's "the narrow face is absent"
   * and "the jaw silhouette is lumpy and sagging" are both this one profile. */
  // Centre dropped from -0.300 to -0.335 and the vertical sigma tightened. At
  // the wider amplitude this term needs to keep its hands off the ala: it is a
  // CHEEK term, and `measureNose` reads the alar width as a relief crossing on
  // the surrounding cheek, so a few tenths of a millimetre of extra pull up at
  // y = -0.25 moves the nose ratios (ally fell to bridgeOverAlar 0.482).
  const lowCheek = g2(ax, 0.318, 0.125, y, -0.335, 0.128);
  dx -= side * 0.042 * lowCheek;

  // Mandibular taper. The jaw has to be narrower than the zygion — on the
  // reference it is by a clear margin, and Bolojan's "heavier jaw" is depth and
  // a square gonial corner, not a jaw as wide as the cheekbones. Without this
  // the silhouette is a rectangle from the eyes to the chin.
  const mandible = g2(ax, 0.290, 0.150, y, -0.450, 0.150);
  dx -= side * 0.044 * mandible;

  /* Mandible: the gonial angle and the jawline edge. A jaw has a corner, and
   * Bolojan's is square and heavy — `jawPush` rides on top of an already
   * stronger ramus.
   *
   * The base comes down from 0.028 to 0.019 and the y-sigma goes up from 0.115
   * to 0.150. Both changes are about the same defect: a narrow, strong outward
   * gaussian at the gonion is not a corner, it is a BULGE with the jawline
   * running through the middle of it, and that is the "lumpy" reading. A real
   * gonial angle is a change of DIRECTION over a couple of centimetres, so the
   * mass has to be spread over the whole ramus and the corner has to come from
   * `jawEdge` below, which is a crease term and does not add width. */
  const ramus = g2(ax, A.gonialX, 0.105, y, A.gonialY, 0.150);
  dx += side * (0.019 + opts.jawPush * 0.9) * ramus;
  // Masseter: the muscle bulk on the ramus, which is the volume that comes
  // BACK after the sub-malar hollow. Hollow with no masseter reads gaunt.
  const masseter = g2(ax, 0.300, 0.105, y, -0.320, 0.115) * front;
  dz += 0.013 * masseter;
  dx += side * 0.012 * masseter;
  // The jawline itself: a crisp edge, with the underside falling away sharply.
  const jawEdge = Math.exp(-Math.pow(
    segDist(ax, y, 0.070, -0.640, A.gonialX + 0.02, -0.330) / 0.048, 2));
  dz += 0.019 * jawEdge * front;
  dy += 0.011 * jawEdge;
  // Under-jaw shelf: everything below the jawline retreats, so the jaw casts.
  const underJaw = smooth(-0.48, -0.70, y) * smooth(0.05, 0.22, ax) * front;
  dz -= 0.026 * underJaw;

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
   *
   * WHAT `measureNose` SAID ABOUT THE PREVIOUS PASS, and it said all of it at
   * once, which is why tuning any single magnitude never fixed the nose:
   *
   *   bridgeOverAlar   1.38   the BRIDGE WAS WIDER THAN THE WINGS. Upside down.
   *                           A nose flares; the alar base is the widest part of
   *                           it and the bridge is about two thirds of that. The
   *                           dorsal flank pull was 0.021 and `alarNarrow` was
   *                           0.048, so the wings were tucked to a point under a
   *                           bridge nothing had narrowed.
   *   projectionRatio  0.44   under-projected against Goode's 0.55-0.60. This is
   *                           the whole of "the nose is too short": its length
   *                           is set by the landmarks and was never wrong, but a
   *                           nose that does not stand out of the face reads
   *                           short however long it measures.
   *   dorsalCamber    +0.12   a hump. `nasalMass` was a Gaussian centred in the
   *                           middle of the nose, which is a bulge by
   *                           construction. A straight dorsum is a MONOTONE ramp
   *                           from the nasion to the tip, and that is the single
   *                           biggest change below.
   *   alarOverLength   0.29   the frontal footprint was a third of what the
   *                           reference's is (0.52 measured off the photo).
   *
   * So: the bridge is narrowed hard, the wings are let back out, projection is
   * re-authored as a ramp instead of a bulge, and the tip gets the lobule, the
   * supratip break and the paired tip-defining points that make a tip read as a
   * tip rather than as the end of a ramp.
   * ---------------------------------------------------------------- */

  /* The dorsum's run: on over the whole bridge, from the nasion down to just
   * above the alar base, and tapering off at both ends rather than being a
   * Gaussian centred somewhere in the middle. Everything nasal rides this, so
   * the nose starts high between the brows — which is most of why the reference
   * reads long — and stops before it can drag the alar base around. */
  const dorsalRun = smooth(-0.244, -0.188, y) * smooth(0.078, 0.012, y);
  /** 0 at the nasion, 1 at the tip: how far down the dorsum we are. */
  const nt = smooth(0.012, -0.212, y);

  // The bridge. Narrow it: the flanks are pulled toward the midline over the
  // band the nasal bones actually occupy, and released again before the cheek,
  // so this narrows a nose rather than pinching a face.
  const dorsalCore = 1 - smooth(0.026, 0.096, ax);
  dx -= side * 0.018 * dorsalRun * front *
    smooth(0.010, 0.062, ax) * (1 - smooth(0.070, 0.120, ax));

  /* Projection, as a RAMP. This is what "straight dorsum" means: the profile
   * climbs steadily from the nasion to the tip with no local maximum in
   * between. The previous Gaussian could not be straight at any magnitude. */
  dz += (0.009 + 0.078 * nt) * dorsalRun * dorsalCore * front;

  // Alar crease: the groove that separates the wing of the nose from the
  // cheek. This is THE line that says "nose" in flat frontal light, and it has
  // to sit OUTSIDE the wing — the fitted ala is at |x| ~ 0.11, so a crease
  // authored at 0.10 carves the nose in half instead of detaching it.
  const alarCrease = Math.exp(-Math.pow(
    segDist(ax, y, 0.118, -0.172, A.alaX + 0.050, A.alaY - 0.004) / 0.020, 2)) * front;
  dz -= 0.028 * alarCrease;

  /* Ala: the wing itself, a rounded lobe that has to sit proud of the crease,
   * and stand out LATERALLY as well as forward — a wing that only projects is
   * a bump on the dorsum, not a wing. It was 0.017 and `measureNose` could not
   * see a wing at all: between the bridge's flank and the crease the surface was
   * only 2-3 mm proud of the face's own low-frequency shape, so the alar
   * footprint came out narrower than the bridge. */
  const ala = g2(ax, A.alaX - 0.010, 0.048, y, A.alaY + 0.008, 0.040) * front;
  dz += 0.027 * ala;
  dx += side * 0.009 * ala;
  /* Tuck, but only enough to keep the wings close. At 0.048 this took 9 mm a
   * side out of the alar base and left the nose narrower at its widest point
   * than at its bridge, which is the geometry of a beak. */
  const alarNarrow = g2(ax, A.alaX + 0.016, 0.068, y, A.alaY + 0.014, 0.060) * front;
  dx -= side * 0.014 * alarNarrow;

  /* THE TIP. Three separate things, and a tip needs all of them.
   *
   * The lobule is the mass; the supratip break is the shallow notch just above
   * it that stops the dorsum running straight into the tip; and the tip-defining
   * points are the paired domes on the lobule whose highlights are what the eye
   * actually reads as "a defined tip". The previous pass had only the mass, and
   * a mass with no break and no points is the end of a ramp. */
  const tip = g2(ax, 0, 0.056, y, A.noseTipY + 0.006, 0.040) * front;
  dz += 0.032 * tip;
  const supratip = g2(ax, 0, 0.044, y, A.noseTipY + 0.050, 0.015) * front;
  dz -= 0.006 * supratip;
  // Safe now, and only now: `ax` is smooth through the midline, so a pair of
  // lobes centred off it no longer welds a crease down the nose.
  const tdp = g2(ax, 0.024, 0.019, y, A.noseTipY + 0.012, 0.028) * front;
  dz += 0.007 * tdp;

  // Undercut beneath the tip: the nose base angles back up toward the lip, so
  // the tip casts a shadow onto the philtrum. A nose without this is a lump.
  const base = g2(ax, 0, 0.092, y, A.subnasaleY - 0.004, 0.028) * front;
  dz -= 0.022 * base;
  dy -= 0.005 * base;

  // Nostrils: two dark pits inside the base, cut in as real geometry so they
  // survive any lighting.
  const nostril = g2(ax, 0.052, 0.026, y, A.subnasaleY + 0.002, 0.019) * front;
  dz -= 0.024 * nostril;

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
  dz += 0.017 * lipMass;
  const lipLine = g2(ax, 0, 0.130, y, A.lipLineY, 0.011) * front;
  dz -= 0.021 * lipLine;

  // Mouth corners tuck back into the face rather than ending in mid-air.
  const corner = g2(ax, A.mouthCornerX, 0.045, y, A.lipLineY, 0.040) * front;
  dz -= 0.013 * corner;

  /* ---------------------------------------------------------------- *
   * 5. CREASES — the age lines. Scaled by `age` so the younger cast
   *    members do not inherit the hero's face.
   * ---------------------------------------------------------------- */

  const age = smooth(0.15, 0.85, opts.age);

  /* A crease only reads if the flesh on ONE side of it stands proud. Cutting a
   * symmetric groove into a smooth surface gives a thin dark line that vanishes
   * the moment the key light moves; the fold that survives is a groove with the
   * cheek mass overhanging its medial edge. Every crease below is authored as
   * that pair. */

  // Nasolabial fold: ala to just outside the mouth corner, with the cheek
  // rolling over it. This is Bolojan's, so it is cut deep.
  const nasoD = segDist(ax, y, A.alaX + 0.020, A.alaY - 0.010,
    A.mouthCornerX + 0.048, A.lipLineY - 0.045);
  /* Depth is bounded by what a fold IS. A deep nasolabial on a man of fifty is
   * a 3-4 mm groove — 0.020 in fitted units — and the previous 0.029 with a
   * 0.011 pad outside it made a 7 mm trench with a lip on it, which read as the
   * hinged jaw of a ventriloquist's dummy rather than as an aged face. The pad
   * is gone: the cheek mass outside the fold is already supplied by the
   * cheekbone and sub-malar terms above, and stacking another one on top is
   * what turned a crease into a moulding. */
  const naso = Math.exp(-Math.pow(nasoD / 0.028, 2)) * front;
  dz -= 0.020 * naso * (0.35 + 0.65 * age);

  // Marionette line: fold continued from the mouth corner down past the chin,
  // which is what ages a mouth as much as the nasolabial does.
  const mario = Math.exp(-Math.pow(
    segDist(ax, y, A.mouthCornerX + 0.030, A.lipLineY - 0.030,
      A.mouthCornerX + 0.012, A.chinY + 0.120) / 0.026, 2)) * front;
  dz -= 0.007 * mario * age;

  // Orbital rim: the eye sits in a socket, not on a wall. Recess the skin
  // around the globe so the lids have somewhere to sit.
  const orbit = g2(ax, A.eyeX, 0.105, y, A.eyeY - 0.012, 0.070) * front;
  dz -= 0.015 * orbit;

  // Tear trough / lower lid shadow, which deepens with age.
  const trough = g2(ax, A.eyeX - 0.018, 0.085, y, A.eyeY - 0.072, 0.026) * front;
  dz -= 0.011 * trough * (0.4 + 0.6 * age);

  // Crow's feet: a fan of grooves radiating back from the outer canthus. Three
  // authored rays rather than a noise field, because a fan has a direction and
  // noise does not.
  for (let i = 0; i < 3; i++) {
    const a = (-0.34 + i * 0.34);
    const cf = Math.exp(-Math.pow(
      segDist(ax, y, A.canthusX + 0.014, A.eyeY + a * 0.055,
        A.canthusX + 0.088, A.eyeY + a * 0.115) / 0.011, 2)) * front;
    dz -= 0.008 * cf * age;
  }

  // Glabellar frown: the vertical crease between the brows. On this man it is
  // permanent, and it is half of why the reference reads as an expression
  // rather than a pose.
  const frown = g2(ax, 0.026, 0.017, y, A.browY + 0.020, 0.062) * front;
  dz -= 0.013 * frown * (0.30 + 0.70 * age);
  // and the horizontal crease over the nose root that goes with it.
  const procerus = g2(ax, 0, 0.070, y, A.browY - 0.030, 0.014) * front;
  dz -= 0.009 * procerus * age;

  // Forehead furrows: two horizontal bands over the frontal eminences. Authored
  // at a wavelength the elevation grid actually resolves — a sine sweep here
  // aliases into a moiré at this row count, which is what the albedo layer's
  // version of this was doing.
  for (let i = 0; i < 3; i++) {
    const fy = 0.185 + i * 0.058;
    const furrow = g2(ax, 0, 0.230, y, fy, 0.014) * front;
    dz -= 0.0055 * furrow * age * (1 - i * 0.18);
  }

  // Preserve the measured frontal silhouette and mandibular taper. Relief
  // normal to the face is what creates the over-carved cheek/nose planes.
  out.dx = dx * k;
  out.dy = (cranialY + (dy - cranialY) * facialRelief) * k;
  out.dz = (cranialZ + (dz - cranialZ) * facialRelief) * k;
  return out;
}
