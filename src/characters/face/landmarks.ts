/**
 * MediaPipe FaceLandmarker index tables.
 *
 * The fitter in `tools/facefit/` emits 478 landmarks per subject in MediaPipe's
 * canonical ordering. Everything in `src/characters/face/` addresses that cloud
 * through the names below rather than through bare integers, because a stray
 * digit in a landmark index produces a confidently wrong face.
 *
 * Indices 0..467 are the face mesh; 468..472 are the left iris ring and
 * 473..477 the right, which is where the eyeballs are placed from.
 *
 * OWNER: characters agent.
 */

export const LM_COUNT = 478;

/** Single points that anchor the whole head. */
export const L = {
  chin: 152,
  forehead: 10,
  glabella: 9,
  noseTip: 1,
  noseBridge: 168,
  noseBottom: 2,
  subnasale: 94,
  noseLeftAla: 129,
  noseRightAla: 358,

  eyeLOuter: 33,
  eyeLInner: 133,
  eyeLTop: 159,
  eyeLBottom: 145,
  eyeROuter: 263,
  eyeRInner: 362,
  eyeRTop: 386,
  eyeRBottom: 374,

  irisL: 468,
  irisR: 473,

  mouthLeft: 61,
  mouthRight: 291,
  lipUpperTop: 0,
  lipUpperEdge: 13,
  lipLowerEdge: 14,
  lipLowerBottom: 17,

  cheekL: 234,
  cheekR: 454,
  jawL: 172,
  jawR: 397,
  templeL: 127,
  templeR: 356,

  browLInner: 55,
  browLOuter: 46,
  browLTop: 52,
  browRInner: 285,
  browROuter: 276,
  browRTop: 282,

  earTopL: 234,
  earTopR: 454,
} as const;

/** The face silhouette, ordered clockwise from the top of the forehead. */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
] as const;

/** Outer vermilion border of the lips. */
export const LIPS_OUTER = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37,
  39, 40, 185,
] as const;

/** Inner lip line — where the mouth opening is. */
export const LIPS_INNER = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82,
  81, 80, 191,
] as const;

export const EYE_L_RING = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
] as const;

export const EYE_R_RING = [
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
] as const;

/** Upper edge of each brow, inner -> outer. */
export const BROW_L_TOP = [107, 66, 105, 63, 70] as const;
export const BROW_R_TOP = [336, 296, 334, 293, 300] as const;
/** Lower edge of each brow, inner -> outer. */
export const BROW_L_BOTTOM = [55, 65, 52, 53, 46] as const;
export const BROW_R_BOTTOM = [285, 295, 282, 283, 276] as const;

/** The nasolabial ridge — the crease that deepens with age. */
export const NASOLABIAL_L = [129, 209, 49, 64, 98, 97] as const;
export const NASOLABIAL_R = [358, 429, 279, 294, 327, 326] as const;

/** Bridge of the nose, top to tip — the T-zone spine. */
export const NOSE_BRIDGE = [168, 6, 197, 195, 5, 4, 1] as const;

/** Iris rings, used to seat and size the eyeballs. */
export const IRIS_L = [468, 469, 470, 471, 472] as const;
export const IRIS_R = [473, 474, 475, 476, 477] as const;
