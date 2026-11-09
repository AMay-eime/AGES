// パーティクルを動かす側（描く側）。ロジックからの「出す」命令と、Particles の設定（rate など）で粒を出し、時間で動かす。
// ゲームの結果には関わらないので、実時間で動かし、乱数も描く側のものを使う。
import type { World, Entity } from '../core/world.ts';
import { lerpValue } from '../core/tween.ts';

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; rot: number;
}

interface Emitter {
  /** 最後に見た Particles の設定と位置（物が消えた後も、残った粒はこの設定で動かす） */
  ghost: Entity;
  parts: Particle[];
  /** rate で出す数の端数 */
  acc: number;
  /** 出し始めてからの秒数 */
  t: number;
  alive: boolean;
  /** エディタの試しの再生: 粒がなくなったら、また出す */
  previewAt?: number;
}

export class ParticleSim {
  readonly emitters = new Map<string, Emitter>();
  private seed = 0x9e3779b9;
  private rand(): number {
    // 描く側だけの乱数（ゲームの乱数を使わない）
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  /** 一度に出す（ロジックからの命令） */
  burst(world: World, id: string, count: number): void {
    const e = world.get(id);
    if (!e?.c.Particles || !e.c.Transform) return;
    const em = this.emitter(e);
    for (let i = 0; i < count; i++) this.spawn(em);
  }

  clear(): void {
    this.emitters.clear();
  }

  private emitter(e: Entity): Emitter {
    let em = this.emitters.get(e.id);
    if (!em) {
      em = { ghost: snapshot(e), parts: [], acc: 0, t: 0, alive: true };
      this.emitters.set(e.id, em);
    }
    em.ghost = snapshot(e);
    return em;
  }

  private spawn(em: Emitter): void {
    const p = em.ghost.c.Particles, tr = em.ghost.c.Transform;
    if (em.parts.length >= p.max) return;
    const j = (v: number, k: number) => v * (1 + (this.rand() * 2 - 1) * k);
    const ang = ((p.angle + (this.rand() - 0.5) * p.spread) * Math.PI) / 180;
    const sp = j(p.speed, p.speedJitter);
    const r = p.radius ? Math.sqrt(this.rand()) * p.radius : 0, ra = this.rand() * Math.PI * 2;
    const ox = Math.cos(ra) * r, oy = Math.sin(ra) * r;
    em.parts.push({
      x: (p.world ? tr.x : 0) + ox, y: (p.world ? tr.y : 0) + oy,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      age: 0, life: Math.max(0.01, j(p.lifetime, p.lifetimeJitter)), rot: this.rand() * 360,
    });
  }

  /** dt 秒だけ進める。world の Particles の物から、rate の分を出す */
  /** previewIds を渡すのは編集中（ゲームを動かしていない）。そのときは選んだ物だけが粒を出し、残りの粒は消えるまで動かす */
  update(world: World, dt: number, previewIds?: string[]): void {
    const editing = previewIds !== undefined;
    // 1. 今ある出し口（物が消えたものは、最後に見た設定のまま残りの粒を動かす）
    for (const em of this.emitters.values()) em.alive = false;
    const live: Entity[] = [];
    for (const e of world.entities.values()) {
      if (!e.c.Particles || !e.c.Transform) continue;
      if (editing && !this.emitters.has(e.id)) continue;
      this.emitter(e).alive = true;
      live.push(e);
    }
    // 2. 出ている粒を動かす（このフレームに出す粒は、出たばかりなので動かさない）
    for (const em of this.emitters.values()) {
      const p = em.ghost.c.Particles;
      const damp = p.drag ? Math.exp(-p.drag * dt) : 1;
      const [gx, gy] = p.gravity ?? [0, 0];
      em.parts = em.parts.filter((q) => {
        q.age += dt;
        if (q.age >= q.life) return false;
        q.vx = (q.vx + gx * dt) * damp;
        q.vy = (q.vy + gy * dt) * damp;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.rot += p.spin * dt;
        return true;
      });
    }
    // 3. 出す。再生中は rate の分（duration の間）
    if (!editing) {
      for (const e of live) {
        const p = e.c.Particles, em = this.emitters.get(e.id)!;
        em.t += dt;
        if (p.playing !== false && p.rate > 0 && (p.duration < 0 || em.t <= p.duration)) {
          em.acc += p.rate * dt;
          while (em.acc >= 1) { this.spawn(em); em.acc--; }
        }
      }
    }
    // 編集中の試しの再生: 選んだ物は、粒がなくなったら少し置いてまた出す
    for (const id of previewIds ?? []) {
      const e = world.get(id);
      const p = e?.c.Particles;
      if (!e || !p || !e.c.Transform) continue;
      const em = this.emitter(e);
      em.alive = true;
      if (p.rate > 0 && !p.burst) {
        em.acc += p.rate * dt;
        while (em.acc >= 1) { this.spawn(em); em.acc--; }
      } else if (em.parts.length === 0) {
        em.previewAt = (em.previewAt ?? 1) + dt; // 選んですぐは待たずに出す
        if (em.previewAt > 0.4) {
          em.previewAt = 0;
          for (let i = 0; i < Math.max(1, p.burst); i++) this.spawn(em);
        }
      }
    }
    // 4. 物が消えて粒もなくなったら忘れる
    for (const [id, em] of this.emitters) if (!em.alive && em.parts.length === 0) this.emitters.delete(id);
  }

  /** 1粒の今の見た目 */
  static look(p: Entity['c'][string], q: Particle): { size: number; color: string; alpha: number } {
    const k = q.age / q.life;
    return {
      size: p.sizeStart + (p.sizeEnd - p.sizeStart) * k,
      color: lerpValue(p.colorStart, p.colorEnd, k) as string,
      alpha: Math.max(0, Math.min(1, p.alphaStart + (p.alphaEnd - p.alphaStart) * k)),
    };
  }

  /** 物が消えても粒が残っている出し口（描く順番に入れる） */
  orphans(): Entity[] {
    return [...this.emitters.values()].filter((em) => !em.alive && em.parts.length).map((em) => em.ghost);
  }

  /** 今出ている粒の数（エディタの表示用） */
  count(): number {
    let n = 0;
    for (const em of this.emitters.values()) n += em.parts.length;
    return n;
  }
}

function snapshot(e: Entity): Entity {
  return { id: e.id, name: e.name, tags: e.tags, c: { Transform: { ...e.c.Transform }, Particles: { ...e.c.Particles }, ...(e.c.Effect ? { Effect: { ...e.c.Effect, params: { ...e.c.Effect.params } } } : {}) } };
}
