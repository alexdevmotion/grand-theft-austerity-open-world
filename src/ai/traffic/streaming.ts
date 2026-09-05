import * as THREE from 'three';
import { footprint } from './sensors';

/** Keep the whole vehicle hidden when adding or removing it from the world. */
export class TrafficVisibility {
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly corner = new THREE.Vector3();

  update(camera: THREE.PerspectiveCamera): void {
    camera.updateWorldMatrix(true, false);
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
  }

  hidden(
    position: THREE.Vector3,
    heading: number,
    kind: string,
    occluded: (point: THREE.Vector3) => boolean,
  ): boolean {
    const [halfLength, halfWidth] = footprint(kind);
    // Include tall bodies and a margin at the edge of the image. Testing only
    // the centre lets the front of a tram appear before its centre is visible.
    const height = 4;
    this.sphere.center.copy(position);
    this.sphere.center.y += height / 2;
    this.sphere.radius = Math.hypot(halfLength, halfWidth, height / 2) + 2;
    if (!this.frustum.intersectsSphere(this.sphere)) return true;

    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    // A single ray can hit a pole or cover only half of a bus. Require cover
    // for every corner of the body before streaming in the camera's view.
    for (const along of [-halfLength, halfLength]) {
      for (const across of [-halfWidth, halfWidth]) {
        for (const y of [0.4, height]) {
          this.corner.set(
            position.x + fx * along + fz * across,
            position.y + y,
            position.z + fz * along - fx * across,
          );
          if (!occluded(this.corner)) return false;
        }
      }
    }
    return true;
  }
}
