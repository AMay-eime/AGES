// UI（画面に固定する物）。置き方（画面や親のどこに合わせるか）・並べ方・ボタン・ゲージの操作。
// 位置はすべて設計の大きさ（ctx.view）で数えるので、どの画面でも、画面なしの実行でも同じ結果になる。
// 描く側もこの計算を使うので、エディタで止めているときも、動かしているときと同じ所に見える。
import type { World, Entity } from './world.ts';
import type { Input } from './input.ts';

export const ANCHORS = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'] as const;
export type Anchor = (typeof ANCHORS)[number];

/** 合わせる所の割合（0=左・上、0.5=中央、1=右・下） */
export function anchorOf(a: string): [number, number] {
  const i = Math.max(0, ANCHORS.indexOf(a as Anchor));
  return [(i % 3) / 2, Math.floor(i / 3) / 2];
}

export interface UiRect {
  /** 左上（設計の大きさで数えた画面の座標） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 自分も親も見えている */
  visible: boolean;
  /** 親の ID（なければ null） */
  parent: string | null;
}

/** 隣に付ける向き */
export const SIDES = ['right', 'left', 'below', 'above'] as const;

/**
 * UI の付いた物の四角を求める。置き方は3通り:
 * - 親（parent）に Layout があれば、その並びの中（anchor・beside は使わない）
 * - beside があれば、その UI の隣に接して（side の向き、gap の間、align で揃える）。相手が動けば一緒に動く
 * - それ以外は、親（なければ画面）の anchor の所
 * x・y はどの置き方でも最後に足すずれ
 */
export function layoutUI(world: World, viewW: number, viewH: number): Map<string, UiRect> {
  const ui = [...world.entities.values()].filter((e) => e.c.UI);
  const byId = new Map(ui.map((e) => [e.id, e]));
  const kids = new Map<string, Entity[]>();
  for (const e of ui) {
    const p = e.c.UI.parent;
    if (p && byId.has(p) && p !== e.id) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(e);
    }
  }
  const screen: UiRect = { x: 0, y: 0, w: viewW, h: viewH, visible: true, parent: null };
  const out = new Map<string, UiRect>();
  const busy = new Set<string>();
  const slots = new Map<string, Map<string, [number, number]>>();

  /** Layout の子の並び（親の左上からの位置） */
  const slotsOf = (parent: Entity, r: UiRect): Map<string, [number, number]> => {
    let m = slots.get(parent.id);
    if (m) return m;
    m = new Map();
    const lay = parent.c.Layout;
    const pad = lay.padding ?? 0, gap = lay.gap ?? 0, horiz = lay.dir === 'horizontal';
    const shown = (kids.get(parent.id) ?? []).filter((k) => k.c.UI.visible !== false).sort((a, b) => (a.c.UI.order ?? 0) - (b.c.UI.order ?? 0));
    const total = shown.reduce((s, k) => s + (horiz ? k.c.UI.w : k.c.UI.h), 0) + gap * Math.max(0, shown.length - 1);
    const inner = horiz ? r.w - pad * 2 : r.h - pad * 2;
    let at = pad + (lay.justify === 'center' ? (inner - total) / 2 : lay.justify === 'end' ? inner - total : 0);
    for (const k of shown) {
      const kw = k.c.UI.w ?? 0, kh = k.c.UI.h ?? 0;
      const cross = horiz ? r.h - pad * 2 - kh : r.w - pad * 2 - kw;
      const off = pad + (lay.align === 'start' ? 0 : lay.align === 'end' ? cross : cross / 2);
      m.set(k.id, horiz ? [at, off] : [off, at]);
      at += (horiz ? kw : kh) + gap;
    }
    slots.set(parent.id, m);
    return m;
  };

  const rectOf = (e: Entity): UiRect => {
    const done = out.get(e.id);
    if (done) return done;
    const u = e.c.UI;
    const w = Math.max(0, u.w ?? 0), h = Math.max(0, u.h ?? 0);
    // 輪になっていたら画面に置く
    const cyc = busy.has(e.id);
    busy.add(e.id);
    const pe = !cyc && u.parent && u.parent !== e.id ? byId.get(u.parent) : undefined;
    const pr = pe ? rectOf(pe) : screen;
    let x: number, y: number, visible = pr.visible && u.visible !== false;
    const be = !cyc && u.beside && u.beside !== e.id ? byId.get(u.beside) : undefined;
    if (pe?.c.Layout) {
      const at = slotsOf(pe, pr).get(e.id);
      if (!at) visible = false; // 隠れている子
      x = pr.x + (at?.[0] ?? 0);
      y = pr.y + (at?.[1] ?? 0);
    } else if (be) {
      const o = rectOf(be);
      const gap = u.gap ?? 0;
      const k = u.align === 'center' ? 0.5 : u.align === 'end' ? 1 : 0;
      if (u.side === 'left' || u.side === 'right') {
        x = u.side === 'left' ? o.x - gap - w : o.x + o.w + gap;
        y = o.y + (o.h - h) * k;
      } else {
        y = u.side === 'above' ? o.y - gap - h : o.y + o.h + gap;
        x = o.x + (o.w - w) * k;
      }
    } else {
      const [ax, ay] = anchorOf(u.anchor);
      x = pr.x + ax * pr.w - ax * w;
      y = pr.y + ay * pr.h - ay * h;
    }
    const r: UiRect = { x: x + (u.x ?? 0), y: y + (u.y ?? 0), w, h, visible, parent: pe ? pe.id : null };
    busy.delete(e.id);
    out.set(e.id, r);
    return r;
  };
  for (const e of ui) rectOf(e);
  return out;
}

/** 隣に付けた相手（beside）をたどると自分に戻るか */
export function besideLoop(get: (id: string) => Record<string, unknown> | undefined, id: string): boolean {
  const seen = new Set<string>();
  for (let cur = get(id)?.beside as string | null | undefined; cur; cur = get(cur)?.beside as string | null | undefined) {
    if (cur === id) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
  }
  return false;
}

/** 描く順（奥から手前）の比べ方に使う値。層 → 順番 → ワールドに入った順 */
function depthOf(e: Entity): [number, number] {
  const c = e.c.Sprite ?? e.c.Shape ?? e.c.Gauge ?? e.c.Text;
  return [c?.layer ?? 0, c?.order ?? 0];
}

/** 押せる物（ボタン・動かせるゲージ） */
const interactive = (e: Entity) => (e.c.Button && e.c.Button.enabled !== false) || (e.c.Gauge && e.c.Gauge.drag);

/** UI の操作の記録（フレームで数える。保存・hash に入る） */
export interface UiSnapshot {
  focus: string | null;
  pressed: string | null;
  down: boolean;
}

const NAV: Record<string, { action: string; keys: string[] }> = {
  up: { action: 'ui_up', keys: ['ArrowUp', 'Pad.Up'] },
  down: { action: 'ui_down', keys: ['ArrowDown', 'Pad.Down'] },
  left: { action: 'ui_left', keys: ['ArrowLeft', 'Pad.Left'] },
  right: { action: 'ui_right', keys: ['ArrowRight', 'Pad.Right'] },
  confirm: { action: 'ui_confirm', keys: ['Enter', 'Space', 'Pad.A'] },
  cancel: { action: 'ui_cancel', keys: ['Escape', 'Pad.B'] },
};

export class UiState {
  focus: string | null = null;
  pressed: string | null = null;
  /** マウス・タッチが押されていたか（前のフレーム。UI が受け取った押し下げはゲームに渡さないので、自分で覚える） */
  down = false;
  /** このフレームに押されたボタン */
  clicked = new Set<string>();
  /** このフレームに値が変わったゲージ */
  changed = new Set<string>();
  /** このフレームに「戻る」が押された（ui_cancel） */
  cancelled = false;
  rects = new Map<string, UiRect>();
  /** マウス・タッチが UI の上にある */
  over = false;
  hover: string | null = null;

  /** フレームの頭（ゲームのシステムより前）に呼ぶ。UI が受け取った押し下げは、ゲームの入力から外す */
  update(world: World, input: Input, viewW: number, viewH: number): void {
    this.clicked.clear();
    this.changed.clear();
    this.cancelled = false;
    this.rects = layoutUI(world, viewW, viewH);
    if (!this.rects.size) { this.focus = this.pressed = this.hover = null; this.down = false; this.over = false; return; }
    const idx = new Map([...world.entities.keys()].map((k, i) => [k, i]));
    const ents = [...this.rects.keys()].map((id) => world.get(id)!).filter(Boolean);
    // 位置を Transform に書く（ゲームのコードから読めるように。中心）
    for (const e of ents) {
      const r = this.rects.get(e.id)!;
      if (e.c.Transform) { e.c.Transform.x = r.x + r.w / 2; e.c.Transform.y = r.y + r.h / 2; }
    }
    const shown = ents.filter((e) => this.rects.get(e.id)!.visible);
    // 手前から順に（同じ層なら後から入った物が手前）
    const front = [...shown].sort((a, b) => {
      const [la, oa] = depthOf(a), [lb, ob] = depthOf(b);
      return lb - la || ob - oa || idx.get(b.id)! - idx.get(a.id)!;
    });
    // 出ているダイアログ（modal）があれば、その中の物だけ押せる
    const modal = front.find((e) => e.c.UI.modal);
    const inside = (e: Entity): boolean => {
      if (!modal) return true;
      for (let id: string | null = e.id; id; id = this.rects.get(id)?.parent ?? null) if (id === modal.id) return true;
      return false;
    };
    const usable = front.filter((e) => interactive(e) && inside(e));
    const hit = (e: Entity, x: number, y: number) => {
      const r = this.rects.get(e.id)!, t = e.c.Transform;
      const sx = Math.abs(t?.sx ?? 1), sy = Math.abs(t?.sy ?? 1);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      return Math.abs(x - cx) <= (r.w * sx) / 2 && Math.abs(y - cy) <= (r.h * sy) / 2;
    };
    const p = input.pointer;
    const downNow = input.isDown('Mouse0') || input.isDown('Touch');
    const pressedNow = downNow && !this.down, releasedNow = !downNow && this.down;
    this.down = downNow;
    this.hover = p ? usable.find((e) => hit(e, p.x, p.y))?.id ?? null : null;
    this.over = !!p && (!!modal || front.some((e) => e.c.UI.block !== false && hit(e, p.x, p.y)));
    if (this.focus && !usable.some((e) => e.id === this.focus)) this.focus = null;
    if (this.pressed && !usable.some((e) => e.id === this.pressed)) this.pressed = null;

    // マウス・タッチ
    let captured = false;
    if (pressedNow && p) {
      if (this.hover) { this.pressed = this.focus = this.hover; captured = true; } else if (this.over) captured = true;
    }
    if (this.pressed) {
      captured = true;
      const e = world.get(this.pressed)!;
      if (e.c.Gauge?.drag && p && downNow) this.setGauge(e, this.fromPointer(e, p.x, p.y));
      if (releasedNow) {
        if (e.c.Button && this.hover === this.pressed) this.clicked.add(this.pressed);
        this.pressed = null;
      }
    }
    // UI が受け取った押し下げは、ゲームには渡さない（ボタンを押したら弾も出る、を防ぐ）
    if (captured || (this.over && downNow)) input.mask(['Mouse0', 'Touch']);

    // キーボード・ゲームパッド（操作 ui_up などがなければ、矢印・Enter・Pad.A）
    const nav = (k: keyof typeof NAV) => {
      const n = NAV[k];
      return input.has(n.action) ? input.pressed(n.action) : n.keys.some((b) => input.pressed(b));
    };
    if (nav('cancel')) this.cancelled = true;
    const dirs: [keyof typeof NAV, number, number][] = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]];
    for (const [k, dx, dy] of dirs) {
      if (!nav(k)) continue;
      const cur = this.focus ? world.get(this.focus) : undefined;
      // 動かせるゲージに合わせているときは、左右で値を変える
      if (cur?.c.Gauge?.drag && dx) { this.setGauge(cur, (cur.c.Gauge.value ?? 0) + dx * (cur.c.Gauge.step || (cur.c.Gauge.max ?? 1) / 10)); continue; }
      this.focus = cur ? this.nearest(cur, usable, dx, dy) ?? this.focus : this.first(usable);
    }
    if (this.focus && nav('confirm') && world.get(this.focus)?.c.Button) this.clicked.add(this.focus);

    // ボタンの見た目の状態（描く側が色を変える）
    for (const e of ents) {
      const b = e.c.Button;
      if (!b) continue;
      b.state = b.enabled === false ? 'disabled' : this.pressed === e.id && this.hover === e.id ? 'pressed' : this.hover === e.id ? 'hover' : this.focus === e.id ? 'focus' : 'normal';
    }
  }

  private fromPointer(e: Entity, x: number, y: number): number {
    const r = this.rects.get(e.id)!, g = e.c.Gauge;
    const max = g.max ?? 1;
    const k = g.dir === 'rightToLeft' ? (r.x + r.w - x) / r.w : g.dir === 'bottomToTop' ? (r.y + r.h - y) / r.h : g.dir === 'topToBottom' ? (y - r.y) / r.h : (x - r.x) / r.w;
    return k * max;
  }

  private setGauge(e: Entity, v: number): void {
    const g = e.c.Gauge;
    const max = g.max ?? 1;
    let nv = Math.max(0, Math.min(max, v));
    if (g.step > 0) nv = Math.round(nv / g.step) * g.step;
    nv = Math.round(nv * 1e6) / 1e6;
    if (nv !== g.value) { g.value = nv; this.changed.add(e.id); }
  }

  /** 最初に合わせる物（左上に近い物） */
  private first(list: Entity[]): string | null {
    let best: Entity | null = null, score = Infinity;
    for (const e of list) {
      const r = this.rects.get(e.id)!;
      const s = r.y * 4 + r.x;
      if (s < score) { score = s; best = e; }
    }
    return best?.id ?? null;
  }

  /** その向きにある、いちばん近い物 */
  private nearest(from: Entity, list: Entity[], dx: number, dy: number): string | null {
    const a = this.rects.get(from.id)!;
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    let best: string | null = null, score = Infinity;
    for (const e of list) {
      if (e.id === from.id) continue;
      const r = this.rects.get(e.id)!;
      const vx = r.x + r.w / 2 - ax, vy = r.y + r.h / 2 - ay;
      const along = vx * dx + vy * dy;
      if (along <= 0.5) continue;
      const side = Math.abs(vx * dy - vy * dx);
      const s = along + side * 2;
      if (s < score) { score = s; best = e.id; }
    }
    return best;
  }

  snapshot(): UiSnapshot {
    return { focus: this.focus, pressed: this.pressed, down: this.down };
  }
}
