// Generate app icons (PNG) with no image libraries: a gold spade on felt
// green, rasterized with 4x supersampling, encoded with a minimal PNG
// writer over node:zlib. Run: npm run gen:icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  const c = 1 - a - b;
  return a >= 0 && b >= 0 && c >= 0;
}

function inSpade(x, y) {
  // Unit space, y down. Spade body: two circles + triangle to the tip.
  const c1 = (x - 0.35) ** 2 + (y - 0.52) ** 2 <= 0.2 ** 2;
  const c2 = (x - 0.65) ** 2 + (y - 0.52) ** 2 <= 0.2 ** 2;
  const tri = inTriangle(x, y, 0.5, 0.08, 0.16, 0.62, 0.84, 0.62);
  // Stem: quad flaring downward.
  const stem =
    y >= 0.64 &&
    y <= 0.9 &&
    Math.abs(x - 0.5) <= 0.07 + (y - 0.64) * 0.35;
  return c1 || c2 || tri || stem;
}

function render(size) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let spadeHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (inSpade(u, v)) spadeHits++;
        }
      }
      const u = x / size;
      const v = y / size;
      // felt background with slight radial shading
      const dist = Math.hypot(u - 0.5, v - 0.45);
      const shade = Math.max(0, 1 - dist * 0.55);
      const bg = [11 + 14 * shade, 61 + 26 * shade, 46 + 20 * shade];
      const gold = [255, 200, 87];
      const f = spadeHits / (SS * SS);
      const idx = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) out[idx + ch] = Math.round(bg[ch] * (1 - f) + gold[ch] * f);
      out[idx + 3] = 255;
    }
  }
  return out;
}

mkdirSync(new URL('../public/icons', import.meta.url), { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(new URL(`../public/icons/${name}`, import.meta.url), encodePng(render(size), size));
  console.log('wrote', name, size);
}
