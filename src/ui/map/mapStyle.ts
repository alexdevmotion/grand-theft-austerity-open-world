/**
 * MAP IDENTITY — the palette the minimap and the full-screen map both paint
 * with, plus the CSS for their chrome.
 *
 * OWNER: map agent.
 *
 * The map is a *Ministry broadcast console*, not a satnav: deep violet paper,
 * magenta ink, a tricolour hairline, scanlines, and a horizontal tear across
 * the picture whenever the Ministry is looking for you. Colours are the sRGB
 * twins of `src/artDirection.ts` — that file stores linear `THREE.Color`s for
 * the renderer, and canvas 2D wants CSS strings, so the few we need are
 * repeated here as hex rather than converted at runtime every frame.
 */

export const MapInk = {
  /** Paper under everything. */
  paper: '#0a0513',
  /** District wash opacity over the paper. */
  washAlpha: 0.92,

  /** Roads: dark casing first, pale carriageway on top. */
  casing: '#0d0718',
  minor: '#8878a8',
  major: '#c9b2f0',
  axis: '#ffd7a6',

  park: 'rgba(74, 214, 160, 0.16)',
  plaza: 'rgba(255, 217, 166, 0.13)',

  frame: 'rgba(255, 61, 127, 0.55)',
  frameSoft: 'rgba(162, 92, 255, 0.30)',

  player: '#ffffff',
  playerEdge: '#2a0f3a',

  waypoint: '#ff3d7f',
  waypointCore: '#ffe4f1',
  route: '#ff3d7f',
  routeGlow: 'rgba(255, 61, 127, 0.22)',
  routeCore: '#ffd0e6',

  /**
   * A destination the *campaign* chose is amber, the same ink as the story
   * anchors; a destination *you* chose by clicking the map is magenta. The
   * legend on the full map promises that distinction, so the marks have to
   * keep it — and in play it is the difference between "the mission is that
   * way" and "I asked to go there".
   */
  missionMark: '#ffb454',
  missionMarkCore: '#fff1d6',

  police: '#4d8bff',
  policeCone: 'rgba(77, 139, 255, 0.16)',
  search: 'rgba(255, 61, 127, 0.055)',
  searchEdge: 'rgba(255, 90, 74, 0.55)',

  traffic: 'rgba(226, 201, 255, 0.42)',

  story: '#ffb454',
  activity: '#4ad6c4',
  landmark: 'rgba(226, 201, 255, 0.85)',

  text: '#f6e8ff',
  textDim: '#b48ede',
  shadow: 'rgba(4, 2, 9, 0.85)',

  /** Romanian tricolour, for the hairline under the minimap and the map rule. */
  tri: ['#002b7f', '#fcd116', '#ce1126'] as const,
} as const;

/** Blip colour per activity kind — matches `KIND_LABEL` in content/activities. */
export const ACTIVITY_INK: Record<string, string> = {
  courier: '#4ad6c4',
  race: '#ffb454',
  evade: '#ff5a4a',
  photo: '#c3a2ff',
};

export const ACTIVITY_GLYPH: Record<string, string> = {
  courier: '⬢',
  race: '▲',
  evade: '✦',
  photo: '◉',
};

/**
 * Chrome for both views. Mounted once into `#ui-root` by MinimapSystem, in the
 * same way `PauseMenu` mounts its own — the HUD is not ours to edit.
 */
export const MAP_CSS = `
.gta-mm {
  position:absolute; left:26px; bottom:78px; width:214px;
  font-family:Inter,system-ui,sans-serif; pointer-events:none; z-index:12;
  transition:opacity .22s ease;
}
.gta-mm.is-off { opacity:0; }
.gta-mm-shell { position:relative; }
.gta-mm canvas { display:block; width:100%; height:auto; }
.gta-mm-tri { display:flex; height:2px; margin-top:3px; opacity:.85; }
.gta-mm-tri i { flex:1; }
.gta-mm-cap {
  display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  margin-top:4px; font-size:9px; letter-spacing:.22em; font-weight:700;
  color:#b48ede; text-shadow:0 1px 3px #000;
}
.gta-mm-cap b { color:#ffb454; font-weight:800; letter-spacing:.18em; }
.gta-mm-cap i { font-style:normal; color:#ff9ec4; }

/* ---------------- full screen ---------------- */

.gta-map {
  position:absolute; inset:0; z-index:44; pointer-events:auto;
  font-family:Inter,system-ui,sans-serif; color:#f6e8ff; display:none;
  background:radial-gradient(ellipse at 50% 45%, rgba(70,20,96,.52) 0%, rgba(10,5,20,.90) 58%, rgba(4,2,9,.97) 100%);
  backdrop-filter:blur(6px) saturate(1.1);
  opacity:0; transition:opacity .16s ease;
}
.gta-map.is-open { display:block; opacity:1; }
.gta-map::before {
  content:''; position:absolute; inset:0; pointer-events:none;
  background:repeating-linear-gradient(0deg, rgba(255,61,127,.075) 0 1px, transparent 1px 3px);
  mix-blend-mode:screen; animation:gtamap-roll 7s linear infinite;
}
@keyframes gtamap-roll { to { transform:translateY(3px); } }

.gta-map-frame {
  position:absolute; inset:34px 34px 34px 34px;
  border:1px solid rgba(255,61,127,.30);
  box-shadow:0 0 0 1px rgba(162,92,255,.14), 0 30px 90px rgba(0,0,0,.72), inset 0 0 120px rgba(123,63,212,.10);
  clip-path:polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 22px 100%, 0 calc(100% - 22px));
  background:rgba(8,4,16,.55); overflow:hidden;
}
.gta-map canvas.gta-map-cv { position:absolute; inset:0; width:100%; height:100%; cursor:crosshair; }
.gta-map.is-drag canvas.gta-map-cv { cursor:grabbing; }

/* All chrome lives inside the sheet's own inset, so nothing straddles the
   frame edge — the title used to sit right on top of the border line. */
.gta-map-ui { position:absolute; inset:34px; pointer-events:none; }

.gta-map-head {
  position:absolute; left:0; right:0; top:0; padding:14px 20px 10px;
  display:flex; align-items:flex-end; gap:16px; pointer-events:none;
  background:linear-gradient(180deg, rgba(10,4,20,.92), rgba(10,4,20,0));
}
.gta-map-head h2 {
  margin:0; font-size:20px; font-weight:800; letter-spacing:.14em; line-height:1;
  background:linear-gradient(180deg,#ffd9a0,#ff7ac2 60%,#a25cff);
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
.gta-map-eyebrow { font-size:9px; letter-spacing:.42em; color:#ff9c3f; font-weight:700; margin-bottom:5px; }
.gta-map-rule { position:absolute; left:20px; right:20px; top:62px; height:1px;
  background:linear-gradient(90deg,#002b7f 0 8%,#fcd116 8% 16%,#ce1126 16% 24%,rgba(255,61,127,.5) 24%,transparent); }
.gta-map-sub { margin-left:auto; font-size:10px; letter-spacing:.2em; color:#b48ede; text-align:right; }
.gta-map-sub b { color:#ff9ec4; }

.gta-map-tools { position:absolute; right:18px; top:80px; display:flex; flex-direction:column; gap:6px; }
.gta-map-tools button {
  pointer-events:auto; min-width:104px; padding:7px 10px; font:700 10px/1 Inter,system-ui,sans-serif;
  letter-spacing:.16em; color:#c3ade0; background:rgba(20,8,34,.82);
  border:1px solid rgba(162,92,255,.28); cursor:pointer; text-align:left;
  transition:background .12s, color .12s, border-color .12s;
}
.gta-map-tools button:hover { background:rgba(255,61,127,.24); color:#fff; border-color:rgba(255,61,127,.6); }
.gta-map-tools button.on { background:#ff3d7f; color:#180520; border-color:#ff9ec4; }

.gta-map-legend {
  position:absolute; left:18px; bottom:16px; display:flex; flex-wrap:wrap; gap:4px 16px;
  max-width:56%; font-size:10px; letter-spacing:.1em; color:#c3ade0; pointer-events:none;
  text-shadow:0 1px 4px #000, 0 0 8px #000;
}
.gta-map-legend span { display:flex; align-items:center; gap:6px; }
.gta-map-legend em { width:8px; height:8px; display:inline-block; font-style:normal; }

.gta-map-foot {
  position:absolute; right:18px; bottom:16px; font-size:9.5px; letter-spacing:.22em;
  color:#9a86b8; text-align:right; pointer-events:none; text-shadow:0 1px 4px #000, 0 0 8px #000;
}
.gta-map-readout {
  position:absolute; left:18px; top:80px; padding:9px 13px; min-width:186px;
  background:linear-gradient(90deg, rgba(22,8,38,.92), rgba(18,8,30,.5));
  border-left:3px solid #ff3d7f; pointer-events:none;
}
.gta-map-readout h4 { margin:0 0 3px; font-size:10px; letter-spacing:.2em; color:#ff9ec4; font-weight:700; }
.gta-map-readout p { margin:0; font-size:14px; font-weight:700; letter-spacing:.04em; }
.gta-map-readout small { display:block; margin-top:3px; font-size:10.5px; letter-spacing:.1em; color:#b48ede; }
`;
