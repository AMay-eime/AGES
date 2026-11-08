// 描くものの並び順と形。描画とクリックでの選択の両方が同じ計算を使う（見えている形どおりに選べる）。
import type { World, Entity } from '../core/world.ts';
import { findFrame, type FrameRef, type SheetDef } from '../core/sheet.ts';

export type DrawKind = 'sprite' | 'shape' | 'text';

export interface Drawable {
  e: Entity;
  kind: DrawKind;
  layer: number;
  order: number;
  /** 同じ層・同じ順番どうしは、ワールドに入った順 */
  idx: number;
}

/** 描くものを、奥から手前の順に並べる */
export function collectDrawables(world: World): Drawable[] {
  const out: Drawable[] = [];
  let idx = 0;
  for (const e of world.entities.values()) {
    if (!e.c.Transform) continue;
    for (const kind of ['sprite', 'shape', 'text'] as const) {
      const c = e.c[kind === 'sprite' ? 'Sprite' : kind === 'shape' ? 'Shape' : 'Text'];
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
