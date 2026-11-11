// 3D の物の、世界での位置・向き（親をたどる）と、カメラ（世界 → 画面、画面 → 世界の光線）。
// 状態を持たない（そのつど求める）。描画・エディタ・AI 向けの確かめ（文字で空間を見る）で同じものを使う。
import type { World, Entity } from '../../core/world.ts';
import { compose, identity, invert, lookRotation, multiply, normalize, orthographic, perspective, positionOf, sub, transformDirection, transformPoint, type Mat4, type Vec3 } from './math.ts';

/** Transform3D の値 */
export interface Pose3 { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number; parent?: string | null }

/** 親子の深さの上限（輪になっていても止まる） */
const MAX_DEPTH = 32;

export function localMatrix(t: Partial<Pose3>): Mat4 {
  return compose([t.x ?? 0, t.y ?? 0, t.z ?? 0], [t.rx ?? 0, t.ry ?? 0, t.rz ?? 0], [t.sx ?? 1, t.sy ?? 1, t.sz ?? 1]);
}

/** 世界での行列。get は ID から Transform3D を引く関数（実行中の World でも、シーンのデータでも使えるように） */
export function worldMatrix(get: (id: string) => Partial<Pose3> | undefined, t: Partial<Pose3>, depth = 0): Mat4 {
  const m = localMatrix(t);
  if (!t.parent || depth >= MAX_DEPTH) return m;
  const pt = get(t.parent);
  return pt && pt !== t ? multiply(worldMatrix(get, pt, depth + 1), m) : m;
}

const poseIn = (world: World) => (id: string) => world.get(id)?.c.Transform3D as Partial<Pose3> | undefined;
const entityOf = (world: World, e: Entity | string): Entity | undefined => (typeof e === 'string' ? world.get(e) : e);

/** 物の世界での行列（Transform3D がなければ null） */
export function matrixOf(world: World, e: Entity | string): Mat4 | null {
  const t = entityOf(world, e)?.c.Transform3D as Partial<Pose3> | undefined;
  return t ? worldMatrix(poseIn(world), t) : null;
}

/** 物の世界での位置 [x, y, z]（Transform3D がなければ null） */
export function worldPosition(world: World, e: Entity | string): Vec3 | null {
  const m = matrixOf(world, e);
  return m ? positionOf(m) : null;
}

/** 物の前（+Z）の向き（世界の向き。長さ1）。カメラが見る向きは、これの逆 */
export function forwardOf(world: World, e: Entity | string): Vec3 | null {
  const m = matrixOf(world, e);
  return m ? normalize(transformDirection(m, [0, 0, 1])) : null;
}

/** 物を point の方へ向ける（rx・ry を書き換える。親のない物向け）。カメラなら camera = true */
export function lookAt(world: World, e: Entity | string, point: Vec3, camera = false): void {
  const ent = entityOf(world, e);
  const t = ent?.c.Transform3D as Pose3 | undefined;
  const from = ent ? worldPosition(world, ent) : null;
  if (!t || !from) return;
  const r = lookRotation(from, point, camera);
  t.rx = r.rx;
  t.ry = r.ry;
  t.rz = 0;
}

/** カメラ（世界 → 画面） */
export interface CameraView3 {
  /** カメラの物の ID（カメラを置いていないときの既定のカメラは ''） */
  id: string;
  pos: Vec3;
  /** 見ている向き（長さ1） */
  dir: Vec3;
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  /** viewProj の逆（画面 → 世界） */
  inverse: Mat4;
  ortho: boolean;
  near: number;
  far: number;
}

interface CameraValues { enabled?: boolean; projection?: string; fov?: number; size?: number; near?: number; far?: number }

/** 行列とカメラの値からカメラを作る（aspect は 幅÷高さ） */
export function cameraFrom(id: string, world: Mat4, c: CameraValues, aspect: number): CameraView3 {
  const near = c.near ?? 0.1, far = Math.max(c.far ?? 200, near + 0.001);
  const ortho = c.projection === 'ortho';
  // カメラの向きに倍率はかけない（大きさを変えても映り方は変わらない）
  const pos = positionOf(world);
  const x = normalize([world[0], world[1], world[2]]), y = normalize([world[4], world[5], world[6]]), z = normalize([world[8], world[9], world[10]]);
  const rigid: Mat4 = [...x, 0, ...y, 0, ...z, 0, ...pos, 1];
  const view = invert(rigid) ?? identity();
  const proj = ortho ? orthographic(c.size ?? 5, aspect, near, far) : perspective(c.fov ?? 60, aspect, near, far);
  const viewProj = multiply(proj, view);
  return { id, pos, dir: [-z[0], -z[1], -z[2]], view, proj, viewProj, inverse: invert(viewProj) ?? identity(), ortho, near, far };
}

/** カメラを置いていないときのカメラ（少し上・手前から原点を見る） */
export function defaultCamera3(aspect: number): CameraView3 {
  const pos: Vec3 = [0, 3, 8];
  const r = lookRotation(pos, [0, 0.5, 0], true);
  return cameraFrom('', compose(pos, [r.rx, r.ry, 0]), {}, aspect);
}

/** いま使うカメラ（enabled の Camera3D の最初の1つ。なければ既定のカメラ） */
export function cameraOf(world: World, aspect: number): CameraView3 {
  for (const e of world.entities.values()) {
    const c = e.c.Camera3D as CameraValues | undefined;
    if (!c || c.enabled === false) continue;
    const m = matrixOf(world, e);
    if (m) return cameraFrom(e.id, m, c, aspect);
  }
  return defaultCamera3(aspect);
}

/**
 * 世界の点が画面のどこに映るか。x・y は画面の px（左上が 0）、depth はカメラからの奥行き（m）。
 * カメラの後ろ（映らない）なら null
 */
export function toScreen(cam: CameraView3, p: Vec3, width: number, height: number): { x: number; y: number; depth: number } | null {
  const depth = (p[0] - cam.pos[0]) * cam.dir[0] + (p[1] - cam.pos[1]) * cam.dir[1] + (p[2] - cam.pos[2]) * cam.dir[2];
  if (!cam.ortho && depth <= 1e-6) return null;
  const n = transformPoint(cam.viewProj, p);
  return { x: (n[0] * 0.5 + 0.5) * width, y: (0.5 - n[1] * 0.5) * height, depth };
}

/** 画面の点（px）から世界へ伸びる光線（クリックで選ぶ・狙う） */
export function screenRay(cam: CameraView3, sx: number, sy: number, width: number, height: number): { origin: Vec3; dir: Vec3 } {
  const nx = (sx / width) * 2 - 1, ny = 1 - (sy / height) * 2;
  const a = transformPoint(cam.inverse, [nx, ny, -1]), b = transformPoint(cam.inverse, [nx, ny, 1]);
  return { origin: a, dir: normalize(sub(b, a)) };
}
