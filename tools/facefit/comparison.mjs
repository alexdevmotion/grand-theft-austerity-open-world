/**
 * Assemble `tools/out/headfix/comparison.png` — the four-panel the lead reviews:
 *
 *   before | after (front) | after (three-quarter) | reference
 *
 * Every panel is cropped to the head and scaled to a common height, so the
 * comparison is about the face rather than about how close the camera was.
 * Run after the shots exist:
 *
 *   bun tools/facefit/comparison.mjs <before.png> <front.png> <three.png>
 *
 * Studio-only. Uses the platform `sips`/`ImageMagick`-free path: a tiny PNG
 * decode/encode via the canvas that Bun already ships is not available here, so
 * this shells out to `sips` for scaling and composites with a raw RGBA buffer.
 */

import { $ } from 'bun';
import { mkdir } from 'node:fs/promises';

const REF = 'docs/reference/likeness/ref-lead-head.png';
const OUT = 'tools/out/headfix/comparison.png';

/** Panel height every source is normalised to. */
const H = 760;

/**
 * Crop boxes, as fractions of each source frame. The renders are 1600x900 with
 * the head centred by `tools/facefit/frame.js`; the reference is already a
 * head crop.
 */
const CROP = {
  render: { x: 0.33, y: 0.0, w: 0.34, h: 1.0 },
  ref: { x: 0, y: 0, w: 1, h: 1 },
};

async function panel(src, box, tag) {
  const info = await $`sips -g pixelWidth -g pixelHeight ${src}`.text();
  const w = Number(/pixelWidth: (\d+)/.exec(info)[1]);
  const h = Number(/pixelHeight: (\d+)/.exec(info)[1]);
  const cw = Math.round(w * box.w);
  const ch = Math.round(h * box.h);
  const ox = Math.round(w * box.x);
  const oy = Math.round(h * box.y);
  const tmp = `/tmp/gta-panel-${tag}.png`;
  // `sips --cropOffset` takes top-left; crop then scale to a common height.
  await $`sips -c ${ch} ${cw} --cropOffset ${oy} ${ox} ${src} --out ${tmp}`.quiet();
  await $`sips --resampleHeight ${H} ${tmp}`.quiet();
  return tmp;
}

const [before, front, three] = process.argv.slice(2);
if (!before || !front || !three) {
  console.error('usage: bun tools/facefit/comparison.mjs <before> <front> <three>');
  process.exit(1);
}

await mkdir('tools/out/headfix', { recursive: true });

const panels = [
  await panel(before, CROP.render, 'a'),
  await panel(front, CROP.render, 'b'),
  await panel(three, CROP.render, 'c'),
  await panel(REF, CROP.ref, 'd'),
];

// `sips` cannot composite, so the strip is built with a one-shot Python that is
// present on every macOS install. Keeping it here rather than as a second file
// because it is four lines and belongs to this script.
const py = `
import struct, zlib, sys
def read(p):
    d = open(p,'rb').read()
    assert d[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
    i, idat, w, h, bd, ct = 8, b'', 0, 0, 0, 0
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; typ = d[i+4:i+8]; body = d[i+8:i+8+ln]
        if typ == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT': idat += body
        i += 12 + ln
    ch = {0:1, 2:3, 3:1, 4:2, 6:4}[ct]
    raw = zlib.decompress(idat); stride = w * ch
    out = bytearray(h * stride); prev = bytearray(stride); pos = 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        for x in range(stride):
            a = line[x-ch] if x >= ch else 0
            b = prev[x]; c = prev[x-ch] if x >= ch else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y*stride:(y+1)*stride] = line; prev = line
    return w, h, ch, bytes(out)

def write(p, w, h, rgb):
    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    raw = b''.join(b'\\x00' + rgb[y*w*3:(y+1)*w*3] for y in range(h))
    open(p,'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))

srcs = [read(p) for p in sys.argv[1:-1]]
GAP = 10
H = max(s[1] for s in srcs)
W = sum(s[0] for s in srcs) + GAP * (len(srcs) - 1)
buf = bytearray(b'\\x12\\x12\\x16' * (W * H))
x0 = 0
for w, h, ch, data in srcs:
    for y in range(h):
        for x in range(w):
            o = (y*w + x) * ch
            d = ((y)*W + x0 + x) * 3
            buf[d:d+3] = data[o:o+3] if ch >= 3 else bytes([data[o]]*3)
    x0 += w + GAP
write(sys.argv[-1], W, H, bytes(buf))
`;
await $`python3 -c ${py} ${panels[0]} ${panels[1]} ${panels[2]} ${panels[3]} ${OUT}`;
console.log(`wrote ${OUT}`);
