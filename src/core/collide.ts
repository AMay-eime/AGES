// 当たり判定（円・矩形の重なりと、範囲・点・線での検索）。物理演算（押し返し・跳ね返り）はしない。
// 形は標準の Collider（Transform の位置・回転・倍率がかかる）。グループの名前で相手を絞る。
// フレームの終わりに、with に書いたグループとの「重なり始め」を求める（次のフレームの ctx.hit.entered。ages run の hits: に数が出る）。
// 検索（overlaps・point・circle・rect・ray）は、呼んだ時点の位置で求める。どれも結果はワールドに入った順で、毎回同じになる。
import type { World, Entity } from './world.ts';

export type HitShape =
  | { kind: 'circle'; x: number; y: number; r: number; box: Box }
  | { kind: 'rect'; x: number; y: number; hw: number; hh: number; cos: number; sin: number; box: Box };

/** 軸にそろった外枠（ざっと絞る用） */
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** 物の当たり判定の形（Collider がない・止めている・消える物は null）。world を渡すと位置の親（Transform.parent）をたどる */
export function shapeOf(e: Entity, world?: World): HitShape | null {
  const c = e.c.Collider, t = e.c.Transform && world && e.c.Transform.parent ? world.pose(e)! : e.c.Transform;
  if (!c || c.enabled === false || !t) return null;
  const sx = Math.abs(t.sx ?? 1), sy = Math.abs(t.sy ?? 1);
  const rad = ((t.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // ずれ（offset）も倍率・回転とともに回す
  const [ox, oy] = c.offset ?? [0, 0];
  const lx = ox * (t.sx ?? 1), ly = oy * (t.sy ?? 1);
  const x = t.x + lx * cos - ly * sin, y = t.y + lx * sin + ly * cos;
  if (c.shape === 'circle') {
    const r = (c.r ?? 8) * Math.max(sx, sy);
    return { kind: 'circle', x, y, r, box: { x0: x - r, y0: y - r, x1: x + r, y1: y + r } };
  }
  const hw = ((c.w ?? 16) * sx) / 2, hh = ((c.h ?? 16) * sy) / 2;
  const ex = Math.abs(hw * cos) + Math.abs(hh * sin), ey = Math.abs(hw * sin) + Math.abs(hh * cos);
  return { kind: 'rect', x, y, hw, hh, cos, sin, box: { x0: x - ex, y0: y - ey, x1: x + ex, y1: y + ey } };
}

const boxes = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** 矩形の中の座標（回転を戻す） */
function local(r: Extract<HitShape, { kind: 'rect' }>, x: number, y: number): [number, number] {
  const dx = x - r.x, dy = y - r.y;
  return [dx * r.cos + dy * r.sin, -dx * r.sin + dy * r.cos];
}

/** 2つの形が重なっているか（触れているだけは重なっていない） */
export function overlap(a: HitShape, b: HitShape): boolean {
  if (!boxes(a.box, b.box)) return false;
  if (a.kind === 'circle' && b.kind === 'circle') return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < (a.r + b.r) ** 2;
  if (a.kind === 'circle') return circleRect(a, b as Extract<HitShape, { kind: 'rect' }>);
  if (b.kind === 'circle') return circleRect(b, a);
  // 回っていなければ外枠どうしで決まる
  if (a.sin === 0 && b.sin === 0) return true;
  return sat(a, b) && sat(b, a);
}

function circleRect(c: Extract<HitShape, { kind: 'circle' }>, r: Extract<HitShape, { kind: 'rect' }>): boolean {
  const [lx, ly] = local(r, c.x, c.y);
  const nx = Math.max(-r.hw, Math.min(r.hw, lx)), ny = Math.max(-r.hh, Math.min(r.hh, ly));
  return (lx - nx) ** 2 + (ly - ny) ** 2 < c.r ** 2;
}

/** 分離軸（a の2つの辺の向き）で、b が離れていないか */
function sat(a: Extract<HitShape, { kind: 'rect' }>, b: Extract<HitShape, { kind: 'rect' }>): boolean {
  const axes: [number, number][] = [[a.cos, a.sin], [-a.sin, a.cos]];
  const ext = (r: typeof a, ax: number, ay: number) => Math.abs(r.hw * (r.cos * ax + r.sin * ay)) + Math.abs(r.hh * (-r.sin * ax + r.cos * ay));
  for (const [ax, ay] of axes) {
    const d = Math.abs((b.x - a.x) * ax + (b.y - a.y) * ay);
    if (d >= ext(a, ax, ay) + ext(b, ax, ay)) return false;
  }
  return true;
}

/** 点が形の中にあるか */
export function contains(s: HitShape, x: number, y: number): boolean {
  if (s.kind === 'circle') return (x - s.x) ** 2 + (y - s.y) ** 2 < s.r ** 2;
  const [lx, ly] = local(s, x, y);
  return Math.abs(lx) < s.hw && Math.abs(ly) < s.hh;
}

/** 線分が形に当たる最初の位置（0〜1。当たらなければ null） */
export function rayHit(s: HitShape, x0: number, y0: number, x1: number, y1: number): number | null {
  if (s.kind === 'circle') {
    const dx = x1 - x0, dy = y1 - y0, fx = x0 - s.x, fy = y0 - s.y;
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - s.r * s.r;
    if (c < 0) return 0; // 始まりが中にある
    if (a === 0) return null;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : null;
  }
  const [ax, ay] = local(s, x0, y0), [bx, by] = local(s, x1, y1);
  let t0 = 0, t1 = 1;
  for (const [p, d, h] of [[ax, bx - ax, s.hw], [ay, by - ay, s.hh]] as [number, number, number][]) {
    if (d === 0) { if (p <= -h || p >= h) return null; continue; }
    let ta = (-h - p) / d, tb = (h - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

/** 形の外枠を、絞り込みの格子に入れる大きさ */
const CELL = 64;

export class HitState {
  /** 前のフレームまでに重なっていた組（"自分|相手"） */
  private pairs = new Set<string>();
  /** このフレームに重なり始めた相手（自分 → 相手の並び） */
  entered = new Map<string, string[]>();
  /** 重なり始めた回数（"グループ→グループ" → 回数。ages run の要約用） */
  counts = new Map<string, number>();
  /** 使われているグループの名前（検索の名前の間違いを知らせる用） */
  groups = new Set<string>();

  /** フレームの終わり（物の出し入れの前）に呼ぶ。with に書いたグループとの重なり始めを求める */
  update(world: World): void {
    this.entered.clear();
    const all: { e: Entity; s: HitShape; g: string }[] = [];
    // このフレームに消した物も数える（当たって消した弾も「当たった」に入るように）
    for (const e of world.entities.values()) {
      const s = shapeOf(e, world);
      if (!s) continue;
      const g = String(e.c.Collider.group ?? '');
      all.push({ e, s, g });
      if (g) this.groups.add(g);
    }
    const seekers = all.filter((a) => a.e.c.Collider.with?.length);
    if (!seekers.length) { this.pairs.clear(); return; }
    // 格子で絞る（相手の候補は、同じ升にいる物だけ）
    const grid = new Map<string, number[]>();
    all.forEach((a, i) => {
      const b = a.s.box;
      for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
        for (let cy = Math.floor(b.y0 / CELL); cy <= Math.floor(b.y1 / CELL); cy++) {
          const k = `${cx},${cy}`;
          const list = grid.get(k);
          if (list) list.push(i); else grid.set(k, [i]);
        }
      }
    });
    const now = new Set<string>();
    for (const a of seekers) {
      const want = new Set<string>(a.e.c.Collider.with);
      const seen = new Set<number>();
      const b = a.s.box;
      for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
        for (let cy = Math.floor(b.y0 / CELL); cy <= Math.floor(b.y1 / CELL); cy++) {
          for (const j of grid.get(`${cx},${cy}`) ?? []) seen.add(j);
        }
      }
      const hits: string[] = [];
      for (const j of [...seen].sort((x, y) => x - y)) {
        const o = all[j];
        if (o.e === a.e || !want.has(o.g) || !overlap(a.s, o.s)) continue;
        const key = `${a.e.id}|${o.e.id}`;
        now.add(key);
        if (this.pairs.has(key)) continue;
        hits.push(o.e.id);
        const ck = `${a.g || '（なし）'}→${o.g}`;
        this.counts.set(ck, (this.counts.get(ck) ?? 0) + 1);
      }
      if (hits.length) this.entered.set(a.e.id, hits);
    }
    this.pairs = now;
  }

  snapshot(): string[] {
    return [...this.pairs];
  }
}

/** 名前（または名前の並び）に合うか。省くと何でも */
export function inGroup(e: Entity, group?: string | string[]): boolean {
  if (group === undefined) return true;
  const g = String(e.c.Collider?.group ?? '');
  return Array.isArray(group) ? group.includes(g) : g === group;
}
