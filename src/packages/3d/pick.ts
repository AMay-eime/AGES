// 光線で物を選ぶ（エディタのクリック・ゲームの狙い・AI の確かめ）。形ごとの箱（球は球）と光線の交わりを求める
import { invert, transformDirection, transformPoint, type Mat4, type Vec3 } from './math.ts';

export interface Ray { origin: Vec3; dir: Vec3 }
/** 形のある物（world は大きさ size をかける前の世界の行列） */
export interface Solid { id: string; matrix: Mat4; shape: string; size: Vec3 }

/** 形を囲む箱の半分の大きさ（物から見た向き） */
export function halfExtents(shape: string, size: Vec3): Vec3 {
  switch (shape) {
    case 'sphere': return [size[0] / 2, size[0] / 2, size[0] / 2];
    case 'cylinder': return [size[0] / 2, size[1] / 2, size[0] / 2];
    case 'capsule': return [size[0] / 2, Math.max(size[0], size[1]) / 2, size[0] / 2];
    case 'plane': return [size[0] / 2, 0.02, size[2] / 2];
    default: return [size[0] / 2, size[1] / 2, size[2] / 2];
  }
}

/** 光線が物に当たる所までの距離（光線の向きの長さを1として）。当たらなければ null */
export function hitSolid(ray: Ray, s: Solid): number | null {
  const inv = invert(s.matrix);
  if (!inv) return null;
  const o = transformPoint(inv, ray.origin), d = transformDirection(inv, ray.dir);
  const h = halfExtents(s.shape, s.size);
  if (s.shape === 'sphere') {
    // |o + t d|² = r²
    const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], b = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]), c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - h[0] * h[0];
    const disc = b * b - 4 * a * c;
    if (a < 1e-18 || disc < 0) return null;
    const t0 = (-b - Math.sqrt(disc)) / (2 * a), t1 = (-b + Math.sqrt(disc)) / (2 * a);
    return t0 >= 0 ? t0 : t1 >= 0 ? t1 : null;
  }
  let near = -Infinity, far = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < -h[k] || o[k] > h[k]) return null; continue; }
    let a = (-h[k] - o[k]) / d[k], b = (h[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  return far < 0 ? null : Math.max(near, 0);
}

/** 光線が最初に当たる物（近い順に全部） */
export function pickSolids(ray: Ray, solids: Solid[]): { id: string; distance: number }[] {
  const out: { id: string; distance: number }[] = [];
  for (const s of solids) { const t = hitSolid(ray, s); if (t !== null) out.push({ id: s.id, distance: t }); }
  return out.sort((a, b) => a.distance - b.distance);
}
