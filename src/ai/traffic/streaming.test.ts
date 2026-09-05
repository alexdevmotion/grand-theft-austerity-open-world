import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { TrafficVisibility } from './streaming';

function view(): TrafficVisibility {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -1);
  const visibility = new TrafficVisibility();
  visibility.update(camera);
  return visibility;
}

describe('traffic streaming visibility', () => {
  test('an exposed vehicle stays visible at both near and distant spawn ranges', () => {
    const visibility = view();
    for (const z of [-45, -100, -150, -195, -400]) {
      expect(visibility.hidden(new THREE.Vector3(0, 0, z), 0, 'dacia', () => false)).toBe(false);
    }
  });

  test('a tram whose centre is outside the frame still needs cover for its visible end', () => {
    // At 100 m the right image edge is x=57.7; the tram nose reaches x=54.3.
    expect(view().hidden(new THREE.Vector3(62, 0, -100), Math.PI / 2, 'tram', () => false)).toBe(false);
  });

  test('vehicles behind the camera can stream without an occlusion ray', () => {
    let rays = 0;
    expect(view().hidden(new THREE.Vector3(0, 0, 60), 0, 'bus', () => { rays++; return false; })).toBe(true);
    expect(rays).toBe(0);
  });

  test('cover must hide every corner including the roof of a tall vehicle', () => {
    const visibility = view();
    const position = new THREE.Vector3(0, 0, -100);
    expect(visibility.hidden(position, 0, 'bus', (p) => p.y < 2)).toBe(false);
    let rays = 0;
    expect(visibility.hidden(position, 0, 'bus', () => { rays++; return true; })).toBe(true);
    expect(rays).toBe(8);
  });

  test('camera cuts immediately use the new view without exposing fresh spawns', () => {
    const visibility = view();
    const position = new THREE.Vector3(0, 0, 80);
    expect(visibility.hidden(position, 0, 'dacia', () => false)).toBe(true);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 2, 100);
    visibility.update(camera);
    expect(visibility.hidden(position, 0, 'dacia', () => false)).toBe(false);
  });
});
