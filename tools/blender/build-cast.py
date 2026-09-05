"""Build editable cast sculpts and eyelid shape keys; cook sparse offsets for Three.

Run from the repository: blender -b -t 2 --python tools/blender/build-cast.py
The head-bone bind space and vertex ordering are deliberately preserved.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
source = json.loads((ROOT / 'tools/blender/input/cast.json').read_text())
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = 1400
scene.render.resolution_y = 800
scene.render.resolution_percentage = 100
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.18, 0.22, 0.28, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.32
cooked = {'version': 1, 'generator': bpy.app.version_string, 'heads': {}}
portraits = bpy.data.collections.new('Assembled cast portraits')
scene.collection.children.link(portraits)
sculpts = bpy.data.collections.new('Lower detail sculpt sources')
scene.collection.children.link(sculpts)
sculpts.hide_render = True
sculpts.hide_viewport = True


def attach_assembly(part, root, collection):
    points = list(zip(*[iter(part['position'])] * 3))
    indices = part.get('index') or list(range(len(points)))
    triangles = list(zip(*[iter(indices)] * 3))
    mesh = bpy.data.meshes.new(root.name + ':' + part['name'])
    mesh.from_pydata(points, [], triangles, shade_flat=False)
    mesh.update()
    obj = bpy.data.objects.new(mesh.name, mesh)
    collection.objects.link(obj)
    obj.parent = root
    obj['runtime_part'] = part['name']
    colors = mesh.color_attributes.new(name='AssemblyColor', type='FLOAT_COLOR', domain='POINT')
    colors.data.foreach_set('color', [c for rgb in zip(*[iter(part['color'])] * 3) for c in (*rgb, 1)])
    if part.get('uv'):
        uv = mesh.uv_layers.new(name='RuntimeUV')
        uv.data.foreach_set('uv', [c for i in indices for c in part['uv'][i * 2:i * 2 + 2]])
    if part.get('normal'):
        mesh.normals_split_custom_set_from_vertices(list(zip(*[iter(part['normal'])] * 3)))
    material = bpy.data.materials.new(mesh.name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get('Principled BSDF')
    color = nodes.new('ShaderNodeVertexColor')
    color.layer_name = 'AssemblyColor'
    links.new(color.outputs['Color'], shader.inputs['Base Color'])
    shader.inputs['Roughness'].default_value = 0.62 if part['kind'] == 'hair' else 0.26
    if part['kind'] == 'cornea':
        shader.inputs['Transmission Weight'].default_value = 1
        shader.inputs['IOR'].default_value = 1.376
        shader.inputs['Roughness'].default_value = 0.035
    if part['kind'] == 'hair':
        shader.inputs['Anisotropic'].default_value = 0.36
        shader.inputs['Specular IOR Level'].default_value = 0.18
        tex = nodes.new('ShaderNodeTexCoord')
        separate = nodes.new('ShaderNodeSeparateXYZ')
        links.new(tex.outputs['UV'], separate.inputs['Vector'])
        if part['name'] == 'hair-shell':
            fade = nodes.new('ShaderNodeMapRange')
            fade.inputs['From Min'].default_value = 0.075
            fade.inputs['From Max'].default_value = 0.34
            links.new(separate.outputs['Y'], fade.inputs['Value'])
            links.new(fade.outputs['Result'], shader.inputs['Alpha'])
        else:
            # Blender-native strand cutouts keep ribbons inspectable without
            # importing the runtime CanvasTexture or photographs.
            wave = nodes.new('ShaderNodeMath')
            wave.operation = 'MULTIPLY'
            wave.inputs[1].default_value = 22 * math.pi * 2
            links.new(separate.outputs['X'], wave.inputs[0])
            sine = nodes.new('ShaderNodeMath')
            sine.operation = 'SINE'
            links.new(wave.outputs[0], sine.inputs[0])
            mask = nodes.new('ShaderNodeMath')
            mask.operation = 'GREATER_THAN'
            mask.inputs[1].default_value = -0.15
            links.new(sine.outputs[0], mask.inputs[0])
            links.new(mask.outputs[0], shader.inputs['Alpha'])
    mesh.materials.append(material)
    return obj

for asset in source['assets']:
    key = f"{asset['id']}:{asset['detail']}"
    points = list(zip(*[iter(asset['position'])] * 3))
    triangles = list(zip(*[iter(asset['index'])] * 3))
    mesh = bpy.data.meshes.new(key)
    mesh.from_pydata(points, [], triangles, shade_flat=False)
    mesh.update()
    obj = bpy.data.objects.new(key, mesh)
    collection = portraits if asset['detail'] == 1 else sculpts
    collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    colors = mesh.color_attributes.new(name='SkinColor', type='FLOAT_COLOR', domain='POINT')
    rgba = [channel for rgb in zip(*[iter(asset['color'])] * 3) for channel in (*rgb, 1)]
    colors.data.foreach_set('color', rgba)
    material = bpy.data.materials.new(key + ':skin')
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Roughness'].default_value = 0.57
    shader.inputs['Subsurface Weight'].default_value = 0.08
    shader.inputs['Subsurface Scale'].default_value = 0.0012
    color_node = material.node_tree.nodes.new('ShaderNodeVertexColor')
    color_node.layer_name = 'SkinColor'
    material.node_tree.links.new(color_node.outputs['Color'], shader.inputs['Base Color'])
    mesh.materials.append(material)

    # Smooth broad cheek/forehead facets while protecting eyes, lips and ears.
    weights = obj.vertex_groups.new(name='Broad planes only')
    eyes = [(Vector(e['centre']), e['radius']) for e in asset['eyes']]
    f = asset['frame']
    for vertex in mesh.vertices:
        x = (vertex.co.x - f['ox']) / f['scale']
        y = (vertex.co.y - f['oy']) / f['scale']
        weight = 0.0
        if abs(x) < 0.36 and vertex.co.z > f['oz']:
            weight = 0.75 if y > 0.12 else 0.38
            if -0.48 < y < -0.24 or abs(x) < 0.09:
                weight *= 0.2
            if any((vertex.co - c).length < radius * 1.7 for c, radius in eyes):
                weight = 0.0
        if weight:
            weights.add([vertex.index], weight, 'REPLACE')
    modifier = obj.modifiers.new('Submillimetre sculpt fairing', 'SMOOTH')
    modifier.factor = 0.32
    modifier.iterations = 3
    modifier.vertex_group = weights.name
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.shape_key_add(name='Basis')
    blink = obj.shape_key_add(name='Blink')
    blink.value = 0.0

    # The fitted eye opening is recessed skin. A closed lid follows the globe
    # just outside the cornea, with its perimeter fixed to the orbital skin.
    for vertex in mesh.vertices:
        for centre, radius in eyes:
            dx = vertex.co.x - centre.x
            dy = vertex.co.y - centre.y
            distance = math.hypot(dx, dy)
            if distance >= radius * 0.99 or vertex.co.z < centre.z - radius * 0.75:
                continue
            front = centre.z + math.sqrt(max(0, radius * radius - distance * distance)) + 0.00065
            if vertex.co.z < front:
                blink.data[vertex.index].co.z = front

    scale = f['scale']
    sculpt, lids = [], []
    for i, vertex in enumerate(mesh.vertices):
        delta = (vertex.co - Vector(points[i])) / scale
        lid = (blink.data[i].co - vertex.co) / scale
        if delta.length > 0.000015:
            sculpt.append([i, *[round(v, 6) for v in delta]])
        if lid.length > 0.000015:
            lids.append([i, *[round(v, 6) for v in lid]])
    cooked['heads'][key] = {'vertices': len(points), 'sculpt': sculpt, 'blink': lids}
    obj['runtime_contract'] = 'Y up, metres, original vertex order; offsets scaled by headFrame.scale'
    obj['reference'] = {'player': 'Alexandru Agatinei + Ilie Bolojan composite', 'ally': 'Alex Nedea', 'nicusor': 'Nicusor Dan'}[asset['id']]
    # The head mesh and its shape keys remain in original Y-up bind space.
    # Only this parent rotates (x,y,z) to Blender (x,-z,y); cooking above is
    # therefore independent of portrait presentation and assembly parts.
    root = bpy.data.objects.new(key + ':portrait-root', None)
    collection.objects.link(root)
    root.rotation_euler.x = math.pi / 2
    root.location = (['player', 'nicusor', 'ally'].index(asset['id']) * 0.43 - 0.43,
                     0 if asset['detail'] == 1 else 0.65, 1.15 - f['oy'])
    root['cast_id'] = asset['id']
    root['coordinate_contract'] = 'Root maps runtime Y-up into Blender Z-up; child vertex order unchanged.'
    obj.parent = root
    for part in asset.get('assembly', []):
        attach_assembly(part, root, collection)
    obj.select_set(False)

out = ROOT / 'src/characters/face/generated'
out.mkdir(parents=True, exist_ok=True)
(out / 'cast-sculpts.json').write_text(json.dumps(cooked, separators=(',', ':')) + '\n')
studio = ROOT / 'assets/blender'
studio.mkdir(parents=True, exist_ok=True)

def area_light(name, location, power, size, color):
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.name = name
    light.data.energy, light.data.shape, light.data.size, light.data.color = power, 'DISK', size, color
    light.rotation_euler = (Vector((0, 0, 1.16)) - light.location).to_track_quat('-Z', 'Y').to_euler()


area_light('Portrait key softbox', (-1.1, -1.6, 2.3), 75, 1.5, (1, 0.90, 0.81))
area_light('Portrait fill softbox', (1.4, -0.8, 1.5), 32, 1.3, (0.78, 0.87, 1))
area_light('Hair rim softbox', (0.6, 0.8, 2.0), 55, 1.1, (1, 0.97, 0.91))
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0.8))
bpy.context.object.name = 'Portrait studio floor'
floor = bpy.data.materials.new('Studio charcoal')
floor.diffuse_color = (0.045, 0.055, 0.065, 1)
floor.use_nodes = True
floor.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = floor.diffuse_color
floor.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.84
bpy.context.object.data.materials.append(floor)
lettering = bpy.data.materials.new('Studio lettering')
lettering.use_nodes = True
lettering.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.67, 0.70, 1)
for i, name in enumerate(['Alexandru / Ilie', 'Nicusor Dan', 'Alex Nedea']):
    x = i * 0.43 - 0.43
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.045, depth=0.22, location=(x, 0, 0.91))
    bpy.context.object.name = name + ':portrait support'
    bpy.context.object.data.materials.append(floor)
    bpy.ops.object.text_add(location=(x, -0.105, 0.845), rotation=(math.pi / 2, 0, 0))
    label = bpy.context.object
    label.name = name + ':label'
    label.data.body, label.data.align_x, label.data.size = name, 'CENTER', 0.023
    label.data.materials.append(lettering)
bpy.ops.object.camera_add(location=(0, -2.55, 1.34))
camera = bpy.context.object
camera.name = 'Assembled cast portrait camera'
camera.rotation_euler = (Vector((0, 0, 1.13)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type, camera.data.ortho_scale = 'ORTHO', 1.42
scene.camera = camera
scene['authoring_notes'] = 'Runtime topology with assembled eyes and hair. Blender strand/iris shading approximates procedural game shaders; not an in-game render.'
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.region_3d.view_perspective = 'CAMERA'
bpy.ops.wm.save_as_mainfile(filepath=str(studio / 'cast.blend'), compress=True)
if '--render' in sys.argv:
    preview = ROOT / 'tools/out/blender-cast-portrait.png'
    preview.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(preview)
    bpy.ops.render.render(write_still=True)
print('COOKED', {k: {'vertices': v['vertices'], 'sculpt': len(v['sculpt']), 'blink': len(v['blink'])} for k, v in cooked['heads'].items()})
