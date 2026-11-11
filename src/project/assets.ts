// アセット（画像・音・フォント）とスプライトシートの読み込み。Node 側専用。
import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetKind } from '../core/schema.ts';
import { sheetPathOf, type SheetDef } from '../core/sheet.ts';
import { kindOf } from '../core/assets.ts';
import { parseShader, type ShaderDef } from '../core/shader.ts';

export { kindOf };

export interface AssetInfo {
  path: string;
  kind: AssetKind;
  bytes: number;
  /** 画像の大きさ(px)。読めなかったときは undefined */
  w?: number;
  h?: number;
  /** 音の長さ(秒)。WAV・OGG・MP3・M4A のファイルの情報から求める */
  sec?: number;
  /** シェーダーの宣言（説明・調整できる値・中身） */
  shader?: ShaderDef;
  /** 3D のモデルの要約（大きさ m・中心・三角形の数・動きの名前。開かずに置き方を決められるように） */
  model?: { size: [number, number, number]; center: [number, number, number]; tris: number; clips: string[] };
}

const SKIP = new Set(['.git', '.ages', 'node_modules']);
/** プロジェクトの直下でだけ見ないフォルダ（dist/ は書き出しの置き場所） */
const SKIP_TOP = new Set(['dist']);

async function walk(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try { names = (await readdir(dir)).sort(); } catch { return out; }
  for (const name of names) {
    if (SKIP.has(name) || (!base && SKIP_TOP.has(name))) continue;
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const s = await stat(abs);
    if (s.isDirectory()) out.push(...(await walk(abs, rel)));
    else out.push(rel);
  }
  return out;
}

/** 画像ファイルの先頭から大きさを読む（PNG / JPEG / GIF / WebP） */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const t = b.toString('ascii', 12, 16);
    if (t === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (t === 'VP8L') { const n = b.readUInt32LE(21); return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) }; }
    if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** WAV の長さ(秒)。ファイルの先頭の情報から求める */
export function wavSeconds(b: Buffer): number | null {
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 16 <= b.length) byteRate = b.readUInt32LE(p + 16);
    if (id === 'data') return byteRate ? size / byteRate : null;
    p += 8 + size + (size & 1);
  }
  return null;
}

/**
 * OGG（Vorbis / Opus）の長さ(秒)。先頭のページから標本化の速さを、最後のページから標本の位置を読む
 * head はファイルの先頭、tail は末尾（同じでもよい）
 */
export function oggSeconds(head: Buffer, tail: Buffer): number | null {
  if (head.length < 64 || head.toString('ascii', 0, 4) !== 'OggS') return null;
  const body = 27 + head[26];
  let rate = 0, skip = 0;
  if (head.toString('ascii', body + 1, body + 7) === 'vorbis' && head[body] === 1) rate = head.readUInt32LE(body + 12);
  else if (head.toString('ascii', body, body + 8) === 'OpusHead') { rate = 48000; skip = head.readUInt16LE(body + 10); }
  if (!rate) return null;
  const last = tail.lastIndexOf('OggS');
  if (last < 0 || last + 14 > tail.length) return null;
  const granule = Number(tail.readBigInt64LE(last + 6));
  return granule > 0 ? Math.max(0, granule - skip) / rate : null;
}

const MP3_RATES = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]];
const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** MP3 の長さ(秒)。Xing/Info の情報があればコマ数から、なければ固定の速さとして大きさから */
export function mp3Seconds(head: Buffer, size: number): number | null {
  let i = 0;
  if (head.toString('ascii', 0, 3) === 'ID3' && head.length >= 10) i = 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]);
  for (; i + 4 <= head.length; i++) {
    if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (head[i + 1] >> 3) & 3, layer = (head[i + 1] >> 1) & 3;
    const br = (head[i + 2] >> 4) & 15, sr = (head[i + 2] >> 2) & 3, mono = (head[i + 3] >> 6) === 3;
    if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) continue; // Layer III だけ
    const rate = MP3_RATES[ver][sr];
    const v1 = ver === 3;
    const samples = v1 ? 1152 : 576;
    const side = v1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const x = i + 4 + side;
    const tag = head.toString('ascii', x, x + 4);
    if ((tag === 'Xing' || tag === 'Info') && x + 12 <= head.length && head.readUInt32BE(x + 4) & 1) return (head.readUInt32BE(x + 8) * samples) / rate;
    const vbri = i + 4 + 32;
    if (head.toString('ascii', vbri, vbri + 4) === 'VBRI' && vbri + 18 <= head.length) return (head.readUInt32BE(vbri + 14) * samples) / rate;
    const kbps = (v1 ? MP3_KBPS_V1 : MP3_KBPS_V2)[br];
    return ((size - i) * 8) / (kbps * 1000);
  }
  return null;
}

/** M4A（MP4）の長さ(秒)。mvhd の時間の単位と長さから */
export function m4aSeconds(...parts: Buffer[]): number | null {
  for (const b of parts) {
    const at = b.indexOf('mvhd');
    if (at < 0 || at + 32 > b.length) continue;
    const v = b[at + 4];
    if (v === 1 && at + 40 <= b.length) {
      const scale = b.readUInt32BE(at + 24);
      return scale ? Number(b.readBigUInt64BE(at + 28)) / scale : null;
    }
    const scale = b.readUInt32BE(at + 16);
    return scale ? b.readUInt32BE(at + 20) / scale : null;
  }
  return null;
}

async function head(path: string, n: number, fromEnd = false): Promise<Buffer> {
  const f = await open(path, 'r');
  try {
    const size = (await f.stat()).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await f.read(buf, 0, len, fromEnd ? size - len : 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

/** 音のファイルの長さ(秒)。読めなければ null */
export async function soundSeconds(abs: string, bytes: number): Promise<number | null> {
  const ext = abs.toLowerCase().slice(abs.lastIndexOf('.'));
  if (ext === '.wav') return wavSeconds(await head(abs, 4096));
  if (ext === '.ogg') return oggSeconds(await head(abs, 4096), await head(abs, 65536, true));
  if (ext === '.mp3') return mp3Seconds(await head(abs, 65536), bytes);
  if (ext === '.m4a') return m4aSeconds(await head(abs, 262144), await head(abs, 262144, true));
  return null;
}

export interface AssetScan {
  assets: AssetInfo[];
  /** プロジェクトの中のすべてのファイル（.git などを除く） */
  files: string[];
  /** 画像の場所 → 切り方（画像の隣の <画像名>.sheet.json） */
  sheets: Map<string, SheetDef>;
  issues: string[];
}

/** プロジェクトの中のアセットとスプライトシートをすべて読む */
export async function scanAssets(dir: string): Promise<AssetScan> {
  const files = await walk(dir);
  const assets: AssetInfo[] = [];
  const sheetFiles = new Map<string, SheetDef>();
  const issues: string[] = [];
  for (const rel of files) {
    if (rel.endsWith('.sheet.json')) {
      try {
        sheetFiles.set(rel, JSON.parse(await readFile(join(dir, rel), 'utf8')) as SheetDef);
      } catch (e) {
        issues.push(`${rel} のJSONが壊れています: ${(e as Error).message}`);
      }
      continue;
    }
    const kind = kindOf(rel);
    if (!kind) continue;
    const abs = join(dir, rel);
    const info: AssetInfo = { path: rel, kind, bytes: (await stat(abs)).size };
    if (kind === 'image') {
      // JPEG は大きさの情報が後ろの方にあることがあるので、少し多めに読む
      const size = imageSize(await head(abs, 64 * 1024));
      if (size) { info.w = size.w; info.h = size.h; }
    }
    if (kind === 'sound') {
      const sec = await soundSeconds(abs, info.bytes).catch(() => null);
      if (sec !== null && Number.isFinite(sec)) info.sec = Math.round(sec * 100) / 100;
    }
    if (kind === 'shader') info.shader = parseShader(rel, await readFile(abs, 'utf8'));
    if (kind === 'model') {
      // モデルを読むのは追加パッケージ 3d（モデルがあるときだけ読み込む）
      try {
        const { summarizeGlb } = await import('../packages/3d/gltf.ts');
        info.model = summarizeGlb(await readFile(abs));
      } catch (e) {
        issues.push(`${rel} を読めません: ${(e as Error).message}`);
      }
    }
    assets.push(info);
  }
  // 定義ファイルを、隣にある同じ名前の画像に結びつける
  const sheets = new Map<string, SheetDef>();
  const used = new Set<string>();
  for (const a of assets) {
    if (a.kind !== 'image') continue;
    const sp = sheetPathOf(a.path);
    const def = sheetFiles.get(sp);
    if (def) { sheets.set(a.path, def); used.add(sp); }
  }
  for (const sp of sheetFiles.keys()) if (!used.has(sp)) issues.push(`${sp}: 同じ名前の画像がありません（例: ${sp.replace(/\.sheet\.json$/, '.png')}）`);
  return { assets, files, sheets, issues };
}
