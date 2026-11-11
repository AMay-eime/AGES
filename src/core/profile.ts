// 速さの計測（ages run --perf）。システムごと・標準の処理ごとの時間を、フレームごとに取っておく。
// ゲームの結果には関わらない（測るだけ）。Game.profile に入れたときだけ動く。
// 同じ入力なら毎回同じ処理をするので、何回か測ってフレームごとに短い方を取ると、たまたまの遅れ（メモリの片付け・コードの準備・ほかのプログラム）が消える（merge）

export interface ProfilePart {
  name: string;
  /** 合計の ms */
  ms: number;
  /** 1フレームでいちばん長かった ms と、そのフレーム */
  max: number;
  maxFrame: number;
}

export class Profile {
  /** 処理ごとの、フレームごとの時間（ms。そのフレームに動かなかったら 0） */
  readonly rows = new Map<string, number[]>();
  /** フレームごとの時間（ms）と、物の数 */
  readonly frames: number[] = [];
  readonly counts: number[] = [];

  /** このフレームの、1つの処理の時間 */
  add(name: string, ms: number): void {
    let r = this.rows.get(name);
    if (!r) this.rows.set(name, (r = []));
    const i = this.frames.length;
    while (r.length < i) r.push(0);
    r[i] = (r[i] ?? 0) + ms;
  }

  /** フレームの終わり（ms はフレーム全体、count は物の数） */
  end(ms: number, count: number): void {
    this.frames.push(ms);
    this.counts.push(count);
  }

  /** もう一度測ったものと合わせる: フレームごと・処理ごとに、短い方を取る */
  merge(o: Profile): void {
    const n = Math.min(this.frames.length, o.frames.length);
    for (let i = 0; i < n; i++) this.frames[i] = Math.min(this.frames[i], o.frames[i]);
    for (const [name, r] of this.rows) {
      const q = o.rows.get(name);
      if (q) for (let i = 0; i < Math.min(r.length, q.length, n); i++) r[i] = Math.min(r[i] ?? 0, q[i] ?? 0);
    }
  }

  /** 処理ごとの合計と、いちばん長かったフレーム（重い順） */
  parts(): ProfilePart[] {
    return [...this.rows].map(([name, r]) => {
      let ms = 0, max = 0, maxFrame = 0;
      r.forEach((v, i) => { ms += v ?? 0; if ((v ?? 0) > max) { max = v; maxFrame = i; } });
      return { name, ms, max, maxFrame };
    }).sort((a, b) => b.ms - a.ms);
  }

  /** 物がいちばん多かったフレーム（進めた後のフレームの番号）と、その数 */
  peak(): { frame: number; count: number } {
    let frame = 0, count = 0;
    this.counts.forEach((c, i) => { if (c > count) { count = c; frame = i + 1; } });
    return { frame, count };
  }

  /** いちばん長かったフレームと、その内訳（重い順に3つ） */
  worst(): { frame: number; ms: number; parts: [string, number][] } {
    let frame = 0, ms = 0;
    this.frames.forEach((v, i) => { if (v > ms) { ms = v; frame = i; } });
    const parts = [...this.rows].map(([name, r]) => [name, r[frame] ?? 0] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { frame, ms, parts };
  }

  /** フレームの時間の合計・平均・真ん中の値、budget ms を超えたフレームの数 */
  summary(budget: number): { total: number; mean: number; median: number; over: number; firstOver: number } {
    const total = this.frames.reduce((a, b) => a + b, 0);
    const sorted = [...this.frames].sort((a, b) => a - b);
    let over = 0, firstOver = -1;
    this.frames.forEach((v, i) => { if (v > budget) { over++; if (firstOver < 0) firstOver = i; } });
    return { total, mean: this.frames.length ? total / this.frames.length : 0, median: sorted[Math.floor(sorted.length / 2)] ?? 0, over, firstOver };
  }
}
