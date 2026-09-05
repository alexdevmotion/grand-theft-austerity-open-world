"""Editable runtime full bodies and rigs. Run after export-bodies.ts with Blender.

No runtime asset is overwritten. The workshop preserves topology and skin weights;
its native materials approximate browser shaders. --render writes a studio proof.
"""
import bpy
import json
import math
import sys
import hashlib
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / 'tools/blender/input/bodies.json'
source = json.loads(INPUT.read_text())
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.resolution_percentage = 100
scene.render.fps = source['fps']
scene.frame_start, scene.frame_end = 1, 60
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.22, .26, .32, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .3


def matrix(values):
    return Matrix([values[i:i + 4] for i in range(0, 16, 4)]).transposed()


def rgb(value):
    channels = [(value >> shift & 255) / 255 for shift in (16, 8, 0)]
    return tuple(c / 12.92 if c < .04045 else ((c + .055) / 1.055) ** 2.4 for c in channels)


def material(name, color, roughness=.72, vertex=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    if vertex:
        node = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        node.layer_name = 'RuntimeColor'
        mat.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
    return mat, shader


def add_part(part, asset, arm, collection):
    points = list(zip(*[iter(part['position'])] * 3))
    triangles = list(zip(*[iter(part['index'])] * 3))
    mesh = bpy.data.meshes.new(asset['id'] + ':' + part['name'])
    mesh.from_pydata(points, [], triangles)
    mesh.update()
    for face in mesh.polygons:
        face.use_smooth = True
    if part.get('normal'):
        mesh.normals_split_custom_set_from_vertices(list(zip(*[iter(part['normal'])] * 3)))
    obj = bpy.data.objects.new(mesh.name, mesh)
    collection.objects.link(obj)
    obj.parent = arm
    obj['runtime_part'] = part['name']
    obj['coordinate_contract'] = 'Original Y-up runtime bind-space vertices, metres; presentation root rotates to Z-up.'
    if part.get('uv'):
        uv = mesh.uv_layers.new(name='RuntimeUV')
        uv.data.foreach_set('uv', [c for i in part['index'] for c in part['uv'][i * 2:i * 2 + 2]])
    if part['kind'] == 'body':
        for slot, name in enumerate(['skin', 'hair', 'top', 'outer', 'legs', 'shoes', 'accent', 'detail']):
            mat, shader = material(asset['id'] + ':' + name, rgb(asset['colors'][name]), .77 if slot in (2, 3, 4) else .55)
            if slot in (2, 3, 4):
                noise = mat.node_tree.nodes.new('ShaderNodeTexNoise')
                noise.inputs['Scale'].default_value = 900
                bump = mat.node_tree.nodes.new('ShaderNodeBump')
                bump.inputs['Strength'].default_value = .12
                bump.inputs['Distance'].default_value = .00045
                mat.node_tree.links.new(noise.outputs['Fac'], bump.inputs['Height'])
                mat.node_tree.links.new(bump.outputs['Normal'], shader.inputs['Normal'])
            mesh.materials.append(mat)
        for face in mesh.polygons:
            face.material_index = min(7, int(part['uv'][face.vertices[0] * 2] * 16))
    else:
        colors = part.get('color')
        if not colors:
            base = Vector(rgb(part['tint']))
            colors = []
            for i in range(len(points)):
                color = base.copy()
                if part['kind'] == 'eye':
                    u, v = part['uv'][i * 2:i * 2 + 2]
                    r = math.hypot(u - .75, v - .5) / .235
                    color = Vector(rgb(0xc9c0b2)) if u <= .5 else color * (.35 if r > .88 else .8)
                    if u > .5 and r < .25:
                        color = Vector((.002, .002, .002))
                if part.get('strand'):
                    root, grey = part['strand'][i * 2:i * 2 + 2]
                    color *= .74 + .26 * root
                    color = color.lerp(Vector((.115, .112, .108)), grey)
                colors.extend(color)
        attribute = mesh.color_attributes.new(name='RuntimeColor', type='FLOAT_COLOR', domain='POINT')
        attribute.data.foreach_set('color', [c for color in zip(*[iter(colors)] * 3) for c in (*color, 1)])
        mat, shader = material(mesh.name, (.3, .3, .3), .6, True)
        if part['kind'] == 'skin':
            shader.inputs['Subsurface Weight'].default_value = .06
            shader.inputs['Subsurface Scale'].default_value = .0012
        elif part['kind'] == 'cornea':
            shader.inputs['Transmission Weight'].default_value = 1
            shader.inputs['Roughness'].default_value = .035
            shader.inputs['IOR'].default_value = 1.376
        elif part['kind'] == 'eye':
            shader.inputs['Roughness'].default_value = .25
        elif part['kind'] == 'hair':
            shader.inputs['Anisotropic'].default_value = .36
            shader.inputs['Specular IOR Level'].default_value = .18
            nodes, links = mat.node_tree.nodes, mat.node_tree.links
            uv = nodes.new('ShaderNodeTexCoord')
            split = nodes.new('ShaderNodeSeparateXYZ')
            links.new(uv.outputs['UV'], split.inputs['Vector'])
            if part['name'] == 'hair-shell':
                mask = nodes.new('ShaderNodeMapRange')
                mask.inputs['From Min'].default_value = .075
                mask.inputs['From Max'].default_value = .34
                links.new(split.outputs['Y'], mask.inputs['Value'])
            else:
                wave = nodes.new('ShaderNodeMath'); wave.operation = 'MULTIPLY'
                wave.inputs[1].default_value = 22 * math.pi * 2
                links.new(split.outputs['X'], wave.inputs[0])
                sine = nodes.new('ShaderNodeMath'); sine.operation = 'SINE'
                links.new(wave.outputs[0], sine.inputs[0])
                mask = nodes.new('ShaderNodeMath'); mask.operation = 'GREATER_THAN'
                mask.inputs[1].default_value = -.15
                links.new(sine.outputs[0], mask.inputs[0])
            links.new(mask.outputs[0], shader.inputs['Alpha'])
        mesh.materials.append(mat)
    if part.get('blink'):
        obj.shape_key_add(name='Basis')
        blink = obj.shape_key_add(name='Blink')
        for i, vertex in enumerate(blink.data):
            vertex.co += Vector(part['blink'][i * 3:i * 3 + 3])
    if part.get('skinIndex'):
        for bone_index, bone in enumerate(asset['bones']):
            group = obj.vertex_groups.new(name=bone['name'])
            for i in range(len(points)):
                weight = sum(part['skinWeight'][i * 4 + j] for j in range(4) if part['skinIndex'][i * 4 + j] == bone_index)
                if weight > 0:
                    group.add([i], weight, 'REPLACE')
    else:
        group = obj.vertex_groups.new(name='head')
        group.add(list(range(len(points))), 1, 'REPLACE')
    modifier = obj.modifiers.new('Runtime 42-bone skin', 'ARMATURE')
    modifier.object = arm
    modifier.use_deform_preserve_volume = False
    return obj


manifest = {'blender': bpy.app.version_string, 'input_sha256': hashlib.sha256(INPUT.read_bytes()).hexdigest(),
            'contract': 'Runtime vertices, UVs, skin weights and sampled walk; native shader approximation.', 'casts': {}}
for slot, asset in enumerate(source['assets']):
    collection = bpy.data.collections.new(asset['id'] + ':full character')
    scene.collection.children.link(collection)
    root = bpy.data.objects.new(asset['id'] + ':presentation', None)
    collection.objects.link(root)
    root.rotation_euler.x = math.pi / 2
    root.location.x = (slot - 1) * .92
    root.scale = (asset['scale'],) * 3
    data = bpy.data.armatures.new(asset['id'] + ':42-bone rig')
    arm = bpy.data.objects.new(data.name, data)
    collection.objects.link(arm)
    arm.parent = root
    arm.show_in_front = True
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for bone in asset['bones']:
        edit = data.edit_bones.new(bone['name'])
        edit.head, edit.tail = (0, 0, 0), (0, max(.008, bone['length']), 0)
        edit.matrix = matrix(bone['matrix'])
        if bone['parent']:
            edit.parent = data.edit_bones[bone['parent']]
        edit.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    parts = [add_part(part, asset, arm, collection) for part in asset['parts']]
    for frame in asset['frames']:
        for i, bone in enumerate(asset['bones']):
            pose = arm.pose.bones[bone['name']]
            pose.rotation_mode = 'QUATERNION'
            pose.matrix_basis = matrix(frame['basis'][i])
            for path in ('location', 'rotation_quaternion', 'scale'):
                pose.keyframe_insert(data_path=path, frame=frame['frame'], group=bone['name'])
    arm.animation_data.action.name = asset['id'] + ':runtime walk 30fps'
    # Compare evaluated Blender skinning to actual Three.SkinnedMesh samples.
    maximum_error = 0
    for frame in asset['frames']:
        if not frame.get('probes'):
            continue
        scene.frame_set(frame['frame'])
        evaluated = parts[0].evaluated_get(bpy.context.evaluated_depsgraph_get())
        for probe in frame['probes']:
            error = (evaluated.data.vertices[probe['index']].co - Vector(probe['position'])).length
            maximum_error = max(maximum_error, error)
    if maximum_error > .0001:
        raise RuntimeError(f"{asset['id']} Blender/runtime skin mismatch: {maximum_error:.6f}m")
    manifest['casts'][asset['id']] = {'body_vertices': len(parts[0].data.vertices),
        'body_triangles': len(parts[0].data.polygons), 'parts': len(parts), 'bones': len(data.bones),
        'walk_frames': len(asset['frames']), 'pose_probe_count': 144, 'max_pose_error_metres': maximum_error,
        'blink_shape_key': 'Blink', 'height_scale': asset['scale']}
    arm.select_set(False)

scene.frame_set(1)
for asset in source['assets']:
    # Open in the relaxed bind pose; the walk remains available in Pose Position.
    bpy.data.armatures[asset['id'] + ':42-bone rig'].pose_position = 'REST'
for relative in ['tools/blender/export-bodies.ts', 'tools/blender/build-bodies.py',
                 'tools/blender/cook-body.py', 'src/characters/tailoredBody.ts',
                 'src/characters/humanoid.ts', 'src/characters/rig.ts', 'src/characters/animation.ts',
                 'src/characters/wardrobe.ts', 'assets/source/hm08/README.md']:
    block = bpy.data.texts.new(relative)
    block.write((ROOT / relative).read_text())
notes = bpy.data.texts.new('WORKSHOP.txt')
notes.write('Three editable cast bodies with runtime native head, hair, eyes, clothing, UVs and 42-bone weights.\n'
            'Select a rig, Armature Data > Skeleton > Pose Position to play frames 1-60 (sampled game walk).\n'
            'REST is the saved presentation. Head mesh has a relative Blink shape key.\n'
            'Each presentation root rotates Y-up to Z-up and applies the actual character height.\n'
            'Body vertices and weights match the game. Studio shaders approximate browser shader appearance.\n'
            'Export with bun tools/blender/export-bodies.ts, then blender -b -t 2 --python tools/blender/build-bodies.py.\n'
            'This workshop does not automatically cook Blender edits back into the game. Source modules are embedded.\n')

def area(name, position, power, size):
    bpy.ops.object.light_add(type='AREA', location=position)
    light = bpy.context.object
    light.name, light.data.energy, light.data.size = name, power, size
    light.rotation_euler = (Vector((0, 0, 1)) - light.location).to_track_quat('-Z', 'Y').to_euler()

area('Broad key', (-3, -4, 5), 450, 4)
area('Soft fill', (3, -2, 3), 230, 3)
area('Shoulder rim', (0, 2, 3), 280, 3)
bpy.ops.mesh.primitive_plane_add(size=200)
floor = bpy.context.object
floor.name = 'Studio ground'
floor.data.materials.append(material('Studio slate', (.055, .065, .08), .85)[0])
bpy.ops.object.camera_add(location=(2.4, -6.5, 2.5))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, .93)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type, camera.data.ortho_scale = 'ORTHO', 3.55
scene.camera = camera
scene['workshop_contract'] = manifest['contract']
for area in bpy.context.screen.areas:
    if area.type == 'VIEW_3D':
        area.spaces.active.region_3d.view_perspective = 'CAMERA'
out = ROOT / 'assets/blender'
out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'bodies.blend'), compress=True)
(out / 'bodies-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
if '--render' in sys.argv:
    scene.render.filepath = str(ROOT / 'tools/out/blender-bodies-overview.png')
    bpy.ops.render.render(write_still=True)
print('BODIES', json.dumps(manifest))
