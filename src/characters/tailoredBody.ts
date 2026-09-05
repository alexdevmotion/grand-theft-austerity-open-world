import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import source from './generated/anatomical-body.json';
import { BI, type BoneName, type Rig } from './rig';
import { SLOT, slotU, type Appearance, type SlotId } from './wardrobe';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smooth = (lo: number, hi: number, x: number): number => {
  const t = clamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t);
};
const names = source.boneNames as BoneName[];
const count = source.position.length / 3;
const neighbours: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
for (let i = 0; i < source.index.length; i += 3) {
  const tri = source.index.slice(i, i + 3);
  for (const a of tri) for (const b of tri) if (a !== b) neighbours[a].add(b);
}
const adjacent = neighbours.map(s => [...s]);

interface BindMap { origin: THREE.Vector3; target: THREE.Vector3; axis: THREE.Vector3;
  rotation: THREE.Quaternion; along: number; across: number }

/** Native HM08 shoulders, axillae, pelvis and hands share vertices. Authored
 * weights are transferred to the frozen game rig; only the bind pose changes. */
export function buildTailoredBody(a: Appearance, rig: Rig): THREE.BufferGeometry {
  const m = rig.metrics;
  const bodyGirth = m.waistW / (a.female ? .1224 : .136);
  const V = (p: number[]) => new THREE.Vector3(p[0], p[1], p[2]);
  const sourceBones = source.bones as Record<BoneName, { head: number[]; tail: number[] }>;
  const maps: BindMap[] = names.map(name => {
    const origin = V(sourceBones[name].head);
    const rawTail = V(sourceBones[name].tail);
    const axis = rawTail.sub(origin);
    const rawLength = axis.length(); axis.normalize();
    const target = rig.points.joint[name];
    const targetAxis = rig.points.dir[name];
    const rotation = new THREE.Quaternion().setFromUnitVectors(axis, targetAxis);
    const hand = /^(hand|thumb|index|middle|ring|pinky)/.test(name);
    if (hand) {
      const side = name.endsWith('L') ? 'L' : 'R';
      const sourceAcross = V(sourceBones[`index0${side}`].head).sub(V(sourceBones[`pinky0${side}`].head));
      sourceAcross.addScaledVector(axis, -sourceAcross.dot(axis)).normalize();
      const targetAcross = rig.points.hand[side].across.clone();
      targetAcross.addScaledVector(targetAxis, -targetAcross.dot(targetAxis)).normalize();
      const from = new THREE.Matrix4().makeBasis(sourceAcross, axis, new THREE.Vector3().crossVectors(sourceAcross, axis));
      const to = new THREE.Matrix4().makeBasis(targetAcross, targetAxis, new THREE.Vector3().crossVectors(targetAcross, targetAxis));
      rotation.setFromRotationMatrix(to.multiply(from.transpose()));
    }
    const gameLength = name.startsWith('hand')
      ? target.distanceTo(rig.points.joint[name.endsWith('L') ? 'middle0L' : 'middle0R'])
      : rig.points.len[name];
    return { origin, target, axis, rotation, along: gameLength / rawLength,
      across: (hand ? .103 : .106) * (hand ? .9 + bodyGirth * .1 : .7 + bodyGirth * .3) };
  });
  const points = new Float32Array(count * 3);
  const boneIndices = new Uint16Array(count * 4);
  const weights = new Float32Array(source.skinWeight);
  const dominant: BoneName[] = [];
  const bare = new Uint8Array(count);
  const sleeves = a.outer !== 'none' && !['hiVis', 'apron'].includes(a.outer);
  const outer = a.outer !== 'none';
  const skirt = a.legs === 'skirt' || a.legs === 'longSkirt';
  const q = new THREE.Vector3(), raw = new THREE.Vector3(), p = new THREE.Vector3();
  const spineStops = [
    [-.8, m.hipY - .13], [.7268, m.hipY], [1.1868, lerp(m.hipY, m.spineY, .38)],
    [1.8666, m.spineY], [2.7966, m.chestY], [4.3285, m.shoulderY - .07],
    [5.2458, m.shoulderY], [5.8902, m.neckY], [6.5, m.neckY + .075],
  ];
  const torsoPoint = (rawPoint: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => {
    let k = 0;
    while (k < spineStops.length - 2 && rawPoint.y > spineStops[k + 1][0]) k++;
    const [y0, a0] = spineStops[k], [y1, a1] = spineStops[k + 1];
    const yy = lerp(a0, a1, (rawPoint.y - y0) / (y1 - y0));
    const neck = smooth(m.shoulderY, m.neckY, yy);
    const sx = lerp(.113 * (.72 + bodyGirth * .28), .102, neck);
    return out.set(rawPoint.x * sx, yy, rawPoint.z * .105 * (.65 + bodyGirth * .35) - .012);
  };
  for (let i = 0; i < count; i++) {
    raw.fromArray(source.position, i * 3); p.set(0, 0, 0);
    dominant[i] = names[source.skinIndex[i * 4]];
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += weights[i * 4 + k];
    for (let k = 0; k < 4; k++) {
      const si = source.skinIndex[i * 4 + k], name = names[si], map = maps[si];
      const w = weights[i * 4 + k] /= sum;
      boneIndices[i * 4 + k] = BI[name];
      if (!w) continue;
      if (/^(hips|spine|chest|upperChest|neck|head)$/.test(name)) torsoPoint(raw, q);
      else {
        q.copy(raw).sub(map.origin);
        const along = q.dot(map.axis);
        q.addScaledVector(map.axis, -along).multiplyScalar(map.across)
          .addScaledVector(map.axis, along * map.along).applyQuaternion(map.rotation).add(map.target);
      }
      p.addScaledVector(q, w);
    }
    const name = dominant[i];
    // The source clavicle frame pitches backwards; transferring its full
    // surface radius raises the deltoid above the neck. Compress just that
    // upper shoulder volume into the acromion-to-neck slope of this rig.
    const shoulderBlend = smooth(.072, .145, Math.abs(p.x));
    if (p.y > m.shoulderY - .04 && Math.abs(p.x) < m.shoulderHalf + .12) {
      p.y = lerp(p.y, m.shoulderY - .04 + (p.y - m.shoulderY + .04) * .52, shoulderBlend);
    }
    if (!a.female && p.z > .02 && Math.abs(p.x) < m.chestW + .018) {
      // HM08's neutral surface carries breasts. Male garments bridge that
      // topology with one broad chest plane instead of preserving two cups.
      const chestBand = smooth(m.spineY+.015,m.chestY+.02,p.y)
        * (1-smooth(m.shoulderY-.11,m.shoulderY-.025,p.y));
      const lateral = Math.abs(p.x)/(m.chestW+.030);
      const chestFront = .108*(.80+bodyGirth*.20)*Math.pow(Math.max(0,1-lateral*lateral),.42);
      p.z = lerp(p.z,chestFront,chestBand*smooth(.02,.065,p.z));
    }
    const hand = /^(hand|thumb|index|middle|ring|pinky)/.test(name);
    const shortArm = a.shortSleeve && (/^forearm/.test(name) ||
      (/^upperArm/.test(name) && p.y < m.shoulderY - m.upperArmLen * .48));
    const bareLeg = /^(thigh|shin|foot|toe)/.test(name) &&
      (skirt || (a.legs === 'shorts' && p.y < lerp(m.hipY, m.kneeY, .58)));
    bare[i] = hand || shortArm || bareLeg || (p.y > m.neckY - .018 && Math.abs(p.x) < m.neckR * 1.25) ? 1 : 0;
    p.toArray(points, i * 3);
  }

  // A garment bridges small anatomical hollows. Keep the source's shoulder
  // topology while removing skin-scale detail beneath cloth, then add ease.
  for (let pass = 0; pass < 5; pass++) {
    const before = points.slice();
    for (let i = 0; i < count; i++) {
      if (bare[i]) continue;
      const ns = adjacent[i];
      for (let axis = 0; axis < 3; axis++) {
        let avg = 0; for (const n of ns) avg += before[n * 3 + axis];
        points[i * 3 + axis] = lerp(before[i * 3 + axis], avg / ns.length, .36);
      }
    }
  }
  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.BufferAttribute(points, 3));
  base.setIndex(source.index); base.computeVertexNormals();
  const normals = base.getAttribute('normal');
  for (let i = 0; i < count; i++) {
    if (bare[i]) continue;
    p.fromArray(points, i * 3);
    const name = dominant[i], leg = /^(thigh|shin|foot|toe)/.test(name);
    const arm = /^(upperArm|forearm)/.test(name);
    let ease = leg ? .014 : (outer && (!arm || sleeves) ? (arm ? .022 : .030) : .009);
    if (a.outer === 'puffer' && !leg) ease += .022;
    if (leg) {
      // Trouser cloth hangs past the calf rather than copying its bare taper.
      const side = p.x > 0 ? 'L' : 'R';
      const ankle = rig.points.joint[`foot${side}`];
      const cuff = 1 - smooth(m.ankleY + .06, m.kneeY, p.y);
      const radial = Math.hypot(p.x - ankle.x, p.z - ankle.z);
      ease += Math.max(0, .052 * (.8 + bodyGirth * .2) - radial) * cuff;
      const knee = Math.exp(-(((p.y - m.kneeY) / .095) ** 2));
      const ankleFold = Math.exp(-(((p.y - m.ankleY - .055) / .048) ** 2));
      ease += .0045 * knee * Math.sin(p.y * 88 + p.x * 21 + p.z * 13)
        + .005 * ankleFold * Math.sin(p.y * 135 - p.x * 25);
    } else if (arm) {
      const elbow = rig.points.joint[name.endsWith('L') ? 'forearmL' : 'forearmR'];
      ease += .006 * Math.exp(-(((p.y - elbow.y) / .08) ** 2)) * Math.sin(p.y * 108 + p.z * 34);
    } else {
      ease += .008 * Math.exp(-(((p.y - m.spineY) / .15) ** 2)) * Math.sin(p.y * 64 + p.x * 20);
    }
    p.x += normals.getX(i) * ease; p.y += normals.getY(i) * ease; p.z += normals.getZ(i) * ease;
    p.toArray(points, i * 3);
  }
  base.computeVertexNormals();
  const normal = base.getAttribute('normal');
  const positions: number[] = [], uv: number[] = [], skinIndex: number[] = [], skinWeight: number[] = [], norm: number[] = [], index: number[] = [];
  const remap = new Map<string, number>();
  const waistCut = m.hipY + .035;
  const put = (i: number, slot: SlotId): number => {
    const key = `${i}:${slot}`; const known = remap.get(key); if (known !== undefined) return known;
    const out = positions.length / 3; remap.set(key, out);
    let px = points[i * 3], py = points[i * 3 + 1], pz = points[i * 3 + 2];
    const garmentTorso = (slot === SLOT.OUTER || (!outer && slot === SLOT.TOP)) && !/^(upperArm|forearm|hand|thumb|index|middle|ring|pinky)/.test(dominant[i]);
    if (garmentTorso) {
      const upper = m.spineY + .08;
      const lower = clamp((upper - py) / (upper - waistCut), 0, 1.5);
      const hem = !outer ? -.006 : a.outer === 'suit' ? .115 : a.outer === 'coat' ? .22 : a.outer === 'longCoat' ? .33 : .080;
      if (py < upper) py = lerp(m.hipY - hem, upper, (py - waistCut) / (upper - waistCut));
      px += Math.sign(px) * lower * (outer ? .018 : .004);
      pz += Math.sign(pz) * lower * (outer ? .017 : .003);
    }
    positions.push(px, py, pz);
    norm.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    const yy = points[i * 3 + 1];
    const v = slot === SLOT.LEGS ? clamp((m.hipY + .04 - yy) / (m.hipY - m.ankleY) * .8, .02, .86)
      : slot === SLOT.SKIN ? .56 : clamp((m.neckY - yy) / .68 * .48, .01, .52);
    // A little angular UV span keeps fabric grain from becoming latitude bands.
    uv.push(slotU(slot) + Math.sin(points[i * 3] * 17) * .018, 1 - v);
    for (let k = 0; k < 4; k++) {
      // The free hem belongs to the pelvis, never to either moving thigh.
      skinIndex.push(garmentTorso && points[i*3+1] < m.hipY+.08 ? BI.hips : boneIndices[i * 4 + k]);
      skinWeight.push(garmentTorso && points[i*3+1] < m.hipY+.08 ? (k === 0 ? 1 : 0) : weights[i * 4 + k]);
    }
    return out;
  };
  const interpolateVertex = (ia: number, ib: number, t: number): number => {
    const out = positions.length/3;
    for (let k=0;k<3;k++) { positions.push(lerp(positions[ia*3+k],positions[ib*3+k],t)); norm.push(lerp(norm[ia*3+k],norm[ib*3+k],t)); }
    for (let k=0;k<2;k++) uv.push(lerp(uv[ia*2+k],uv[ib*2+k],t));
    const combined = new Map<number,number>();
    for (const [vertex,blend] of [[ia,1-t],[ib,t]]) for (let k=0;k<4;k++) {
      const bone=skinIndex[vertex*4+k]; combined.set(bone,(combined.get(bone)??0)+skinWeight[vertex*4+k]*blend);
    }
    const ws=[...combined].sort((a,b)=>b[1]-a[1]).slice(0,4), total=ws.reduce((n,w)=>n+w[1],0);
    for(let k=0;k<4;k++){skinIndex.push(ws[k]?.[0]??0);skinWeight.push((ws[k]?.[1]??0)/total);}
    return out;
  };
  const waistVertex = (a: number, b: number, slot: SlotId): number => {
    const t = (waistCut - points[a*3+1]) / (points[b*3+1] - points[a*3+1]);
    return interpolateVertex(put(a,slot),put(b,slot),t);
  };
  const clippedWaist = (ids: number[], above: boolean): void => {
    const slot = above ? (outer ? SLOT.OUTER : SLOT.TOP) : SLOT.LEGS;
    const polygon: number[] = [];
    for(let k=0;k<3;k++) {
      const i=ids[k],j=ids[(k+1)%3];
      const inside=(points[i*3+1]>=waistCut)===above, next=(points[j*3+1]>=waistCut)===above;
      if(inside)polygon.push(put(i,slot));
      if(inside!==next)polygon.push(waistVertex(i,j,slot));
    }
    for(let k=1;k+1<polygon.length;k++)index.push(polygon[0],polygon[k],polygon[k+1]);
  };
  const emit = (polygon: number[]): void => {
    for(let k=1;k+1<polygon.length;k++)index.push(polygon[0],polygon[k],polygon[k+1]);
  };
  const cutShirtInsert = (ids: number[]): void => {
    let remaining=ids.map(i=>put(i,SLOT.OUTER));
    const bottom=m.chestY-.015,top=m.neckY-.012,slope=.070/(top-bottom);
    const planes=[
      (i:number)=>positions[i*3+1]-bottom,
      (i:number)=>top-positions[i*3+1],
      (i:number)=>(positions[i*3+1]-bottom)*slope-positions[i*3],
      (i:number)=>(positions[i*3+1]-bottom)*slope+positions[i*3],
    ];
    for(const distance of planes) {
      const inside:number[]=[],outside:number[]=[];
      for(let k=0;k<remaining.length;k++) {
        const i=remaining[k],j=remaining[(k+1)%remaining.length],di=distance(i),dj=distance(j);
        (di>=0?inside:outside).push(i);
        if((di>=0)!==(dj>=0)) {
          const cut=interpolateVertex(i,j,di/(di-dj));inside.push(cut);outside.push(cut);
        }
      }
      emit(outside);remaining=inside;
      if(!remaining.length)return;
    }
    // Replace the cloth in the opening with a shirt on the exact same native
    // surface. There is no opaque jacket underneath to poke through a chord.
    const shirt=remaining.map(i=>{
      const out=positions.length/3;
      for(let k=0;k<3;k++){positions.push(positions[i*3+k]);norm.push(norm[i*3+k]);}
      uv.push(slotU(SLOT.TOP),uv[i*2+1]);
      for(let k=0;k<4;k++){skinIndex.push(skinIndex[i*4+k]);skinWeight.push(skinWeight[i*4+k]);}
      return out;
    });
    emit(shirt);
  };
  for (let j = 0; j < source.index.length; j += 3) {
    const ids = source.index.slice(j, j + 3);
    const y = ids.reduce((n, i) => n + points[i * 3 + 1], 0) / 3;
    const name = dominant[ids[0]];
    const hand = /^(hand|thumb|index|middle|ring|pinky)/.test(name);
    const arm = /^(upperArm|forearm)/.test(name);
    const leg = !hand && !arm && y < waistCut;
    if (!hand && !arm && ids.some(i => points[i*3+1] >= waistCut) && ids.some(i => points[i*3+1] < waistCut)) {
      clippedWaist(ids,true); clippedWaist(ids,false); continue;
    }
    if (['suit','coat','longCoat'].includes(a.outer) && !hand && !arm &&
      !ids.every(i=>bare[i]) &&
      ids.some(i=>points[i*3+1]>m.chestY-.02) && ids.some(i=>points[i*3+1]<m.neckY) &&
      ids.every(i=>points[i*3+2]>.025)) {
      cutShirtInsert(ids); continue;
    }
    let slot: SlotId = hand || ids.every(i => bare[i]) ? SLOT.SKIN
      : leg ? SLOT.LEGS : outer ? SLOT.OUTER : SLOT.TOP;
    if (!sleeves && /^(upperArm|forearm)/.test(name) && slot === SLOT.OUTER) slot = SLOT.TOP;
    if (slot === SLOT.SKIN && !hand && !arm && y < m.hipY + .02 && !skirt && a.legs !== 'shorts') slot = SLOT.LEGS;
    index.push(...ids.map(i => put(i, slot)));
  }
  base.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(index);
  geometry.userData.anatomicalBody = { source: source.source, revision: source.revision, nativeVertices: count };
  addGarmentDetails(geometry, a, rig);
  return geometry;
}

/** Tailored details use barycentric skin weights from the body under them.
 * They follow the torso in a bend and never remain rigidly pinned to one bone. */
export function addGarmentDetails(g: THREE.BufferGeometry, a: Appearance, rig: Rig): void {
  const m = rig.metrics, bvh = new MeshBVH(g, { indirect: true });
  const pos = Array.from((g.getAttribute('position') as THREE.BufferAttribute).array);
  const uv = Array.from((g.getAttribute('uv') as THREE.BufferAttribute).array);
  const si = Array.from((g.getAttribute('skinIndex') as THREE.BufferAttribute).array);
  const sw = Array.from((g.getAttribute('skinWeight') as THREE.BufferAttribute).array);
  const idx = Array.from(g.index!.array);
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), bary = new THREE.Vector3();
  const attr = g.getAttribute('position');
  const detailStart = pos.length / 3;
  const sample = (x: number, y: number, slot: SlotId, lift = .005, back = false): number => {
    ray.origin.set(x, y, back ? -1 : 1); ray.direction.set(0, 0, back ? 1 : -1);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) return -1;
    const out = pos.length / 3;
    let z = back ? -.10 : .10;
    const weighted = new Map<number, number>();
    if (hit) {
      z = hit.point.z;
      const f = hit.face!; pa.fromBufferAttribute(attr, f.a); pb.fromBufferAttribute(attr, f.b); pc.fromBufferAttribute(attr, f.c);
      THREE.Triangle.getBarycoord(hit.point, pa, pb, pc, bary);
      for (const [vertex, weight] of [[f.a, bary.x], [f.b, bary.y], [f.c, bary.z]]) {
        for (let k = 0; k < 4; k++) {
          const bone = si[vertex * 4 + k];
          weighted.set(bone, (weighted.get(bone) ?? 0) + sw[vertex * 4 + k] * weight);
        }
      }
    } else weighted.set(y < m.spineY ? BI.hips : y < m.yokeY ? BI.chest : BI.upperChest, 1);
    const entries = [...weighted].filter(([, weight]) => weight > 0).sort((aa, bb) => bb[1] - aa[1]).slice(0, 4);
    const total = entries.reduce((n, e) => n + e[1], 0);
    pos.push(x, y, z + (back ? -lift : lift));
    uv.push(slotU(slot), .5);
    for (let k = 0; k < 4; k++) { si.push(entries[k]?.[0] ?? 0); sw.push((entries[k]?.[1] ?? 0) / total); }
    return out;
  };
  // Clip decoration into the native triangles it rests on. Subdividing an
  // arbitrary polygon still leaves chords below a curved or posed surface.
  const surfaces = a.cast ? [false, true].map(back => {
    const faces: { xy: [number,number][]; minX:number;maxX:number;minY:number;maxY:number }[] = [];
    for(let i=0;i<g.index!.count;i+=3) {
      const ids=[g.index!.getX(i),g.index!.getX(i+1),g.index!.getX(i+2)];
      pa.fromBufferAttribute(attr,ids[0]);pb.fromBufferAttribute(attr,ids[1]);pc.fromBufferAttribute(attr,ids[2]);
      const cross=(pb.x-pa.x)*(pc.y-pa.y)-(pb.y-pa.y)*(pc.x-pa.x);
      if((back ? -cross : cross)<1e-9)continue;
      const x=(pa.x+pb.x+pc.x)/3,y=(pa.y+pb.y+pc.y)/3;
      ray.origin.set(x,y,back?-1:1);ray.direction.set(0,0,back?1:-1);
      const hit=bvh.raycastFirst(ray,THREE.DoubleSide);
      if(!hit || Math.abs(hit.point.z-(pa.z+pb.z+pc.z)/3)>.0001)continue;
      const xy:[number,number][]=[[pa.x,pa.y],[pb.x,pb.y],[pc.x,pc.y]];
      if(cross<0)xy.reverse();
      faces.push({xy,minX:Math.min(pa.x,pb.x,pc.x),maxX:Math.max(pa.x,pb.x,pc.x),minY:Math.min(pa.y,pb.y,pc.y),maxY:Math.max(pa.y,pb.y,pc.y)});
    }
    return faces;
  }) : [[], []];
  const panel = (outline: [number, number][], slot: SlotId, lift = .006, back = false): void => {
    const triangles=THREE.ShapeUtils.triangulateShape(outline.map(p=>new THREE.Vector2(...p)),[]);
    if(!a.cast) {
      // Distant crowd keeps the cheaper projected details; exact cloth
      // clipping is reserved for the three inspectable main characters.
      const add=(a:[number,number],b:[number,number],c:[number,number],level:number):void=>{
        if(level<2 && Math.max(Math.hypot(a[0]-b[0],a[1]-b[1]),Math.hypot(c[0]-b[0],c[1]-b[1]),Math.hypot(a[0]-c[0],a[1]-c[1]))>.07) {
          const ab:[number,number]=[(a[0]+b[0])/2,(a[1]+b[1])/2],bc:[number,number]=[(c[0]+b[0])/2,(c[1]+b[1])/2],ca:[number,number]=[(a[0]+c[0])/2,(a[1]+c[1])/2];
          add(a,ab,ca,level+1);add(ab,b,bc,level+1);add(ca,bc,c,level+1);add(ab,bc,ca,level+1);return;
        }
        const ids=[a,b,c].map(p=>sample(p[0],p[1],slot,lift,back));
        if(ids.some(i=>i<0))return;
        const cross=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
        if((cross>0)!==back)idx.push(...ids);else idx.push(ids[0],ids[2],ids[1]);
      };
      for(const tri of triangles)add(outline[tri[0]],outline[tri[1]],outline[tri[2]],0);
      return;
    }
    for(const tri of triangles) {
      const shape=tri.map(i=>outline[i]);
      const minX=Math.min(...shape.map(p=>p[0])),maxX=Math.max(...shape.map(p=>p[0]));
      const minY=Math.min(...shape.map(p=>p[1])),maxY=Math.max(...shape.map(p=>p[1]));
      for(const face of surfaces[back?1:0]) {
        if(face.maxX<minX||face.minX>maxX||face.maxY<minY||face.minY>maxY)continue;
        let poly=shape;
        for(let edge=0;edge<3&&poly.length;edge++) {
          const a=face.xy[edge],b=face.xy[(edge+1)%3];
          const distance=(p:[number,number])=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
          const next:[number,number][]=[];
          for(let k=0;k<poly.length;k++) {
            const p=poly[k],q=poly[(k+1)%poly.length],dp=distance(p),dq=distance(q);
            if(dp>=0)next.push(p);
            if((dp>=0)!==(dq>=0)){const t=dp/(dp-dq);next.push([lerp(p[0],q[0],t),lerp(p[1],q[1],t)]);}
          }
          poly=next;
        }
        if(poly.length<3)continue;
        const ids=poly.map(p=>sample(p[0],p[1],slot,lift,back));
        if(ids.some(i=>i<0))continue;
        for(let k=1;k+1<ids.length;k++) {
          const a=poly[0],b=poly[k],c=poly[k+1],cross=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
          if(Math.abs(cross)<1e-12)continue;
          if((cross>0)!==back)idx.push(ids[0],ids[k],ids[k+1]);else idx.push(ids[0],ids[k+1],ids[k]);
        }
      }
    }
  };
  const seam = (line: [number, number][], slot: SlotId, width = .0016, lift = .008, back = false): void => {
    for (let i = 0; i + 1 < line.length; i++) {
      const p = line[i], q = line[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
      const nx = -dy / len * width / 2, ny = dx / len * width / 2;
      panel([[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]], slot, lift, back);
    }
  };
  const torsoSlot = a.outer === 'none' ? SLOT.TOP : SLOT.OUTER;
  const collarY = m.neckY - .012;
  if (a.collarUp) {
    const start = pos.length / 3, segments = 28;
    for (let k = 0; k <= segments; k++) {
      const angle = .40 + k / segments * (Math.PI * 2 - .8);
      const front = Math.cos(angle), side = Math.sin(angle);
      for (let row = 0; row < 2; row++) {
        const radius = m.neckR * (row ? 1.45 : 1.52);
        pos.push(side * radius, m.neckY - .025 + row * (.055 - Math.max(0,front)*.013), front * radius - .006);
        uv.push(slotU(SLOT.OUTER), row ? .90 : .96);
        si.push(BI.upperChest, BI.neck,0,0); sw.push(.85,.15,0,0);
      }
      if (k) {
        const c=start+k*2; idx.push(c-2,c+1,c-1,c-2,c,c+1);
      }
    }
  }
  // Folded collar points, lapels and welt pockets make suits recognizable in a
  // full-body shot. A jacket instead carries a zip and slanted hand pockets.
  if (a.top === 'shirt' || a.outer === 'suit' || a.outer === 'uniform') {
    for (const s of [-1, 1]) {
      panel([[s * .025, collarY], [s * .066, collarY + .006], [s * .095, collarY - .055], [s * .050, collarY - .068]], SLOT.TOP, .019);
    }
  }
  if (a.outer === 'suit' || a.outer === 'coat' || a.outer === 'longCoat') {
    for (const s of [-1, 1]) {
      panel([[s * .05, collarY], [s * .107, collarY - .036], [s * .084, m.yokeY + .017],
        [s * .12, m.yokeY - .008], [s * .022, m.spineY + .030], [s * .060, m.chestY + .018]], SLOT.OUTER, .010);
      seam([[s * .060, collarY - .012], [s * .078, m.yokeY + .012], [s * .022, m.spineY + .03]], SLOT.DETAIL, .002, .017);
      seam([[s * .050, m.hipY + .036], [s * .133, m.hipY + .041]], SLOT.DETAIL, .009);
      panel([[s * .050, m.hipY + .042], [s * .133, m.hipY + .047], [s * .132, m.hipY + .019], [s * .052, m.hipY + .012]], SLOT.OUTER, .010);
    }
    seam([[-.103, m.chestY + .092], [-.046, m.chestY + .098]], SLOT.DETAIL, .006);
    seam([[0, m.neckY - .035], [0, m.spineY + .03]], SLOT.TOP, .008, .006);
    for (const y of [m.spineY + .035, m.hipY + .062]) panel([[-.003,y+.004],[.005,y+.004],[.005,y-.004],[-.003,y-.004]], SLOT.DETAIL, .014);
  } else if (a.outer !== 'none') {
    seam([[0, collarY], [0, m.chestY], [0, m.hipY - .045]], SLOT.DETAIL, .006, .010);
    for (let y = m.hipY - .04; y < collarY - .025; y += .011) seam([[-.003,y],[.003,y]], SLOT.TOP, .0018, .012);
    panel([[-.006,m.yokeY+.018],[.006,m.yokeY+.018],[.005,m.yokeY-.006],[-.005,m.yokeY-.006]], SLOT.DETAIL, .018);
    for (const s of [-1, 1]) {
      seam([[s * .070,m.hipY+.025],[s * .127,m.spineY+.030]], SLOT.DETAIL, .007, .011);
      seam([[s * .076,m.hipY+.018],[s * .135,m.spineY+.026]], SLOT.OUTER, .002, .014);
    }
  }
  // Shoulder seam follows the actual mesh on front and back, never a cap.
  for (const s of [-1, 1]) for (const back of [false, true]) {
    seam([[s*.085,m.neckY-.037],[s*.145,m.shoulderY+.020],[s*(m.shoulderHalf+.009),m.shoulderY-.018]], torsoSlot, .002, .006, back);
  }
  if (a.outer === 'none') {
    const y = m.hipY + .022;
    seam([[-m.waistW*.88,y],[0,y-.005],[m.waistW*.88,y]], SLOT.TOP, .006, .005);

  }
  if (a.accessory === 'sitePass' || a.accessory === 'lanyard') {
    const badgeY = m.chestY - .016;
    for (const s of [-1,1]) seam([[s*.052,m.neckY-.028],[s*.049,m.yokeY+.02],[s*.018,badgeY+.028]],
      a.accessory === 'sitePass' ? SLOT.ACCENT : SLOT.DETAIL, .003, .011);
    panel([[-.020,badgeY+.025],[.020,badgeY+.025],[.020,badgeY-.025],[-.020,badgeY-.025]],
      a.accessory === 'sitePass' ? SLOT.ACCENT : SLOT.TOP,.014);
    seam([[-.012,badgeY+.004],[.012,badgeY+.004]],SLOT.DETAIL,.003,.016);
    seam([[-.012,badgeY-.007],[.005,badgeY-.007]],SLOT.DETAIL,.002,.016);
  }
  // Belt, fly, pocket openings, back patch pockets and outseams are geometry.
  if(a.outer === 'none' && a.legs !== 'skirt' && a.legs !== 'longSkirt') {
  const waist = m.hipY - .014;
  for (const back of [false, true]) seam([[-m.pelvisW*.86,waist],[0,waist+.002],[m.pelvisW*.86,waist]], SLOT.DETAIL, .016, .007, back);
  for (const s of [-1, 1]) {
    seam([[s*.058,waist-.018],[s*.123,waist-.079]], SLOT.DETAIL, .0022);
    for (const x of [.04,.112]) seam([[s*x,waist+.012],[s*x,waist-.014]], SLOT.LEGS, .007, .011);
    panel([[s*.025,waist-.035],[s*.108,waist-.032],[s*.105,waist-.111],[s*.070,waist-.124],[s*.029,waist-.107]], SLOT.LEGS, .008, true);
    seam([[s*.033,waist-.044],[s*.098,waist-.040]], SLOT.DETAIL, .0018, .011, true);
  }
  seam([[.012,waist-.017],[.014,waist-.105]],SLOT.DETAIL,.002);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv,2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si,4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw,4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.tailoringVertices = pos.length/3-detailStart;
}
