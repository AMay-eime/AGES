// 描くものの並び順と形。描画とクリックでの選択の両方が同じ計算を使う（見えている形どおりに選べる）。
import type { World, Entity } from '../core/world.ts';
import { findFrame, type FrameRef, type SheetDef } from '../core/sheet.ts';

export type DrawKind = 'sprite' | 'shape' | 'text' | 'particles' | 'gauge';

export interface Drawable {
  e: Entity;
  kind: DrawKind;
  layer: number;
  order: number;
  /** 同じ層・同じ順番どうしは、ワールドに入った順 */
  idx: number;
}

/** 描くものを、奥から手前の順に並べる */
export function collectDrawables(world: World, extra: Entity[] = []): Drawable[] {
  const out: Drawable[] = [];
  let idx = 0;
  for (const e of [...world.entities.values(), ...extra]) {
    if (!e.c.Transform && !e.c.UI) continue;
    for (const kind of ['sprite', 'shape', 'gauge', 'text', 'particles'] as const) {
      const c = e.c[kind === 'sprite' ? 'Sprite' : kind === 'shape' ? 'Shape' : kind === 'text' ? 'Text' : kind === 'gauge' ? 'Gauge' : 'Particles'];
      if (!c || c.visible === false) continue;
      out.push({ e, kind, layer: c.layer ?? 0, order: c.order ?? 0, idx: idx++ });
    }
  }
  return out.sort((a, b) => a.layer - b.layer || a.order - b.order || a.idx - b.idx);
}

/** 4つの角（左上・右上・右下・左下）。x0,y0,x1,y1,x2,y2,x3,y3 */
export type Corners = [number, number, number, number, number, number, number, number];

/** 大きさ・基準点・Transform（位置・回転・倍率）から4つの角を求める */
export function cornersOf(t: { x: number; y: number; rot?: number; sx?: number; sy?: number }, w: number, h: number, ax: number, ay: number): Corners {
  const sx = t.sx ?? 1, sy = t.sy ?? 1;
  const l = -ax * w * sx, r = (1 - ax) * w * sx, tp = -ay * h * sy, b = (1 - ay) * h * sy;
  const rad = ((t.rot ?? 0) * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const p = (x: number, y: number): [number, number] => [t.x + x * c - y * s, t.y + x * s + y * c];
  return [...p(l, tp), ...p(r, tp), ...p(r, b), ...p(l, b)] as Corners;
}

/** 線（物の位置から to まで、太さ width）の4つの角。to には回転・倍率がかかる。a・b（0〜1）で線の一部だけ（破線の1本） */
export function lineCorners(t: { x: number; y: number; rot?: number; sx?: number; sy?: number }, to: [number, number], width: number, a = 0, b = 1): Corners {
  const rad = ((t.rot ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const lx = to[0] * (t.sx ?? 1), ly = to[1] * (t.sy ?? 1);
  const dx = lx * c - ly * s, dy = lx * s + ly * c, len = Math.hypot(dx, dy) || 1;
  const x0 = t.x + dx * a, y0 = t.y + dy * a, x1 = t.x + dx * b, y1 = t.y + dy * b;
  const hw = Math.max(width, 1) / 2, nx = (-dy / len) * hw, ny = (dx / len) * hw;
  return [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny];
}

/**
 * 破線: 長さ len の上で、線を引く所（len に対する 0〜1 の [始め, 終わり]）の並び。
 * on・off は線とすきまの長さ、offset だけ模様をずらす。on か off が 0 以下なら全部（実線）。多すぎるときは 1024 本まで
 */
export function dashSpans(len: number, on: number, off: number, offset = 0): [number, number][] {
  if (!(len > 0)) return [];
  if (!(on > 0) || !(off > 0)) return [[0, 1]];
  const period = on + off, out: [number, number][] = [];
  for (let p = -(((offset % period) + period) % period); p < len && out.length < 1024; p += period) {
    const a = Math.max(p, 0), b = Math.min(p + on, len);
    if (b > a) out.push([a / len, b / len]);
  }
  return out;
}

/** 四角の枠の破線（太さ stroke）。上→右→下→左とひと回りでつながる模様を、四角の中の帯（0〜1 の [x0,y0,x1,y1]）の並びで */
export function dashedBands(w: number, h: number, stroke: number, on: number, off: number, offset = 0): [number, number, number, number][] {
  if (stroke * 2 >= Math.min(w, h)) return [[0, 0, 1, 1]];
  const fx = stroke / w, fy = stroke / h, k = 1 - 2 * fy, ih = h - 2 * stroke;
  const sides: [number, (a: number, b: number) => [number, number, number, number]][] = [
    [w, (a, b) => [a, 0, b, fy]],
    [ih, (a, b) => [1 - fx, fy + k * a, 1, fy + k * b]],
    [w, (a, b) => [1 - b, 1 - fy, 1 - a, 1]],
    [ih, (a, b) => [0, 1 - fy - k * b, fx, 1 - fy - k * a]],
  ];
  const out: [number, number, number, number][] = [];
  let d = 0;
  for (const [len, band] of sides) {
    for (const [a, b] of dashSpans(len, on, off, offset + d)) out.push(band(a, b));
    d += len;
  }
  return out;
}

/** 楕円（半径 rx・ry）のまわりの長さ（近似） */
export function ellipsePerimeter(rx: number, ry: number): number {
  const h = ((rx - ry) / (rx + ry || 1)) ** 2;
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** 円・楕円の枠（幅 w・高さ h、太さ stroke）の、角度 a0〜a1（ラジアン。0 が右、時計回り）の一切れの4つの角 */
export function ringPiece(t: { x: number; y: number; rot?: number; sx?: number; sy?: number }, w: number, h: number, stroke: number, a0: number, a1: number): Corners {
  const sx = t.sx ?? 1, sy = t.sy ?? 1;
  const rad = ((t.rot ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const rx = w / 2, ry = h / 2, ix = Math.max(0, rx - stroke), iy = Math.max(0, ry - stroke);
  const pt = (px: number, py: number, a: number): [number, number] => {
    const lx = Math.cos(a) * px * sx, ly = Math.sin(a) * py * sy;
    return [t.x + lx * c - ly * s, t.y + lx * s + ly * c];
  };
  return [...pt(rx, ry, a0), ...pt(rx, ry, a1), ...pt(ix, iy, a1), ...pt(ix, iy, a0)] as Corners;
}

/** 四角の枠（太さ stroke）を、四角の中の4つの帯（0〜1 の範囲 [x0,y0,x1,y1]）にする。太すぎるときは塗りつぶしと同じ1枚 */
export function strokeBands(w: number, h: number, stroke: number): [number, number, number, number][] {
  if (stroke * 2 >= Math.min(w, h)) return [[0, 0, 1, 1]];
  const fx = stroke / w, fy = stroke / h;
  return [[0, 0, 1, fy], [0, 1 - fy, 1, 1], [0, fy, fx, 1 - fy], [1 - fx, fy, 1, 1 - fy]];
}

/**
 * 敷き詰め: 長さ len を、1枚の大きさ size の絵で埋める（off だけ絵をずらす）。はみ出す1枚は切る。
 * 返すのは [置く所の始め, 終わり（len に対する 0〜1）, 絵の中の始め, 終わり（1枚に対する 0〜1）] の並び（多すぎるときは 512 枚まで）
 */
export function tileSpans(len: number, size: number, off: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (!(len > 0) || !(size > 0)) return out;
  for (let p = -(((off % size) + size) % size); p < len && out.length < 512; p += size) {
    const a = Math.max(p, 0), b = Math.min(p + size, len);
    if (b > a) out.push([a / len, b / len, (a - p) / size, (b - p) / size]);
  }
  return out;
}

/** 点が4つの角の中にあるか（回転していても正しく判定する） */
export function pointInCorners(px: number, py: number, q: Corners): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const x1 = q[i * 2], y1 = q[i * 2 + 1], x2 = q[((i + 1) % 4) * 2], y2 = q[((i + 1) % 4) * 2 + 1];
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
    if (cross !== 0) {
      const s = Math.sign(cross);
      if (sign && s !== sign) return false;
      sign = s;
    }
  }
  return true;
}

/** スプライトの描き方（画像のどこを・どの大きさで・どこを基準に）。描画と検証が同じ計算を使う */
export interface SpriteGeometry {
  w: number;
  h: number;
  ax: number;
  ay: number;
  /** 画像の中の範囲(px) */
  src: { x: number; y: number; w: number; h: number };
}

export function spriteGeometry(
  s: { frame?: FrameRef; size?: [number, number]; anchor?: [number, number] },
  sheet: SheetDef | undefined,
  imageW: number,
  imageH: number,
): SpriteGeometry | null {
  let src = { x: 0, y: 0, w: imageW, h: imageH };
  let pivot: [number, number] | undefined;
  if (sheet) {
    const f = findFrame(sheet, imageW, imageH, s.frame ?? 0);
    if (!f) return null;
    src = { x: f.x, y: f.y, w: f.w, h: f.h };
    pivot = f.pivot;
  }
  const w = s.size?.[0] && s.size[0] > 0 ? s.size[0] : src.w;
  const h = s.size?.[1] && s.size[1] > 0 ? s.size[1] : src.h;
  const [ax, ay] = pivot ?? s.anchor ?? [0.5, 0.5];
  return { w, h, ax, ay, src };
}
