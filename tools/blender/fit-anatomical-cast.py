"""Fit the CC0 HM08 head to sparse photographed facial landmarks.

Run after `bun tools/blender/export-cast.ts` with Blender --background --python.
This is a regularized anatomical reconstruction, not a scan. Photo depth is a
weak constraint; the source skull, nostrils, lips and eyelid topology survive.
"""
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/source/hm08'
OUT = ROOT / 'src/characters/face/generated/anatomical-cast.json'
EVIDENCE = ROOT / 'tools/out/anatomical-cast'
SHA = '437dd513888a92399d1d3200d2e80859fae55abc'


def read_source():
    vertices, texcoords, faces = [], [], []
    group = ''
    for line in (SOURCE / 'base.obj').read_text().splitlines():
        a = line.split()
        if not a:
            continue
        if a[0] == 'v':
            vertices.append([float(x) for x in a[1:]])
        elif a[0] == 'vt':
            texcoords.append([float(x) for x in a[1:3]])
        elif a[0] == 'g':
            group = a[1]
        elif a[0] == 'f' and group == 'body':
            f = [tuple(int(x) - 1 for x in token.split('/')[:2]) for token in a[1:]]
            if min(vertices[i][1] for i, _ in f) > 5.95:
                faces.append(f)
    return np.array(vertices), texcoords, faces


raw, texcoords, faces = read_source()
source_ids = sorted({i for f in faces for i, _ in f})
id_local = {j: i for i, j in enumerate(source_ids)}
# The neutral outer canthi set the origin and scale. Preserve native X/Y/Z.
neutral = (raw - np.array([0, 7.2874, 1.358])) * .615
# Forehead landmarks stop at the hairline; keep an adult cranial vault behind
# them rather than extrapolating the measured face to a whole oversized head.
neutral[:, 1] = np.where(neutral[:, 1] > .14, .14 + (neutral[:, 1] - .14) * .76, neutral[:, 1])
neutral[:, 2] *= .86


def mirror(index):
    p = raw[index].copy()
    p[0] *= -1
    delta = np.linalg.norm(raw[:13380] - p, axis=1)
    result = int(np.argmin(delta))
    assert delta[result] < 1e-5, (index, result)
    return result


# Source IDs are zero-based HM08 skin vertices. These were checked against
# the source surface and its facial rig. Exact positions are exported for audit.
# The confidence controls depth only; image-plane measurements are stronger.
CORRESPONDENCES = [
    ('chin', 5296, 152, .70), ('forehead', 251, 10, .40),
    ('nose-tip', 297, 1, .85), ('nose-root', 133, 168, .65),
    ('subnasale', 343, 94, .65), ('upper-lip', 466, 0, .70),
    ('lower-lip', 495, 17, .65),
]
for name, source, lm_left, lm_right, confidence in [
    ('eye-outer', 21, 33, 263, 1), ('eye-inner', 63, 133, 362, 1),
    ('eye-top', 1, 159, 386, 1), ('eye-bottom', 44, 145, 374, 1),
    ('nose-ala', 319, 129, 358, .55), ('mouth-corner', 413, 61, 291, .65),
    ('brow-inner', 209, 55, 285, .40), ('brow-middle', 222, 52, 282, .40),
    ('brow-outer', 232, 46, 276, .40), ('cheek', 5326, 234, 454, .35),
    ('jaw', 915, 172, 397, .40), ('temple', 5236, 127, 356, .25),
]:
    CORRESPONDENCES += [(name + '-negativeX', source, lm_left, confidence),
                        (name + '-positiveX', mirror(source), lm_right, confidence)]

# A continuous loop follows the actual skin edge around the tear opening.
# Ordered outer -> lower -> inner -> upper -> outer, with no repeated endpoint.
RIM_L = [21, 24, 27, 30, 33, 36, 41, 44, 47, 50, 53, 63, 60, 57, 54, 1, 0, 6, 9, 12, 15, 18]
RIM_R = [mirror(i) for i in RIM_L]


def kernel(a, b):
    # Broad kernels cannot carve a separate bump at every photo landmark.
    d = (a[:, None, :] - b[None, :, :]) / np.array([.26, .30, .32])
    return np.exp(-np.sum(d * d, axis=2) * .5)


def fit(cloud):
    points, displacement, reports = [], [], []
    for name, source, landmark, confidence in CORRESPONDENCES:
        p = neutral[source]
        d = cloud[landmark] - p
        # Monocular z is estimated, especially at the silhouette. Keep that
        # uncertainty out of the shape instead of baking deep cheek trenches.
        d[2] = np.clip(d[2], -.16, .16) * confidence
        d[:2] = np.clip(d[:2], -.16, .16)
        points.append(p)
        displacement.append(d)
        reports.append({'name': name, 'sourceIndex': source, 'landmark': landmark,
                        'depthConfidence': confidence, 'target': cloud[landmark].tolist()})
    # Anchor the unphotographed vault, occiput and lower neck to the source.
    for i in [881, 962, 882, 1015, 5399, 11998]:
        p = neutral[i].copy()
        if p[2] < -.7:
            d = np.array([0, 0, -.80 - p[2]])
        else:
            d = np.zeros(3)
        points.append(p)
        displacement.append(d)
    for x in [-.24, 0, .24]:
        for z in [-.55, -.20]:
            points.append(np.array([x, -.83, z]))
            displacement.append(np.zeros(3))
    points = np.array(points)
    coefficients = np.linalg.solve(kernel(points, points) + np.eye(len(points)) * .018,
                                   np.array(displacement))
    fitted = neutral + kernel(neutral, points) @ coefficients
    for report in reports:
        p = fitted[report['sourceIndex']]
        report['fitted'] = p.tolist()
        report['xyError'] = float(np.linalg.norm(p[:2] - np.array(report['target'])[:2]))
    return fitted, reports


def taper_neck(fitted, cast_id):
    """Seat the native nape inside the existing body-neck cylinder.

    The lower rear HM08 neck is farther back than the body rig's neck axis.
    Only shrink that overlap region; the photographed chin and anterior jaw
    remain outside this posterior gate, and no point is expanded radially.
    """
    radius = .23 if cast_id == 'player' else .195
    centre_z = -.258
    def smooth(value):
        t = np.clip(value, 0, 1)
        return t * t * (3 - 2 * t)
    influence = smooth((-.40 - fitted[:, 1]) / .20)
    influence *= smooth((-.18 - fitted[:, 2]) / .18)
    radial = np.hypot(fitted[:, 0] / radius,
                      (fitted[:, 2] - centre_z) / (radius * 1.08))
    shrink = 1 / np.maximum(radial, 1)
    weight = 1 + influence * (shrink - 1)
    result = fitted.copy()
    active = weight < 1
    result[active, 0] *= weight[active]
    result[active, 2] = centre_z + (fitted[active, 2] - centre_z) * weight[active]
    assert np.array_equal(result[:, 1], fitted[:, 1])
    assert np.max(weight) <= 1 and np.min(weight) > 0
    controls = [source for _, source, _, _ in CORRESPONDENCES]
    assert np.array_equal(result[controls], fitted[controls]), 'Neck taper moved a photographed facial control'
    # Full-strength posterior overlap must fit inside the body-neck ellipse.
    full = (fitted[:, 1] <= -.60) & (fitted[:, 2] <= -.36)
    final_radial = np.hypot(result[full, 0] / radius,
                            (result[full, 2] - centre_z) / (radius * 1.08))
    assert np.max(final_radial, initial=0) <= 1 + 1e-12
    return result


def eye_anchor(fitted, rim):
    ring = fitted[rim]
    outer, inner = ring[0], ring[11]
    centre = (outer + inner) * .5
    width = float(np.linalg.norm(outer[:2] - inner[:2]))
    radius = float(np.clip(width * .42, .064, .074))
    # The corneal apex sits just forward of the eyelid rim, while the globe
    # equator stays inside the socket. Eye size comes from this actual opening.
    centre[2] = float(np.mean(ring[:, 2])) - radius * .91
    return {'centre': centre.tolist(), 'radius': radius, 'irisRadius': radius * .47,
            'forward': [0, 0, 1], 'ring': ring.tolist(), 'sourceRing': rim}


def blink_delta(fitted, eyes):
    delta = np.zeros_like(fitted)
    for eye in eyes:
        ring = np.array(eye['ring'])
        outer, inner = ring[0], ring[11]
        xmin, xmax = sorted([outer[0], inner[0]])
        t = np.clip((fitted[:, 0] - xmin) / (xmax - xmin), 0, 1)
        ot = (outer[0] - xmin) / (xmax - xmin)
        left, right = (outer, inner) if ot < .5 else (inner, outer)
        seam_y = left[1] * (1 - t) + right[1] * t - .005 * np.sin(t * math.pi)
        # Upper/lower source rims receive the same seam function; influence
        # falls off around the orbital socket, preserving eyebrows and cheeks.
        lid_centre_y = (fitted[eye['sourceRing'][15], 1] + fitted[eye['sourceRing'][7], 1]) * .5
        extent = np.max(np.abs(ring[:, 1] - lid_centre_y))
        ydist = np.abs(fitted[:, 1] - lid_centre_y)
        influence = np.exp(-np.maximum(ydist - extent * 1.05, 0) ** 2 / .035 ** 2)
        influence *= np.exp(-np.maximum(np.abs(fitted[:, 2] - np.mean(ring[:, 2])) - .035, 0) ** 2 / .045 ** 2)
        influence *= ((fitted[:, 0] > xmin) & (fitted[:, 0] < xmax))
        delta[:, 1] += (seam_y - fitted[:, 1]) * influence
        # Advance closing skin slightly over the globe; do not pull it through
        # the pupil as a flat Y-only translation would do.
        centre = np.array(eye['centre'])
        cap = centre[2] + np.sqrt(np.maximum(eye['radius'] ** 2 - (fitted[:, 0] - centre[0]) ** 2 - (seam_y - centre[1]) ** 2, 0)) + .006
        delta[:, 2] += np.maximum(cap - fitted[:, 2], 0) * influence
    return delta


def cooked_mesh(fitted, blink):
    # One Catmull-Clark step gives the eyelids and lips continuous curvature.
    # Evaluate the identical modifier for Basis and Blink, preserving morph order.
    mesh = bpy.data.meshes.new('cook subdivision source')
    mesh.from_pydata(fitted[source_ids].tolist(), [], [[id_local[i] for i, _ in f] for f in faces])
    uv = mesh.uv_layers.new(name='UVMap')
    for poly, face in zip(mesh.polygons, faces):
        poly.use_smooth = True
        for loop, (_, tex) in zip(poly.loop_indices, face):
            uv.data[loop].uv = texcoords[tex]
    obj = bpy.data.objects.new('temporary cook', mesh)
    bpy.context.collection.objects.link(obj)
    obj.shape_key_add(name='Basis')
    shape = obj.shape_key_add(name='Blink')
    shape.value = 0
    for local, source in enumerate(source_ids):
        shape.data[local].co = Vector(fitted[source] + blink[source])
    mod = obj.modifiers.new('Anatomical surface refinement', 'SUBSURF')
    mod.levels = mod.render_levels = 1
    bpy.context.view_layer.update()
    dep = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(dep)
    refined = evaluated.to_mesh()
    positions = np.array([v.co[:] for v in refined.vertices])
    normals = np.array([v.normal[:] for v in refined.vertices])
    refined_faces = [[(refined.loops[j].vertex_index, tuple(round(x, 6) for x in refined.uv_layers.active.data[j].uv))
                      for j in p.loop_indices] for p in refined.polygons]
    evaluated.to_mesh_clear()
    shape.value = 1
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(dep)
    refined = evaluated.to_mesh()
    closed = np.array([v.co[:] for v in refined.vertices])
    evaluated.to_mesh_clear()
    assert len(closed) == len(positions)
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(mesh)
    # Blender preserves the control vertices first. This assertion also guards
    # a Blender change before those indices are used to refine the anchor ring.
    assert np.max(np.linalg.norm(positions[:len(source_ids)] - fitted[source_ids], axis=1)) < .075
    refined_controls = fitted.copy()
    refined_controls[source_ids] = positions[:len(source_ids)]
    nearest = KDTree(len(source_ids))
    for source in source_ids:
        nearest.insert(Vector(fitted[source]), source)
    nearest.balance()
    source_nearest = [nearest.find(Vector(p))[1] for p in positions]
    # Only UV seams split; subdivision adds points without an exact original
    # source index, so sourceIndices explicitly documents nearest provenance.
    mapping, vertex_keys, indices = {}, [], []
    for face in refined_faces:
        ids = []
        for key in face:
            if key not in mapping:
                mapping[key] = len(vertex_keys)
                vertex_keys.append(key)
            ids.append(mapping[key])
        indices += [ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]]
    def flat(values):
        return np.round(np.array(values).reshape(-1), 6).tolist()
    return {'position': flat([positions[i] for i, _ in vertex_keys]), 'index': indices,
            'normal': flat([normals[i] for i, _ in vertex_keys]),
            'uv': flat([t for _, t in vertex_keys]),
            'sourceIndices': [source_nearest[i] for i, _ in vertex_keys],
            'sourceIndexMode': 'nearest-original-HM08-control-vertex', 'subdivisionLevel': 1,
            'blink': flat([closed[i] - positions[i] for i, _ in vertex_keys])}, refined_controls


def material(name, rgb, roughness=.55):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    return m


def rgb(hexvalue):
    values = [(hexvalue >> n & 255) / 255 for n in [16, 8, 0]]
    return [v / 12.92 if v < .04045 else ((v + .055) / 1.055) ** 2.4 for v in values]


def skin_material(cast_id, base_color):
    """Use the runtime's normalized diffuse variation on the editable UVs."""
    m = material(cast_id + ' skin', rgb(base_color))
    nodes, links = m.node_tree.nodes, m.node_tree.links
    age = 'young' if cast_id == 'ally' else 'middleage'
    image = bpy.data.images.load(str(SOURCE / 'skin' / f'{age}_lightskinned_male_diffuse.png'), check_existing=True)
    image.colorspace_settings.name = 'sRGB'
    if not image.packed_file:
        image.pack()
    texture = nodes.new('ShaderNodeTexImage')
    texture.name = 'Packed HM08 diffuse'
    texture.label = 'CC0 HM08 skin · sRGB decoded to linear'
    texture.image = image
    texture.location = (-780, 180)
    uv = nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'
    uv.location = (-1000, 180)
    links.new(uv.outputs['UV'], texture.inputs['Vector'])
    normalize = nodes.new('ShaderNodeVectorMath')
    normalize.operation = 'DIVIDE'
    normalize.label = 'Divide by linear #d2ae91 reference'
    normalize.inputs[1].default_value = rgb(0xd2ae91)
    normalize.location = (-530, 180)
    links.new(texture.outputs['Color'], normalize.inputs[0])
    variation = nodes.new('ShaderNodeMixRGB')
    variation.blend_type = 'MIX'
    variation.label = '85% diffuse variation · retain cast color'
    variation.inputs[0].default_value = .85
    variation.inputs[1].default_value = (1, 1, 1, 1)
    variation.location = (-300, 180)
    links.new(normalize.outputs['Vector'], variation.inputs[2])
    tint = nodes.new('ShaderNodeMixRGB')
    tint.blend_type = 'MULTIPLY'
    tint.label = 'Cast skin tint'
    tint.inputs[0].default_value = 1
    tint.inputs[1].default_value = (*rgb(base_color), 1)
    tint.location = (-60, 180)
    links.new(variation.outputs['Color'], tint.inputs[2])
    bsdf = nodes.get('Principled BSDF')
    bsdf.location = (180, 180)
    links.new(tint.outputs['Color'], bsdf.inputs['Base Color'])
    return m


def validate_mesh(cooked, cast_id):
    positions = np.array(cooked['position']).reshape((-1, 3))
    blink = np.array(cooked['blink']).reshape((-1, 3))
    triangles = np.array(cooked['index']).reshape((-1, 3))
    assert np.isfinite(positions).all() and np.isfinite(blink).all()
    assert len(cooked['normal']) == len(cooked['position'])
    assert len(cooked['uv']) == len(positions) * 2
    assert np.max(triangles) < len(positions) and np.min(triangles) >= 0
    area = np.linalg.norm(np.cross(positions[triangles[:, 1]] - positions[triangles[:, 0]],
                                   positions[triangles[:, 2]] - positions[triangles[:, 0]]), axis=1)
    assert np.min(area) > 1e-12, 'Degenerate triangle in anatomical cook'
    neck_radius = .23 if cast_id == 'player' else .195
    posterior_neck = positions[(positions[:, 1] < -.72) & (positions[:, 2] < -.36)]
    neck_envelope = np.hypot(posterior_neck[:, 0] / neck_radius,
                             (posterior_neck[:, 2] + .258) / (neck_radius * 1.08))
    assert len(neck_envelope) > 0 and np.max(neck_envelope) < 1.01, 'Subdivided nape protrudes beyond neck overlap'
    opened = BVHTree.FromPolygons(positions.tolist(), triangles.tolist(), all_triangles=True)
    closed = BVHTree.FromPolygons((positions + blink).tolist(), triangles.tolist(), all_triangles=True)
    samples = []
    for side in ['eyeL', 'eyeR']:
        eye = cooked['anchors'][side]
        c = Vector(eye['centre'])
        pole = c.z + eye['radius']
        for dx, dy in [(0, 0), (-.006, 0), (.006, 0), (0, .006), (0, -.006)]:
            origin = c + Vector((dx, dy, .5))
            hit = opened.ray_cast(origin, Vector((0, 0, -1)))[0]
            shut = closed.ray_cast(origin, Vector((0, 0, -1)))[0]
            assert hit is None or hit.z < pole - .008, f'{side} skin obscures open pupil'
            assert shut is not None and shut.z > pole, f'{side} blink leaves pupil uncovered'
            samples.append({'eye': side, 'offset': [dx, dy],
                            'openSkinBehindApex': None if hit is None else pole - hit.z,
                            'closedSkinAheadOfApex': shut.z - pole})
    return {'vertices': len(positions), 'triangles': len(triangles),
            'nonzeroBlinkComponents': int(np.count_nonzero(blink)), 'pupilSamples': samples,
            'posteriorNeckMaxEllipseRadiusBelowYMinus072': float(np.max(neck_envelope))}


def studio_head(name, fitted, blink, appearance, offset, eyes):
    mesh = bpy.data.meshes.new(name + ' HM08 quads')
    # All saved mesh coordinates use original fitted Y-up. The root supplies
    # presentation rotation only, so artists can compare cooked indices.
    mesh.from_pydata(fitted[source_ids].tolist(), [], [[id_local[i] for i, _ in f] for f in faces])
    mesh.update()
    uv = mesh.uv_layers.new(name='UVMap')
    for poly, face in zip(mesh.polygons, faces):
        for loop, (_, tex) in zip(poly.loop_indices, face):
            uv.data[loop].uv = texcoords[tex]
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.rotation_euler.x = math.pi / 2
    obj.location.x = offset
    obj.data.materials.append(skin_material(name, appearance['skin']))
    mod = obj.modifiers.new('Anatomical surface refinement', 'SUBSURF')
    mod.levels = mod.render_levels = 1
    for p in mesh.polygons:
        p.use_smooth = True
    obj.shape_key_add(name='Basis')
    key = obj.shape_key_add(name='Blink')
    key.value = 0
    for i, source in enumerate(source_ids):
        key.data[i].co = Vector(fitted[source] + blink[source])
    # Named controls expose correspondence choices to the artist. They are
    # editor guides only and never appear as painted landmarks in the game.
    for label, source, landmark, confidence in CORRESPONDENCES:
        guide = bpy.data.objects.new(f'{name} {label} HM08:{source} → photo:{landmark}', None)
        bpy.context.collection.objects.link(guide)
        guide.parent = obj
        guide.location = fitted[source].tolist()
        guide.empty_display_type = 'SPHERE'
        guide.empty_display_size = .009
        guide.hide_render = True
        guide['depth_confidence'] = confidence
    for ei, eye in enumerate(eyes):
        centre = eye['centre']
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=eye['radius'],
            location=(centre[0] + offset, -centre[2], centre[1]))
        sphere = bpy.context.object
        sphere.name = name + f' globe {ei}'
        sphere.data.materials.append(material(name + f' sclera {ei}', (.5, .47, .42), .26))
        for p in sphere.data.polygons:
            p.use_smooth = True
        # Paint iris and pupil on the actual globe surface; floating flat discs
        # can overlap the lids and falsely suggest that the mesh exposes them.
        iris_mat = material(name + f' iris {ei}', rgb(appearance['irisColor']), .24)
        pupil_mat = material(name + f' pupil {ei}', (.001, .001, .001), .2)
        sphere.data.materials.append(iris_mat)
        sphere.data.materials.append(pupil_mat)
        for polygon in sphere.data.polygons:
            centre_local = polygon.center
            rr = math.hypot(centre_local.x, centre_local.z)
            if centre_local.y < 0 and rr < eye['irisRadius']:
                polygon.material_index = 2 if rr < eye['irisRadius'] * .4 else 1
    return obj


bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
assets = [a for a in json.loads((ROOT / 'tools/blender/input/cast.json').read_text())['assets'] if a['detail'] == 1]
output = {'version': 1, 'units': 'fitted-face', 'up': 'Y', 'forward': 'Z',
          'source': {'name': 'MakeHuman HM08', 'commit': SHA, 'license': 'CC0-1.0'}, 'casts': {}}
summary = {}
for i, asset in enumerate(assets):
    fitted, correspondence = fit(np.array(asset['fitCloud']).reshape((-1, 3)))
    fitted = taper_neck(fitted, asset['id'])
    eyes = [eye_anchor(fitted, rim) for rim in [RIM_L, RIM_R]]
    blink = blink_delta(fitted, eyes)
    cooked, refined_controls = cooked_mesh(fitted, blink)
    eyes = [eye_anchor(refined_controls, rim) for rim in [RIM_L, RIM_R]]
    head = fitted[source_ids]
    cooked['anchors'] = {'eyeL': eyes[0], 'eyeR': eyes[1],
                         'chinY': float(fitted[5296, 1]), 'crownY': float(np.max(head[:, 1])),
                         'templeHalf': float(max(abs(fitted[5394, 0]), abs(fitted[mirror(5394), 0]))),
                         'headDepth': float(np.max(head[:, 2]) - np.min(head[:, 2])),
                         'neckY': float(np.min(head[:, 1]))}
    cooked['correspondences'] = correspondence
    validation = validate_mesh(cooked, asset['id'])
    output['casts'][asset['id']] = cooked
    summary[asset['id']] = {'vertices': len(cooked['sourceIndices']), 'triangles': len(cooked['index']) // 3,
                           'maxLandmarkXYError': max(r['xyError'] for r in correspondence),
                           'medianLandmarkXYError': float(np.median([r['xyError'] for r in correspondence])),
                           'anchors': cooked['anchors'], 'validation': validation}
    studio_head(asset['id'], fitted, blink, asset['castAppearance'], (i - 1) * 1.15, eyes)

OUT.parent.mkdir(parents=True, exist_ok=True)
encoded = json.dumps(output, separators=(',', ':'), allow_nan=False)
if '--workshop-only' in sys.argv:
    assert OUT.read_text() == encoded, 'Workshop-only rebuild would change cooked geometry'
elif not OUT.exists() or OUT.read_text() != encoded:
    OUT.write_text(encoded)
EVIDENCE.mkdir(parents=True, exist_ok=True)
(EVIDENCE / 'fit-report.json').write_text(json.dumps(summary, indent=2))
(EVIDENCE / 'source-correspondences.json').write_text(json.dumps([
    {'name': n, 'sourceIndex': i, 'sourcePosition': raw[i].tolist(), 'landmark': lm, 'depthConfidence': c}
    for n, i, lm, c in CORRESPONDENCES], indent=2))

for name, loc, power, size in [('Key', (-2, -3, 3), 180, 3), ('Fill', (2, -2, 1), 75, 2), ('Rim', (0, 1, 2), 140, 2)]:
    d = bpy.data.lights.new(name, 'AREA')
    d.energy, d.shape, d.size = power, 'DISK', size
    obj = bpy.data.objects.new(name, d)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector((0, 0, 0)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
camera = bpy.data.cameras.new('Cast comparison')
obj = bpy.data.objects.new('Camera', camera)
bpy.context.collection.objects.link(obj)
obj.location = (0, -7, .05)
obj.rotation_euler = (Vector((0, -.1, -.08)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
camera.type, camera.ortho_scale = 'ORTHO', 3.6
scene = bpy.context.scene
scene.camera = obj
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1500, 850, 100
scene.world.color = (.06, .06, .06)
scene.render.filepath = str(EVIDENCE / 'studio.png')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'assets/blender/anatomical-cast.blend'), compress=True)
if '--no-render' not in sys.argv:
    bpy.ops.render.render(write_still=True)
print('Anatomical cook complete:', json.dumps({k: {x: v[x] for x in ['vertices', 'triangles', 'maxLandmarkXYError', 'medianLandmarkXYError']} for k, v in summary.items()}))
