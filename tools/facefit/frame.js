/**
 * Look-dev framing for the hero head, driven from the browser console.
 *
 * The camera is parked along the sun direction so the key light lands on the
 * face, and the actor's yaw is pinned by a rAF loop — the player controller
 * rewrites `rotation.y` every frame from its own heading, so setting it once
 * lasts exactly one frame and the shot comes out of the back of the head.
 *
 * Not shipped: `tools/` is studio-only. Paste into the console or eval it.
 */
(() => {
  const D = window.__GTA_DEBUG__;
  const S = window.__GTA_SKY__;
  const g = window.__GTA_FACE__.head.group;
  let actor = g;
  while (actor.parent && !actor.name.startsWith('char:')) actor = actor.parent;

  const api = {
    /** @param {'front'|'three'|'profile'} view */
    shot(view = 'front', dist = 0.62, fov = 32) {
      D.setWeather('clearSunset');
      D.setTimeOfDay(19.4);
      // `playerPos` is the capsule origin and it bobs with the gait, so the head
      // drifts out of frame between shots. The head bone's own world position is
      // the only stable anchor; aim a little above it, at the eye line.
      const w = g.parent.getWorldPosition(g.position.clone());
      const p = [w.x, w.y, w.z];
      const y = w.y + 0.075;
      const s = S.sunDirection;
      const L = Math.hypot(s.x, s.z) || 1;
      // Camera sits on the sun's azimuth, swung round for the other views.
      const turn = view === 'three' ? 0.62 : view === 'profile' ? 1.48 : 0;
      const ax = Math.atan2(s.x / L, s.z / L) + turn;
      const cx = p[0] + Math.sin(ax) * dist;
      const cz = p[2] + Math.cos(ax) * dist;
      D.setCamera(cx, y + 0.06, cz, p[0], y - 0.02, p[2], fov);
      // Face the camera and hold it there.
      // Keep the actor facing the key while the camera orbits for the profile.
      api.yaw = Math.atan2(s.x / L, s.z / L);
      if (!api.pinned) {
        api.pinned = true;
        const tick = () => {
          if (api.pinned) actor.rotation.y = api.yaw;
          requestAnimationFrame(tick);
        };
        tick();
      }
      return JSON.stringify(D.stats());
    },
    release() { api.pinned = false; },
    pinned: false,
    yaw: 0,
    actor,
  };
  window.__GTA_SHOT__ = api;
  return 'ok';
})();
