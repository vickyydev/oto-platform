// Generated colour bars as a y4m file for Chromium's file-fed fake camera (nobody's picture).
import { writeFileSync } from 'node:fs';
const W = 640, H = 480, frames = 4;
const bars = [[235,128,128],[210,16,146],[170,166,16],[145,54,34],[106,202,222],[81,90,240],[41,240,110],[16,128,128]]; // Y,U,V
const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
const parts = [header];
for (let f = 0; f < frames; f++) {
  const Y = Buffer.alloc(W * H), U = Buffer.alloc(W * H / 4), V = Buffer.alloc(W * H / 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const b = bars[Math.floor(((x + f * 8) % W) / (W / 8))]; Y[y * W + x] = b[0]; }
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) { const b = bars[Math.floor(((x * 2 + f * 8) % W) / (W / 8))]; U[y * W / 2 + x] = b[1]; V[y * W / 2 + x] = b[2]; }
  parts.push(Buffer.from('FRAME\n'), Y, U, V);
}
writeFileSync(process.argv[2], Buffer.concat(parts));
