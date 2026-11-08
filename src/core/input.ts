// 入力。キーボード・マウス・タッチ・ゲームパッドを、同じ「ボタンの名前」と「軸の値」で扱う。
// 1フレームごとの入力（FrameInput）だけを扱うので、記録と再生が正確にできる（同じ入力なら毎回同じ結果）。
//
// ボタンの名前:
//   キーボード  KeyboardEvent.code（KeyZ, ArrowLeft, Space, Enter, ShiftLeft …）
//   マウス      Mouse0（左）Mouse1（中）Mouse2（右）
//   タッチ      Touch（どこかに触れている）
//   ゲームパッド Pad.A Pad.B Pad.X Pad.Y Pad.LB Pad.RB Pad.LT Pad.RT Pad.Back Pad.Start Pad.LS Pad.RS Pad.Up Pad.Down Pad.Left Pad.Right Pad.Home
//              スティックを倒した向き Pad.LStickLeft など。2台目以降は Pad2.A のように番号を付ける
// 軸の名前（-1〜1。トリガーは 0〜1）: Pad.LX Pad.LY Pad.RX Pad.RY Pad.LT Pad.RT
//
// 操作の名前（例 fire, move_x）は標準の表 $actions で決める。ゲームのコードは名前で読み、割り当てはゲームの中から変えられる（キーコンフィグ）。

import { suggest } from './schema.ts';

export interface FrameInput {
  /** 押されているボタン */
  buttons: Iterable<string>;
  /** アナログの軸の値 */
  axes?: Record<string, number>;
  /** マウス・タッチの位置（ゲームの画面の座標。画面の外なら null） */
  pointer?: { x: number; y: number } | null;
  /** このフレームのホイールの回転量 */
  wheel?: number;
  /** 触れている指 */
  touches?: { id: number; x: number; y: number }[];
}

/** 操作の割り当て（表 $actions の1行） */
export interface ActionDef {
  kind: 'button' | 'axis';
  keys: string[];
  negative: string[];
  analog: string[];
  deadzone: number;
}

export type Binding = Partial<Pick<ActionDef, 'keys' | 'negative' | 'analog'>>;

const PAD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'];
const PAD_STICKS = ['LStickLeft', 'LStickRight', 'LStickUp', 'LStickDown', 'RStickLeft', 'RStickRight', 'RStickUp', 'RStickDown'];
export const PAD_AXES = ['LX', 'LY', 'RX', 'RY', 'LT', 'RT'];

/** 使えるボタンの名前（検証の「もしかして」に使う） */
export const KNOWN_BUTTONS: string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((c) => `Digit${c}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote', 'IntlRo', 'IntlYen', 'Convert', 'NonConvert', 'KanaMode',
  ...'0123456789'.split('').map((c) => `Numpad${c}`), 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadEnter', 'NumpadDecimal',
  'Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4', 'Touch',
  ...['Pad', 'Pad2', 'Pad3', 'Pad4'].flatMap((p) => [...PAD_BUTTONS, ...PAD_STICKS].map((b) => `${p}.${b}`)),
];
export const KNOWN_AXES: string[] = ['Pad', 'Pad2', 'Pad3', 'Pad4'].flatMap((p) => PAD_AXES.map((a) => `${p}.${a}`));

/** 人に見せるボタンの名前（キーコンフィグの画面などに） */
export function buttonLabel(code: string): string {
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (arrows[code]) return arrows[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const m = code.match(/^Pad(\d?)\.(.+)$/);
  // キーボードの Y と見分けがつくように、パッドには「パッド」を付ける（2台目からは番号も）
  if (m) return `パッド${m[1] ? `${m[1]} ` : ''}${({ Up: '十字↑', Down: '十字↓', Left: '十字←', Right: '十字→' } as Record<string, string>)[m[2]] ?? m[2]}`;
  const names: Record<string, string> = { Mouse0: 'マウス左', Mouse1: 'マウス中', Mouse2: 'マウス右', Touch: 'タッチ', Space: 'スペース', Escape: 'Esc', ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl', ControlRight: '右Ctrl', AltLeft: '左Alt', AltRight: '右Alt' };
  return names[code] ?? code;
}

/** 軸の値をそろえる（記録が短く、再生でずれない） */
export const quantize = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 256) / 256;

export class Input {
  private down = new Set<string>();
  private prev = new Set<string>();
  private axesNow: Record<string, number> = {};
  private axesPrev: Record<string, number> = {};
  private defaults = new Map<string, ActionDef>();
  private overrides = new Map<string, Binding>();
  /** マウス・タッチの位置（ゲームの画面の座標）。画面の外なら null */
  pointer: { x: number; y: number } | null = null;
  /** このフレームのホイールの回転量 */
  wheel = 0;
  touches: { id: number; x: number; y: number }[] = [];

  /** 操作の名前と割り当て（表 $actions から。ゲームが始まるときにエンジンが入れる） */
  setActions(defs: Map<string, ActionDef>): void {
    this.defaults = defs;
  }

  /** このフレームの入力を丸ごと設定する（フレーム頭で呼ぶ）。古い書き方（押されているキーの並びだけ）も使える */
  setFrame(input: Iterable<string> | FrameInput): void {
    const f: FrameInput = isFrameInput(input) ? input : { buttons: input };
    this.prev = this.down;
    this.down = new Set(f.buttons);
    this.axesPrev = this.axesNow;
    this.axesNow = { ...(f.axes ?? {}) };
    if (f.pointer !== undefined) this.pointer = f.pointer;
    this.wheel = f.wheel ?? 0;
    this.touches = f.touches ?? [];
  }

  // ---------- 読む（操作の名前か、ボタンの名前） ----------

  /** 押されているか（操作の名前か、ボタンの名前） */
  isDown(name: string): boolean {
    const a = this.def(name);
    return a ? this.actionValue(a, this.down, this.axesNow) !== 0 : this.down.has(name);
  }
  /** このフレームで押された瞬間 */
  pressed(name: string): boolean {
    const a = this.def(name);
    if (!a) return this.down.has(name) && !this.prev.has(name);
    return this.actionValue(a, this.down, this.axesNow) !== 0 && this.actionValue(a, this.prev, this.axesPrev) === 0;
  }
  /** このフレームで離された瞬間 */
  released(name: string): boolean {
    const a = this.def(name);
    if (!a) return !this.down.has(name) && this.prev.has(name);
    return this.actionValue(a, this.down, this.axesNow) === 0 && this.actionValue(a, this.prev, this.axesPrev) !== 0;
  }
  /** 操作の値。axis は -1〜1（キーなら -1 / 0 / 1、スティックならその間）、button は 0 か 1 */
  value(action: string): number {
    const a = this.def(action);
    if (!a) throw new Error(`操作 ${action} はありません（表 $actions に行を足してください）${this.suggestAction(action)}`);
    return this.actionValue(a, this.down, this.axesNow);
  }
  /** -1 / 0 / 1（ボタン2つから。手早く試すとき用） */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }
  /** アナログの軸の値（例 Pad.LX） */
  raw(axis: string): number {
    return this.axesNow[axis] ?? 0;
  }
  /** 押されているボタン（並べ替え済み） */
  keys(): string[] {
    return [...this.down].sort();
  }

  // ---------- キーコンフィグ ----------

  /** 操作の名前の一覧 */
  actions(): string[] {
    return [...this.defaults.keys()];
  }
  /** 今の割り当て */
  bindings(action: string): ActionDef {
    const a = this.def(action);
    if (!a) throw new Error(`操作 ${action} はありません${this.suggestAction(action)}`);
    return structuredClone(a);
  }
  /** 割り当てを変える（ゲームの中から。キーコンフィグの画面など）。渡した項目だけ変わる */
  bind(action: string, b: Binding): void {
    if (!this.defaults.has(action)) throw new Error(`操作 ${action} はありません${this.suggestAction(action)}`);
    this.overrides.set(action, { ...this.overrides.get(action), ...structuredClone(b) });
  }
  /** 割り当てを表の通りに戻す（省くと全部） */
  resetBindings(action?: string): void {
    if (action) this.overrides.delete(action);
    else this.overrides.clear();
  }
  /** 変えた割り当て（セーブ用。表の通りのものは入らない） */
  exportBindings(): Record<string, Binding> {
    return Object.fromEntries(structuredClone([...this.overrides.entries()]));
  }
  /** セーブから割り当てを戻す（ない操作は無視する） */
  importBindings(o: Record<string, Binding>): void {
    for (const [k, v] of Object.entries(o ?? {})) if (this.defaults.has(k)) this.overrides.set(k, structuredClone(v));
  }
  /** このフレームで押された瞬間のボタン（どれか1つ。キーコンフィグで「押したボタンを割り当てる」ときに） */
  lastPressed(): string | null {
    for (const b of [...this.down].sort()) if (!this.prev.has(b)) return b;
    return null;
  }
  /** そのボタンを使っている操作（同じボタンの二重の割り当てを知らせるときに） */
  usedBy(button: string): string[] {
    return this.actions().filter((n) => { const a = this.def(n)!; return a.keys.includes(button) || a.negative.includes(button) || a.analog.includes(button); });
  }
  /** 人に見せるボタンの名前 */
  label(button: string): string {
    return buttonLabel(button);
  }

  private def(name: string): ActionDef | undefined {
    const d = this.defaults.get(name);
    if (!d) return undefined;
    const o = this.overrides.get(name);
    return o ? { ...d, ...o } : d;
  }

  private actionValue(a: ActionDef, buttons: Set<string>, axes: Record<string, number>): number {
    const on = (list: string[]) => list.some((b) => buttons.has(b));
    let v = (on(a.keys) ? 1 : 0) - (a.kind === 'axis' && on(a.negative) ? 1 : 0);
    // アナログの軸: 遊び（deadzone）より大きく倒したときだけ。キーとスティックの大きいほう
    for (const ax of a.analog) {
      const x = axes[ax] ?? 0;
      if (Math.abs(x) > a.deadzone && Math.abs(x) > Math.abs(v)) v = a.kind === 'button' ? 1 : x;
    }
    return a.kind === 'button' ? (v !== 0 ? 1 : 0) : Math.max(-1, Math.min(1, v));
  }

  private suggestAction(name: string): string {
    const names = this.actions();
    return suggest(name, names) || (names.length ? `（ある操作: ${names.join(', ')}）` : '');
  }
}

/** 表 $actions の行から、操作の名前と割り当てを作る */
export function actionsFromRows(rows: readonly { id: string }[]): Map<string, ActionDef> {
  return new Map(rows.map((r) => [r.id, r as unknown as ActionDef]));
}

const isFrameInput = (x: unknown): x is FrameInput => !!x && typeof x === 'object' && 'buttons' in (x as object);

// ---------- 記録と再生 ----------

/** 入力の記録。変化があったフレームだけ保存する。 */
export interface InputEvent {
  /** フレーム番号 */
  f: number;
  /** 押されたボタン */
  d?: string[];
  /** 離されたボタン */
  u?: string[];
  /** 変わった軸の値（0 に戻ったものも入る） */
  a?: Record<string, number>;
  /** マウス・タッチの位置（null = 画面の外） */
  p?: [number, number] | null;
  /** ホイール（そのフレームだけ） */
  w?: number;
  /** 触れている指（変わったとき） */
  t?: [number, number, number][];
}

export interface InputRecording {
  seed: number;
  scene: string;
  frames: number;
  events: InputEvent[];
}

const samePtr = (a: { x: number; y: number } | null | undefined, b: { x: number; y: number } | null | undefined) => (a ?? null) === (b ?? null) || (!!a && !!b && a.x === b.x && a.y === b.y);

export class InputRecorder {
  events: InputEvent[] = [];
  private last = new Set<string>();
  private lastAxes: Record<string, number> = {};
  private lastPtr: { x: number; y: number } | null = null;
  private lastTouch = '[]';
  record(frame: number, input: Iterable<string> | FrameInput): void {
    const f: FrameInput = isFrameInput(input) ? input : { buttons: input };
    const now = new Set(f.buttons);
    const ev: InputEvent = { f: frame };
    const d = [...now].filter((k) => !this.last.has(k));
    const u = [...this.last].filter((k) => !now.has(k));
    if (d.length) ev.d = d.sort();
    if (u.length) ev.u = u.sort();
    const axes = f.axes ?? {};
    const a: Record<string, number> = {};
    for (const k of new Set([...Object.keys(axes), ...Object.keys(this.lastAxes)])) if ((axes[k] ?? 0) !== (this.lastAxes[k] ?? 0)) a[k] = axes[k] ?? 0;
    if (Object.keys(a).length) ev.a = a;
    if (f.pointer !== undefined && !samePtr(f.pointer, this.lastPtr)) { ev.p = f.pointer ? [f.pointer.x, f.pointer.y] : null; this.lastPtr = f.pointer; }
    if (f.wheel) ev.w = f.wheel;
    const t = JSON.stringify((f.touches ?? []).map((x) => [x.id, x.x, x.y]));
    if (t !== this.lastTouch) { ev.t = JSON.parse(t); this.lastTouch = t; }
    if (Object.keys(ev).length > 1) this.events.push(ev);
    this.last = now;
    this.lastAxes = { ...axes };
  }
}

export class InputPlayback {
  private held = new Set<string>();
  private axes: Record<string, number> = {};
  private ptr: { x: number; y: number } | null = null;
  private touches: { id: number; x: number; y: number }[] = [];
  private i = 0;
  private events: InputEvent[];
  constructor(events: InputEvent[]) {
    this.events = events;
  }
  /** そのフレームで押されているキー（古い書き方。ボタンだけ） */
  keysAt(frame: number): string[] {
    return [...(this.at(frame).buttons as Set<string>)];
  }
  /** そのフレームの入力 */
  at(frame: number): FrameInput {
    let wheel = 0;
    while (this.i < this.events.length && this.events[this.i].f <= frame) {
      const ev = this.events[this.i++];
      ev.d?.forEach((k) => this.held.add(k));
      ev.u?.forEach((k) => this.held.delete(k));
      if (ev.a) for (const [k, v] of Object.entries(ev.a)) { if (v) this.axes[k] = v; else delete this.axes[k]; }
      if (ev.p !== undefined) this.ptr = ev.p ? { x: ev.p[0], y: ev.p[1] } : null;
      if (ev.w && ev.f === frame) wheel += ev.w;
      if (ev.t) this.touches = ev.t.map(([id, x, y]) => ({ id, x, y }));
    }
    return { buttons: new Set(this.held), axes: { ...this.axes }, pointer: this.ptr, wheel, touches: this.touches };
  }
}

/**
 * 入力の指定を、入力の記録に変換する。";" で区切り、各部分は "開始-終了:入力+入力"（終了のフレームで離す）か "フレーム:入力"
 *   KeyZ / Pad.A / Mouse0   … ボタン
 *   @fire                   … 操作の名前（$actions の最初の割り当てのボタン）。@move_x=-1 は − の向き、@move_x=0.5 はアナログ
 *   Pad.LX=0.7              … 軸の値
 *   ptr=240,300             … マウス・タッチの位置（ゲームの画面の座標）。wheel=3 … ホイール
 * 例: "0-120:ArrowLeft+KeyZ;120-200:@move_x=1;30-40:Mouse0+ptr=240,100"
 */
export function keysToEvents(spec: string, actions?: Map<string, ActionDef>): InputEvent[] {
  const timeline = new Map<number, InputEvent>();
  const at = (f: number) => timeline.get(f) ?? (timeline.set(f, { f }), timeline.get(f)!);
  const press = (a: number, b: number | null, k: string) => {
    (at(a).d ??= []).push(k);
    if (b !== null) (at(b).u ??= []).push(k);
  };
  const axis = (a: number, b: number | null, k: string, v: number) => {
    (at(a).a ??= {})[k] = quantize(v);
    if (b !== null) (at(b).a ??= {})[k] = 0;
  };
  for (const seg of spec.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = seg.match(/^(\d+)(?:-(\d+))?:(.+)$/);
    if (!m) throw new Error(`入力の指定（--keys）の書き方が違います: "${seg}"。例: 0-120:ArrowLeft+KeyZ、30:ptr=240,100`);
    const a = Number(m[1]), b = m[2] !== undefined ? Number(m[2]) : null;
    for (const tok of m[3].split('+').map((x) => x.trim()).filter(Boolean)) {
      const kv = tok.match(/^([^=]+)=(.+)$/);
      if (tok.startsWith('@')) {
        const name = (kv ? kv[1] : tok).slice(1);
        const def = actions?.get(name);
        if (!def) throw new Error(`--keys の @${name}: 操作 ${name} はありません${suggest(name, [...(actions?.keys() ?? [])])}（表 $actions）`);
        const v = kv ? Number(kv[2]) : 1;
        if (v === 1 || v === -1) {
          const k = (v > 0 ? def.keys : def.negative)[0];
          if (!k) throw new Error(`--keys の ${tok}: 操作 ${name} に${v > 0 ? '' : ' − の向きの'}ボタンが割り当てられていません`);
          press(a, b, k);
        } else {
          const ax = def.analog[0];
          if (!ax) throw new Error(`--keys の ${tok}: 操作 ${name} にアナログの軸が割り当てられていません`);
          axis(a, b, ax, v);
        }
      } else if (kv && kv[1] === 'ptr') {
        const [x, y] = kv[2].split(',').map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--keys の ${tok}: ptr=横,縦 の形で書きます（例 ptr=240,100）`);
        at(a).p = [x, y];
      } else if (kv && kv[1] === 'wheel') at(a).w = Number(kv[2]);
      else if (kv) axis(a, b, kv[1], Number(kv[2]));
      else press(a, b, tok);
    }
  }
  return [...timeline.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
}
