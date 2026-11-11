// 3D の計算（ベクトル・行列・回転）。依存なし。ブラウザでも Node でも同じ結果になる（ages run で確かめられる）。
// 決まり: 右手系・Y が上・単位はメートル（glTF・three.js と同じ）。行列は列が先（column-major）の16個の数。
// 回転は度。順番は ry（左右。上から見て反時計回りが正）→ rx（上下）→ rz（傾き）で、行列では R = Ry·Rx·Rz。
// 物の「前」は +Z（glTF のモデルの向き）、カメラが見る向きは −Z。

export type Vec3 = [number, number, number];
/** 4x4 の行列（列が先。m[12..14] が位置） */
export type Mat4 = number[];

const RAD = Math.PI / 180;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
/** 長さ1にする（長さ0なら [0, 0, 0]） */
export const normalize = (a: Vec3): Vec3 => { const l = length(a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** a·b（b を先に、a を後にかける） */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** 回転の3つの軸（行列の左上 3x3 の列）。R = Ry·Rx·Rz */
export function rotationAxes(rx: number, ry: number, rz: number): [Vec3, Vec3, Vec3] {
  const cx = Math.cos(rx * RAD), sx = Math.sin(rx * RAD), cy = Math.cos(ry * RAD), sy = Math.sin(ry * RAD), cz = Math.cos(rz * RAD), sz = Math.sin(rz * RAD);
  return [
    [cy * cz + sy * sx * sz, cx * sz, -sy * cz + cy * sx * sz],
    [-cy * sz + sy * sx * cz, cx * cz, sy * sz + cy * sx * cz],
    [sy * cx, -sx, cy * cx],
  ];
}

/** 位置・回転（度）・倍率から行列を作る */
export function compose(pos: Vec3, rot: Vec3, scl: Vec3 = [1, 1, 1]): Mat4 {
  const [x, y, z] = rotationAxes(rot[0], rot[1], rot[2]);
  return [
    x[0] * scl[0], x[1] * scl[0], x[2] * scl[0], 0,
    y[0] * scl[1], y[1] * scl[1], y[2] * scl[1], 0,
    z[0] * scl[2], z[1] * scl[2], z[2] * scl[2], 0,
    pos[0], pos[1], pos[2], 1,
  ];
}

/** 軸（長さ1）のまわりに deg 度回す行列（右ねじの向き） */
export function rotationAbout(axis: Vec3, deg: number): Mat4 {
  const [x, y, z] = axis, c = Math.cos(deg * RAD), s = Math.sin(deg * RAD), t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

export function translation(p: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1];
}

/** 位置・回転（クォータニオン x y z w）・倍率から行列を作る（glTF のノード） */
export function composeQuat(t: number[], q: number[], s: number[]): Mat4 {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/** 行列を位置・回転（度）・倍率に戻す（compose の逆。斜めにつぶれた行列は近い値になる） */
export function decompose(m: Mat4): { pos: Vec3; rot: Vec3; scale: Vec3 } {
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]);
  let sz = Math.hypot(m[8], m[9], m[10]);
  // 鏡写し（向きが裏返っている）なら、z の倍率を負にする
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sz = -sz;
  const zx = m[8] / (sz || 1), zy = m[9] / (sz || 1), zz = m[10] / (sz || 1);
  const xy = m[1] / (sx || 1), yy = m[5] / (sy || 1);
  const rx = Math.asin(Math.max(-1, Math.min(1, -zy)));
  let ry: number, rz: number;
  if (Math.abs(zy) < 0.999999) {
    ry = Math.atan2(zx, zz);
    rz = Math.atan2(xy, yy);
  } else {
    // 真上・真下を向いている（ry と rz が区別できない）: rz を 0 にする
    ry = Math.atan2(-m[2] / (sx || 1), m[0] / (sx || 1));
    rz = 0;
  }
  return { pos: [m[12], m[13], m[14]], rot: [rx / RAD, ry / RAD, rz / RAD], scale: [sx, sy, sz] };
}

/** 逆行列（つぶれていて求められないときは null） */
export function invert(m: Mat4): Mat4 | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-14) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/** 点を行列で動かす（遠近の割り算つき） */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] || 1;
  return [(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w, (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w, (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w];
}

/** 向きを行列で回す（位置は足さない） */
export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

export const positionOf = (m: Mat4): Vec3 => [m[12], m[13], m[14]];

/** 遠近のある映し方。fov は縦の見える角度（度）、aspect は 幅÷高さ */
export function perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fov * RAD) / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

/** 遠近のない映し方。size は縦に見える半分の長さ（m） */
export function orthographic(size: number, aspect: number, near: number, far: number): Mat4 {
  const nf = 1 / (near - far);
  return [1 / (size * aspect), 0, 0, 0, 0, 1 / size, 0, 0, 0, 0, 2 * nf, 0, 0, 0, (far + near) * nf, 1];
}

/**
 * from から to を向く回転（度。rz は 0）。物は +Z が前、カメラ（camera = true）は −Z が見る向き
 */
export function lookRotation(from: Vec3, to: Vec3, camera = false): { rx: number; ry: number } {
  const d = normalize(sub(to, from));
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) return { rx: 0, ry: 0 };
  const k = camera ? -1 : 1;
  const rx = -k * Math.asin(Math.max(-1, Math.min(1, d[1])));
  // 真上・真下では左右の向きが決まらないので 0
  const ry = Math.abs(d[0]) < 1e-9 && Math.abs(d[2]) < 1e-9 ? 0 : Math.atan2(k * d[0], k * d[2]);
  return { rx: round6(rx / RAD), ry: round6(ry / RAD) };
}

/** 角度を −180〜180 に */
export function wrapAngle(deg: number): number {
  const a = ((deg + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6 || 0;
