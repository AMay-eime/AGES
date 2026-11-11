// 空間を文字で確かめる（ages space）。AI が画像を見なくても、置いた物の位置・大きさ・上下の関係・カメラからの見え方が分かるようにする。
// 物の形は、軸にそろった外枠（回した物は少し大きめ）で数える。依存なし（Node でも同じ結果）
import { multiply, transformPoint, translation, type Mat4, type Vec3 } from './math.ts';
import { cameraOf, matrixOf, toScreen } from './space.ts';
import { hitSolid, type Solid } from './pick.ts';
import { overlap3, shapeOf, type Shape3 } from './collide.ts';
import type { World } from '../../core/world.ts';

/** モデルの大きさと中心（アセットの要約から。場所 → 値） */
export type ModelBounds = Map<string, { size: Vec3; center: Vec3 }>;

interface Thing {
  id: string;
  what: string;
  solid: Solid;
  min: Vec3;
  max: Vec3;
  center: Vec3;
}

const r2 = (v: number): number => Math.round(v * 100) / 100 || 0;
const vec = (v: number[]): string => `[${v.map(r2).join(',')}]`;

/** 形を囲む箱の半分（板は厚さなし） */
function half(shape: string, size: Vec3): Vec3 {
  switch (shape) {
    case 'sphere': return [size[0] / 2, size[0] / 2, size[0] / 2];
    case 'cylinder': return [size[0] / 2, size[1] / 2, size[0] / 2];
    case 'capsule': return [size[0] / 2, Math.max(size[0], size[1]) / 2, size[0] / 2];
    case 'plane': return [size[0] / 2, 0, size[2] / 2];
    default: return [size[0] / 2, size[1] / 2, size[2] / 2];
  }
}

function bounds(m: Mat4, h: Vec3): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = transformPoint(m, [i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]]);
    for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  }
  return { min, max };
}

/** 形のある物（Mesh3D・Model3D）を集める */
function things(world: World, models: ModelBounds): Thing[] {
  const out: Thing[] = [];
  for (const e of world.entities.values()) {
    const wm = matrixOf(world, e);
    if (!wm) continue;
    const mesh = e.c.Mesh3D as { shape?: string; size?: Vec3; visible?: boolean } | undefined;
    const model = e.c.Model3D as { model?: string; visible?: boolean } | undefined;
    let solid: Solid | null = null, what = '';
    if (mesh && mesh.visible !== false) { solid = { id: e.id, matrix: wm, shape: mesh.shape ?? 'box', size: mesh.size ?? [1, 1, 1] }; what = mesh.shape ?? 'box'; }
    else if (model && model.visible !== false && model.model) {
      const b = models.get(model.model);
      if (!b) continue;
      solid = { id: e.id, matrix: multiply(wm, translation(b.center)), shape: 'box', size: b.size };
      what = model.model.slice(model.model.lastIndexOf('/') + 1);
    }
    if (!solid) continue;
    const { min, max } = bounds(solid.matrix, half(solid.shape, solid.size));
    out.push({ id: e.id, what, solid, min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] });
  }
  return out;
}

export interface SpaceOptions {
  width: number;
  height: number;
  models: ModelBounds;
  /** この物だけ（省くと全部） */
  only?: string[];
  /** この物と、そのまわり radius m にある物だけ（外枠どうしの距離で） */
  near?: { id: string; radius: number };
}

/** 空間の様子を文字で（1つの物に1行。⚠ は置き間違いらしいもの） */
export function describeSpace(world: World, o: SpaceOptions): string[] {
  const all = things(world, o.models);
  if (!all.length) return ['形のある 3D の物（Mesh3D・Model3D）がありません'];
  const cam = cameraOf(world, o.width / Math.max(1, o.height));
  const out: string[] = [];
  const warns: string[] = [];
  out.push(`カメラ ${cam.id || '（既定）'} 位置${vec(cam.pos)} 見る向き${vec(cam.dir)}${cam.ortho ? ' 遠近なし' : ''}`);
  const dist = (t: Thing) => Math.hypot(t.center[0] - cam.pos[0], t.center[1] - cam.pos[1], t.center[2] - cam.pos[2]);
  // 外枠どうしの距離（重なっていれば 0）
  const gap = (a: Thing, b: Thing) => Math.hypot(...[0, 1, 2].map((k) => Math.max(0, a.min[k] - b.max[k], b.min[k] - a.max[k])));
  const center = o.near ? all.find((t) => t.id === o.near!.id) : undefined;
  const picked = o.only?.length ? all.filter((t) => o.only!.includes(t.id)) : center ? all.filter((t) => gap(t, center) <= o.near!.radius) : all;
  if (center) out.push(`${center.id} のまわり ${o.near!.radius}m にある物だけ（${picked.length} / ${all.length}）`);
  const shown = picked.sort((a, b) => dist(a) - dist(b));
  out.push('物（カメラに近い順。位置は外枠の中心・大きさは 幅x高さx奥行き m ｜ 上下 ｜ 画面の位置 px・見かけの高さ px・距離 m）:');
  for (const t of shown) {
    // ---- 上下: 真下にある物（外枠が、この物の底の中心を含むもの）
    const EPS = 0.02;
    let rest = '';
    const under = all.filter((u) => u.id !== t.id && u.min[0] <= t.center[0] && t.center[0] <= u.max[0] && u.min[2] <= t.center[2] && t.center[2] <= u.max[2]);
    // 沈んでいる: ほかの物の上の面を、またいでいる（底はその面より下、頭は上。床に埋まった・重なって置いた）
    const sunk = under.filter((u) => u.max[1] - t.min[1] > EPS && t.max[1] - u.max[1] > EPS).sort((a, b) => b.max[1] - a.max[1])[0];
    const below = under.filter((u) => u.max[1] <= t.min[1] + EPS).sort((a, b) => b.max[1] - a.max[1])[0];
    if (sunk) {
      rest = `${sunk.id} に ${r2(sunk.max[1] - t.min[1])} 沈んでいる`;
      warns.push(`⚠ ${t.id} が ${sunk.id} に ${r2(sunk.max[1] - t.min[1])}m 沈んでいます（底 y=${r2(t.min[1])}、${sunk.id} の上の面 y=${r2(sunk.max[1])}。y を ${r2(sunk.max[1] - t.min[1])} 上げると面に乗る）`);
    } else if (below) {
      const gap = t.min[1] - below.max[1];
      if (gap <= EPS) rest = `${below.id} の上`;
      else rest = `${below.id} の ${r2(gap)} 上に浮く`;
    } else {
      const inside = under.find((u) => u.min[1] < t.min[1] && t.max[1] <= u.max[1] + EPS);
      rest = inside ? `${inside.id} の中` : '下に何もない';
    }
    // ---- 画面
    let screen = '';
    const d = dist(t);
    const s = toScreen(cam, t.center, o.width, o.height);
    if (!s) screen = 'カメラの後ろ';
    else {
      const top = toScreen(cam, [t.center[0], t.max[1], t.center[2]], o.width, o.height), bottom = toScreen(cam, [t.center[0], t.min[1], t.center[2]], o.width, o.height);
      const tall = top && bottom ? Math.round(Math.abs(bottom.y - top.y)) : 0;
      const side = [s.x < 0 ? '左' : s.x > o.width ? '右' : '', s.y < 0 ? '上' : s.y > o.height ? '下' : ''].filter(Boolean).join('');
      if (side) screen = `画面の外（${side}）`;
      else {
        // 中心が、手前のほかの物に隠れていないか
        const len = Math.max(1e-9, d), dir: Vec3 = [(t.center[0] - cam.pos[0]) / len, (t.center[1] - cam.pos[1]) / len, (t.center[2] - cam.pos[2]) / len];
        const mine = hitSolid({ origin: cam.pos, dir }, t.solid) ?? d;
        let hider = '', near = mine - 0.01;
        for (const u of all) { if (u.id === t.id) continue; const h = hitSolid({ origin: cam.pos, dir }, u.solid); if (h !== null && h < near) { near = h; hider = u.id; } }
        screen = `画面(${Math.round(s.x)},${Math.round(s.y)}) 高さ${tall}px${hider ? ` 中心が ${hider} に隠れている` : ''}`;
      }
    }
    out.push(`  ${t.id} ${t.what} 位置${vec(t.center)} 大きさ${r2(t.max[0] - t.min[0])}x${r2(t.max[1] - t.min[1])}x${r2(t.max[2] - t.min[2])} ｜ 底y=${r2(t.min[1])} ${rest} ｜ ${screen} 距離${r2(d)}`);
  }
  // ---- 当たり判定: 見た目とのずれ・いま重なっている組
  const shapes: { id: string; s: Shape3 }[] = [];
  for (const e of world.entities.values()) { const s = e.c.Collider3D ? shapeOf(world, e) : null; if (s) shapes.push({ id: e.id, s }); }
  const shownIds = new Set(shown.map((t) => t.id));
  for (const { id, s } of shapes) {
    const t = all.find((x) => x.id === id);
    if (!t || !shownIds.has(id)) continue;
    const c: Vec3 = [(s.box.min[0] + s.box.max[0]) / 2, (s.box.min[1] + s.box.max[1]) / 2, (s.box.min[2] + s.box.max[2]) / 2];
    const off = [0, 1, 2].some((k) => Math.abs(c[k] - t.center[k]) > Math.max(0.05, (t.max[k] - t.min[k]) * 0.3));
    if (off) warns.push(`⚠ ${id} の当たり判定が見た目とずれています（判定の中心${vec(c)} 大きさ${r2(s.box.max[0] - s.box.min[0])}x${r2(s.box.max[1] - s.box.min[1])}x${r2(s.box.max[2] - s.box.min[2])}、見た目の中心${vec(t.center)}。Collider3D.offset・size を直す）`);
  }
  const pairs: string[] = [];
  const part = picked.length < all.length;
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) if ((!part || shownIds.has(shapes[i].id) || shownIds.has(shapes[j].id)) && overlap3(shapes[i].s, shapes[j].s)) pairs.push(`${shapes[i].id}–${shapes[j].id}`);
  if (shapes.length) out.push(`当たり判定 ${shapes.length}個。${part ? '出した物が' : ''}いま重なっている組: ${pairs.length ? pairs.slice(0, 30).join(' ') + (pairs.length > 30 ? ` …ほか${pairs.length - 30}` : '') : 'なし'}`);
  out.push(...warns);
  return out;
}
