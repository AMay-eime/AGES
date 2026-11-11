// モデルの動き（glTF のアニメーション）: 時刻からノードの姿勢を求め、骨の行列を作る。依存なし（Node でも同じ結果）。
// 動きの切り替えは、前の動きの姿勢と混ぜてなめらかにする（Model3D の fade 秒）
import { composeQuat, multiply, type Mat4 } from './math.ts';
import type { GltfChannel, GltfClip, GltfModel } from './gltf.ts';

/** ノードごとの姿勢（位置・回転・倍率。動かないノードは null） */
export type Pose = ({ t: number[]; r: number[]; s: number[] } | null)[];

/** 動きの中の時刻（loop ならくり返し、でなければ最後で止まる） */
export function clipTime(clip: GltfClip, time: number, loop: boolean): number {
  if (clip.duration <= 0) return 0;
  return loop ? ((time % clip.duration) + clip.duration) % clip.duration : Math.max(0, Math.min(clip.duration, time));
}

function sampleChannel(c: GltfChannel, t: number): number[] {
  const n = c.times.length, w = c.path === 'rotation' ? 4 : 3;
  const cubic = c.interp === 'CUBICSPLINE';
  // 値は1つの鍵に w 個（CUBICSPLINE は 入りの傾き・値・出の傾きで 3w 個）
  const at = (k: number, part = 1) => { const o = cubic ? k * 3 * w + part * w : k * w; return c.values.slice(o, o + w); };
  if (n === 0) return w === 4 ? [0, 0, 0, 1] : [0, 0, 0];
  if (t <= c.times[0] || n === 1) return at(0);
  if (t >= c.times[n - 1]) return at(n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c.times[mid] <= t) lo = mid; else hi = mid; }
  const dt = c.times[hi] - c.times[lo], s = dt > 0 ? (t - c.times[lo]) / dt : 0;
  if (c.interp === 'STEP') return at(lo);
  const a = at(lo), b = at(hi);
  let out: number[];
  if (cubic) {
    const s2 = s * s, s3 = s2 * s, m0 = at(lo, 2), m1 = at(hi, 0);
    out = a.map((v, i) => (2 * s3 - 3 * s2 + 1) * v + (s3 - 2 * s2 + s) * dt * m0[i] + (-2 * s3 + 3 * s2) * b[i] + (s3 - s2) * dt * m1[i]);
  } else if (w === 4) return mixQuat(a, b, s);
  else out = a.map((v, i) => v + (b[i] - v) * s);
  return w === 4 ? normQuat(out) : out;
}

const normQuat = (q: number[]): number[] => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
/** 回転を混ぜる（近い向きへ回る。角が小さいので、まっすぐ混ぜて長さを直す） */
function mixQuat(a: number[], b: number[], s: number): number[] {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], k = d < 0 ? -1 : 1;
  // 角が大きいときは球の上で混ぜる
  if (Math.abs(d) < 0.95) {
    const th = Math.acos(Math.min(1, Math.abs(d))), sn = Math.sin(th) || 1, wa = Math.sin((1 - s) * th) / sn, wb = (Math.sin(s * th) / sn) * k;
    return normQuat([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb]);
  }
  return normQuat([a[0] + (b[0] * k - a[0]) * s, a[1] + (b[1] * k - a[1]) * s, a[2] + (b[2] * k - a[2]) * s, a[3] + (b[3] * k - a[3]) * s]);
}

/** 動きの、その時刻の姿勢（動きのないノードは元の姿勢） */
export function samplePose(model: GltfModel, clip: GltfClip | null, time: number): Pose {
  const pose: Pose = model.nodes.map((n) => (n.trs ? { t: n.trs.t, r: n.trs.r, s: n.trs.s } : null));
  for (const c of clip?.channels ?? []) {
    const p = pose[c.node];
    if (!p) continue;
    const v = sampleChannel(c, time);
    pose[c.node] = { ...p, [c.path === 'translation' ? 't' : c.path === 'rotation' ? 'r' : 's']: v };
  }
  return pose;
}

/** 姿勢 a と b を混ぜる（w = 0 で a、1 で b） */
export function blendPose(a: Pose, b: Pose, w: number): Pose {
  return a.map((x, i) => {
    const y = b[i];
    if (!x || !y) return x ?? y;
    return { t: x.t.map((v, k) => v + (y.t[k] - v) * w), r: mixQuat(x.r, y.r, w), s: x.s.map((v, k) => v + (y.s[k] - v) * w) };
  });
}

/** ノードの世界の行列（モデルの座標。親から先に） */
export function poseMatrices(model: GltfModel, pose: Pose): Mat4[] {
  const out: Mat4[] = new Array(model.nodes.length);
  for (const i of model.order) {
    const n = model.nodes[i], p = pose[i];
    const local = p ? composeQuat(p.t, p.r, p.s) : n.local;
    out[i] = n.parent >= 0 && out[n.parent] ? multiply(out[n.parent], local) : local;
  }
  for (let i = 0; i < out.length; i++) out[i] ??= model.nodes[i].world;
  return out;
}

/** 骨の行列（16個ずつ並べる。頂点を モデルの座標の中で 動かす行列 = 骨の世界の行列 × 元の姿勢の逆） */
export function jointMatrices(model: GltfModel, skin: number, worlds: Mat4[]): Float32Array {
  const sk = model.skins[skin];
  const out = new Float32Array((sk?.joints.length ?? 0) * 16);
  sk?.joints.forEach((j, k) => out.set(multiply(worlds[j] ?? model.nodes[j].world, sk.inverseBind[k]), k * 16));
  return out;
}

/**
 * Model3D の値から、いまの姿勢のノードの行列を求める（clip が空・見つからなければ元の姿勢）。
 * 切り替えの途中（fadeLeft > 0）は、前の動き prevClip の、切り替えた時の姿勢（prevTime）と混ぜる
 */
export function modelPose(model: GltfModel, c: { clip?: string; time?: number; loop?: boolean; prevClip?: string; prevTime?: number; fade?: number; fadeLeft?: number }): Mat4[] | null {
  const find = (name?: string) => (name ? model.animations.find((a) => a.name === name) ?? null : null);
  const cur = find(c.clip), prev = find(c.prevClip);
  if (!cur && !prev) return model.skins.length ? poseMatrices(model, samplePose(model, null, 0)) : null;
  let pose = samplePose(model, cur, cur ? clipTime(cur, c.time ?? 0, c.loop !== false) : 0);
  const fade = c.fade ?? 0, left = c.fadeLeft ?? 0;
  if (left > 0 && fade > 0) pose = blendPose(samplePose(model, prev, prev ? clipTime(prev, c.prevTime ?? 0, false) : 0), pose, 1 - Math.min(1, left / fade));
  return poseMatrices(model, pose);
}
