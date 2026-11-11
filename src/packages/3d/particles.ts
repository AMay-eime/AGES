// 3D のパーティクルを動かす側（描く側）。ゲームの結果には関わらないので、乱数も描く側のものを使う（2D の ParticleSim と同じ考え方）。
// 「出す」合図は部品の値（Particles3D.bursts。ゲームのコードは burst3 で増やす）で受け取る。GL に頼らないので Node でも動く
import { transformDirection, type Mat4, type Vec3 } from './math.ts';
import { matrixOf } from './space.ts';
import type { World } from '../../core/world.ts';

export interface Particle3 { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; rot: number }

/** Particles3D の値（描く側が読むもの） */
export interface Particles3DValues {
  burst: number; rate: number; playing: boolean; duration: number; lifetime: number; lifetimeJitter: number;
  speed: number; speedJitter: number; direction: Vec3; spread: number; radius: number; gravity: Vec3; drag: number;
  sizeStart: number; sizeEnd: number; colorStart: string; colorEnd: string; alphaStart: number; alphaEnd: number;
  shape: string; image: string; spin: number; blend: string; world: boolean; max: number;
  bursts: number; burstCount: number; since: number; age: number;
}

export interface Emitter3 {
  id: string;
  /** 最後に見た設定と、出し口の世界の行列（物が消えた後も、残った粒はこれで動かす） */
  p: Particles3DValues;
  matrix: Mat4;
  parts: Particle3[];
  acc: number;
  t: number;
  alive: boolean;
  /** ここまで出した「出す」合図の数 */
  last: number;
  /** 最後に見た age（戻ったら、世界が作り直された = 出し口も初めから） */
  age: number;
  previewAt?: number;
}

/** ゲームのコードから: 一度に出す（count を省くと Particles3D.burst の数）。画面なしの実行でも bursts が増えるので確かめられる */
export function burst3(world: World, id: string, count?: number): void {
  const c = world.entities.get(id)?.c.Particles3D as { bursts: number; burstCount: number; since: number } | undefined;
  if (!c) return;
  c.bursts = (c.bursts ?? 0) + 1;
  c.burstCount = Math.max(0, Math.floor(count ?? 0));
  c.since = 0;
}

export class ParticleSim3D {
  readonly emitters = new Map<string, Emitter3>();
  private seed = 0x2545f491;
  private rand(): number {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  clear(): void { this.emitters.clear(); }

  count(): number {
    let n = 0;
    for (const em of this.emitters.values()) n += em.parts.length;
    return n;
  }

  private spawn(em: Emitter3): void {
    const p = em.p, m = em.matrix;
    if (em.parts.length >= p.max) return;
    const j = (v: number, k: number) => v * (1 + (this.rand() * 2 - 1) * k);
    // 向き: direction（物から見た向き）を軸に、spread 度の円すいの中で均等に。360 で全方向
    const dl = Math.hypot(p.direction[0], p.direction[1], p.direction[2]) || 1;
    const axis: Vec3 = [p.direction[0] / dl, p.direction[1] / dl, p.direction[2] / dl];
    const half = (Math.min(360, Math.max(0, p.spread)) / 2) * (Math.PI / 180);
    const cos = 1 - this.rand() * (1 - Math.cos(half)), sin = Math.sqrt(Math.max(0, 1 - cos * cos)), ph = this.rand() * Math.PI * 2;
    const ref: Vec3 = Math.abs(axis[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const u: Vec3 = norm([axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]]);
    const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    const local: Vec3 = [0, 1, 2].map((k) => axis[k] * cos + (u[k] * Math.cos(ph) + v[k] * Math.sin(ph)) * sin) as Vec3;
    const dir = p.world ? norm(transformDirection(m, local)) : local;
    const sp = j(p.speed, p.speedJitter);
    // 出る場所: 物の位置を中心にした球の中
    let o: Vec3 = [0, 0, 0];
    if (p.radius > 0) {
      const r = Math.cbrt(this.rand()) * p.radius, a = this.rand() * Math.PI * 2, c = this.rand() * 2 - 1, s = Math.sqrt(1 - c * c);
      o = [Math.cos(a) * s * r, c * r, Math.sin(a) * s * r];
    }
    const base: Vec3 = p.world ? [m[12], m[13], m[14]] : [0, 0, 0];
    em.parts.push({ x: base[0] + o[0], y: base[1] + o[1], z: base[2] + o[2], vx: dir[0] * sp, vy: dir[1] * sp, vz: dir[2] * sp, age: 0, life: Math.max(0.01, j(p.lifetime, p.lifetimeJitter)), rot: this.rand() * 360 });
  }

  /**
   * dt 秒だけ進める。previewIds を渡すのは編集中（ゲームを動かしていない）: 選んだ物だけが粒を出し、粒がなくなったらまた出す
   */
  update(world: World, dt: number, previewIds?: string[]): void {
    const editing = previewIds !== undefined;
    for (const em of this.emitters.values()) em.alive = false;
    const live: Emitter3[] = [];
    for (const e of world.entities.values()) {
      const p = e.c.Particles3D as Particles3DValues | undefined;
      if (!p) continue;
      const m = matrixOf(world, e);
      if (!m) continue;
      if (editing && !previewIds!.includes(e.id) && !this.emitters.has(e.id)) continue;
      let em = this.emitters.get(e.id);
      // プレイを始めた・止めたとき（同じ ID の物が、初めからになった）は、出し口も初めから
      if (em && (p.age ?? 0) < em.age) { this.emitters.delete(e.id); em = undefined; }
      if (!em) {
        // 初めて見た出し口: 出たばかりの合図（2フレーム以内）だけを出す。前からあった合図は出し直さない
        em = { id: e.id, p, matrix: m, parts: [], acc: 0, t: 0, alive: true, age: 0, last: (p.bursts ?? 0) > 0 && (p.since ?? 9999) <= 2 ? p.bursts - 1 : (p.bursts ?? 0) };
        this.emitters.set(e.id, em);
      }
      em.p = { ...p };
      em.matrix = m;
      em.age = p.age ?? 0;
      em.alive = true;
      live.push(em);
    }
    // 出ている粒を動かす
    for (const em of this.emitters.values()) {
      const p = em.p, damp = p.drag ? Math.exp(-p.drag * dt) : 1, g = p.gravity ?? [0, 0, 0];
      em.parts = em.parts.filter((q) => {
        q.age += dt;
        if (q.age >= q.life) return false;
        q.vx = (q.vx + g[0] * dt) * damp; q.vy = (q.vy + g[1] * dt) * damp; q.vz = (q.vz + g[2] * dt) * damp;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        q.rot += p.spin * dt;
        return true;
      });
    }
    // 出す: 一度に出す合図と、出し続ける分
    for (const em of live) {
      const p = em.p;
      if (!editing) {
        if ((p.bursts ?? 0) > em.last) {
          const n = (p.bursts - em.last) * (p.burstCount > 0 ? p.burstCount : p.burst);
          for (let i = 0; i < n; i++) this.spawn(em);
        }
        em.last = p.bursts ?? 0;
        em.t += dt;
        if (p.playing !== false && p.rate > 0 && (p.duration < 0 || em.t <= p.duration)) {
          em.acc += p.rate * dt;
          while (em.acc >= 1) { this.spawn(em); em.acc--; }
        }
      } else if (previewIds!.includes(em.id)) {
        if (p.rate > 0 && !p.burst) {
          em.acc += p.rate * dt;
          while (em.acc >= 1) { this.spawn(em); em.acc--; }
        } else if (em.parts.length === 0) {
          em.previewAt = (em.previewAt ?? 1) + dt;
          if (em.previewAt > 0.4) { em.previewAt = 0; for (let i = 0; i < Math.max(1, p.burst); i++) this.spawn(em); }
        }
      }
    }
    for (const [id, em] of this.emitters) if (!em.alive && em.parts.length === 0) this.emitters.delete(id);
  }

  /** 粒の世界での位置（world が false の出し口は、物についていく） */
  static position(em: Emitter3, q: Particle3): Vec3 {
    if (em.p.world) return [q.x, q.y, q.z];
    const m = em.matrix;
    return [m[0] * q.x + m[4] * q.y + m[8] * q.z + m[12], m[1] * q.x + m[5] * q.y + m[9] * q.z + m[13], m[2] * q.x + m[6] * q.y + m[10] * q.z + m[14]];
  }

  /** 1粒の今の見た目（大きさ m・色 0〜1・不透明度） */
  static look(p: Particles3DValues, q: Particle3): { size: number; color: Vec3; alpha: number } {
    const k = q.age / q.life, a = rgbOf(p.colorStart), b = rgbOf(p.colorEnd);
    return {
      size: p.sizeStart + (p.sizeEnd - p.sizeStart) * k,
      color: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k],
      alpha: Math.max(0, Math.min(1, p.alphaStart + (p.alphaEnd - p.alphaStart) * k)),
    };
  }
}

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
function rgbOf(hex: string): Vec3 {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return Number.isNaN(n) ? [1, 1, 1] : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
