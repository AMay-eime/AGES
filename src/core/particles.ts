// パーティクルの命令。ロジックは「いつ・どの物から・いくつ出すか」だけを決め、粒を動かして描くのは描く側。
// 画面なしの実行でも、何回出したかが ages run の要約に載る。

export interface ParticleCmd {
  t: 'burst';
  frame: number;
  /** 出す物の ID */
  id: string;
  count: number;
}

export interface ParticleApi {
  /** 一度に出す（count を省くと Particles.burst の数） */
  burst(id: string, count?: number): void;
  /** 出し続けるのを始める・止める（Particles.playing を変える） */
  play(id: string): void;
  stop(id: string): void;
}
