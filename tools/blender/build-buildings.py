"""Build an editable architectural workshop from actual runtime mesh constructors.

bun tools/blender/export-buildings.ts
blender -b -t 2 --python tools/blender/build-buildings.py
Use -- --render to render the workshop overview after saving.
"""
import bpy
import hashlib
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / 'tools/blender/input/buildings.json'
RUNTIME_SOURCES = [
    'src/world/city/materials.ts', 'src/world/city/facades.ts', 'src/world/city/landmarks.ts',
    'src/world/city/architecture.ts', 'src/world/city/parkedDacia.ts',
]
source = json.loads(INPUT.read_text())

if '--verify' in sys.argv:
    bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/blender/buildings.blend'))
    assert hashlib.sha256(INPUT.read_bytes()).hexdigest() == json.loads((ROOT / 'assets/blender/buildings-manifest.json').read_text())['source_sha256']
    manifest = json.loads((ROOT / 'assets/blender/buildings-manifest.json').read_text())
    verified = {}
    for asset in source['assets']:
        collection = bpy.data.collections[asset['id']]
        assert collection.asset_data
        verified[asset['id']] = {'meshes': 0, 'vertices': 0, 'triangles': 0}
        for part in asset['parts']:
            obj = next(o for o in collection.objects if o.type == 'MESH' and o.get('runtime_part') == part['id'])
            mesh = obj.data
            attrs = part['attributes']
            pos = attrs['position']['values']
            indices = part['index']
            assert len(mesh.vertices) == len(pos) // 3
            assert len(mesh.polygons) == len(indices) // 3
            for i, vertex in enumerate(mesh.vertices):
                expected = (pos[i*3], -pos[i*3+2], pos[i*3+1])
                assert max(abs(a-b) for a,b in zip(vertex.co, expected)) < 0.00005
            for i, polygon in enumerate(mesh.polygons):
                assert list(polygon.vertices) == indices[i*3:i*3+3]
            assert mesh.has_custom_normals
            assert len(mesh.materials) == manifest['models'][asset['id']]['parts'][part['id']]['materials']
            assert all(mat.use_nodes for mat in mesh.materials)
            if part['id'] == 'detail':
                for i, color in enumerate(mesh.color_attributes['RuntimeColor'].data):
                    assert max(abs(a-b) for a,b in zip(color.color[:3], attrs['color']['values'][i*3:i*3+3])) < 0.000001
                for name, offset in [('DetailMetalness',0),('DetailRoughness',1)]:
                    for i, value in enumerate(mesh.attributes[name].data):
                        assert abs(value.value - attrs['aMR']['values'][i*2+offset]) < 0.000001
            else:
                assert mesh.uv_layers.get('RuntimeMetreUV')
                for i, value in enumerate(mesh.uv_layers['RuntimeMetreUV'].data):
                    expected = attrs['uv']['values'][indices[i]*2:indices[i]*2+2]
                    assert max(abs(a-b) for a,b in zip(value.uv,expected)) < 0.0001
            verified[asset['id']]['meshes'] += 1
            verified[asset['id']]['vertices'] += len(mesh.vertices)
            verified[asset['id']]['triangles'] += len(mesh.polygons)
    for relative in RUNTIME_SOURCES:
        assert bpy.data.texts[relative].as_string() == (ROOT / relative).read_text()
    assert bpy.context.scene.camera
    assert bpy.context.scene.unit_settings.system == 'METRIC'
    assert len([o for o in bpy.data.objects if o.type == 'LIGHT']) >= 1
    assert not any(n.type == 'TEX_IMAGE' for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes)
    print('REOPENED_BUILDINGS_VERIFIED', json.dumps(verified))
    sys.exit(0)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.36, 0.43, 0.52, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.42


def coordinates(values):
    return [(x, -z, y) for x, y, z in zip(*[iter(values)] * 3)]


def material(name, color, roughness=0.85):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    return mat, shader


def attribute(tree, name):
    node = tree.nodes.new('ShaderNodeAttribute')
    node.attribute_name = name
    node.label = name
    return node.outputs['Fac']


def facade_material(style):
    """Editable node approximation; the runtime GLSL is retained as a text block."""
    colors = {0: (0.12, 0.15, 0.17), 1: (0.30, 0.27, 0.22), 2: (0.20, 0.20, 0.17),
              3: (0.37, 0.31, 0.24), 4: (0.40, 0.36, 0.29), 5: (0.23, 0.22, 0.20),
              6: (0.30, 0.27, 0.23), 7: (0.35, 0.30, 0.23)}
    mat, shader = material(f'Facade {style} - editable metre grammar', colors.get(style, colors[2]))
    tree = mat.node_tree

    def math_node(operation, a, b=0):
        node = tree.nodes.new('ShaderNodeMath')
        node.operation = operation
        for socket, value in zip(node.inputs, [a, b]):
            if isinstance(value, (int, float)):
                socket.default_value = value
            else:
                tree.links.new(value, socket)
        return node.outputs[0]

    uv = tree.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'RuntimeMetreUV'
    separate = tree.nodes.new('ShaderNodeSeparateXYZ')
    tree.links.new(uv.outputs['UV'], separate.inputs[0])
    u = math_node('FRACT', math_node('DIVIDE', separate.outputs['X'], attribute(tree, 'FacadeBayWidth')))
    above = math_node('SUBTRACT', separate.outputs['Y'], attribute(tree, 'FacadeGroundHeight'))
    v = math_node('FRACT', math_node('DIVIDE', above, attribute(tree, 'FacadeFloorHeight')))

    def opening(lo, hi, vlo=0.24, vhi=0.77):
        horizontal = math_node('MULTIPLY', math_node('GREATER_THAN', u, lo), math_node('LESS_THAN', u, hi))
        vertical = math_node('MULTIPLY', math_node('GREATER_THAN', v, vlo), math_node('LESS_THAN', v, vhi))
        return math_node('MULTIPLY', horizontal, vertical)

    edge = 0.075 if style == 0 else 0.28
    inner = opening(edge, 1 - edge, 0.12 if style == 0 else 0.24, 0.86 if style == 0 else 0.77)
    outer = opening(edge - 0.035, 1 - edge + 0.035, 0.085 if style == 0 else 0.205, 0.895 if style == 0 else 0.805)
    geometry = tree.nodes.new('ShaderNodeNewGeometry')
    normal = tree.nodes.new('ShaderNodeSeparateXYZ')
    tree.links.new(geometry.outputs['Normal'], normal.inputs[0])
    wall = math_node('LESS_THAN', math_node('ABSOLUTE', normal.outputs['Z']), 0.55)
    inhabited = math_node('MULTIPLY', wall, math_node('GREATER_THAN', above, 0))
    window = math_node('MULTIPLY', inner, inhabited)
    frame = math_node('MULTIPLY', math_node('SUBTRACT', outer, inner), inhabited)
    if style == 6:
        window = math_node('MULTIPLY', window, 0)
        frame = math_node('MULTIPLY', frame, 0)

    noise = tree.nodes.new('ShaderNodeTexNoise')
    tree.links.new(uv.outputs['UV'], noise.inputs['Vector'])
    noise.inputs['Scale'].default_value = 1.2
    noise.inputs['Detail'].default_value = 3
    weather = tree.nodes.new('ShaderNodeMixRGB')
    tree.links.new(noise.outputs['Fac'], weather.inputs[0])
    base = colors.get(style, colors[2])
    weather.inputs[1].default_value = (*(c * 0.75 for c in base), 1)
    weather.inputs[2].default_value = (*(c * 1.05 for c in base), 1)
    framed = tree.nodes.new('ShaderNodeMixRGB')
    tree.links.new(frame, framed.inputs[0])
    tree.links.new(weather.outputs[0], framed.inputs[1])
    framed.inputs[2].default_value = (0.42, 0.42, 0.38, 1)
    glazed = tree.nodes.new('ShaderNodeMixRGB')
    tree.links.new(window, glazed.inputs[0])
    tree.links.new(framed.outputs[0], glazed.inputs[1])
    glazed.inputs[2].default_value = (0.018, 0.030, 0.041, 1)
    tree.links.new(glazed.outputs[0], shader.inputs['Base Color'])
    tree.links.new(math_node('SUBTRACT', 0.9, math_node('MULTIPLY', window, 0.70)), shader.inputs['Roughness'])
    bump = tree.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.22
    bump.inputs['Distance'].default_value = 0.055
    tree.links.new(math_node('SUBTRACT', math_node('MULTIPLY', frame, 0.15), window), bump.inputs['Height'])
    tree.links.new(bump.outputs[0], shader.inputs['Normal'])
    mat['fidelity'] = 'Editable Blender approximation of runtime facade GLSL; topology and grammar attributes are exact.'
    return mat


facades = {style: facade_material(style) for style in range(8)}
detail, shader = material('Runtime detail - vertex PBR', (0.30, 0.29, 0.26))
tree = detail.node_tree
color = tree.nodes.new('ShaderNodeVertexColor')
color.layer_name = 'RuntimeColor'
tree.links.new(color.outputs['Color'], shader.inputs['Base Color'])
for name, socket in [('DetailMetalness', 'Metallic'), ('DetailRoughness', 'Roughness')]:
    tree.links.new(attribute(tree, name), shader.inputs[socket])
emissive = tree.nodes.new('ShaderNodeVertexColor')
emissive.layer_name = 'RuntimeEmission'
tree.links.new(emissive.outputs['Color'], shader.inputs['Emission Color'])
shader.inputs['Emission Strength'].default_value = 1.0
surfaces = {}
for kind, label, color in [(0, 'asphalt', (0.04, 0.04, 0.038)), (1, 'pavement', (0.14, 0.14, 0.12)),
                           (2, 'kerb', (0.19, 0.19, 0.16)), (3, 'plaza', (0.24, 0.23, 0.20)),
                           (4, 'grass', (0.08, 0.10, 0.035)), (5, 'gravel', (0.11, 0.09, 0.065)),
                           (6, 'water', (0.015, 0.035, 0.05)), (7, 'marking', (0.65, 0.62, 0.55))]:
    surfaces[kind] = material(f'Surface {kind} - {label}', color, 0.12 if kind == 6 else 0.88)[0]

ATTRIBUTES = {
    'aFacade': ['FacadeStyle', 'FacadeFloorHeight', 'FacadeBayWidth', 'FacadeSeed'],
    'aFacade2': ['FacadeBuildingHeight', 'FacadeGroundHeight', 'FacadeLitBias', 'FacadeTint'],
    'aSurf': ['SurfaceKind', 'SurfaceHalfWidth', 'SurfaceLanes', 'SurfaceSeed'],
    'aMR': ['DetailMetalness', 'DetailRoughness'],
    'aFoliage': ['FoliageTransmission', 'FoliageWind'],
}


def make_mesh(part, collection):
    attrs = part['attributes']
    vertices = coordinates(attrs['position']['values'])
    indices = part.get('index') or list(range(len(vertices)))
    faces = list(zip(*[iter(indices)] * 3))
    mesh = bpy.data.meshes.new(part['id'])
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(part['id'], mesh)
    collection.objects.link(obj)
    for source_name, names in ATTRIBUTES.items():
        if source_name in attrs:
            for channel, name in enumerate(names):
                attr = mesh.attributes.new(name=name, type='FLOAT', domain='POINT')
                attr.data.foreach_set('value', attrs[source_name]['values'][channel::len(names)])
    for source_name, name in [('color', 'RuntimeColor'), ('aEmissive', 'RuntimeEmission')]:
        if source_name in attrs:
            attr = mesh.color_attributes.new(name=name, type='FLOAT_COLOR', domain='POINT')
            attr.data.foreach_set('color', [c for rgb in zip(*[iter(attrs[source_name]['values'])] * 3) for c in (*rgb, 1)])
    if 'uv' in attrs:
        uv = mesh.uv_layers.new(name='RuntimeMetreUV')
        uv.data.foreach_set('uv', [v for i in indices for v in attrs['uv']['values'][i * 2:i * 2 + 2]])
    mesh.normals_split_custom_set_from_vertices(coordinates(attrs['normal']['values']))
    options = facades if part['id'] == 'facade' else surfaces if part['id'] == 'surface' else {0: detail}
    keys = list(options)
    for mat in options.values():
        mesh.materials.append(mat)
    source_key = 'aFacade' if part['id'] == 'facade' else 'aSurf'
    for polygon, triangle in zip(mesh.polygons, faces):
        category = round(attrs[source_key]['values'][triangle[0] * 4]) if source_key in attrs else 0
        polygon.material_index = keys.index(category) if category in keys else 0
        polygon.use_smooth = True
    obj['runtime_part'] = part['id']
    obj['source_attributes'] = json.dumps({k: v['itemSize'] for k, v in attrs.items()})
    return obj


layout = {'socialist-bloc': (-260, -20, 0), 'builders-house': (-170, -20, 0), 'parliament': (110, 100, 0)}
counts = {}
for asset in source['assets']:
    collection = bpy.data.collections.new(asset['id'])
    scene.collection.children.link(collection)
    collection.asset_mark()
    collection.asset_data.description = asset['label'] + ' — editable runtime topology and attributes'
    root = bpy.data.objects.new(asset['label'], None)
    collection.objects.link(root)
    root.location = layout[asset['id']]
    root['runtime_source'] = asset['source']
    root['runtime_origin_y_up'] = asset['origin']
    root['constructor_parameters'] = json.dumps(asset['parameters'])
    root['runtime_physics_metadata'] = json.dumps(asset['runtime'])
    root['coordinates'] = 'Runtime local (x,y,z) maps to Blender (x,-z,y), in metres.'
    counts[asset['id']] = {'parts': {}}
    for part in asset['parts']:
        obj = make_mesh(part, collection)
        obj.parent = root
        counts[asset['id']]['parts'][part['id']] = {'vertices': len(obj.data.vertices),
            'triangles': len(obj.data.polygons), 'materials': len(obj.data.materials),
            'attributes': list(obj.data.attributes.keys())}

# Retain the authoritative source shader beside the editable approximation.
for relative in RUNTIME_SOURCES:
    block = bpy.data.texts.new(relative)
    block.write((ROOT / relative).read_text())
readme = bpy.data.texts.new('READ ME - Building workshop')
readme.write('Three runtime building constructors, exact indexed triangles and metre UVs.\n'
    'Collections are asset-marked. Facade, detail and surface are separate editable meshes.\n'
    'Use Edit Mode > Select Linked to select components of a merged detail mesh.\n'
    'Blender node facades approximate the GLSL; the original source is retained in Text blocks.\n'
    'This is an authoring export. Saving this file does not modify the browser game.\n')

bpy.ops.mesh.primitive_plane_add(size=1000, location=(0, 0, -0.25))
ground = bpy.context.object
ground.name = 'Workshop ground - not a runtime asset'
ground.data.materials.append(material('Workshop ground', (0.11, 0.12, 0.13))[0])
bpy.ops.object.light_add(type='SUN', location=(0, -100, 180))
bpy.context.object.name = 'Architectural daylight'
bpy.context.object.rotation_euler = (math.radians(28), math.radians(-25), math.radians(-30))
bpy.context.object.data.energy = 2.1
bpy.context.object.data.angle = math.radians(8)


def camera(name, position, target, ortho=None):
    bpy.ops.object.camera_add(location=position)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    obj.data.clip_end = 3000
    if ortho:
        obj.data.type = 'ORTHO'
        obj.data.ortho_scale = ortho
    else:
        obj.data.lens = 48
    return obj


camera('Inspect socialist bloc', (-315, -115, 46), (-260, -20, 13))
camera('Inspect Builders House', (-240, -125, 65), (-170, -20, 40))
camera('Inspect Parliament', (380, -230, 150), (110, 90, 36))
scene.camera = camera('Workshop overview', (430, -580, 440), (-5, 35, 15), 700)
scene['asset_contract'] = source['contract']
scene['runtime_mesh_count'] = sum(len(asset['parts']) for asset in source['assets'])
scene['shader_parity'] = 'Runtime detail PBR retained; facade/surface GLSL approximated in editable Blender nodes.'
scene['roundtrip_status'] = 'Authoring export only; no mesh import/cook back into runtime exists yet.'
out = ROOT / 'assets/blender'
out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'buildings.blend'), compress=True)
manifest = {'blender': bpy.app.version_string, 'source_sha256': hashlib.sha256(INPUT.read_bytes()).hexdigest(),
    'units': 'metres', 'coordinate_transform': 'Three (x,y,z) to Blender (x,-z,y)',
    'models': counts, 'shader_parity': scene['shader_parity'], 'roundtrip_status': scene['roundtrip_status']}
(out / 'buildings-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
if '--render' in sys.argv:
    scene.render.filepath = str(out / 'buildings-overview.png')
    bpy.ops.render.render(write_still=True)
print('BUILDINGS', json.dumps({k: v['parts'] for k, v in counts.items()}))
