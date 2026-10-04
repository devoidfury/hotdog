// Regenerate the 005-vision-board fixture image (evals/series/kielbasa-1/tasks/fixture-vision/board.png):
//   bun evals/tools/gen-board.ts
// A 3x3 grid of solid color cells on a 384x384 canvas. Top-left is red,
// bottom-right is yellow; the rest are distractors. Minimal hand-rolled PNG
// writer (raw chunks + manual CRC), no dependencies.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const W = 384;
const H = 384;
const CELL = 128;

type RGB = [number, number, number];
const RED: RGB = [224, 27, 36];
const ORANGE: RGB = [243, 156, 18];
const GREEN: RGB = [39, 174, 96];
const BLUE: RGB = [41, 128, 185];
const PURPLE: RGB = [142, 68, 173];
const YELLOW: RGB = [241, 196, 15];

// grid[row][col]
const grid: RGB[][] = [
  [RED, BLUE, GREEN],
  [PURPLE, ORANGE, BLUE],
  [GREEN, PURPLE, YELLOW],
];

const pixels = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 3);
  pixels[rowStart] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const [r, g, b] = grid[Math.floor(y / CELL)]![Math.floor(x / CELL)]!;
    const p = rowStart + 1 + x * 3;
    pixels[p] = r;
    pixels[p + 1] = g;
    pixels[p + 2] = b;
  }
}

function crc32(buf: Buffer): number {
  let crc = -1;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB
// bytes 10-12: compression 0, filter 0, interlace 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = process.argv[2] ?? new URL("../series/kielbasa-1/tasks/fixture-vision/board.png", import.meta.url).pathname;
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(`wrote ${target} (${png.length} bytes)`);
