// 3D の当たり判定（箱・球・カプセルの重なりと、点・球・箱・線での検索）。物理演算（押し返し・重力）はしない。
// 形は Collider3D（Transform3D の位置・回転・倍率がかかる）。グループの名前で相手を絞る（2D の ctx.hit と同じ考え方）。
// 検索は、呼んだ時点の位置で求める。結果はワールドに入った順で、毎回同じになる。依存なし（Node でも同じ結果）
import { cross, dot, normalize, sub, type Mat4, type Vec3 } from './math.ts';
import { matrixOf } from './space.ts';
import type { Entity, World } from '../../core/world.ts';

/** 軸にそろった外枠（ざっと絞る用） */
export interface Aabb { min: Vec3; max: Vec3 }

/**
 * 当たり判定の形（世界の座標）。
 * - round: 線分 a–b から r までの所（球は a = b。カプセルは a・b が両はしの丸みの中心）
 * - box: 中心 c・3つの向き axes（長さ1）・それぞれの半分の長さ half
 */
export type Shape3 =
  | { kind: 'round'; a: Vec3; b: Vec3; r: number; box: Aabb }
  | { kind: 'box'; c: Vec3; axes: [Vec3, Vec3, Vec3]; half: Vec3; box: Aabb };

type Round = Extract<Shape3, { kind: 'round' }>;
type Box = Extract<Shape3, { kind: 'box' }>;

const addScaled = (p: Vec3, d: Vec3, k: number): Vec3 => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function roundShape(a: Vec3, b: Vec3, r: number): Round {
  return { kind: 'round', a, b, r, box: { min: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r], max: [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r] } };
}
function boxShape(c: Vec3, axes: [Vec3, Vec3, Vec3], half: Vec3): Box {
  const e: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) e[k] = Math.abs(axes[0][k]) * half[0] + Math.abs(axes[1][k]) * half[1] + Math.abs(axes[2][k]) * half[2];
  return { kind: 'box', c, axes, half, box: { min: [c[0] - e[0], c[1] - e[1], c[2] - e[2]], max: [c[0] + e[0], c[1] + e[1], c[2] + e[2]] } };
}

/** 球の形（検索用） */
export const sphereShape = (center: Vec3, r: number): Shape3 => roundShape(center, center, Math.max(0, r));
/** 軸にそろった箱の形（検索用。size は幅・高さ・奥行き） */
export const boxShapeAt = (center: Vec3, size: Vec3): Shape3 => boxShape(center, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [Math.abs(size[0]) / 2, Math.abs(size[1]) / 2, Math.abs(size[2]) / 2]);

/** Collider3D の値と世界の行列から、形を作る */
export function shapeFrom(c: { shape?: string; size?: number[]; offset?: number[] }, m: Mat4): Shape3 {
  const cols: Vec3[] = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  const scale = cols.map((v) => Math.hypot(v[0], v[1], v[2]));
  const axes = cols.map((v, k) => (scale[k] > 1e-12 ? [v[0] / scale[k], v[1] / scale[k], v[2] / scale[k]] : ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[])[k])) as [Vec3, Vec3, Vec3];
  const o = c.offset ?? [0, 0, 0], size = c.size ?? [1, 1, 1];
  // ずれ（offset）も回転・倍率とともに動く
  const center: Vec3 = [m[12] + m[0] * o[0] + m[4] * o[1] + m[8] * o[2], m[13] + m[1] * o[0] + m[5] * o[1] + m[9] * o[2], m[14] + m[2] * o[0] + m[6] * o[1] + m[10] * o[2]];
  if (c.shape === 'sphere') return roundShape(center, center, (Math.abs(size[0]) / 2) * Math.max(scale[0], scale[1], scale[2]));
  if (c.shape === 'capsule') {
    const r = (Math.abs(size[0]) / 2) * Math.max(scale[0], scale[2]);
    const half = Math.max(0, (Math.abs(size[1]) * scale[1]) / 2 - r);
    return roundShape(addScaled(center, axes[1], -half), addScaled(center, axes[1], half), r);
  }
  return boxShape(center, axes, [(Math.abs(size[0]) * scale[0]) / 2, (Math.abs(size[1]) * scale[1]) / 2, (Math.abs(size[2]) * scale[2]) / 2]);
}

/** 物の当たり判定の形（Collider3D がない・止めている・Transform3D がないなら null） */
export function shapeOf(world: World, e: Entity | string): Shape3 | null {
  const ent = typeof e === 'string' ? world.entities.get(e) : e;
  const c = ent?.c.Collider3D as { shape?: string; size?: number[]; offset?: number[]; enabled?: boolean } | undefined;
  if (!ent || !c || c.enabled === false) return null;
  const m = matrixOf(world, ent);
  return m ? shapeFrom(c, m) : null;
}

const boxes = (a: Aabb, b: Aabb): boolean => a.min[0] < b.max[0] && b.min[0] < a.max[0] && a.min[1] < b.max[1] && b.min[1] < a.max[1] && a.min[2] < b.max[2] && b.min[2] < a.max[2];

/** 2つの線分のいちばん近い所の、距離の2乗（点どうし・点と線分も含む） */
function segSeg2(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-18 && e <= 1e-18) return dot(r, r);
  if (a <= 1e-18) t = clamp(f / e, 0, 1);
  else {
    const c = dot(d1, r);
    if (e <= 1e-18) s = clamp(-c / a, 0, 1);
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-18 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const x = r[0] + d1[0] * s - d2[0] * t, y = r[1] + d1[1] * s - d2[1] * t, z = r[2] + d1[2] * s - d2[2] * t;
  return x * x + y * y + z * z;
}

/** 箱から見た座標（中心が原点・軸が箱の向き） */
const inBox = (b: Box, p: Vec3): Vec3 => { const d = sub(p, b.c); return [dot(d, b.axes[0]), dot(d, b.axes[1]), dot(d, b.axes[2])]; };

/** 点（箱から見た座標）と箱の、距離の2乗（中なら 0） */
function pointBox2(half: Vec3, p: Vec3): number {
  let d = 0;
  for (let k = 0; k < 3; k++) { const o = Math.abs(p[k]) - half[k]; if (o > 0) d += o * o; }
  return d;
}

/** 線分と箱の、距離の2乗。線分の上の点と箱の距離は谷が1つなので、区間をせばめて求める（決まった回数。毎回同じ結果） */
function segBox2(b: Box, p: Vec3, q: Vec3): number {
  const a = inBox(b, p), d = sub(inBox(b, q), a);
  const at = (t: number) => pointBox2(b.half, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]);
  if (dot(d, d) <= 1e-18) return at(0);
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (at(m1) <= at(m2)) hi = m2; else lo = m1;
  }
  return at((lo + hi) / 2);
}

/** 箱どうし: 分ける向き（それぞれの3つの向きと、その組み合わせ 9つ）が1つでもあれば離れている */
function boxBox(a: Box, b: Box): boolean {
  const d = sub(b.c, a.c);
  const ext = (x: Box, ax: Vec3) => Math.abs(dot(x.axes[0], ax)) * x.half[0] + Math.abs(dot(x.axes[1], ax)) * x.half[1] + Math.abs(dot(x.axes[2], ax)) * x.half[2];
  const apart = (ax: Vec3) => { const l = Math.hypot(ax[0], ax[1], ax[2]); return l > 1e-9 && Math.abs(dot(d, ax)) >= ext(a, ax) + ext(b, ax); };
  for (const ax of a.axes) if (apart(ax)) return false;
  for (const ax of b.axes) if (apart(ax)) return false;
  for (const x of a.axes) for (const y of b.axes) if (apart(cross(x, y))) return false;
  return true;
}

/** 2つの形が重なっているか（触れているだけは重なっていない） */
export function overlap3(a: Shape3, b: Shape3): boolean {
  if (!boxes(a.box, b.box)) return false;
  if (a.kind === 'round' && b.kind === 'round') return segSeg2(a.a, a.b, b.a, b.b) < (a.r + b.r) ** 2;
  if (a.kind === 'round') return segBox2(b as Box, a.a, a.b) < a.r * a.r || inside(b as Box, a.a);
  if (b.kind === 'round') return segBox2(a, b.a, b.b) < b.r * b.r || inside(a, b.a);
  return boxBox(a, b);
}
const inside = (b: Box, p: Vec3): boolean => { const l = inBox(b, p); return Math.abs(l[0]) < b.half[0] && Math.abs(l[1]) < b.half[1] && Math.abs(l[2]) < b.half[2]; };

/** 点が形の中にあるか */
export function contains3(s: Shape3, p: Vec3): boolean {
  return s.kind === 'round' ? segSeg2(s.a, s.b, p, p) < s.r * s.r : inside(s, p);
}

/** 線分 from → to が形に当たる最初の所（t は 0〜1、normal は当たった面の向き）。当たらなければ null。始まりが中なら t = 0 */
export function rayHit3(s: Shape3, from: Vec3, to: Vec3): { t: number; normal: Vec3 } | null {
  const d = sub(to, from), len = Math.hypot(d[0], d[1], d[2]);
  const back: Vec3 = len > 0 ? [-d[0] / len, -d[1] / len, -d[2] / len] : [0, 1, 0];
  if (contains3(s, from)) return { t: 0, normal: back };
  if (len <= 0) return null;
  if (s.kind === 'box') {
    const o = inBox(s, from), e = sub(inBox(s, to), o);
    // 入る所 t0（いちばん遅く入る面）と、出る所 t1。面の上から中へ向かう線は、t = 0 で当たる（足元の地面）
    let t0 = -Infinity, t1 = Infinity, axis = -1, sign = 1;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(e[k]) < 1e-12) { if (o[k] <= -s.half[k] || o[k] >= s.half[k]) return null; continue; }
      let ta = (-s.half[k] - o[k]) / e[k], tb = (s.half[k] - o[k]) / e[k], sg = -1;
      if (ta > tb) { [ta, tb] = [tb, ta]; sg = 1; }
      if (ta > t0) { t0 = ta; axis = k; sign = sg; }
      t1 = Math.min(t1, tb);
    }
    if (axis < 0 || t0 > t1 || t0 < 0 || t0 > 1 || t1 <= 0) return null;
    const n = s.axes[axis];
    return { t: t0, normal: [n[0] * sign, n[1] * sign, n[2] * sign] };
  }
  // 丸い形: 両はしの球と、間の筒のうち、いちばん手前
  let best = Infinity;
  const ball = (c: Vec3) => {
    const oc = sub(from, c), b = dot(oc, d), cc = dot(oc, oc) - s.r * s.r, a = len * len, disc = b * b - a * cc;
    if (disc < 0) return;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t >= 0 && t <= 1 && t < best) best = t;
  };
  ball(s.a);
  const ba = sub(s.b, s.a), baba = dot(ba, ba);
  if (baba > 1e-18) {
    ball(s.b);
    const oa = sub(from, s.a), bard = dot(ba, d), baoa = dot(ba, oa), rdoa = dot(d, oa), oaoa = dot(oa, oa);
    const a = baba * len * len - bard * bard, b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - s.r * s.r * baba;
    const disc = b * b - a * c;
    if (a > 1e-18 && disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a, y = baoa + t * bard;
      if (t >= 0 && t <= 1 && y > 0 && y < baba && t < best) best = t;
    }
  }
  if (!Number.isFinite(best)) return null;
  const p = addScaled(from, d, best);
  // 当たった所から、いちばん近い芯の点への向きの逆が、面の向き
  const k = baba > 1e-18 ? clamp(dot(sub(p, s.a), ba) / baba, 0, 1) : 0;
  return { t: best, normal: normalize(sub(p, addScaled(s.a, ba, k))) };
}

/** 名前（または名前の並び）に合うか。省くと何でも */
function inGroup(e: Entity, group?: string | string[]): boolean {
  if (group === undefined) return true;
  const g = String((e.c.Collider3D as { group?: string } | undefined)?.group ?? '');
  return Array.isArray(group) ? group.includes(g) : g === group;
}

/** 形に重なる物（Collider3D のある物。except は除く） */
function query(world: World, s: Shape3, group?: string | string[], except?: string): string[] {
  const out: string[] = [];
  for (const e of world.entities.values()) {
    if (e.id === except || !e.c.Collider3D || !inGroup(e, group)) continue;
    const o = shapeOf(world, e);
    if (o && overlap3(s, o)) out.push(e.id);
  }
  return out;
}

/** 線で当たった所 */
export interface RayHit3 { id: string; point: Vec3; normal: Vec3; dist: number }

/**
 * 3D の当たり判定の検索（ゲームのコードから: `import { hit3 } from 'ages/3d'`）。
 * group はグループの名前か、その並び（省くと全部）
 */
export const hit3 = {
  /** 今（呼んだ時点の位置で）重なっている相手。ワールドに入った順 */
  overlaps(world: World, id: string, group?: string | string[]): string[] {
    const s = shapeOf(world, id);
    return s ? query(world, s, group, id) : [];
  },
  /** 重なり始めた相手（Collider3D.with に書いたグループだけ。前のフレームの終わりの位置で） */
  entered(world: World, id: string, group?: string | string[]): string[] {
    const list = ((world.entities.get(id)?.c.Collider3D as { entered?: string[] } | undefined)?.entered ?? []) as string[];
    return group === undefined ? [...list] : list.filter((o) => { const e = world.entities.get(o); return !!e && inGroup(e, group); });
  },
  /** 2つが重なっているか */
  test(world: World, a: string, b: string): boolean {
    const x = shapeOf(world, a), y = shapeOf(world, b);
    return !!x && !!y && overlap3(x, y);
  },
  /** その点を含む物 */
  point(world: World, p: Vec3, group?: string | string[]): string[] {
    const out: string[] = [];
    for (const e of world.entities.values()) {
      if (!e.c.Collider3D || !inGroup(e, group)) continue;
      const o = shapeOf(world, e);
      if (o && contains3(o, p)) out.push(e.id);
    }
    return out;
  },
  /** 球（中心と半径）に重なる物 */
  sphere(world: World, center: Vec3, r: number, group?: string | string[]): string[] {
    return query(world, sphereShape(center, r), group);
  },
  /** 箱（中心と 幅・高さ・奥行き。軸にそろった箱）に重なる物 */
  box(world: World, center: Vec3, size: Vec3, group?: string | string[]): string[] {
    return query(world, boxShapeAt(center, size), group);
  },
  /** 線分 from → to で最初に当たる物（見通し・足元の地面・弾。normal は当たった面の向き、dist は from からの距離） */
  ray(world: World, from: Vec3, to: Vec3, group?: string | string[]): RayHit3 | null {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    let best: RayHit3 | null = null, bt = Infinity;
    for (const e of world.entities.values()) {
      if (!e.c.Collider3D || !inGroup(e, group)) continue;
      const o = shapeOf(world, e);
      const h = o && rayHit3(o, from, to);
      if (h && h.t < bt) { bt = h.t; best = { id: e.id, point: [from[0] + (to[0] - from[0]) * h.t, from[1] + (to[1] - from[1]) * h.t, from[2] + (to[2] - from[2]) * h.t], normal: h.normal, dist: h.t * len }; }
    }
    return best;
  },
};

/** 形の線（エディタで当たり判定を見せる用。線分の並び） */
export function wireOf(s: Shape3): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  if (s.kind === 'box') {
    const c = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      let p = s.c;
      for (let k = 0; k < 3; k++) p = addScaled(p, s.axes[k], (i >> k) & 1 ? s.half[k] : -s.half[k]);
      return p;
    });
    for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) out.push([c[a], c[b]]);
    return out;
  }
  const ba = sub(s.b, s.a), len = Math.hypot(ba[0], ba[1], ba[2]);
  const u: Vec3 = len > 1e-9 ? [ba[0] / len, ba[1] / len, ba[2] / len] : [0, 1, 0];
  const v = normalize(cross(u, Math.abs(u[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(u, v);
  const N = 24;
  const arc = (c: Vec3, x: Vec3, y: Vec3, from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      out.push([addScaled(addScaled(c, x, Math.cos(a0) * s.r), y, Math.sin(a0) * s.r), addScaled(addScaled(c, x, Math.cos(a1) * s.r), y, Math.sin(a1) * s.r)]);
    }
  };
  // 両はしの輪と丸み（球は a = b なので、3つの輪になる）
  arc(s.a, v, w, 0, N);
  for (const x of [v, w]) { arc(s.b, x, u, 0, N / 2); arc(s.a, x, u, N / 2, N); }
  if (len > 1e-9) {
    arc(s.b, v, w, 0, N);
    for (const x of [v, w]) for (const k of [-1, 1]) out.push([addScaled(s.a, x, k * s.r), addScaled(s.b, x, k * s.r)]);
  }
  return out;
}
