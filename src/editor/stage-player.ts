// 試しの舞台（api.stage）の時間の操作: 再生・一時停止・コマ送り・シーク・値が変わったときに同じフレームまで作り直す・回の終わり。
// DOM を使わない（Node のテストで確かめる）。画面に描くのは stage.ts。
// シークは状態を写しておかず、作り直して少しずつ進める（Game には状態を丸ごと戻す仕組みがなく、写し漏れで結果が変わるのを避けるため。速さは DECISIONS.md）
import type { Game } from '../core/game.ts';
import type { Trial } from '../core/trial.ts';
import type { StageSummary } from './window-api.ts';

/** 回の終わりから次の回までの間（秒。実時間） */
export const GAP = 0.4;

export interface PlayerSettings {
  fps: number;
  /** 1回の最大のフレーム数（Infinity で切らない） */
  limit: number;
  loop: boolean;
  speed: number;
  onCycle?(summary: StageSummary): void;
}

export class StagePlayer {
  trial: Trial | null = null;
  /** 作れなかった・止まった理由（あれば進めない） */
  error = '';
  /** 回の終わり（at は実時間の ms） */
  done: { at: number; gone: boolean } | null = null;
  paused = false;
  /** シークの行き先のフレーム（着くまで fastForward で少しずつ進める） */
  target: number | null = null;
  /** 早送り中（見た目だけの物＝粒は出さない） */
  ff = false;
  readonly frameFns = new Set<(game: Game) => void>();
  private acc = 0;
  private waiters: (() => void)[] = [];
  private make: () => Trial;
  private settings: () => PlayerSettings;

  constructor(make: () => Trial, settings: () => PlayerSettings) {
    this.make = make;
    this.settings = settings;
  }

  get game(): Game | null {
    return this.trial?.game ?? null;
  }

  /** 最初から作り直す（シークは取り消す） */
  build(): void {
    this.settle();
    this.create();
  }

  /** 作り直して、今のフレーム（シーク中ならその行き先）まで進める（値が変わったとき） */
  rebuildKeep(): void {
    const f = this.target ?? this.trial?.game.frame ?? 0;
    this.create();
    if (this.trial && f > 0) this.target = f;
    else this.settle();
  }

  /** その秒のフレームへ。前なら作り直す。着いたら（または取り消されたら）解決 */
  seek(seconds: number): Promise<void> {
    this.settle();
    const f = Math.max(0, Math.round(seconds * this.settings().fps));
    if (!this.trial || this.error || f < this.trial.game.frame) this.create();
    const t = this.trial;
    if (!t || this.error || this.done || t.game.frame >= f) return Promise.resolve();
    this.target = f;
    return new Promise((r) => this.waiters.push(r));
  }

  /** シークの行き先へ、ms のあいだ進める（少なくとも1フレーム）。着いたら解決する */
  fastForward(ms: number): void {
    if (this.target === null) return;
    const t0 = performance.now();
    this.ff = true;
    try {
      do {
        const t = this.trial;
        if (!t || this.error || this.done || t.game.frame >= this.target) break;
        this.advance();
      } while (performance.now() - t0 < ms);
    } finally {
      this.ff = false;
    }
    const t = this.trial;
    if (!t || this.error || this.done || t.game.frame >= this.target) this.settle();
  }

  /** 実時間で進める（dt 秒）。シーク中は進めない（fastForward で） */
  tick(dt: number, now = performance.now()): void {
    if (this.target !== null) return;
    const s = this.settings();
    if (this.done) {
      if (s.loop && !this.paused && (now - this.done.at) / 1000 > GAP) this.create();
      return;
    }
    if (this.paused || this.error || !this.trial) { this.acc = 0; return; }
    this.acc += dt * s.speed;
    let n = 0;
    while (this.acc >= 1 / s.fps) {
      if (++n > 16) { this.acc = 0; break; } // 追いつけないときは遅れを捨てる
      this.acc -= 1 / s.fps;
      if (!this.advance()) break;
    }
  }

  /** 一時停止して n フレーム進める */
  step(n = 1): void {
    this.settle();
    this.paused = true;
    for (let i = 0; i < n; i++) if (!this.advance()) break;
  }

  get playing(): boolean {
    return !this.paused;
  }
  set playing(v: boolean) {
    if (v && this.done) this.create();
    this.paused = !v;
  }

  /** 1フレーム進める。進めなかった・回が終わったら false */
  advance(): boolean {
    const t = this.trial;
    if (!t || this.error || this.done) return false;
    try {
      t.step();
    } catch (e) {
      this.error = (e as Error).message;
      this.settle();
      this.settings().onCycle?.(this.summary(false));
      return false;
    }
    for (const fn of this.frameFns) {
      try { fn(t.game); } catch (e) { console.error(e); }
    }
    const gone = t.gone();
    if (gone || t.game.frame >= this.settings().limit) {
      this.done = { at: performance.now(), gone };
      this.settings().onCycle?.(this.summary(gone));
      if (!this.settings().loop) this.paused = true;
    }
    return !this.done;
  }

  summary(gone: boolean): StageSummary {
    const g = this.trial?.game;
    return {
      frames: g?.frame ?? 0, gone,
      sounds: Object.fromEntries(g?.soundCounts ?? []), particles: Object.fromEntries(g?.particleCounts ?? []), events: Object.fromEntries(g?.counts ?? []),
      warnings: [...(g?.warnings ?? [])], ...(this.error ? { error: this.error } : {}),
    };
  }

  /** 待っているシークをすべて解決する */
  settle(): void {
    this.target = null;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  private create(): void {
    this.error = '';
    this.done = null;
    this.acc = 0;
    this.trial = null;
    try {
      this.trial = this.make();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }
}
