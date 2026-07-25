/* Generate Klippy PWA icons as real PNGs, no image library needed.
 * A violet rounded square with a white "K". Run: node scripts/gen-icons.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');

// ---- tiny PNG encoder ------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- drawing ---------------------------------------------------------------
function icon(size, { pad = 0 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const px = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  // rounded-square violet background (gradient top-left -> bottom-right)
  const inset = Math.round(size * pad);
  const radius = Math.round((size - inset * 2) * 0.22);
  const inRounded = (x, y) => {
    const x0 = inset, y0 = inset, x1 = size - inset - 1, y1 = size - inset - 1;
    if (x < x0 || y < y0 || x > x1 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= radius * radius || (x >= x0 + radius && x <= x1 - radius) || (y >= y0 + radius && y <= y1 - radius);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!inRounded(x, y)) continue;
    const t = (x + y) / (2 * size); // 0..1 diagonal
    const r = Math.round(139 + (79 - 139) * t);   // #8b5cf6 -> #4f46e5
    const g = Math.round(92 + (70 - 92) * t);
    const b = Math.round(246 + (229 - 246) * t);
    px(x, y, r, g, b, 255);
  }
  // white "K"
  const m = size, sIn = inset;
  const left = Math.round(sIn + (m - sIn * 2) * 0.30);
  const top = Math.round(sIn + (m - sIn * 2) * 0.26);
  const bottom = Math.round(sIn + (m - sIn * 2) * 0.74);
  const right = Math.round(sIn + (m - sIn * 2) * 0.70);
  const stroke = Math.max(2, Math.round((m - sIn * 2) * 0.085));
  const white = (x, y) => px(x, y, 255, 255, 255, 255);
  // vertical bar
  for (let y = top; y <= bottom; y++) for (let x = left; x < left + stroke; x++) white(x, y);
  const midY = Math.round((top + bottom) / 2);
  // upper arm: from (left, midY) to (right, top)
  const drawLine = (x0, y0, x1, y1) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + (x1 - x0) * (s / steps));
      const y = Math.round(y0 + (y1 - y0) * (s / steps));
      for (let a = 0; a < stroke; a++) for (let b = 0; b < stroke; b++) white(x + a, y + b);
    }
  };
  drawLine(left, midY, right - stroke, top);
  drawLine(left, midY, right - stroke, bottom);
  return encodePNG(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), icon(192));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), icon(512));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), icon(512, { pad: 0.12 }));
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), icon(180));
console.log('icons written to public/');
