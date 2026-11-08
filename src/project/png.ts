// PNG の読み込み（依存ゼロ。Node 側専用）。ages slice の「自動で切る」「空のコマを除く」に使う。
// ブラウザのエディタは画像をそのまま canvas で読むので、ここは通らない。
import { inflateSync } from 'node:zlib';
import type { Pixels } from '../core/slice.ts';

export function decodePng(buf: Buffer): Pixels {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG ではありません');
  let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  let palette: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!w || !h) throw new Error('PNG の大きさが読めません');
  if (interlace) throw new Error('インターレースの PNG は読めません。エディタの「切り方」画面なら使えます（または画像を保存し直してください）');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`この PNG の色の形式（${color}）は読めません`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((w * channels * depth) / 8);
  const lines = Buffer.alloc(stride * h);
  // 行ごとのフィルタを戻す
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
  }
  // RGBA 8bit にそろえる
  const out = new Uint8Array(w * h * 4);
  const sample = (line: Buffer, i: number): number => {
    if (depth === 8) return line[i];
    if (depth === 16) return line[i * 2];
    const per = 8 / depth, byte = line[Math.floor(i / per)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 && color !== 3 ? 255 / ((1 << depth) - 1) : 1;
  const tr16 = (k: number) => (trns && trns.length >= k * 2 + 2 ? trns.readUInt16BE(k * 2) : -1);
  for (let y = 0; y < h; y++) {
    const line = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (color === 3) {
        const k = sample(line, x);
        out[o] = palette?.[k * 3] ?? 0; out[o + 1] = palette?.[k * 3 + 1] ?? 0; out[o + 2] = palette?.[k * 3 + 2] ?? 0;
        out[o + 3] = trns && k < trns.length ? trns[k] : 255;
      } else if (color === 0 || color === 4) {
        const raw0 = sample(line, x * channels);
        const g = Math.round(raw0 * scale);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = color === 4 ? Math.round(sample(line, x * 2 + 1) * scale) : depth === 16 ? (line.readUInt16BE(x * 2) === tr16(0) ? 0 : 255) : raw0 === tr16(0) ? 0 : 255;
      } else {
        out[o] = sample(line, x * channels); out[o + 1] = sample(line, x * channels + 1); out[o + 2] = sample(line, x * channels + 2);
        if (color === 6) out[o + 3] = sample(line, x * 4 + 3);
        else out[o + 3] = trns && out[o] === (tr16(0) >> (depth === 16 ? 8 : 0)) && out[o + 1] === (tr16(1) >> (depth === 16 ? 8 : 0)) && out[o + 2] === (tr16(2) >> (depth === 16 ? 8 : 0)) ? 0 : 255;
      }
    }
  }
  return { w, h, data: out };
}
