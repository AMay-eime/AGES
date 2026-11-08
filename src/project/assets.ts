// アセット（画像・音・フォント）とスプライトシートの読み込み。Node 側専用。
import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ASSET_EXT, type AssetKind } from '../core/schema.ts';
import { sheetPathOf, type SheetDef } from '../core/sheet.ts';

export interface AssetInfo {
  path: string;
  kind: AssetKind;
  bytes: number;
  /** 画像の大きさ(px)。読めなかったときは undefined */
  w?: number;
  h?: number;
}

const SKIP = new Set(['.git', '.ages', 'node_modules']);

async function walk(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try { names = (await readdir(dir)).sort(); } catch { return out; }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const s = await stat(abs);
    if (s.isDirectory()) out.push(...(await walk(abs, rel)));
    else out.push(rel);
  }
  return out;
}

export function kindOf(path: string): AssetKind | null {
  const p = path.toLowerCase();
  for (const [k, exts] of Object.entries(ASSET_EXT) as [AssetKind, string[]][]) if (exts.some((e) => p.endsWith(e))) return k;
  return null;
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

async function head(path: string, n: number): Promise<Buffer> {
  const f = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await f.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

export interface AssetScan {
  assets: AssetInfo[];
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
  return { assets, sheets, issues };
}
