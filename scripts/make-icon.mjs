// Renders the Claudiogram app icons with zero dependencies.
// Design: open "C" lettermark with the heartbeat trace escaping through its
// opening, ending in a glowing sweep-head dot (the live-trace cursor).
// Outputs: scripts/icon-master.png (1024px — source for AppIcon.icns via sips/iconutil)
//          Claudiogram.ico         (256px PNG-in-ICO, repo root — Windows shortcuts)
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function render(S) {
  const f = S / 1024;

  // --- geometry -------------------------------------------------------------
  // Rounded-rect background plate (Big Sur style: inset with generous radius).
  const MARGIN = 100 * f, RADIUS = 200 * f;
  function plateDist(x, y) {
    const hw = (S - 2 * MARGIN) / 2;
    const dx = Math.abs(x - S / 2) - (hw - RADIUS);
    const dy = Math.abs(y - S / 2) - (hw - RADIUS);
    const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - RADIUS;
  }

  // Open "C": circle arc with a gap facing right (rounded endpoints).
  const C_R = 300 * f, GAP_HALF = 0.96; // radians; ~55° half-opening
  function arcDist(x, y) {
    const dx = x - S / 2, dy = y - S / 2;
    if (Math.abs(Math.atan2(dy, dx)) > GAP_HALF) return Math.abs(Math.hypot(dx, dy) - C_R);
    const ex = S / 2 + C_R * Math.cos(GAP_HALF), ey = C_R * Math.sin(GAP_HALF);
    return Math.min(Math.hypot(x - ex, y - (S / 2 + ey)), Math.hypot(x - ex, y - (S / 2 - ey)));
  }

  // Heartbeat trace through the C's opening (1024-grid coordinates).
  const PTS = [[300, 512], [430, 512], [488, 368], [560, 650], [618, 512], [790, 512]]
    .map(([x, y]) => [x * f, y * f]);
  function segDist(px, py, [ax, ay], [bx, by]) {
    const vx = bx - ax, vy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  }
  function pulseDist(x, y) {
    let d = Infinity;
    for (let i = 0; i < PTS.length - 1; i++) d = Math.min(d, segDist(x, y, PTS[i], PTS[i + 1]));
    return d;
  }

  // Stroke + glow intensity from a distance field.
  const ink = (d, hw, glowR, glowA) =>
    Math.min(1, Math.max(0, 1 - Math.max(0, d - hw) / glowR) ** 2 * glowA +
      Math.min(1, Math.max(0, 0.5 - (d - hw) / (3 * f))));

  // --- raster ----------------------------------------------------------------
  const BG = [8, 12, 10], GREEN = [83, 252, 161];
  const px = Buffer.alloc(S * S * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const plate = plateDist(x + 0.5, y + 0.5);
      const cover = Math.min(1, Math.max(0, 0.5 - plate / 2)); // 2px AA edge
      if (cover === 0) continue; // transparent corner
      let [r, g, b] = BG;
      const dDot = Math.hypot(x + 0.5 - 872 * f, y + 0.5 - 512 * f) - 10 * f;
      const a = Math.min(1,
        ink(arcDist(x + 0.5, y + 0.5), 54 * f, 150 * f, 0.20) +
        ink(pulseDist(x + 0.5, y + 0.5), 30 * f, 150 * f, 0.22) +
        ink(dDot, 20 * f, 100 * f, 0.5));
      r += (GREEN[0] - r) * a; g += (GREEN[1] - g) * a; b += (GREEN[2] - b) * a;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = Math.round(cover * 255);
    }
  }
  return encodePng(px, S);
}

// --- minimal PNG encoder -----------------------------------------------------
const CRC_T = new Int32Array(256).map((_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
const crc32 = (buf) => {
  let c = -1;
  for (const byte of buf) c = CRC_T[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(px, S) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO wrapper (single PNG-compressed 256px entry; Vista+) ------------------
function ico(png, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);                 // reserved
  head.writeUInt16LE(1, 2);                 // type: icon
  head.writeUInt16LE(1, 4);                 // image count
  head[6] = size === 256 ? 0 : size;        // width (0 = 256)
  head[7] = size === 256 ? 0 : size;        // height
  head.writeUInt16LE(1, 10);                // color planes
  head.writeUInt16LE(32, 12);               // bits per pixel
  head.writeUInt32LE(png.length, 14);       // payload bytes
  head.writeUInt32LE(22, 18);               // payload offset
  return Buffer.concat([head, png]);
}

const master = render(1024);
writeFileSync(new URL('./icon-master.png', import.meta.url), master);
console.log('wrote icon-master.png', master.length, 'bytes');

const png256 = render(256);
const icoBuf = ico(png256, 256);
writeFileSync(new URL('../Claudiogram.ico', import.meta.url), icoBuf);
console.log('wrote Claudiogram.ico', icoBuf.length, 'bytes');
