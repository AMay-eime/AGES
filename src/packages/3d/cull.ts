// 画面の外の物を描かないための判定（カメラの見える範囲 = 6つの面）。依存なし（Node でも同じ結果）
import type { Mat4, Vec3 } from './math.ts';

/** 面 [a, b, c, d]（a x + b y + c z + d ≥ 0 が内側。法線の長さは1） */
export type Plane = [number, number, number, number];

/** 映し方の行列（viewProj）から、見える範囲の6つの面（左・右・下・上・手前・奥）を取り出す */
export function frustumPlanes(m: Mat4): Plane[] {
  const row = (i: number): Plane => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const mix = (a: Plane, b: Plane, s: number): Plane => {
    const p: Plane = [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s, a[3] + b[3] * s];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / l, p[1] / l, p[2] / l, p[3] / l];
  };
  return [mix(r3, r0, 1), mix(r3, r0, -1), mix(r3, r1, 1), mix(r3, r1, -1), mix(r3, r2, 1), mix(r3, r2, -1)];
}

/** 球（中心と半径）が、見える範囲に少しでも入っているか（外側の面が1つでもあれば false） */
export function sphereVisible(planes: Plane[], c: Vec3, r: number): boolean {
  for (const p of planes) if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return false;
  return true;
}
