// ブラウザの入力の機器（キーボード・マウス・タッチ・ゲームパッド）を、1フレームの入力（FrameInput）にまとめる。
// ゲームの側は機器を知らない。ここで「ボタンの名前」と「軸の値」にそろえてから渡す（記録と再生がそのまま使える）。
import { quantize, type FrameInput } from '../core/input.ts';

/** 標準の並び（Gamepad.mapping === 'standard'）のボタンの名前 */
export const PAD_BUTTON_ORDER = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'];
/** スティックをこれより倒したら、向きのボタン（Pad.LStickLeft など）も押されたことにする */
const STICK_BUTTON = 0.5;
/** スティックのわずかなぶれは 0 にする（記録が増えすぎないように。遊びの調整は表 $actions の deadzone で） */
const NOISE = 0.05;

type Point = { x: number; y: number };

/** ゲームパッドの今の状態を、ボタンの名前と軸の値にする。1台目は Pad、2台目は Pad2 … */
export function readGamepads(pads: readonly (Gamepad | null)[], buttons: Set<string>, axes: Record<string, number>): void {
  let n = 0;
  for (const g of pads) {
    if (!g || !g.connected) continue;
    const pre = n === 0 ? 'Pad' : `Pad${n + 1}`;
    if (++n > 4) break;
    g.buttons.forEach((b, i) => {
      const name = PAD_BUTTON_ORDER[i];
      if (name && (b.pressed || b.value > 0.5)) buttons.add(`${pre}.${name}`);
    });
    const put = (name: string, v: number | undefined) => {
      if (v === undefined || Math.abs(v) < NOISE) return;
      axes[`${pre}.${name}`] = quantize(v);
    };
    put('LX', g.axes[0]); put('LY', g.axes[1]); put('RX', g.axes[2]); put('RY', g.axes[3]);
    put('LT', g.buttons[6]?.value); put('RT', g.buttons[7]?.value);
    const stick = (s: 'L' | 'R', x = 0, y = 0) => {
      if (x < -STICK_BUTTON) buttons.add(`${pre}.${s}StickLeft`);
      if (x > STICK_BUTTON) buttons.add(`${pre}.${s}StickRight`);
      if (y < -STICK_BUTTON) buttons.add(`${pre}.${s}StickUp`);
      if (y > STICK_BUTTON) buttons.add(`${pre}.${s}StickDown`);
    };
    stick('L', g.axes[0], g.axes[1]);
    stick('R', g.axes[2], g.axes[3]);
  }
}

const getPads = (): readonly (Gamepad | null)[] => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []);
const round1 = (v: number) => Math.round(v * 10) / 10;

export class Devices {
  /** 押されているキー（KeyboardEvent.code） */
  readonly keys = new Set<string>();
  private mouse = new Set<string>();
  /** 前のフレームから今までに押されたもの（フレームの間に押して離した短い押しも、1フレームは押したことにする） */
  private tapped = new Set<string>();
  private ptr: Point | null = null;
  private wheelAcc = 0;
  private touch = new Map<number, Point>();
  private off: (() => void)[] = [];
  /** 入力を受け付けるか（エディタでは再生中だけ） */
  enabled: () => boolean = () => true;

  /** キーボードをつなぐ。ignore が true を返すキーは受けない（文字を入力している欄など） */
  bindKeyboard(target: Window | HTMLElement, ignore: (e: KeyboardEvent) => boolean = () => false): void {
    const down = (e: Event) => {
      const k = e as KeyboardEvent;
      if (!this.enabled() || ignore(k)) return;
      this.keys.add(k.code);
      this.tapped.add(k.code);
      // 矢印・スペースでページが動かないように
      if (k.code.startsWith('Arrow') || k.code === 'Space') k.preventDefault();
    };
    const up = (e: Event) => { this.keys.delete((e as KeyboardEvent).code); };
    const blur = () => this.clear();
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.off.push(() => { target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); window.removeEventListener('blur', blur); });
  }

  /**
   * マウス・タッチをつなぐ。toGame は画面の点 → ゲームの画面の座標（ctx.view と同じ向きと大きさ）。映っていない所は null
   * accept が false のときのクリックはゲームに渡さない（エディタで選ぶのに使う）
   */
  bindPointer(target: HTMLElement, toGame: (clientX: number, clientY: number) => Point | null, accept: () => boolean = () => true): void {
    const at = (cx: number, cy: number) => { const p = toGame(cx, cy); return p ? { x: round1(p.x), y: round1(p.y) } : null; };
    const on = (el: EventTarget, type: string, fn: (e: never) => void, opt?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opt);
      this.off.push(() => el.removeEventListener(type, fn as EventListener, opt));
    };
    on(target, 'mousedown', (e: MouseEvent) => {
      if (!this.enabled() || !accept()) return;
      this.mouse.add(`Mouse${e.button}`);
      this.tapped.add(`Mouse${e.button}`);
      this.ptr = at(e.clientX, e.clientY);
    });
    on(window, 'mouseup', (e: MouseEvent) => { this.mouse.delete(`Mouse${e.button}`); });
    on(window, 'mousemove', (e: MouseEvent) => {
      if (!this.enabled()) return;
      const r = target.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      this.ptr = inside || this.mouse.size ? at(e.clientX, e.clientY) : null;
    });
    on(target, 'mouseleave', () => { if (!this.mouse.size) this.ptr = null; });
    on(target, 'wheel', (e: WheelEvent) => {
      if (!this.enabled() || !accept()) return;
      // 機器による量の違いをなくすため、1回の回転を 1 として数える（下・奥が +）
      this.wheelAcc += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    const touches = (e: TouchEvent) => {
      if (!this.enabled() || !accept()) return;
      e.preventDefault(); // マウスのまねをさせない
      this.touch.clear();
      for (const t of Array.from(e.touches)) { const p = at(t.clientX, t.clientY); if (p) this.touch.set(t.identifier, p); }
      const first = this.touch.values().next().value;
      if (first) this.ptr = first;
    };
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) on(target, type, touches, { passive: false });
  }

  /** このフレームの入力を作る（フレームの頭で1回。ホイールはここで 0 に戻る） */
  frame(): FrameInput {
    const buttons = new Set<string>([...this.keys, ...this.mouse, ...this.tapped]);
    this.tapped.clear();
    const axes: Record<string, number> = {};
    if (this.enabled()) readGamepads(getPads(), buttons, axes);
    if (this.touch.size) buttons.add('Touch');
    const wheel = this.wheelAcc;
    this.wheelAcc = 0;
    return { buttons, axes, pointer: this.ptr, wheel, touches: [...this.touch].map(([id, p]) => ({ id, x: p.x, y: p.y })) };
  }

  /** 押されているものを全部離す（停止・画面を離れたとき） */
  clear(): void {
    this.keys.clear();
    this.mouse.clear();
    this.tapped.clear();
    this.touch.clear();
    this.wheelAcc = 0;
  }

  detach(): void {
    for (const f of this.off.splice(0)) f();
  }
}

/** キーコンフィグ・エディタの「押して決める」用: 次に押されたボタン（か倒した軸）を待つ。止める関数を返す */
export function captureNext(done: (code: string) => void, opts: { analog?: boolean; target?: HTMLElement; alive?: () => boolean } = {}): () => void {
  let stopped = false;
  const before = new Set<string>();
  readGamepads(getPads(), before, {});
  // 待つ画面が閉じられていたら、何もせずにやめる
  const gone = () => { if (opts.alive && !opts.alive()) { stop(); return true; } return stopped; };
  const finish = (code: string) => { if (stopped) return; stop(); done(code); };
  const key = (e: KeyboardEvent) => { if (gone() || opts.analog) return; e.preventDefault(); e.stopPropagation(); finish(e.code); };
  const mouse = (e: MouseEvent) => { if (gone() || opts.analog) return; e.preventDefault(); e.stopPropagation(); finish(`Mouse${e.button}`); };
  const noMenu = (e: Event) => e.preventDefault();
  window.addEventListener('keydown', key, true);
  opts.target?.addEventListener('mousedown', mouse);
  opts.target?.addEventListener('contextmenu', noMenu);
  const poll = () => {
    if (gone()) return;
    const now = new Set<string>();
    const axes: Record<string, number> = {};
    readGamepads(getPads(), now, axes);
    if (opts.analog) {
      // 大きく倒した軸（トリガー・スティック）
      const best = Object.entries(axes).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
      if (best && Math.abs(best[1]) > 0.6) return finish(best[0]);
    } else {
      for (const b of now) if (!before.has(b)) return finish(b);
    }
    for (const b of [...before]) if (!now.has(b)) before.delete(b);
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
  function stop() {
    stopped = true;
    window.removeEventListener('keydown', key, true);
    opts.target?.removeEventListener('mousedown', mouse);
    opts.target?.removeEventListener('contextmenu', noMenu);
  }
  return stop;
}
