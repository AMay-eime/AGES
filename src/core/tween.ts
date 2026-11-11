// トゥイーン（値を時間で変える）。ロジックの側でフレームで数えるので、同じ入力なら毎回同じ結果になる。
import { EASES, EASE_NAMES, type EaseName } from './ease.ts';
import { suggest, type Field } from './schema.ts';

export type TweenValue = number | number[] | string;

export interface TweenOptions {
  /** かける秒数（片道） */
  time?: number;
  ease?: EaseName;
  /** 始めるまでの秒数 */
  delay?: number;
  /** くり返す回数（-1 で止めるまで） */
  repeat?: number;
  /** 行って戻る */
  yoyo?: boolean;
  /** 始めの値（省くと今の値） */
  from?: Record<string, TweenValue>;
  /** 終わったら物を消す */
  destroy?: boolean;
  /** 終わったらこの出来事を記録する（ctx.emit と同じ） */
  emit?: string;
  /** 表 $tweens の行の名前（その手触りを使い、ここに書いたもので上書き） */
  preset?: string;
}

/** 進行中のトゥイーン（そのまま保存できる形） */
export interface TweenState {
  id: string;
  comp: string;
  field: string;
  /** シェーダーの値（Effect.params.amount）のときの中の名前 */
  sub?: string;
  from: TweenValue;
  to: TweenValue;
  /** 動き始めるフレーム（delay の後） */
  start: number;
  /** 片道のフレーム数 */
  frames: number;
  ease: EaseName;
  repeat: number;
  yoyo: boolean;
  /** 何回目の片道か */
  cycle: number;
  round: boolean;
  destroy?: boolean;
  emit?: string;
}

const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** 色を [r, g, b, a]（0〜255）に。#rrggbb なら a は 255 */
const rgb = (c: string) => [1, 3, 5, 7].map((i) => (i === 7 && c.length < 9 ? 255 : parseInt(c.slice(i, i + 2), 16)));
const hex = (v: number[]) => '#' + v.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');

/** a から b へ k（0〜1、はみ出してもよい）だけ進めた値 */
export function lerpValue(a: TweenValue, b: TweenValue, k: number, round = false): TweenValue {
  const r = (x: number) => (round ? Math.round(x) : x);
  if (typeof a === 'number' && typeof b === 'number') return r(a + (b - a) * k);
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => r(x + ((b[i] ?? x) - x) * k));
  if (typeof a === 'string' && typeof b === 'string') {
    const x = rgb(a), y = rgb(b), out = hex(x.map((v, i) => v + (y[i] - v) * k));
    // 透け具合（#rrggbbaa）は、どちらかに書いてあるときだけ残す
    return a.length === 9 || b.length === 9 ? out : out.slice(0, 7);
  }
  return b;
}

/** 目指す値を、今の値と型に合わせて決める（'+10' / '-10' は今の値からの差） */
export function targetValue(at: string, f: Field, current: unknown, to: unknown): TweenValue {
  if (f.type === 'number' || f.type === 'int') {
    if (typeof current !== 'number') throw new Error(`${at}: 今の値が数ではありません`);
    if (typeof to === 'number') return to;
    if (typeof to === 'string' && /^[+-]\d/.test(to)) return current + Number(to);
    throw new Error(`${at}: 行き先は数（'+10' のように書くと今からの差）です。受け取った値: ${JSON.stringify(to)}`);
  }
  if (f.type === 'color') {
    if (typeof to === 'string' && HEX.test(to) && typeof current === 'string' && HEX.test(current)) return to.toLowerCase();
    throw new Error(`${at}: 色は '#rrggbb'（透けるなら '#rrggbbaa'）の形で書きます。受け取った値: ${JSON.stringify(to)}`);
  }
  if (f.type === 'vec2' || f.type === 'vec3' || (f.type === 'list' && (f.of.type === 'number' || f.of.type === 'int'))) {
    if (Array.isArray(to) && Array.isArray(current) && to.length === current.length && to.every((x) => typeof x === 'number')) return to;
    throw new Error(`${at}: 数の並び（今と同じ ${Array.isArray(current) ? current.length : '?'} 個）を書きます。受け取った値: ${JSON.stringify(to)}`);
  }
  throw new Error(`${at} は ${f.type} なので、時間で変えられません（数・色・数の並びだけ）`);
}

export function checkEase(name: string): EaseName {
  if (!(EASE_NAMES as string[]).includes(name)) throw new Error(`変わり方 ${name} はありません${suggest(name, EASE_NAMES)}（ある名前: ${EASE_NAMES.join(' ')}）`);
  return name as EaseName;
}

/**
 * フレームを1つ進めたときの値。done なら、くり返しも含めて終わった
 * frame は、そのフレームの番号（step の中、frame++ の前）
 */
export function tweenAt(t: TweenState, frame: number): { value?: TweenValue; done: boolean } {
  if (frame < t.start) return { done: false };
  const elapsed = frame - t.start + 1;
  const total = t.repeat < 0 ? Infinity : t.repeat + 1;
  const cycle = Math.min(Math.floor((elapsed - 1) / t.frames), total - 1);
  const inCycle = Math.min(1, (elapsed - cycle * t.frames) / t.frames);
  const back = t.yoyo && cycle % 2 === 1;
  const k = EASES[t.ease](back ? 1 - inCycle : inCycle);
  const done = cycle === total - 1 && inCycle >= 1;
  return { value: lerpValue(t.from, t.to, k, t.round), done };
}
