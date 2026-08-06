// 生成 Venture 托盘图标（32x32 RGBA PNG）并打印 dataURL，供 electron/main.cjs 内嵌使用。
// 用法: node scripts/gen-tray-icon.cjs
const zlib = require('node:zlib');

const SIZE = 32;

function insideRoundedRect(x, y, radius) {
  const minX = radius, maxX = SIZE - 1 - radius;
  const minY = radius, maxY = SIZE - 1 - radius;
  const cx = Math.min(Math.max(x, minX), maxX);
  const cy = Math.min(Math.max(y, minY), maxY);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// 点到线段距离
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : (apx * abx + apy * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function pixelColor(x, y) {
  // 圆角方块背景：深蓝 → 靛蓝 渐变
  if (!insideRoundedRect(x, y, 8)) return [0, 0, 0, 0];
  const t = (x + y) / (2 * (SIZE - 1));
  const r = Math.round(59 + (99 - 59) * t);
  const g = Math.round(130 + (102 - 130) * t);
  const b = Math.round(246 + (241 - 246) * t);
  // 白色 V 字（两条线段，粗约 3.2px）
  const V_LEFT = [7.5, 9.5, 16, 23];
  const V_RIGHT = [16, 23, 24.5, 9.5];
  const dLeft = distToSegment(x + 0.5, y + 0.5, ...V_LEFT);
  const dRight = distToSegment(x + 0.5, y + 0.5, ...V_RIGHT);
  if (dLeft <= 3.2 || dRight <= 3.2) return [255, 255, 255, 255];
  return [r, g, b, 255];
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixelColor(x, y);
    const off = rowStart + 1 + x * 4;
    raw[off] = r;
    raw[off + 1] = g;
    raw[off + 2] = b;
    raw[off + 3] = a;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

console.log('data:image/png;base64,' + png.toString('base64'));
