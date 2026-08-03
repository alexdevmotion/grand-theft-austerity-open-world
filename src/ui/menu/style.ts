/**
 * FRONT-END STYLE.
 *
 * The reference front-end (`docs/reference/menu/visual-proof.css`) is the spec:
 * the colour wash over the art, the grain, the tricolour strap, the BUCUREȘTI
 * chip, the GRAND / THEFT / AUSTERITY lockup with its purple stroke and hard
 * shadow, the pink selected-item underline, the gold Political Instability
 * stars. Everything here matches those values and then adds the motion the
 * reference only implies: a studio sting, a settle on the art, a staggered
 * lockup entrance, sub-pages that slide over the frame, and a broadcast band
 * that ties the front-end to the HUD and pause menu.
 *
 * TWO DELIBERATE DEPARTURES FROM THE REFERENCE CSS
 * 1. No `@import` of Google Fonts. Nothing in this game fetches an asset at
 *    runtime, and a title screen that reflows 400 ms after paint looks broken.
 *    `Archivo Black` / `Barlow Condensed` are asked for first and fall back to
 *    fonts that are actually installed (`Arial Black`, `Avenir Next Condensed`).
 * 2. Everything is namespaced under `.gta-fe` — the front-end mounts into
 *    `document.body`, above the boot overlay, and must not leak a rule into the
 *    HUD, the minimap or the pause menu.
 *
 * Animation is transform/opacity/clip-path only, so the compositor carries it
 * and the paused world behind still renders at frame rate. When the player
 * starts the game the whole root is `display:none`, so the cost in gameplay is
 * exactly zero.
 */

export const FRONT_END_CSS = `
.gta-fe {
  --fe-pink: #ff397d;
  --fe-pink-hot: #ff3b82;
  --fe-gold: #ffd541;
  --fe-deep: #2c0b3e;
  --fe-night: #12051f;
  --fe-display: 'Archivo Black', 'Arial Black', Impact, Haettenschweiler, sans-serif;
  --fe-cond: 'Barlow Condensed', 'Avenir Next Condensed', 'Arial Narrow', Inter, system-ui, sans-serif;
  --fe-body: Inter, system-ui, -apple-system, sans-serif;
  --fe-pad: clamp(28px, 5vw, 92px);

  position: fixed;
  inset: 0;
  z-index: 150;
  overflow: hidden;
  isolation: isolate;
  color: #fff;
  background: #06030c;
  font-family: var(--fe-cond);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  cursor: default;
  user-select: none;
  contain: strict;
}
.gta-fe.is-gone { display: none; }
.gta-fe * { box-sizing: border-box; margin: 0; }
.gta-fe button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }

/* ---- phases -------------------------------------------------------- */
.gta-fe .fe-phase {
  position: absolute;
  inset: 0;
  opacity: 0;
  visibility: hidden;
  transition: opacity .75s ease, visibility .75s;
}
.gta-fe .fe-phase.fe-on { opacity: 1; visibility: visible; }

/* ---- shared layers ------------------------------------------------- */
.gta-fe .fe-artwrap { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
.gta-fe .fe-art {
  position: absolute;
  inset: -3%;
  background: var(--fe-art) center 42% / cover no-repeat;
  transform: scale(1.03);
  will-change: transform;
}
.gta-fe .fe-on .fe-artwrap { animation: fe-settle 3.4s cubic-bezier(.2,.85,.2,1) both; }
.gta-fe .fe-on .fe-art { animation: fe-drift 30s ease-in-out 3.4s infinite alternate; }

.gta-fe .fe-wash {
  position: absolute;
  inset: 0;
  z-index: 1;
  background:
    linear-gradient(90deg, rgb(12 3 24 / 88%) 0%, rgb(17 5 31 / 58%) 30%, transparent 60%),
    linear-gradient(0deg, rgb(10 3 20 / 88%) 0%, rgb(12 4 22 / 32%) 34%, transparent 52%),
    radial-gradient(120% 90% at 50% 40%, transparent 42%, rgb(7 3 14 / 60%) 100%);
}
.gta-fe .fe-bloom {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  opacity: .5;
  background: radial-gradient(46% 38% at 13% 76%, rgb(255 122 60 / 26%), transparent 70%),
              radial-gradient(64% 46% at 30% 30%, rgb(196 62 214 / 14%), transparent 72%);
  animation: fe-breathe 11s ease-in-out infinite alternate;
}
.gta-fe .fe-grain {
  position: absolute;
  inset: -50%;
  z-index: 8;
  pointer-events: none;
  opacity: .13;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.62'/%3E%3C/svg%3E");
  animation: fe-grain .38s steps(2) infinite;
}
.gta-fe .fe-scan {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
  opacity: .5;
  background: repeating-linear-gradient(0deg, rgb(255 120 170 / 6%) 0 1px, transparent 1px 3px);
}
.gta-fe .fe-band {
  position: absolute;
  left: 0; right: 0;
  height: 26vh;
  z-index: 7;
  pointer-events: none;
  background: linear-gradient(180deg, transparent, rgb(255 61 127 / 7%) 45%, rgb(255 213 65 / 5%) 55%, transparent);
  animation: fe-band 9s linear infinite;
}
.gta-fe .fe-vig {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
  box-shadow: inset 0 0 22vh 8vh rgb(6 2 12 / 62%);
}

/* ================================================================== */
/* 1. STUDIO STING                                                     */
/* ================================================================== */
.gta-fe .fe-sting {
  display: grid;
  place-items: center;
  background: radial-gradient(ellipse at 50% 52%, #2b0b43 0%, #150620 44%, #05030a 100%);
  transition: opacity 1s ease, visibility 1s;
}
.gta-fe .fe-sting::before {
  content: '';
  position: absolute;
  left: 50%; top: 50%;
  width: min(1100px, 92vw);
  aspect-ratio: 2 / 1;
  transform: translate(-50%, -54%);
  background: radial-gradient(ellipse, rgb(143 47 224 / 26%), transparent 65%);
  pointer-events: none;
}
.gta-fe .fe-sting .fe-grain { opacity: .055; }
.gta-fe .fe-sting .fe-scan { opacity: .28; }
.gta-fe .fe-sting-inner { position: relative; width: min(680px, 70vw); text-align: center; }
.gta-fe .fe-sting .fe-mark { display: block; width: 100%; height: auto; overflow: visible; }
.gta-fe .fe-sting-tri {
  height: 5px;
  width: 0;
  margin: 34px auto 0;
  background: linear-gradient(90deg, #0756c8 0 33.3%, #ffd000 33.3% 66.6%, #df243d 66.6%);
  box-shadow: 0 0 26px rgb(250 54 124 / 70%);
}
.gta-fe .fe-sting-presents {
  margin-top: 20px;
  font-family: var(--fe-cond);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: .58em;
  text-indent: .58em;
  color: rgb(255 255 255 / 0%);
}
.gta-fe .fe-sting-flash {
  position: absolute;
  left: 12%; top: 2%;
  width: 26%; aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle, rgb(255 255 255 / 90%), rgb(255 213 65 / 45%) 35%, transparent 70%);
  opacity: 0;
  pointer-events: none;
}
.gta-fe .fe-skip {
  position: absolute;
  right: var(--fe-pad);
  bottom: clamp(26px, 5vh, 54px);
  z-index: 9;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .3em;
  color: rgb(255 255 255 / 0%);
}
.gta-fe .fe-sting.fe-on .fe-mark { animation: fe-mark-in 1.6s cubic-bezier(.16,1,.3,1) both; }
.gta-fe .fe-sting.fe-on .fe-mark-b { animation: fe-wipe-up .85s .5s cubic-bezier(.4,1,.3,1) both; }
.gta-fe .fe-sting.fe-on .fe-mark-sheen { animation: fe-sheen 1.25s .95s cubic-bezier(.35,.1,.2,1) both; }
.gta-fe .fe-sting.fe-on .fe-mark-star { animation: fe-star-pop .8s 1.2s cubic-bezier(.2,1.7,.35,1) both; }
.gta-fe .fe-sting.fe-on .fe-mark-word { animation: fe-word-in 1.3s 1.3s cubic-bezier(.16,1,.3,1) both; }
.gta-fe .fe-sting.fe-on .fe-mark-word2 { animation-delay: 1.46s; }
.gta-fe .fe-sting.fe-on .fe-sting-tri { animation: fe-tri-grow 1.1s 1.85s cubic-bezier(.2,.9,.2,1) both; }
.gta-fe .fe-sting.fe-on .fe-sting-presents { animation: fe-presents 1.6s 2.25s ease both; }
.gta-fe .fe-sting.fe-on .fe-sting-flash { animation: fe-flash .7s 1.2s ease-out both; }
.gta-fe .fe-sting.fe-on .fe-skip { animation: fe-hint-in 1.2s 1.9s ease both; }

.gta-fe .fe-mark-word {
  font-family: var(--fe-display);
  font-weight: 900;
  letter-spacing: 1px;
}
.gta-fe .fe-mark-word2 { letter-spacing: 12px; }
.gta-fe .fe-mark-star { transform-box: fill-box; transform-origin: center; }
.gta-fe .fe-mark-b { transform-box: fill-box; }

/* ================================================================== */
/* 2. LOADING                                                          */
/* ================================================================== */
.gta-fe .fe-load .fe-wash {
  background:
    linear-gradient(90deg, rgb(15 4 26 / 72%) 0%, rgb(17 5 31 / 34%) 42%, transparent 66%),
    linear-gradient(0deg, #10041a 0%, rgb(17 5 28 / 92%) 22%, rgb(19 5 31 / 46%) 46%, transparent 66%),
    linear-gradient(180deg, rgb(12 4 21 / 62%) 0%, transparent 22%),
    radial-gradient(120% 100% at 50% 45%, transparent 40%, rgb(7 3 14 / 62%) 100%);
}
.gta-fe .fe-load-mark {
  position: absolute;
  z-index: 4;
  top: clamp(26px, 4.4vh, 60px);
  right: var(--fe-pad);
  width: clamp(200px, 21vw, 380px);
  opacity: .95;
}
.gta-fe .fe-load-mark .fe-mark { display: block; width: 100%; height: auto; }
.gta-fe .fe-load-copy {
  position: absolute;
  z-index: 4;
  left: var(--fe-pad);
  bottom: clamp(120px, 19vh, 210px);
  width: min(72vw, 1130px);
  text-shadow: 0 4px 16px rgb(19 5 31 / 90%);
}
.gta-fe .fe-chip {
  display: inline-block;
  padding: .28em .62em .22em;
  color: #2a0b3d;
  background: var(--fe-gold);
  font-weight: 900;
  font-size: clamp(12px, 1.15vw, 19px);
  letter-spacing: .14em;
}
.gta-fe .fe-load-copy h2 {
  margin: .5em 0 0;
  font: 900 clamp(26px, 3.35vw, 56px)/1.02 var(--fe-display);
  letter-spacing: -.045em;
  text-transform: uppercase;
  text-wrap: balance;
  text-shadow: 0 6px 26px rgb(10 2 18 / 85%);
}
.gta-fe .fe-load-copy p {
  max-width: 34em;
  margin: 1em 0 0;
  color: rgb(255 255 255 / 82%);
  font-size: clamp(15px, 1.42vw, 25px);
  font-weight: 600;
  letter-spacing: .02em;
  line-height: 1.28;
}
.gta-fe .fe-swap { animation: fe-swap .8s ease both; }

.gta-fe .fe-load-foot {
  position: absolute;
  z-index: 4;
  left: var(--fe-pad);
  right: var(--fe-pad);
  bottom: clamp(30px, 5.5vh, 66px);
  display: grid;
  grid-template-columns: minmax(auto, 30%) 1fr auto;
  align-items: center;
  gap: 22px;
  font-weight: 800;
  letter-spacing: .12em;
  font-size: clamp(11px, 1.05vw, 17px);
}
.gta-fe .fe-load-status { color: rgb(255 255 255 / 88%); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gta-fe .fe-load-status::after {
  content: '';
  display: inline-block;
  width: .5em; height: 1em;
  margin-left: .5em;
  vertical-align: -.12em;
  background: var(--fe-pink);
  animation: fe-caret 1s steps(2) infinite;
}
.gta-fe .fe-bar {
  position: relative;
  height: 7px;
  background: rgb(255 255 255 / 20%);
  overflow: hidden;
}
.gta-fe .fe-bar i {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  background: linear-gradient(90deg, var(--fe-pink), var(--fe-gold));
  box-shadow: 0 0 18px var(--fe-pink);
  transition: width .3s cubic-bezier(.3,.9,.3,1);
}
.gta-fe .fe-bar b {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 30%), transparent);
  width: 18%;
  animation: fe-bar-sheen 2.4s linear infinite;
}
.gta-fe .fe-bar u {
  position: absolute;
  top: 0; bottom: 0;
  width: 2px;
  background: rgb(9 3 16 / 75%);
}
.gta-fe .fe-load-pct {
  min-width: 3.4em;
  text-align: right;
  color: var(--fe-gold);
  font-variant-numeric: tabular-nums;
  font-size: clamp(14px, 1.35vw, 22px);
}

/* ================================================================== */
/* 3. TITLE                                                            */
/* ================================================================== */
.gta-fe .fe-tri {
  position: absolute;
  z-index: 3;
  top: 0;
  right: 4vw;
  width: 0;
  height: 7px;
  background: linear-gradient(90deg, #0756c8 0 33.3%, #ffd000 33.3% 66.6%, #df243d 66.6%);
  box-shadow: 0 0 32px rgb(250 54 124 / 75%);
}
.gta-fe .fe-studio {
  position: absolute;
  z-index: 4;
  top: clamp(22px, 3.6vh, 50px);
  left: var(--fe-pad);
  width: clamp(230px, 25vw, 430px);
}
.gta-fe .fe-studio .fe-mark { display: block; width: 100%; height: auto; }

.gta-fe .fe-lockup {
  position: absolute;
  z-index: 4;
  top: 21vh;
  left: var(--fe-pad);
  width: min(44vw, 680px);
  transform: rotate(-1.5deg);
  transform-origin: 0 50%;
  filter: drop-shadow(0 12px 24px rgb(17 2 31 / 72%));
  transition: opacity .5s ease, transform .5s cubic-bezier(.2,.9,.2,1), filter .5s ease;
}
.gta-fe .fe-loc {
  width: max-content;
  margin-bottom: .3em;
  padding: .2em .58em .14em;
  color: #271037;
  background: var(--fe-gold);
  font: 900 clamp(14px, 1.35vw, 24px)/1 var(--fe-cond);
  letter-spacing: .2em;
}
.gta-fe .fe-lockup h1 {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  font: 900 clamp(56px, 7.3vw, 134px)/.7 var(--fe-display);
  letter-spacing: -.075em;
  text-transform: uppercase;
}
.gta-fe .fe-lockup h1 span {
  display: block;
  padding-right: .09em;
  color: #fff;
  -webkit-text-stroke: clamp(1px, .18vw, 4px) var(--fe-deep);
  text-shadow: 8px 8px 0 var(--fe-deep);
}
.gta-fe .fe-lockup h1 .fe-aust {
  margin-top: .14em;
  padding: .1em .14em .13em .09em;
  color: #2b093e;
  background: var(--fe-pink);
  -webkit-text-stroke: 0;
  font-size: .56em;
  letter-spacing: -.035em;
  text-shadow: none;
  box-shadow: 8px 8px 0 rgb(44 11 62 / 85%);
}
.gta-fe .fe-tag {
  margin-top: .85em;
  font: italic 800 clamp(15px, 1.6vw, 28px)/1 var(--fe-cond);
  letter-spacing: .22em;
  text-shadow: 0 3px 14px #21092c;
}

.gta-fe .fe-menu {
  position: absolute;
  z-index: 5;
  left: var(--fe-pad);
  bottom: clamp(74px, 11.4vh, 132px);
  display: flex;
  align-items: flex-start;
  gap: clamp(10px, 1.6vw, 28px);
  width: min(62vw, 860px);
}
.gta-fe .fe-item {
  position: relative;
  padding: .34em 0 .3em;
  border-bottom: 3px solid transparent;
  color: rgb(255 255 255 / 62%);
  font-size: clamp(16px, 1.55vw, 29px);
  font-weight: 800;
  letter-spacing: .07em;
  text-align: left;
  transition: color .16s ease, border-color .16s ease, transform .16s ease, text-shadow .16s ease;
}
/* The pink underline + glow IS the focus indicator; the UA ring fights it. */
.gta-fe .fe-item:focus,
.gta-fe .fe-item:focus-visible { outline: none; }
.gta-fe .fe-item .fe-item-sub {
  /* Absolute so a long sub-label cannot widen its row: the gaps between menu
     items must be set by the words the player reads, not by hidden text. */
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: .34em;
  color: var(--fe-gold);
  font-size: .52em;
  letter-spacing: .14em;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity .2s ease, transform .2s ease;
  white-space: nowrap;
}
.gta-fe .fe-item.is-sel {
  color: #fff;
  border-bottom-color: var(--fe-pink-hot);
  text-shadow: 0 0 20px rgb(255 55 128 / 95%);
  transform: translateY(-2px);
}
.gta-fe .fe-item.is-sel .fe-item-sub { opacity: 1; transform: none; }
.gta-fe .fe-item.is-off { color: rgb(255 255 255 / 26%); cursor: not-allowed; }
.gta-fe .fe-item.is-off.is-sel { color: rgb(255 255 255 / 52%); border-bottom-color: rgb(255 61 127 / 45%); text-shadow: none; }
.gta-fe .fe-item.is-off .fe-item-sub { color: rgb(255 255 255 / 40%); }

.gta-fe .fe-hint {
  position: absolute;
  z-index: 5;
  left: var(--fe-pad);
  bottom: clamp(26px, 4.2vh, 52px);
  font-size: clamp(9px, .78vw, 13px);
  font-weight: 800;
  letter-spacing: .28em;
  color: rgb(255 255 255 / 46%);
}
.gta-fe .fe-hint kbd {
  padding: .25em .5em;
  margin: 0 .15em;
  border: 1px solid rgb(255 61 127 / 40%);
  background: rgb(162 92 255 / 16%);
  color: #ffd9f0;
  font: 700 .92em/1 var(--fe-body);
  letter-spacing: .1em;
}

.gta-fe .fe-mobile-notice {
  position: absolute;
  z-index: 6;
  left: var(--fe-pad);
  bottom: clamp(26px, 4.2vh, 52px);
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(92vw, 420px);
  padding: 12px 14px 13px;
  background: linear-gradient(135deg, rgb(44 11 62 / 88%), rgb(18 5 31 / 92%));
  border-left: 3px solid var(--fe-pink-hot);
  box-shadow: 0 12px 36px rgb(0 0 0 / 45%);
}
.gta-fe .fe-mobile-notice[hidden] { display: none; }
.gta-fe .fe-mobile-kicker {
  font-family: var(--fe-cond);
  font-size: clamp(12px, 2.8vw, 15px);
  font-weight: 800;
  letter-spacing: .28em;
  color: var(--fe-gold);
}
.gta-fe .fe-mobile-body {
  font-size: clamp(12px, 3.1vw, 15px);
  font-weight: 600;
  letter-spacing: .04em;
  line-height: 1.35;
  color: #f4e9ff;
}
.gta-fe.is-mobile .fe-hint { display: none; }
.gta-fe.is-mobile .fe-menu { bottom: clamp(118px, 22vh, 168px); }

.gta-fe .fe-crisis {
  position: absolute;
  z-index: 5;
  right: clamp(24px, 4.2vw, 76px);
  bottom: clamp(28px, 5vh, 60px);
  display: grid;
  justify-items: end;
  padding: 13px 16px 11px;
  border-right: 4px solid var(--fe-pink-hot);
  background: linear-gradient(90deg, transparent, rgb(22 4 37 / 84%));
}
.gta-fe .fe-crisis span {
  font-size: clamp(11px, .95vw, 17px);
  font-weight: 800;
  letter-spacing: .17em;
}
.gta-fe .fe-crisis b { display: flex; gap: .12em; margin-top: .18em; }
.gta-fe .fe-crisis i {
  color: var(--fe-gold);
  font-size: clamp(18px, 1.9vw, 34px);
  font-style: normal;
  line-height: 1;
  text-shadow: 0 0 15px #fd317f;
}
.gta-fe .fe-edition {
  position: absolute;
  z-index: 4;
  top: 50%;
  right: -128px;
  transform: rotate(90deg);
  color: rgb(255 255 255 / 52%);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .23em;
}

/* entrance --------------------------------------------------------- */
.gta-fe .fe-title.fe-on .fe-tri { animation: fe-tri-title 1.1s .2s cubic-bezier(.2,.9,.2,1) both; }
.gta-fe .fe-title.fe-on .fe-studio { animation: fe-rise .9s .3s cubic-bezier(.16,1,.3,1) both; }
.gta-fe .fe-title.fe-on .fe-loc { animation: fe-wipe-right .6s .5s cubic-bezier(.3,.9,.2,1) both; }
.gta-fe .fe-title.fe-on h1 span { animation: fe-slide-in .85s cubic-bezier(.16,1,.3,1) both; }
.gta-fe .fe-title.fe-on h1 span:nth-child(1) { animation-delay: .62s; }
.gta-fe .fe-title.fe-on h1 span:nth-child(2) { animation-delay: .74s; }
.gta-fe .fe-title.fe-on h1 .fe-aust { animation: fe-stamp .7s .92s cubic-bezier(.2,1.5,.3,1) both; }
.gta-fe .fe-title.fe-on .fe-tag { animation: fe-tag-in 1.4s 1.12s cubic-bezier(.16,1,.3,1) both; }
.gta-fe .fe-title.fe-on .fe-item { animation: fe-rise .8s cubic-bezier(.16,1,.3,1) both; }
.gta-fe .fe-title.fe-on .fe-item:nth-child(1) { animation-delay: 1.24s; }
.gta-fe .fe-title.fe-on .fe-item:nth-child(2) { animation-delay: 1.33s; }
.gta-fe .fe-title.fe-on .fe-item:nth-child(3) { animation-delay: 1.42s; }
.gta-fe .fe-title.fe-on .fe-item:nth-child(4) { animation-delay: 1.51s; }
.gta-fe .fe-title.fe-on .fe-item:nth-child(5) { animation-delay: 1.60s; }
.gta-fe .fe-title.fe-on .fe-crisis { animation: fe-rise .9s 1.55s cubic-bezier(.16,1,.3,1) both; }
.gta-fe .fe-title.fe-on .fe-crisis i { animation: fe-star-pop .7s cubic-bezier(.2,1.7,.35,1) both; }
.gta-fe .fe-title.fe-on .fe-crisis i:nth-child(1) { animation-delay: 1.70s; }
.gta-fe .fe-title.fe-on .fe-crisis i:nth-child(2) { animation-delay: 1.82s; }
.gta-fe .fe-title.fe-on .fe-crisis i:nth-child(3) { animation-delay: 1.94s; }
.gta-fe .fe-title.fe-on .fe-crisis i:nth-child(4) { animation-delay: 2.06s; }
.gta-fe .fe-title.fe-on .fe-crisis i:nth-child(5) { animation-delay: 2.18s; }
.gta-fe .fe-title.fe-on .fe-edition { animation: fe-fade-in 1.2s 2s ease both; }
.gta-fe .fe-title.fe-on .fe-hint { animation: fe-hint-in 1.2s 2.2s ease both; }
.gta-fe .fe-title.fe-on .fe-mobile-notice { animation: fe-hint-in 1.2s 2.0s ease both; }

/* ---- sub-pages ---------------------------------------------------- */
/* A page is modal: the frame behind it drops away. This is also insurance —
   whatever the compositor does with the art layer under a panel, there is
   nothing bright left underneath to show through. */
.gta-fe .fe-scrim {
  position: absolute;
  inset: 0;
  /* Under the menu row (5) and the panel (6), over the art and the lockup (4)
     — the row you are navigating must stay crisp. */
  z-index: 4;
  pointer-events: none;
  opacity: 0;
  background: linear-gradient(90deg, rgb(6 2 12 / 62%), rgb(6 2 12 / 78%));
  transition: opacity .32s ease;
}
.gta-fe .fe-title.has-page .fe-scrim { opacity: 1; }
.gta-fe .fe-page {
  position: absolute;
  z-index: 6;
  top: 46%;
  right: var(--fe-pad);
  width: min(55vw, 790px);
  height: auto;
  max-height: min(78vh, calc(100% - 190px));
  display: flex;
  flex-direction: column;
  padding: 26px 30px 20px;
  /* Glass, not a sticker: the frame stays readable behind an out-of-focus wash
     of the art, which is what stops the panel looking pasted on. */
  /* No backdrop-filter: in headless Chrome it swallows the element's own
     background and the art bleeds straight through the panel. A solid panel is
     also the more legible answer over art this busy. */
  background: linear-gradient(180deg, #180a2a, #0a0512);
  border: 1px solid rgb(255 61 127 / 34%);
  box-shadow: 0 0 0 1px rgb(162 92 255 / 16%), 0 34px 90px rgb(0 0 0 / 70%), inset 0 0 90px rgb(123 63 212 / 16%);
  clip-path: polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px));
  opacity: 0;
  visibility: hidden;
  transform: translate(34px, -50%);
  transition: opacity .28s ease, transform .32s cubic-bezier(.16,1,.3,1), visibility .32s;
  font-family: var(--fe-body);
}
.gta-fe .fe-title.has-page .fe-page { opacity: 1; visibility: visible; transform: translate(0, -50%); }
.gta-fe .fe-title.has-page .fe-lockup { opacity: .3; transform: rotate(-1.5deg) translateX(-26px) scale(.94); filter: none; }
/* !important beats the entrance keyframes, which are still holding their end
   state on these elements (animation-fill-mode: both). */
.gta-fe .fe-title.has-page .fe-crisis,
.gta-fe .fe-title.has-page .fe-crisis i,
.gta-fe .fe-title.has-page .fe-edition {
  animation: none !important;
  opacity: 0 !important;
  transition: opacity .3s ease;
}
.gta-fe .fe-title.has-page .fe-item { color: rgb(255 255 255 / 34%); }
.gta-fe .fe-title.has-page .fe-item.is-sel { color: #fff; }

.gta-fe .fe-page-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .42em; color: #ff9c3f; }
.gta-fe .fe-page-title {
  margin: 8px 0 2px;
  font: 900 clamp(26px, 2.6vw, 44px)/1 var(--fe-display);
  letter-spacing: .02em;
  background: linear-gradient(180deg, #ffd9a0 0%, #ff7ac2 55%, #a25cff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.gta-fe .fe-page-crumb { font-size: 10px; letter-spacing: .34em; color: #b48ede; }
.gta-fe .fe-page-rule { height: 1px; margin: 16px 0 14px; background: linear-gradient(90deg, var(--fe-pink), #a25cff, transparent); }
.gta-fe .fe-page-body {
  flex: 0 1 auto;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: rgb(255 61 127 / 55%) transparent;
  /* Fades the cut edge so a list that continues below the fold says so. */
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 22px, #000 calc(100% - 30px), transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0, #000 22px, #000 calc(100% - 30px), transparent 100%);
}
.gta-fe .fe-page-body::-webkit-scrollbar { width: 4px; }
.gta-fe .fe-page-body::-webkit-scrollbar-thumb { background: rgb(255 61 127 / 55%); }
.gta-fe .fe-page-foot { margin-top: 14px; font-size: 10px; letter-spacing: .26em; color: #7f6b9c; }

.gta-fe .fe-row {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  padding: 11px 14px;
  background: rgb(255 255 255 / 3%);
  border-left: 3px solid transparent;
  margin-bottom: 6px;
  transition: background .12s, border-color .12s, transform .12s;
}
.gta-fe .fe-row.is-sel {
  background: linear-gradient(90deg, rgb(255 61 127 / 22%), rgb(123 63 212 / 10%) 60%, transparent);
  border-left-color: var(--fe-pink);
  transform: translateX(3px);
}
.gta-fe .fe-row-lab { font-size: 13px; font-weight: 600; letter-spacing: .08em; min-width: 42%; }
.gta-fe .fe-row-ctl { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.gta-fe .fe-row-ctl b { min-width: 3.4em; text-align: right; font-size: 12px; letter-spacing: .1em; color: #ffb454; }
.gta-fe .fe-row-t { font-size: 15px; font-weight: 800; letter-spacing: .13em; }

.gta-fe .fe-segs { display: flex; gap: 4px; }
.gta-fe .fe-seg {
  padding: 6px 11px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .16em;
  background: rgb(255 255 255 / 5%);
  color: #c3ade0;
  border: 1px solid transparent;
  cursor: pointer;
}
.gta-fe .fe-seg.on { background: var(--fe-pink); color: #180520; border-color: #ff9ec4; }
.gta-fe .fe-meter { position: relative; width: clamp(120px, 16vw, 190px); height: 4px; background: #3d2359; }
.gta-fe .fe-meter i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, var(--fe-pink), var(--fe-gold)); }
.gta-fe .fe-meter s {
  position: absolute;
  top: -6px;
  width: 3px; height: 16px;
  margin-left: -1.5px;
  background: #fff;
  box-shadow: 0 0 10px rgb(255 61 127 / 90%);
}

.gta-fe .fe-group { margin: 0 0 13px; }
.gta-fe .fe-group h4 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-family: var(--fe-cond);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .3em;
  color: var(--fe-gold);
}
.gta-fe .fe-group h4::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, rgb(255 213 65 / 45%), transparent); }
.gta-fe .fe-keys { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0 24px; }
.gta-fe .fe-key { display: flex; align-items: center; gap: 10px; padding: 4.5px 2px; border-bottom: 1px solid rgb(255 255 255 / 6%); }
.gta-fe .fe-key-k { display: flex; gap: 4px; min-width: 116px; flex-wrap: wrap; }
.gta-fe .fe-key-l { font-size: 12px; color: #d9c8ee; }
.gta-fe kbd {
  padding: 5px 7px;
  background: rgb(162 92 255 / 16%);
  border: 1px solid rgb(255 61 127 / 35%);
  color: #ffd9f0;
  font: 700 10px/1 ui-monospace, monospace;
  letter-spacing: .08em;
  white-space: nowrap;
}
.gta-fe .fe-note { margin-top: 10px; font-size: 10.5px; letter-spacing: .1em; color: #8b76a8; line-height: 1.5; }

.gta-fe .fe-credits { padding-right: 8px; }
.gta-fe .fe-credit-block { margin-bottom: 22px; }
.gta-fe .fe-credit-block h5 {
  font-family: var(--fe-cond);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .34em;
  color: var(--fe-pink);
  margin-bottom: 7px;
}
.gta-fe .fe-credit-block p { font-size: 13px; line-height: 1.7; color: #e6d9f6; }
.gta-fe .fe-credit-end { padding: 10px 0 30px; font-family: var(--fe-cond); font-size: 12px; letter-spacing: .3em; color: #8b76a8; }

/* ---- start curtain ------------------------------------------------ */
.gta-fe .fe-curtain {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(circle at 30% 62%, rgb(255 89 150 / 55%), rgb(20 5 32 / 92%) 45%, #05030a 78%);
}
.gta-fe .fe-launch {
  position: absolute;
  left: var(--fe-pad);
  right: var(--fe-pad);
  bottom: clamp(34px, 7vh, 82px);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px 24px;
  opacity: 0;
  transform: translateY(16px);
}
.gta-fe .fe-launch-kicker {
  grid-column: 1 / -1;
  color: var(--fe-gold);
  font-size: clamp(10px, .78vw, 13px);
  font-weight: 900;
  letter-spacing: .34em;
}
.gta-fe .fe-launch-status {
  color: rgb(255 255 255 / 92%);
  font-size: clamp(13px, 1.15vw, 19px);
  font-weight: 900;
  letter-spacing: .16em;
}
.gta-fe .fe-launch-progress {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 4ch;
  align-items: center;
  gap: 18px;
}
.gta-fe .fe-launch-bar {
  position: relative;
  height: 8px;
  overflow: hidden;
  background: rgb(255 255 255 / 18%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 10%);
}
.gta-fe .fe-launch-bar i {
  position: absolute;
  inset: 0;
  transform: scaleX(0);
  transform-origin: left center;
  background: linear-gradient(90deg, var(--fe-pink), var(--fe-gold));
  transition: transform .42s cubic-bezier(.16, 1, .3, 1);
}
.gta-fe .fe-launch-pct {
  color: var(--fe-gold);
  font-size: clamp(14px, 1.25vw, 21px);
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
/* The controls, on the curtain the player waits behind after START. */
.gta-fe .fe-launch-keys {
  grid-column: 1 / -1;
  margin-top: clamp(10px, 1.6vh, 20px);
  padding-top: clamp(10px, 1.6vh, 18px);
  border-top: 1px solid rgb(255 255 255 / 14%);
}
.gta-fe .fe-launch-keys-t {
  margin: 0 0 8px;
  color: var(--fe-gold);
  font-size: clamp(9px, .7vw, 12px);
  font-weight: 900;
  letter-spacing: .34em;
}
.gta-fe .fe-launch-keys-g {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px 26px;
  max-width: 1100px;
}
.gta-fe .fe-hint-key { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gta-fe .fe-hint-k { display: flex; gap: 3px; flex-shrink: 0; }
.gta-fe .fe-hint-l {
  font-size: clamp(10px, .82vw, 13px);
  font-weight: 700;
  letter-spacing: .08em;
  color: rgb(255 255 255 / 66%);
}
.gta-fe.is-starting .fe-curtain { animation: fe-curtain 1.15s ease-in both; }
.gta-fe.is-starting .fe-launch { animation: fe-launch-in .55s .35s cubic-bezier(.16, 1, .3, 1) both; }
.gta-fe.is-starting .fe-lockup { animation: fe-punch .9s ease-out both; }
.gta-fe.is-starting .fe-menu,
.gta-fe.is-starting .fe-hint,
.gta-fe.is-starting .fe-mobile-notice,
.gta-fe.is-starting .fe-crisis,
.gta-fe.is-starting .fe-page { opacity: 0; transition: opacity .3s ease; }

/* ================================================================== */
/* keyframes                                                           */
/* ================================================================== */
@keyframes fe-grain {
  0% { transform: translate(1%, -1%); }
  25% { transform: translate(-2%, 2%); }
  50% { transform: translate(2%, 1%); }
  75% { transform: translate(-1%, -2%); }
  100% { transform: translate(1%, 2%); }
}
@keyframes fe-drift {
  from { transform: scale(1.03) translate3d(-.6%, 0, 0); }
  to { transform: scale(1.085) translate3d(1.4%, -1.1%, 0); }
}
@keyframes fe-settle {
  from { transform: scale(1.09); }
  to { transform: scale(1); }
}
@keyframes fe-breathe {
  from { opacity: .38; }
  to { opacity: .62; }
}
@keyframes fe-band {
  0% { top: -30%; }
  100% { top: 115%; }
}
@keyframes fe-caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes fe-bar-sheen { from { transform: translateX(-120%); } to { transform: translateX(560%); } }
@keyframes fe-swap {
  0% { opacity: 1; }
  22% { opacity: 0; transform: translateY(10px); }
  23% { transform: translateY(-10px); }
  100% { opacity: 1; transform: none; }
}
@keyframes fe-mark-in {
  from { opacity: 0; transform: scale(.9) translateY(16px); filter: blur(7px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes fe-wipe-up {
  from { clip-path: inset(100% 0 0 0); }
  to { clip-path: inset(0 0 0 0); }
}
@keyframes fe-sheen {
  from { transform: translateX(0) skewX(-18deg); }
  to { transform: translateX(1000px) skewX(-18deg); }
}
@keyframes fe-star-pop {
  0% { opacity: 0; transform: scale(0) rotate(-70deg); }
  60% { opacity: 1; transform: scale(1.22) rotate(6deg); }
  100% { opacity: 1; transform: none; }
}
@keyframes fe-word-in {
  from { opacity: 0; letter-spacing: 22px; }
  to { opacity: 1; }
}
@keyframes fe-tri-grow {
  from { width: 0; }
  to { width: min(320px, 58%); }
}
@keyframes fe-tri-title {
  from { width: 0; }
  to { width: 26vw; }
}
@keyframes fe-presents {
  0% { opacity: 0; letter-spacing: .9em; }
  35%, 100% { color: rgb(255 255 255 / 62%); letter-spacing: .58em; }
}
@keyframes fe-flash {
  0% { opacity: 0; transform: scale(.2); }
  30% { opacity: .95; }
  100% { opacity: 0; transform: scale(2.4); }
}
@keyframes fe-hint-in {
  from { opacity: 0; }
  to { color: rgb(255 255 255 / 46%); opacity: 1; }
}
@keyframes fe-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes fe-rise {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: none; }
}
@keyframes fe-wipe-right {
  from { clip-path: inset(0 100% 0 0); }
  to { clip-path: inset(0 0 0 0); }
}
@keyframes fe-slide-in {
  from { opacity: 0; transform: translateX(-52px) skewX(6deg); }
  to { opacity: 1; transform: none; }
}
@keyframes fe-stamp {
  0% { opacity: 0; transform: scale(1.28) translateY(-6px); }
  100% { opacity: 1; transform: none; }
}
@keyframes fe-tag-in {
  0% { opacity: 0; letter-spacing: .7em; }
  100% { opacity: 1; letter-spacing: .22em; }
}
@keyframes fe-curtain {
  0% { opacity: 0; }
  22% { opacity: .55; }
  100% { opacity: 1; }
}
@keyframes fe-launch-in {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: none; }
}
@keyframes fe-punch {
  0% { transform: rotate(-1.5deg) scale(1); }
  18% { transform: rotate(-1.5deg) scale(1.045); }
  100% { transform: rotate(-1.5deg) scale(1.02); opacity: .2; }
}

/* ---- narrow / short screens --------------------------------------- */
@media (max-width: 900px) {
  .gta-fe .fe-lockup { top: 18vh; width: 74vw; }
  .gta-fe .fe-lockup h1 { font-size: clamp(46px, 13vw, 82px); }
  .gta-fe .fe-menu { width: 90vw; flex-wrap: wrap; gap: 12px 18px; }
  .gta-fe .fe-crisis, .gta-fe .fe-edition { display: none; }
  .gta-fe .fe-page { left: var(--fe-pad); width: auto; top: 12vh; bottom: 12vh; }
  .gta-fe .fe-load-copy { width: 86vw; }
  .gta-fe .fe-load-foot { grid-template-columns: 1fr auto; }
  .gta-fe .fe-load-status { grid-column: 1 / -1; }
  .gta-fe .fe-launch { bottom: clamp(28px, 6vh, 54px); }
  .gta-fe .fe-launch-status { letter-spacing: .1em; }
}
@media (max-height: 620px) {
  .gta-fe .fe-lockup { top: 15vh; }
  .gta-fe .fe-studio { width: clamp(190px, 20vw, 300px); }
  .gta-fe .fe-menu { bottom: 42px; }
  .gta-fe .fe-hint { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .gta-fe .fe-grain,
  .gta-fe .fe-band,
  .gta-fe .fe-bloom,
  .gta-fe .fe-on .fe-art,
  .gta-fe .fe-on .fe-artwrap,
  .gta-fe .fe-bar b { animation: none; }
  .gta-fe.is-starting .fe-launch { animation-duration: .01ms; animation-delay: 0s; }
}
`;
