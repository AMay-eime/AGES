// 入力。キー名は KeyboardEvent.code（例: ArrowLeft, KeyZ, Space）。
// 1フレームごとに「押されているキーの集合」だけを扱うので、記録と再生が正確にできる。

export class Input {
  private down = new Set<string>();
  private prev = new Set<string>();

  /** このフレームで押されているキーを丸ごと設定する（フレーム頭で呼ぶ） */
  setFrame(keys: Iterable<string>): void {
    this.prev = this.down;
    this.down = new Set(keys);
  }
  isDown(key: string): boolean {
    return this.down.has(key);
  }
  /** このフレームで押された瞬間 */
  pressed(key: string): boolean {
    return this.down.has(key) && !this.prev.has(key);
  }
  released(key: string): boolean {
    return !this.down.has(key) && this.prev.has(key);
  }
  /** -1 / 0 / 1 */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }
  keys(): string[] {
    return [...this.down].sort();
  }
}

/** 入力の記録。変化があったフレームだけ保存する。 */
export interface InputEvent {
  /** フレーム番号 */
  f: number;
  /** 押されたキー */
  d?: string[];
  /** 離されたキー */
  u?: string[];
}

export interface InputRecording {
  seed: number;
  scene: string;
  frames: number;
  events: InputEvent[];
}

export class InputRecorder {
  events: InputEvent[] = [];
  private last = new Set<string>();
  record(frame: number, keys: Iterable<string>): void {
    const now = new Set(keys);
    const d = [...now].filter((k) => !this.last.has(k));
    const u = [...this.last].filter((k) => !now.has(k));
    if (d.length || u.length) {
      const ev: InputEvent = { f: frame };
      if (d.length) ev.d = d.sort();
      if (u.length) ev.u = u.sort();
      this.events.push(ev);
    }
    this.last = now;
  }
}

export class InputPlayback {
  private held = new Set<string>();
  private i = 0;
  private events: InputEvent[];
  constructor(events: InputEvent[]) {
    this.events = events;
  }
  /** そのフレームで押されているキー */
  keysAt(frame: number): string[] {
    while (this.i < this.events.length && this.events[this.i].f <= frame) {
      const ev = this.events[this.i++];
      ev.d?.forEach((k) => this.held.add(k));
      ev.u?.forEach((k) => this.held.delete(k));
    }
    return [...this.held];
  }
}
