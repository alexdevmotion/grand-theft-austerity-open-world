"""Build a Blender vehicle workshop from the runtime geometry.

bun tools/blender/export-vehicles.ts
blender -b -t 2 --python tools/blender/build-vehicles.py
Pass -- --render for an optional studio overview PNG.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
source = json.loads((ROOT / 'tools/blender/input/vehicles.json').read_text())
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.32, 0.39, 0.46, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.45


def coordinates(values):
    """Rotate Three Y-up into Blender Z-up, retaining a right-handed basis."""
    return [(x, -z, y) for x, y, z in zip(*[iter(values)] * 3)]


materials = {}
for category in ['paint', 'chrome', 'rubber', 'glass', 'interior', 'lamp']:
    material = bpy.data.materials.new(category)
    material.use_nodes = True
    shader = material.node_tree.nodes.get('Principled BSDF')
    color = material.node_tree.nodes.new('ShaderNodeVertexColor')
    color.layer_name = 'VehicleColor'
    material.node_tree.links.new(color.outputs['Color'], shader.inputs['Base Color'])
    for attribute, socket in [('SurfaceRoughness', 'Roughness'), ('SurfaceMetalness', 'Metallic'), ('SurfaceCoat', 'Coat Weight')]:
        node = material.node_tree.nodes.new('ShaderNodeAttribute')
        node.attribute_name = attribute
        material.node_tree.links.new(node.outputs['Fac'], shader.inputs[socket])
    shader.inputs['Coat Roughness'].default_value = 0.09
    if category == 'glass':
        shader.inputs['Transmission Weight'].default_value = 0.76
        shader.inputs['IOR'].default_value = 1.52
    material.diffuse_color = {'paint': (0.5, 0.38, 0.22, 1), 'chrome': (0.65, 0.66, 0.67, 1),
        'rubber': (0.035, 0.035, 0.035, 1), 'glass': (0.3, 0.42, 0.4, 0.3),
        'interior': (0.1, 0.085, 0.065, 1), 'lamp': (0.65, 0.6, 0.42, 1)}[category]
    materials[category] = material


def create_mesh(part, collection):
    vertices = coordinates(part['position'])
    indices = part.get('index') or list(range(len(vertices)))
    faces = list(zip(*[iter(indices)] * 3))
    mesh = bpy.data.meshes.new(part['id'])
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(part['id'], mesh)
    collection.objects.link(obj)
    color = mesh.color_attributes.new(name='VehicleColor', type='FLOAT_COLOR', domain='POINT')
    rgba = [channel for rgb in zip(*[iter(part['color'])] * 3) for channel in (*rgb, 1)]
    color.data.foreach_set('color', rgba)
    surface = part['surface']
    for channel, name in enumerate(['SurfaceRoughness', 'SurfaceMetalness', 'SurfaceCoat']):
        attr = mesh.attributes.new(name=name, type='FLOAT', domain='POINT')
        attr.data.foreach_set('value', surface[channel::3])
    for channel in range(8):
        attr = mesh.attributes.new(name=f'LampChannel{channel}', type='FLOAT', domain='POINT')
        values = part['lightA' if channel < 4 else 'lightB']
        attr.data.foreach_set('value', values[channel % 4::4])
    uv = mesh.uv_layers.new(name='VehicleAtlasUV')
    uv.data.foreach_set('uv', [value for vertex in indices for value in part['uv'][vertex * 2:vertex * 2 + 2]])
    mesh.normals_split_custom_set_from_vertices(coordinates(part['normal']))
    categories = list(materials)
    for material in materials.values():
        mesh.materials.append(material)
    for polygon, triangle in zip(mesh.polygons, faces):
        vertex = triangle[0]
        rough, metal, coat = surface[vertex * 3:vertex * 3 + 3]
        lamp = any(part['lightA'][vertex * 4:vertex * 4 + 4]) or any(part['lightB'][vertex * 4:vertex * 4 + 4])
        category = ('glass' if part['kind'] == 'glass' else 'lamp' if lamp else
                    'chrome' if metal >= 0.5 else 'rubber' if rough >= 0.85 and coat < 0.15 else
                    'paint' if coat >= 0.3 else 'interior')
        polygon.material_index = categories.index(category)
        polygon.use_smooth = True
    obj['runtime_part'] = part['id']
    obj['atlas_contract'] = 'VehicleAtlasUV retained; atlas image is runtime-generated and not baked here.'
    return obj


counts = {}
columns = 5
for index, asset in enumerate(source['assets']):
    collection = bpy.data.collections.new(asset['id'])
    scene.collection.children.link(collection)
    root = bpy.data.objects.new(asset['id'], None)
    collection.objects.link(root)
    root.location = ((index % columns) * 6.0, (index // columns) * 18.0, asset['spec']['rideHeight'])
    root['runtime_model'] = asset['id']
    root['units'] = 'metres; Three (x,y,z) becomes Blender (x,-z,y)'
    root['source'] = 'src/vehicles/models.ts; regenerate with bun tools/blender/export-vehicles.ts'
    pivots = {}
    for door in asset['doors']:
        pivot = bpy.data.objects.new(door['id'] + '.hinge', None)
        collection.objects.link(pivot)
        pivot.parent = root
        pivot.location = coordinates(door['hinge'])[0]
        pivot.empty_display_type = 'PLAIN_AXES'
        pivot.empty_display_size = 0.15
        pivot['open_angle_radians'] = -door['angle'] * door['side']
        pivot['usage'] = 'Rotate local Z to open; shell and glass share this hinge.'
        pivots[door['id']] = pivot
    triangles = 0
    for part in asset['parts']:
        if not part['position']:
            continue
        obj = create_mesh(part, collection)
        door = next((key for key in pivots if part['id'].startswith(key + '.')), None)
        obj.parent = pivots[door] if door else root
        obj.location = (0, 0, 0) if door else coordinates(part['offset'])[0]
        if part['kind'] == 'wheel':
            obj['usage'] = 'Rotate local X for wheel spin; local Z for steering.'
        triangles += len(obj.data.polygons)
    counts[asset['id']] = {'parts': len(asset['parts']), 'doors': len(pivots), 'triangles': triangles}

# A useful authoring view: true metre-scale fleet laid out on a neutral floor.
rows = math.ceil(len(source['assets']) / columns)
centre = Vector((12, (rows - 1) * 9, 0))
bpy.ops.mesh.primitive_plane_add(size=200, location=(centre.x, centre.y, -0.08))
ground = bpy.context.object
ground.name = 'Workshop ground'
floor = bpy.data.materials.new('Workshop concrete')
floor.diffuse_color = (0.13, 0.14, 0.15, 1)
ground.data.materials.append(floor)
bpy.ops.object.light_add(type='SUN', location=(0, 0, 15))
bpy.context.object.name = 'Workshop daylight'
bpy.context.object.rotation_euler = (math.radians(28), math.radians(-20), math.radians(-35))
bpy.context.object.data.energy = 2.3
bpy.context.object.data.angle = math.radians(12)
bpy.ops.object.camera_add(location=centre + Vector((43, -53, 51)))
camera = bpy.context.object
camera.rotation_euler = (centre - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = max(44, rows * 17)
scene.camera = camera
scene['asset_contract'] = 'Editable runtime vehicle geometry, hinge-separated doors, per-vertex PBR attributes. No gameplay changes.'
scene['vehicle_count'] = len(counts)
out = ROOT / 'assets/blender'
out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'vehicles.blend'), compress=True)
(out / 'vehicles-manifest.json').write_text(json.dumps({'blender': bpy.app.version_string, 'models': counts}, indent=2) + '\n')
if '--render' in sys.argv:
    scene.render.filepath = str(out / 'vehicles-overview.png')
    bpy.ops.render.render(write_still=True)
print('VEHICLES', json.dumps(counts))
