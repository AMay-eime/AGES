// 基本の形（箱・球・円柱・カプセル・板）の頂点。位置・面の向き（法線）・UV を 8 個ずつ並べる。
// 箱・球・円柱・板は 1m の大きさで作り、Mesh3D.size で伸ばす。カプセルは丸い所がつぶれないよう、その大きさで作る。
export interface Geometry {
  /** 頂点ごとに x y z nx ny nz u v */
  vertices: Float32Array;
  indices: Uint16Array;
}

class Builder {
  v: number[] = [];
  i: number[] = [];
  get count(): number { return this.v.length / 8; }
  vert(p: number[], n: number[], u: number, v: number): number { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], u, v); return this.count - 1; }
  quad(a: number, b: number, c: number, d: number): void { this.i.push(a, b, c, a, c, d); }
  done(): Geometry { return { vertices: new Float32Array(this.v), indices: new Uint16Array(this.i) }; }
}

export function box(): Geometry {
  const b = new Builder();
  // 面ごとに: 向き n、横 u、縦 v
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  for (const [n, u, v] of faces) {
    const at = (s: number, t: number) => [0, 1, 2].map((k) => (n[k] + u[k] * s + v[k] * t) * 0.5);
    const a = b.vert(at(-1, -1), n, 0, 1), c = b.vert(at(1, -1), n, 1, 1), d = b.vert(at(1, 1), n, 1, 0), e = b.vert(at(-1, 1), n, 0, 0);
    b.quad(a, c, d, e);
  }
  return b.done();
}

/** 上向きの板（XZ の面。1m 四方） */
export function plane(): Geometry {
  const b = new Builder();
  const n = [0, 1, 0];
  b.quad(b.vert([-0.5, 0, 0.5], n, 0, 1), b.vert([0.5, 0, 0.5], n, 1, 1), b.vert([0.5, 0, -0.5], n, 1, 0), b.vert([-0.5, 0, -0.5], n, 0, 0));
  return b.done();
}

/** 輪を積んで作る（球・カプセル）。rings は [半径, 高さ, 法線の横, 法線の縦, v] の並び */
function lathe(rings: [number, number, number, number, number][], seg: number): Geometry {
  const b = new Builder();
  for (const [r, y, nr, ny, v] of rings) {
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2, cx = Math.sin(a), cz = Math.cos(a);
      b.vert([r * cx, y, r * cz], [nr * cx, ny, nr * cz], s / seg, v);
    }
  }
  for (let k = 0; k < rings.length - 1; k++) {
    for (let s = 0; s < seg; s++) {
      const a = k * (seg + 1) + s, c = a + seg + 1;
      b.quad(a, c, c + 1, a + 1);
    }
  }
  return b.done();
}

export function sphere(seg = 24, rows = 16): Geometry {
  const rings: [number, number, number, number, number][] = [];
  for (let k = 0; k <= rows; k++) {
    const t = (k / rows) * Math.PI;
    rings.push([Math.sin(t) * 0.5, Math.cos(t) * 0.5, Math.sin(t), Math.cos(t), k / rows]);
  }
  return lathe(rings, seg);
}

export function cylinder(seg = 24): Geometry {
  // ふた（上・下）は法線が違うので、輪を分ける
  return lathe([
    [0, 0.5, 0, 1, 0], [0.5, 0.5, 0, 1, 0],
    [0.5, 0.5, 1, 0, 0], [0.5, -0.5, 1, 0, 1],
    [0.5, -0.5, 0, -1, 1], [0, -0.5, 0, -1, 1],
  ], seg);
}

/** カプセル（太さ diameter・全体の高さ height。高さが太さより小さければ球になる） */
export function capsule(diameter: number, height: number, seg = 24, rows = 8): Geometry {
  const r = diameter / 2, half = Math.max(0, height / 2 - r);
  const rings: [number, number, number, number, number][] = [];
  const total = Math.PI * r + half * 2 || 1;
  for (let k = 0; k <= rows; k++) {
    const t = (k / rows) * (Math.PI / 2);
    rings.push([Math.sin(t) * r, half + Math.cos(t) * r, Math.sin(t), Math.cos(t), (t * r) / total]);
  }
  for (let k = 0; k <= rows; k++) {
    const t = Math.PI / 2 + (k / rows) * (Math.PI / 2);
    rings.push([Math.sin(t) * r, -half + Math.cos(t) * r, Math.sin(t), Math.cos(t), ((Math.PI / 2) * r + half * 2 + (t - Math.PI / 2) * r) / total]);
  }
  return lathe(rings, seg);
}

export const SHAPES = ['box', 'sphere', 'cylinder', 'capsule', 'plane'] as const;
export type ShapeName = (typeof SHAPES)[number];
