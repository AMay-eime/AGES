// ゲームの画面の取っ手（ギズモ）: 移動・回転・拡大縮小（Unity の W・E・R と同じ形）。
// 取っ手の形・当たり・ドラッグの量の計算だけを置く（画面の座標で。ブラウザの物を使わないので Node でも試せる）。
// 移動はワールドの軸（格子にそろえやすい）、拡大縮小は物の向きの軸（倍率は物から見た値なので）。
// 矢印の先が値の増える向き（AGES は下向きが y の正）。

export type Tool = 'move' | 'rotate' | 'scale';
/** 取っ手: x・y は軸ごと、xy は真ん中（移動は自由に・拡大縮小は縦横そろえて）、ring は回転の輪 */
export type Handle = 'x' | 'y' | 'xy' | 'ring';
type V = [number, number];

/** 取っ手の大きさ（ページの px。拡大しても、キャンバスが縮んで見えても同じ大きさ） */
export const GIZMO = { len: 64, head: 9, box: 6, center: 7, ring: 56, hit: 7 } as const;

/** 物の画面の中心と、画面での軸の向き（単位の長さ）。move はワールドの軸、scale・rotate は物の向き */
export interface GizmoFrame {
  c: V;
  /** ワールドの x・y 軸の画面での向き（カメラが回っていれば一緒に回る） */
  wx: V; wy: V;
  /** 物の x・y 軸の画面での向き（物の回転とカメラの回転を重ねたもの） */
  ox: V; oy: V;
  /** 取っ手の大きさの倍率（描く先の px ÷ ページの px。キャンバスが縮んで見えても、取っ手は同じ大きさに見える） */
  k: number;
}

const add = (a: V, b: V, k = 1): V => [a[0] + b[0] * k, a[1] + b[1] * k];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1];
const unit = (a: V): V => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

/** 画面への写し方（toScreen）と物の画面の値（x・y・rot）から、取っ手の枠組みを作る */
export function gizmoFrame(toScreen: (x: number, y: number) => V, pose: { x: number; y: number; rot: number }, k = 1): GizmoFrame {
  const c = toScreen(pose.x, pose.y);
  const r = (pose.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return {
    c,
    wx: unit(sub(toScreen(pose.x + 1, pose.y), c)),
    wy: unit(sub(toScreen(pose.x, pose.y + 1), c)),
    ox: unit(sub(toScreen(pose.x + cos, pose.y + sin), c)),
    oy: unit(sub(toScreen(pose.x - sin, pose.y + cos), c)),
    k,
  };
}

/** 取っ手の大きさ（描く先の px） */
function sized(f: GizmoFrame): { [K in keyof typeof GIZMO]: number } {
  return { len: GIZMO.len * f.k, head: GIZMO.head * f.k, box: GIZMO.box * f.k, center: GIZMO.center * f.k, ring: GIZMO.ring * f.k, hit: GIZMO.hit * f.k };
}

/** 点と線分の距離 */
function segDist(p: V, a: V, b: V): number {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return Math.hypot(...sub(p, add(a, ab, t)));
}

/** その点にある取っ手（なければ null）。真ん中を軸より先に見る */
export function hitGizmo(tool: Tool, f: GizmoFrame, p: V): Handle | null {
  const { len, center, ring, hit, head } = sized(f);
  if (tool === 'rotate') return Math.abs(Math.hypot(...sub(p, f.c)) - ring) <= hit ? 'ring' : null;
  if (Math.abs(p[0] - f.c[0]) <= center + 2 && Math.abs(p[1] - f.c[1]) <= center + 2) return 'xy';
  const [ax, ay] = tool === 'move' ? [f.wx, f.wy] : [f.ox, f.oy];
  const dx = segDist(p, add(f.c, ax, center), add(f.c, ax, len + head));
  const dy = segDist(p, add(f.c, ay, center), add(f.c, ay, len + head));
  if (Math.min(dx, dy) > hit) return null;
  return dx <= dy ? 'x' : 'y';
}

/** 移動: ワールドでの動き（軸の取っ手なら、その軸だけ） */
export function moveDelta(h: Handle, dx: number, dy: number): V {
  return h === 'x' ? [dx, 0] : h === 'y' ? [0, dy] : [dx, dy];
}

/** 回転: 真ん中から見た、押した所から今の所までの角度（度。時計回りが正。-180〜180） */
export function rotateDelta(f: GizmoFrame, start: V, now: V): number {
  const a0 = Math.atan2(start[1] - f.c[1], start[0] - f.c[0]);
  const a1 = Math.atan2(now[1] - f.c[1], now[0] - f.c[0]);
  let d = ((a1 - a0) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/**
 * 拡大縮小: 横・縦の倍率にかける数。軸の取っ手は、その軸に沿って真ん中から離れた割合（真ん中を越えると裏返る）。
 * 真ん中は縦横そろえて、右か上へ動かすと大きく（ページの 100px で2倍）
 */
export function scaleFactor(h: Handle, f: GizmoFrame, start: V, now: V): V {
  if (h === 'xy') {
    const k = Math.max(0.01, 1 + ((now[0] - start[0]) - (now[1] - start[1])) / (100 * f.k));
    return [k, k];
  }
  const ax = h === 'x' ? f.ox : f.oy;
  let s0 = dot(sub(start, f.c), ax);
  if (Math.abs(s0) < 8 * f.k) s0 = sized(f).len;
  const k = dot(sub(now, f.c), ax) / s0;
  return h === 'x' ? [k, 1] : [1, k];
}

/** 角度を -360〜360 に収め、そろえる（step 度ごと。0 なら 0.1 度） */
export function tidyRot(rot: number, step = 0): number {
  let r = rot;
  while (r > 360) r -= 360;
  while (r < -360) r += 360;
  r = step ? Math.round(r / step) * step : Math.round(r * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

/** 倍率を -20〜20 に収め、0 にしない（step ごと。0 なら 0.01） */
export function tidyScale(s: number, step = 0): number {
  const q = step || 0.01;
  let v = Math.round(s / q) * q;
  v = Math.round(v * 1000) / 1000;
  if (Math.abs(v) < q) v = s < 0 ? -q : q;
  return Math.max(-20, Math.min(20, v));
}

/** 取っ手を描く（over は指している・動かしている取っ手） */
export function drawGizmo(g: CanvasRenderingContext2D, tool: Tool, f: GizmoFrame, over: Handle | null): void {
  const { len, head, box, center, ring } = sized(f);
  const lw = (w: number) => w * f.k;
  const X = '#ff5d73', Y = '#5fd38d', C = '#4fa3ff', HI = '#ffe066';
  g.save();
  g.setLineDash([]);
  g.lineCap = 'round';
  if (tool === 'rotate') {
    g.lineWidth = lw(over === 'ring' ? 4 : 2.5);
    g.strokeStyle = over === 'ring' ? HI : C;
    g.beginPath(); g.arc(f.c[0], f.c[1], ring, 0, Math.PI * 2); g.stroke();
    // 物の向き（0 度の向き）の目印
    g.lineWidth = lw(2);
    g.strokeStyle = X;
    const e = add(f.c, f.ox, ring);
    g.beginPath(); g.moveTo(f.c[0], f.c[1]); g.lineTo(e[0], e[1]); g.stroke();
    g.fillStyle = X;
    g.beginPath(); g.arc(e[0], e[1], lw(4), 0, Math.PI * 2); g.fill();
    g.restore();
    return;
  }
  const axes: [Handle, V, string][] = tool === 'move' ? [['x', f.wx, X], ['y', f.wy, Y]] : [['x', f.ox, X], ['y', f.oy, Y]];
  for (const [h, ax, col] of axes) {
    const a = add(f.c, ax, center), b = add(f.c, ax, len);
    g.lineWidth = lw(over === h ? 4 : 2.5);
    g.strokeStyle = g.fillStyle = over === h ? HI : col;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    if (tool === 'move') {
      // 矢印の頭（値の増える向き）
      const n: V = [-ax[1], ax[0]], tip = add(f.c, ax, len + head);
      g.beginPath();
      g.moveTo(tip[0], tip[1]);
      g.lineTo(...add(b, n, head * 0.55));
      g.lineTo(...add(b, n, -head * 0.55));
      g.closePath(); g.fill();
    } else {
      g.fillRect(b[0] - box, b[1] - box, box * 2, box * 2);
    }
  }
  g.lineWidth = lw(2);
  g.strokeStyle = over === 'xy' ? HI : C;
  g.fillStyle = over === 'xy' ? 'rgba(255,224,102,0.35)' : 'rgba(79,163,255,0.25)';
  g.fillRect(f.c[0] - center, f.c[1] - center, center * 2, center * 2);
  g.strokeRect(f.c[0] - center, f.c[1] - center, center * 2, center * 2);
  g.restore();
}
