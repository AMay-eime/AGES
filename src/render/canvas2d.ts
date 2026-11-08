// 2D描画（Canvas 2D）。ロジックからは独立していて、World を読むだけ。
// 対応: Transform + Shape（rect / circle）, Transform + Text
import type { World, Entity } from '../core/world.ts';

export interface RenderOptions {
  background: string;
  /** 選択中のエンティティID（枠を描く） */
  selected?: string;
}

export function renderWorld(g: CanvasRenderingContext2D, world: World, opts: RenderOptions): void {
  const { width, height } = g.canvas;
  g.save();
  g.fillStyle = opts.background;
  g.fillRect(0, 0, width, height);
  for (const e of world.entities.values()) drawEntity(g, e);
  const sel = opts.selected ? world.get(opts.selected) : undefined;
  if (sel) drawSelection(g, sel);
  g.restore();
}

function drawEntity(g: CanvasRenderingContext2D, e: Entity): void {
  const t = e.c.Transform;
  if (!t) return;
  const s = e.c.Shape;
  if (s) {
    g.save();
    g.translate(t.x, t.y);
    if (t.rot) g.rotate((t.rot * Math.PI) / 180);
    g.fillStyle = s.color;
    if (s.kind === 'circle') {
      g.beginPath();
      g.ellipse(0, 0, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
    }
    g.restore();
  }
  const tx = e.c.Text;
  if (tx && tx.text) {
    g.save();
    g.fillStyle = tx.color;
    g.font = `${tx.size}px system-ui, sans-serif`;
    g.textAlign = tx.align;
    g.textBaseline = 'middle';
    g.fillText(tx.text, t.x, t.y);
    g.restore();
  }
}

function drawSelection(g: CanvasRenderingContext2D, e: Entity): void {
  const b = bounds(e);
  if (!b) return;
  g.save();
  g.strokeStyle = '#ffb02e';
  g.lineWidth = 2;
  g.setLineDash([5, 3]);
  g.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
  g.restore();
}

/** 当たり判定・クリック選択用のおおまかな範囲 */
export function bounds(e: Entity): { x: number; y: number; w: number; h: number } | null {
  const t = e.c.Transform;
  if (!t) return null;
  if (e.c.Shape) return { x: t.x - e.c.Shape.w / 2, y: t.y - e.c.Shape.h / 2, w: e.c.Shape.w, h: e.c.Shape.h };
  if (e.c.Text) {
    const w = Math.max(20, (e.c.Text.text?.length ?? 0) * e.c.Text.size * 0.6);
    const x = e.c.Text.align === 'center' ? t.x - w / 2 : e.c.Text.align === 'right' ? t.x - w : t.x;
    return { x, y: t.y - e.c.Text.size / 2, w, h: e.c.Text.size };
  }
  return { x: t.x - 6, y: t.y - 6, w: 12, h: 12 };
}

/** 座標にあるエンティティ（後に描かれたものを優先） */
export function pick(world: World, x: number, y: number): Entity | undefined {
  const list = [...world.entities.values()].reverse();
  return list.find((e) => {
    const b = bounds(e);
    return b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  });
}
