/**
 * THE B★ BUILDERSTAR GAMES MARK, inline.
 *
 * Geometry is the studio mark preserved at `docs/reference/menu/`: a purple
 * gradient panel with a clipped corner, a white B, a gold star over the corner
 * and the wordmark. It is emitted as SVG source rather than loaded as a file so
 * (a) nothing is fetched at runtime and (b) each part carries a class the CSS
 * can animate independently for the boot sting — the panel scales in, the B
 * wipes, the star pops, the wordmark tightens its letter-spacing.
 *
 * `id` namespaces the gradient/filter ids: the sting, the title screen and the
 * loading screen each mount their own copy and duplicate ids would make them
 * share (and fight over) one gradient.
 */

export function studioMark(id: string): string {
  return `
<svg class="fe-mark" viewBox="0 0 650 170" role="img" aria-label="Builderstar Games" focusable="false">
  <defs>
    <linearGradient id="${id}-panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fd3c84"/>
      <stop offset=".46" stop-color="#8f2fe0"/>
      <stop offset="1" stop-color="#3f0e69"/>
    </linearGradient>
    <linearGradient id="${id}-sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".85"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="${id}-shadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="7" stdDeviation="5" flood-color="#11031e" flood-opacity=".7"/>
    </filter>
    <clipPath id="${id}-clip">
      <path d="M19 12h133l27 27v111H19z"/>
    </clipPath>
  </defs>
  <g filter="url(#${id}-shadow)">
    <path class="fe-mark-panel" fill="url(#${id}-panel)" stroke="#fff" stroke-width="8"
          d="M19 12h133l27 27v111H19z"/>
    <path class="fe-mark-b" fill="#fff"
          d="M47 38h55c31 0 47 10 47 30 0 12-7 21-21 26 17 5 26 14 26 28 0 22-17 33-51 33H47zm36 25v20h16c9 0 14-3 14-10s-5-10-14-10zm0 43v23h19c10 0 15-4 15-12 0-7-5-11-15-11z"/>
    <g clip-path="url(#${id}-clip)">
      <rect class="fe-mark-sheen" x="-190" y="0" width="150" height="170"
            fill="url(#${id}-sheen)" transform="skewX(-18)"/>
    </g>
    <path class="fe-mark-star" fill="#ffd541" stroke="#2a073f" stroke-width="3"
          d="m146 15 9 18 20 3-15 14 4 20-18-10-18 10 4-20-15-14 20-3z"/>
  </g>
  <g fill="#fff">
    <text class="fe-mark-word" x="198" y="79" font-size="50">BUILDERSTAR</text>
    <text class="fe-mark-word fe-mark-word2" x="201" y="124" font-size="27">GAMES</text>
  </g>
</svg>`;
}

/** The tricolour strap used top-right on the title screen and under the sting. */
export const TRICOLOR_STOPS = '#0756c8 0 33.3%, #ffd000 33.3% 66.6%, #df243d 66.6%';
