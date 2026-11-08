// シード付き乱数（mulberry32）。状態は数値1つなので保存・復元・比較が簡単。
// ゲームロジックでは Math.random ではなく必ず ctx.rng を使う。

export class Rng {
  state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** 0以上1未満 */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** min以上max未満の実数 */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  /** min以上max以下の整数 */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}
