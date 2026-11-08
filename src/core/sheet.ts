// スプライトシート。画像の隣に置く「<画像名>.sheet.json」で、1コマの大きさと名前付きのアニメーションを決める。
// 例: assets/ships.png の隣に assets/ships.sheet.json
//   { "frame": [32, 32], "clips": { "explode": { "frames": [4, 5, 6, 7, 8], "fps": 15, "loop": false } } }

export interface ClipDef {
  /** コマ番号の並び（左上から右へ、0から数える） */
  frames: number[];
  /** 1秒あたりのコマ数 */
  fps: number;
  /** 最後まで行ったら最初に戻るか（既定 true） */
  loop?: boolean;
}

export interface SheetDef {
  /** 1コマの大きさ [幅, 高さ](px) */
  frame: [number, number];
  /** コマとコマの間の隙間(px) */
  spacing?: number;
  /** 画像の端の余白(px) */
  margin?: number;
  clips?: Record<string, ClipDef>;
}

/** 画像の場所から、シートの定義ファイルの場所を求める */
export function sheetPathOf(image: string): string {
  return image.replace(/\.[^./]+$/, '') + '.sheet.json';
}

export function columnsOf(sheet: SheetDef, imageW: number): number {
  const s = sheet.spacing ?? 0, m = sheet.margin ?? 0;
  return Math.max(1, Math.floor((imageW - 2 * m + s) / (sheet.frame[0] + s)));
}

export function frameCount(sheet: SheetDef, imageW: number, imageH: number): number {
  const s = sheet.spacing ?? 0, m = sheet.margin ?? 0;
  const rows = Math.max(1, Math.floor((imageH - 2 * m + s) / (sheet.frame[1] + s)));
  return columnsOf(sheet, imageW) * rows;
}

/** コマ番号の、画像の中での位置と大きさ(px) */
export function frameRect(sheet: SheetDef, imageW: number, index: number): { x: number; y: number; w: number; h: number } {
  const s = sheet.spacing ?? 0, m = sheet.margin ?? 0;
  const cols = columnsOf(sheet, imageW);
  const [fw, fh] = sheet.frame;
  return { x: m + (index % cols) * (fw + s), y: m + Math.floor(index / cols) * (fh + s), w: fw, h: fh };
}

/** シートの定義を検証する。問題の一覧を返す */
export function checkSheet(path: string, sheet: SheetDef): string[] {
  const errs: string[] = [];
  if (!Array.isArray(sheet.frame) || sheet.frame.length !== 2 || !sheet.frame.every((n) => Number.isInteger(n) && n > 0)) {
    errs.push(`${path}: frame は [幅, 高さ] の正の整数が必要です。例: "frame": [32, 32]`);
  }
  for (const [name, c] of Object.entries(sheet.clips ?? {})) {
    if (!Array.isArray(c.frames) || !c.frames.length || !c.frames.every((n) => Number.isInteger(n) && n >= 0)) errs.push(`${path}: clips.${name}.frames はコマ番号（0以上の整数）の並びが必要です`);
    if (typeof c.fps !== 'number' || c.fps <= 0) errs.push(`${path}: clips.${name}.fps は正の数が必要です`);
  }
  return errs;
}
