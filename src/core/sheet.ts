// スプライトシート。画像の隣に置く「<画像名>.sheet.json」で、画像のどこを1コマとして使うかを決める。
// 例: assets/ships.png の隣に assets/ships.sheet.json
//
// 格子（同じ大きさのコマが並んでいる画像）:
//   { "frame": [32, 32], "clips": { "explode": { "frames": [4, 5, 6, 7, 8], "fps": 15, "loop": false } } }
// 自由な矩形（大きさも位置もばらばらな画像。Unity のスプライトエディタと同じ考え方）:
//   { "frames": [ { "name": "hero_idle", "rect": [0, 0, 24, 32], "pivot": [0.5, 1] }, ... ],
//     "clips": { "walk": { "frames": ["hero_walk1", "hero_walk2"], "fps": 8 } } }
//
// コマは番号（0から）でも名前でも指定できる。名前で指定すると、切り直してもずれない。

/** コマの指定。番号（0から）か名前 */
export type FrameRef = number | string;

export interface FrameDef {
  /** コマの名前（シートの中で重ならない。数字だけの名前は番号と紛らわしいので使えない） */
  name: string;
  /** 画像の中の位置と大きさ [x, y, 幅, 高さ](px) */
  rect: [number, number, number, number];
  /** 基準点（コマの中の割合。[0.5, 0.5]=中央、[0.5, 1]=下の中央）。あれば Sprite.anchor より優先 */
  pivot?: [number, number];
}

export interface ClipDef {
  /** コマの並び（番号か名前） */
  frames: FrameRef[];
  /** 1秒あたりのコマ数 */
  fps: number;
  /** 最後まで行ったら最初に戻るか（既定 true） */
  loop?: boolean;
}

export interface SheetDef {
  /** 格子: 1コマの大きさ [幅, 高さ](px) */
  frame?: [number, number];
  /** 格子: コマとコマの間の隙間(px) */
  spacing?: number;
  /** 格子: 画像の端の余白(px) */
  margin?: number;
  /** 自由な矩形。あれば格子の指定は使わない */
  frames?: FrameDef[];
  clips?: Record<string, ClipDef>;
}

/** 位置まで決まったコマ */
export interface Frame {
  index: number;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pivot?: [number, number];
}

/** 画像の場所から、シートの定義ファイルの場所を求める */
export function sheetPathOf(image: string): string {
  return image.replace(/\.[^./]+$/, '') + '.sheet.json';
}

export function isGrid(sheet: SheetDef): boolean {
  return !sheet.frames && Array.isArray(sheet.frame);
}

export function columnsOf(sheet: SheetDef, imageW: number): number {
  if (!sheet.frame) return 1;
  const s = sheet.spacing ?? 0, m = sheet.margin ?? 0;
  return Math.max(1, Math.floor((imageW - 2 * m + s) / (sheet.frame[0] + s)));
}

function rowsOf(sheet: SheetDef, imageH: number): number {
  if (!sheet.frame) return 1;
  const s = sheet.spacing ?? 0, m = sheet.margin ?? 0;
  return Math.max(1, Math.floor((imageH - 2 * m + s) / (sheet.frame[1] + s)));
}

export function frameCount(sheet: SheetDef, imageW: number, imageH: number): number {
  if (sheet.frames) return sheet.frames.length;
  if (!sheet.frame) return 0;
  return columnsOf(sheet, imageW) * rowsOf(sheet, imageH);
}

/** 番号のコマ。範囲外なら null */
export function frameAt(sheet: SheetDef, imageW: number, imageH: number, index: number): Frame | null {
  if (!Number.isInteger(index) || index < 0) return null;
  if (sheet.frames) {
    const f = sheet.frames[index];
    if (!f) return null;
    const [x, y, w, h] = f.rect;
    return { index, name: f.name, x, y, w, h, pivot: f.pivot };
  }
  if (!sheet.frame || index >= frameCount(sheet, imageW, imageH)) return null;
  const s = sheet.spacing ?? 0, m = sheet.margin ?? 0;
  const cols = columnsOf(sheet, imageW);
  const [fw, fh] = sheet.frame;
  return { index, x: m + (index % cols) * (fw + s), y: m + Math.floor(index / cols) * (fh + s), w: fw, h: fh };
}

/** 番号か名前でコマを探す。見つからなければ null */
export function findFrame(sheet: SheetDef, imageW: number, imageH: number, ref: FrameRef): Frame | null {
  if (typeof ref === 'number') return frameAt(sheet, imageW, imageH, ref);
  const i = sheet.frames?.findIndex((f) => f.name === ref) ?? -1;
  return i >= 0 ? frameAt(sheet, imageW, imageH, i) : null;
}

/** すべてのコマ */
export function listFrames(sheet: SheetDef, imageW: number, imageH: number): Frame[] {
  const n = frameCount(sheet, imageW, imageH);
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) out.push(frameAt(sheet, imageW, imageH, i)!);
  return out;
}

/** 人とAIに見せるコマの呼び名 */
export function frameLabel(f: { index: number; name?: string }): string {
  return f.name ? `${f.name}(#${f.index})` : `#${f.index}`;
}

/** 格子のシートを、同じ並びの自由な矩形に書き換える（名前は「画像名_番号」）。番号での指定はそのまま使える */
export function toExplicit(sheet: SheetDef, imageW: number, imageH: number, base: string): SheetDef {
  if (sheet.frames) return structuredClone(sheet);
  const frames = listFrames(sheet, imageW, imageH).map((f) => ({ name: `${base}_${f.index}`, rect: [f.x, f.y, f.w, f.h] as FrameDef['rect'] }));
  const out: SheetDef = { frames };
  if (sheet.clips) out.clips = structuredClone(sheet.clips);
  return out;
}

/** 画像の名前（拡張子なし）。コマの名前の頭に使う */
export function baseNameOf(image: string): string {
  return (image.split('/').pop() ?? image).replace(/\.[^.]+$/, '');
}

const isInt = (n: unknown): n is number => Number.isInteger(n);

/** シートの定義を検証する（画像の大きさがなくても分かる問題）。問題の一覧を返す */
export function checkSheet(path: string, sheet: SheetDef): string[] {
  const errs: string[] = [];
  if (!sheet || typeof sheet !== 'object') return [`${path}: シートの定義はオブジェクトが必要です`];
  if (sheet.frames && sheet.frame) errs.push(`${path}: frame（格子）と frames（自由な矩形）は片方だけにしてください`);
  if (!sheet.frames && !sheet.frame) errs.push(`${path}: frame（格子の1コマの大きさ）か frames（自由な矩形の並び）が必要です。例: "frame": [32, 32]`);
  if (sheet.frame && (!Array.isArray(sheet.frame) || sheet.frame.length !== 2 || !sheet.frame.every((n) => isInt(n) && n > 0))) {
    errs.push(`${path}: frame は [幅, 高さ] の正の整数が必要です。例: "frame": [32, 32]`);
  }
  const names = new Set<string>();
  if (sheet.frames !== undefined) {
    if (!Array.isArray(sheet.frames)) errs.push(`${path}: frames は並び（配列）が必要です`);
    else sheet.frames.forEach((f, i) => {
      const at = `${path}: frames[${i}]`;
      if (typeof f?.name !== 'string' || !f.name) errs.push(`${at} に名前（name）がありません`);
      else if (/^\d+$/.test(f.name)) errs.push(`${at}.name="${f.name}": 数字だけの名前は番号と紛らわしいので使えません`);
      else if (names.has(f.name)) errs.push(`${at}.name="${f.name}" が重複しています`);
      else names.add(f.name);
      if (!Array.isArray(f?.rect) || f.rect.length !== 4 || !f.rect.every(isInt) || f.rect[0] < 0 || f.rect[1] < 0 || f.rect[2] <= 0 || f.rect[3] <= 0) {
        errs.push(`${at}.rect は [x, y, 幅, 高さ] の整数（幅・高さは1以上）が必要です`);
      }
      if (f?.pivot !== undefined && (!Array.isArray(f.pivot) || f.pivot.length !== 2 || !f.pivot.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
        errs.push(`${at}.pivot は [横, 縦] の数（0〜1が目安。[0.5, 1]=下の中央）が必要です`);
      }
    });
  }
  for (const [name, c] of Object.entries(sheet.clips ?? {})) {
    if (!Array.isArray(c?.frames) || !c.frames.length) { errs.push(`${path}: clips.${name}.frames はコマ（番号か名前）の並びが必要です`); continue; }
    for (const r of c.frames) {
      if (typeof r === 'number') { if (!isInt(r) || r < 0) errs.push(`${path}: clips.${name}.frames の ${r} は0以上の整数が必要です`); }
      else if (typeof r !== 'string') errs.push(`${path}: clips.${name}.frames の要素は番号か名前が必要です`);
      else if (!sheet.frames) errs.push(`${path}: clips.${name}.frames の "${r}": 格子のシートではコマを番号で指定します`);
      else if (!names.has(r)) errs.push(`${path}: clips.${name}.frames の "${r}" というコマはありません`);
    }
    if (typeof c.fps !== 'number' || c.fps <= 0) errs.push(`${path}: clips.${name}.fps は正の数が必要です`);
  }
  return errs;
}

/** 画像の大きさが分かったうえでの検証（画像からはみ出す矩形・範囲外の番号） */
export function checkSheetImage(path: string, sheet: SheetDef, imageW: number, imageH: number): string[] {
  const errs: string[] = [];
  sheet.frames?.forEach((f, i) => {
    if (!Array.isArray(f.rect)) return;
    const [x, y, w, h] = f.rect;
    if (x + w > imageW || y + h > imageH) errs.push(`${path}: ${f.name ?? `frames[${i}]`} の矩形 [${f.rect.join(', ')}] が画像（${imageW}x${imageH}）からはみ出しています`);
  });
  const n = frameCount(sheet, imageW, imageH);
  for (const [name, c] of Object.entries(sheet.clips ?? {})) {
    for (const r of c.frames ?? []) if (typeof r === 'number' && r >= n) errs.push(`${path}: clips.${name}.frames の ${r} は範囲外です（${n} コマ、0から数えます）`);
  }
  return errs;
}
