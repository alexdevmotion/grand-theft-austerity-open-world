"""Cook CC0 HM08 topology and authored skin weights for the game's 42-bone rig.

No Blender installation or network is needed. Source vertex IDs and joint
helpers remain explicit so the runtime bind-pose transfer can be reproduced.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/source/hm08'
vertices, groups = [], {}
group = ''
for line in (SOURCE / 'base.obj').read_text().splitlines():
    a = line.split()
    if not a:
        continue
    if a[0] == 'v':
        vertices.append([float(n) for n in a[1:4]])
    elif a[0] == 'g':
        group = a[1]
        groups[group] = []
    elif a[0] == 'f':
        groups[group].append([int(n.split('/')[0]) - 1 for n in a[1:]])

def joint(name):
    ids = {i for f in groups[name] for i in f}
    return [round(sum(vertices[i][k] for i in ids) / len(ids), 6) for k in range(3)]

raw_rig = json.loads((SOURCE / 'rig.game_engine.json').read_text())
weights = json.loads((SOURCE / 'weights.game_engine.json').read_text())
assert weights['license'] == 'CC0'
mapping = {'pelvis': 'hips', 'spine_01': 'spine', 'spine_02': 'chest',
           'spine_03': 'upperChest', 'neck_01': 'neck', 'head': 'head'}
for side in ['l', 'r']:
    for raw, game in [('clavicle', 'clavicle'), ('upperarm', 'upperArm'),
                      ('lowerarm', 'forearm'), ('hand', 'hand'), ('thigh', 'thigh'),
                      ('calf', 'shin'), ('foot', 'foot'), ('ball', 'toe')]:
        mapping[raw + '_' + side] = game + side.upper()
    for digit in ['thumb', 'index', 'middle', 'ring', 'pinky']:
        for n in [1, 2, 3]:
            mapping[f'{digit}_0{n}_{side}'] = f'{digit}{0 if n == 1 else 1}{side.upper()}'

bones = {}
for raw, game in mapping.items():
    source = raw_rig[raw]
    if game not in bones:
        bones[game] = {'head': joint(source['head']['cube_name']),
                       'tail': joint(source['tail']['cube_name'])}
    elif '_03_' in raw:
        bones[game]['tail'] = joint(source['tail']['cube_name'])

# The hand frame uses the palm to the middle knuckle, rather than the source
# rig's short metacarpal helper. This preserves a full palm after retargeting.
for side in ['L', 'R']:
    bones['hand' + side]['tail'] = bones['middle0' + side]['head']

vertex_weights = [dict() for _ in vertices]
for raw, entries in weights['weights'].items():
    game = mapping.get(raw)
    if not game:
        continue
    for i, w in entries:
        vertex_weights[i][game] = vertex_weights[i].get(game, 0) + w

# Keep the native neck cut and both hands. Feet are inside authored shoes.
faces = [f for f in groups['body'] if max(vertices[i][1] for i in f) < 6.0
         and min(vertices[i][1] for i in f) > -7.55]
ids = sorted({i for f in faces for i in f})
local = {source: n for n, source in enumerate(ids)}
names = list(bones)
skin_index, skin_weight = [], []
for i in ids:
    ws = sorted(vertex_weights[i].items(), key=lambda a: -a[1])[:4]
    assert ws, i
    total = sum(w for _, w in ws)
    skin_index += [names.index(b) for b, _ in ws] + [0] * (4 - len(ws))
    skin_weight += [round(w / total, 6) for _, w in ws] + [0] * (4 - len(ws))
index = []
for f in faces:
    for k in range(1, len(f) - 1):
        index += [local[f[0]], local[f[k]], local[f[k + 1]]]

out = {'source': 'MakeHuman HM08 / CC0', 'revision': '437dd513888a92399d1d3200d2e80859fae55abc',
       'sourceIndices': ids, 'position': [n for i in ids for n in vertices[i]],
       'index': index, 'boneNames': names, 'bones': bones,
       'skinIndex': skin_index, 'skinWeight': skin_weight}
dest = ROOT / 'src/characters/generated/anatomical-body.json'
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, separators=(',', ':')) + '\n')
print(f'{len(ids)} body vertices, {len(index) // 3} triangles, {dest.stat().st_size} bytes')
