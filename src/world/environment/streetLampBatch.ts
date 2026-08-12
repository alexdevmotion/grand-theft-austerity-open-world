import * as THREE from 'three';

/** Authored street-lamp placement recorded by the city geometry builder. */
export interface StreetLampSlot {
  readonly x: number;
  readonly z: number;
  readonly y0: number;
  readonly inwardX: number;
  readonly inwardZ: number;
  readonly height: number;
}

const REFERENCE_HEIGHT = 8.4;
const UP = new THREE.Vector3(0, 1, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * One draw call for a chunk's lamps, while retaining a stable matrix slot for
 * every pole. Breaking a pole zeros only that slot; neighbouring lamps keep
 * their original matrices and never become thousands of Object3Ds.
 */
export class StreetLampBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  private readonly intact: boolean[];
  private readonly authored: THREE.Matrix4[];

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    slots: ReadonlyArray<StreetLampSlot>,
    name: string,
  ) {
    this.count = slots.length;
    this.intact = new Array(this.count).fill(true);
    this.authored = new Array(this.count);
    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.name = name;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;

    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const length = Math.hypot(slot.inwardX, slot.inwardZ) || 1;
      const dx = slot.inwardX / length;
      const dz = slot.inwardZ / length;
      // The template arm points local +X. THREE's +Y rotation maps local +X
      // to (cos(yaw), 0, -sin(yaw)), hence the negative atan2.
      rotation.setFromAxisAngle(UP, -Math.atan2(dz, dx));
      position.set(slot.x, slot.y0, slot.z);
      scale.set(1, slot.height / REFERENCE_HEIGHT, 1);
      const matrix = new THREE.Matrix4().compose(position, rotation, scale);
      this.authored[i] = matrix;
      this.mesh.setMatrixAt(i, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  isIntact(index: number): boolean {
    return this.intact[index] ?? false;
  }

  setIntactVisible(index: number, visible: boolean): void {
    if (index < 0 || index >= this.count || this.intact[index] === visible) return;
    this.intact[index] = visible;
    this.mesh.setMatrixAt(index, visible ? this.authored[index] : HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
