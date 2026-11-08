// 画像の切り出しの計算。Unity のスプライトエディタの「Slice」と同じ3通り（大きさの格子・数の格子・自動）。
// ブラウザ（エディタの「切り方」画面）でも Node（ages slice）でも同じ計算を使う。
import { listFrames, type ClipDef, type FrameDef, type FrameRef, type SheetDef } from './sheet.ts';

/** RGBA の画素（1画素4バイト） */
export interface Pixels {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray;
}

export type Rect = [number, number, number, number];

export interface GridOptions {
  /** 1コマの大きさ [幅, 高さ]（cell か count のどちらか） */
  cell?: [number, number];
  /** 横・縦のコマの数 [列, 行] */
  count?: [number, number];
  spacing?: number;
  margin?: number;
  /** 何も描かれていないコマを除く（画素が必要） */
  skipEmpty?: boolean;
}

export interface AutoOptions {
  /** この不透明度（0〜255）以上を「描かれている」とする。既定 1 */
  alpha?: number;
  /** これより小さいもの（幅も高さも）は捨てる(px)。既定 2（点のごみを拾わない） */
  minSize?: number;
  /** これ以下の距離(px)で離れている部分は1つにまとめる。既定 0（爆発の粒など、離れた部品を1コマにしたいときに増やす） */
  gap?: number;
  /** 見つけた矩形を外側に広げる(px)。既定 0 */
  pad?: number;
}

/** 格子で切る */
export function gridRects(w: number, h: number, o: GridOptions, px?: Pixels): Rect[] {
  const s = o.spacing ?? 0, m = o.margin ?? 0;
  let cw: number, ch: number, cols: number, rows: number;
  if (o.count) {
    [cols, rows] = o.count;
    if (!(cols > 0 && rows > 0)) throw new Error('コマの数は1以上が必要です');
    cw = Math.floor((w - 2 * m - (cols - 1) * s) / cols);
    ch = Math.floor((h - 2 * m - (rows - 1) * s) / rows);
  } else if (o.cell) {
    [cw, ch] = o.cell;
    if (!(cw > 0 && ch > 0)) throw new Error('コマの大きさは1以上が必要です');
    cols = Math.max(0, Math.floor((w - 2 * m + s) / (cw + s)));
    rows = Math.max(0, Math.floor((h - 2 * m + s) / (ch + s)));
  } else throw new Error('格子で切るには cell（1コマの大きさ）か count（コマの数）が必要です');
  if (cw < 1 || ch < 1) throw new Error(`コマが小さくなりすぎます（${cw}x${ch}）。数か余白を減らしてください`);
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rect: Rect = [m + c * (cw + s), m + r * (ch + s), cw, ch];
      if (o.skipEmpty && px && isEmpty(px, rect)) continue;
      out.push(rect);
    }
  }
  return out;
}

/** 「描かれている画素」の判定。透明な部分がある画像は不透明度で、ない画像は左上の色を背景とみなして判定する */
function solidTest(px: Pixels, alpha = 1): (i: number) => boolean {
  const d = px.data;
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { hasAlpha = true; break; }
  if (hasAlpha) return (i) => d[i * 4 + 3] >= alpha;
  const [r, g, b] = [d[0], d[1], d[2]];
  return (i) => Math.abs(d[i * 4] - r) + Math.abs(d[i * 4 + 1] - g) + Math.abs(d[i * 4 + 2] - b) > 24;
}

function isEmpty(px: Pixels, [x, y, w, h]: Rect): boolean {
  const solid = solidTest(px);
  for (let yy = y; yy < Math.min(px.h, y + h); yy++) for (let xx = x; xx < Math.min(px.w, x + w); xx++) if (solid(yy * px.w + xx)) return false;
  return true;
}

/** 自動で切る: 描かれている部分のかたまりごとに矩形を作り、上の行から左→右の順に並べる */
export function autoRects(px: Pixels, o: AutoOptions = {}): Rect[] {
  const { w, h } = px;
  const solid = solidTest(px, o.alpha ?? 1);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let boxes: Rect[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !solid(start)) continue;
    let top = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (!seen[j] && solid(j)) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    boxes.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1]);
  }
  boxes = mergeNear(boxes, o.gap ?? 0);
  const min = o.minSize ?? 2;
  boxes = boxes.filter(([, , bw, bh]) => bw >= min || bh >= min);
  const pad = o.pad ?? 0;
  if (pad) boxes = boxes.map(([x, y, bw, bh]) => {
    const nx = Math.max(0, x - pad), ny = Math.max(0, y - pad);
    return [nx, ny, Math.min(w, x + bw + pad) - nx, Math.min(h, y + bh + pad) - ny] as Rect;
  });
  return sortRects(boxes);
}

/** 近い（重なる・gap 以内の）矩形をまとめる */
function mergeNear(boxes: Rect[], gap: number): Rect[] {
  let list = boxes.slice();
  for (let changed = true; changed;) {
    changed = false;
    const out: Rect[] = [];
    for (const b of list) {
      const hit = out.findIndex((o) => b[0] <= o[0] + o[2] + gap && o[0] <= b[0] + b[2] + gap && b[1] <= o[1] + o[3] + gap && o[1] <= b[1] + b[3] + gap
        && (gap > 0 || overlaps(o, b)));
      if (hit < 0) { out.push(b); continue; }
      const o = out[hit];
      const x0 = Math.min(o[0], b[0]), y0 = Math.min(o[1], b[1]);
      out[hit] = [x0, y0, Math.max(o[0] + o[2], b[0] + b[2]) - x0, Math.max(o[1] + o[3], b[1] + b[3]) - y0];
      changed = true;
    }
    list = out;
  }
  return list;
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** 上の行から、行の中は左から右へ並べる（縦の中心が同じ行の範囲に入るものを同じ行とみなす） */
export function sortRects(rects: Rect[]): Rect[] {
  const byTop = rects.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const rows: { top: number; bottom: number; items: Rect[] }[] = [];
  for (const r of byTop) {
    const cy = r[1] + r[3] / 2;
    const row = rows.find((w) => cy >= w.top && cy <= w.bottom);
    if (row) { row.items.push(r); row.bottom = Math.max(row.bottom, r[1] + r[3]); }
    else rows.push({ top: r[1], bottom: r[1] + r[3], items: [r] });
  }
  return rows.flatMap((w) => w.items.sort((a, b) => a[0] - b[0]));
}

const cover = (a: Rect, b: Rect) => {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / Math.min(a[2] * a[3], b[2] * b[3]);
};

export const iou = (a: Rect, b: Rect) => {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
};

/**
 * 矩形に名前を付けてコマにする。前の切り方とほぼ同じ場所（重なり半分以上）のコマは、名前と基準点を引き継ぐ
 * （切り直しても、名前で指定しているシーンや動きが崩れない）。新しいコマは「画像名_番号」
 */
export function nameFrames(rects: Rect[], base: string, old: FrameDef[] = [], pivot?: [number, number]): FrameDef[] {
  const used = new Set<FrameDef>();
  const keep = rects.map((r) => {
    let best: FrameDef | undefined, score = 0.5;
    for (const f of old) {
      if (used.has(f)) continue;
      const v = iou(r, f.rect);
      if (v >= score) { best = f; score = v; }
    }
    if (best) used.add(best);
    return best;
  });
  const names = new Set(keep.filter(Boolean).map((f) => f!.name));
  let n = 0;
  const fresh = () => { while (names.has(`${base}_${n}`)) n++; names.add(`${base}_${n}`); return `${base}_${n}`; };
  return rects.map((rect, i) => {
    const k = keep[i];
    const f: FrameDef = { name: k?.name ?? fresh(), rect: [...rect] as Rect };
    const pv = k?.pivot ?? pivot;
    if (pv) f.pivot = [...pv] as [number, number];
    return f;
  });
}

/**
 * 切り方を変えたとき、前のコマ（番号）が新しい切り方のどのコマ（番号）になるか。無くなったコマは -1。
 * 前が自由な矩形なら名前で（renames で名前を変えたものも追う）、前が格子なら場所の重なりで対応させる。
 */
export function frameMapper(before: SheetDef, after: SheetDef, w: number, h: number, renames: Record<string, string> = {}): (i: number) => number {
  const old = listFrames(before, w, h), next = listFrames(after, w, h);
  const byName = new Map(next.filter((f) => f.name).map((f) => [f.name!, f.index]));
  const cache = new Map<number, number>();
  return (i) => {
    if (cache.has(i)) return cache.get(i)!;
    const o = old[i];
    let j = -1;
    if (o?.name && before.frames) j = byName.get(renames[o.name] ?? o.name) ?? -1;
    else if (o) {
      // 小さいほうの半分以上が重なっていれば同じコマとみなす（格子のマスの中に収まった、ぴったりの矩形も追える）
      let score = 0.5;
      for (const f of next) {
        const v = cover([o.x, o.y, o.w, o.h], [f.x, f.y, f.w, f.h]);
        if (v >= score) { score = v; j = f.index; }
      }
    }
    cache.set(i, j);
    return j;
  };
}

/** 新しい切り方でのコマの指定。番号がずれたときだけ、自由な矩形なら名前に変える（以後ずれないように） */
export function remapRef(ref: FrameRef, map: (i: number) => number, after: SheetDef): FrameRef | null {
  if (typeof ref !== 'number') return ref;
  const j = map(ref);
  if (j < 0) return null;
  if (j === ref) return ref;
  return after.frames ? after.frames[j].name : j;
}

/** 前の切り方の動きを、新しい切り方に引き継ぐ。無くなったコマを使っていた動きは missing に入る */
export function carryClips(before: SheetDef | undefined, after: SheetDef, w: number, h: number): { clips?: Record<string, ClipDef>; missing: string[] } {
  if (!before?.clips) return { missing: [] };
  const map = frameMapper(before, after, w, h);
  const names = new Set((after.frames ?? []).map((f) => f.name));
  const clips: Record<string, ClipDef> = {};
  const missing: string[] = [];
  for (const [name, c] of Object.entries(before.clips)) {
    const frames: FrameRef[] = [];
    for (const r of c.frames) {
      const n = remapRef(r, map, after);
      if (n === null || (typeof n === 'string' && !names.has(n))) missing.push(`${name} の ${typeof r === 'number' ? `#${r}` : r}`);
      else frames.push(n);
    }
    clips[name] = { ...c, frames };
  }
  return { clips, missing };
}
