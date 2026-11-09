// ages run の入力（--keys・--input・click=ボタンのID・シーン名+フレーム）を、フレームごとの入力にする。
// CLI の ages run と、画面を撮るページ（editor/shot.ts）が同じものを使い、同じフレームで同じ状態になるようにする。
import { InputPlayback, keysToEvents, type ActionDef, type FrameInput, type InputEvent } from './input.ts';
import type { Game } from './game.ts';
import { layoutUI } from './ui.ts';

/** シーンに入るたびに押す入力（title+30-32:@ui_confirm。フレームはそのシーンに入ってから数える） */
export interface SceneKey {
  scene: string;
  a: number;
  /** 離すフレーム（省くと、そのシーンにいる間ずっと） */
  b: number | null;
  buttons: string[];
  axes: Record<string, number>;
  ptr?: [number, number];
  /** a のフレームで押し、次のフレームで離す（ボタンの ID か、画面の位置） */
  click?: string | [number, number];
}

/** ages run の入力のまとめ（シリアライズできる形。画面を撮るページにもそのまま渡す） */
export interface RunKeys {
  events: InputEvent[];
  /** フレーム → 押すボタンの ID（click=） */
  clicks: [number, string][];
  scene: SceneKey[];
}

const SCENE_SEG = /^([^\d\s:;+][^\s:;+]*)\+(\d+)(?:-(\d+))?:(.+)$/;
const CLICK_ID = /^click=([A-Za-z_][\w~-]*)$/;

/**
 * --keys を読む。'0-120:ArrowLeft+@fire;30:click=start' のフレームはゲームの始めから、
 * 'title+30:@ui_confirm' のフレームは、そのシーンに入ってから（入るたびに）
 */
export function parseRunKeys(spec: string, actions?: Map<string, ActionDef>): RunKeys {
  const clicks: [number, string][] = [];
  const scene: SceneKey[] = [];
  const abs: string[] = [];
  for (const raw of spec.split(';').map((x) => x.trim()).filter(Boolean)) {
    const sm = raw.match(SCENE_SEG);
    if (sm) {
      const a = Number(sm[2]), b = sm[3] !== undefined ? Number(sm[3]) : null;
      if (b !== null && b <= a) throw new Error(`--keys の ${raw}: 終わりのフレームは始めより後にします`);
      const toks = sm[4].split('+').map((x) => x.trim()).filter(Boolean);
      const k: SceneKey = { scene: sm[1], a, b, buttons: [], axes: {} };
      const rest: string[] = [];
      for (const tok of toks) {
        const id = tok.match(CLICK_ID), xy = tok.match(/^click=(-?[\d.]+),(-?[\d.]+)$/);
        if (xy) k.click = [Number(xy[1]), Number(xy[2])];
        else if (id) k.click = id[1];
        else rest.push(tok);
      }
      if (rest.length) {
        // 押す物の書き方は、始めから数えるものと同じ（1フレーム目の入力を取り出す）
        const first = keysToEvents(`0-1:${rest.join('+')}`, actions)[0] ?? { f: 0 };
        k.buttons = first.d ?? [];
        k.axes = first.a ?? {};
        if (first.p) k.ptr = first.p;
        if (first.w) throw new Error(`--keys の ${raw}: wheel はシーンからのフレームでは使えません`);
      }
      scene.push(k);
      continue;
    }
    // click=ボタンのID は、そのフレームのボタンの真ん中を押す（位置を数えなくてよい）
    const m = raw.match(/^(\d+):(.+)$/);
    if (!m) { abs.push(raw); continue; }
    const rest = m[2].split('+').filter((tok) => {
      const c = tok.trim().match(CLICK_ID);
      if (c) clicks.push([Number(m[1]), c[1]]);
      return !c;
    });
    if (rest.length) abs.push(`${m[1]}:${rest.join('+')}`);
  }
  return { events: abs.length ? keysToEvents(abs.join(';'), actions) : [], clicks, scene };
}

/** RunKeys を、フレームごとの入力にする */
export class RunInput {
  private play: InputPlayback;
  private clicks: Map<number, string>;
  private scene: SceneKey[];
  constructor(keys: RunKeys) {
    this.play = new InputPlayback(keys.events);
    this.clicks = new Map(keys.clicks);
    this.scene = keys.scene;
  }

  /**
   * そのフレームの入力（game.step の前に呼ぶ）。
   * ボタンが見つからないときは warning を返す（押すフレームだけ）
   */
  at(game: Game, width: number, height: number): { input: FrameInput; warning?: string } {
    const inp = this.play.at(game.frame);
    const buttons = new Set(inp.buttons);
    let warning: string | undefined;
    let layout: ReturnType<typeof layoutUI> | null = null;
    const center = (id: string): [number, number] | null => {
      const r = (layout ??= layoutUI(game.world, width, height)).get(id);
      return r ? [r.x + r.w / 2, r.y + r.h / 2] : null;
    };
    // click: そのフレームで押し、次のフレームで離す（同じ所で）
    const click = (target: string | [number, number], down: boolean) => {
      const at = typeof target === 'string' ? center(target) : target;
      if (!at) { if (down && typeof target === 'string') warning = target; return; }
      inp.pointer = { x: at[0], y: at[1] };
      if (down) buttons.add('Mouse0');
      else buttons.delete('Mouse0');
    };
    const target = this.clicks.get(game.frame) ?? this.clicks.get(game.frame - 1);
    if (target) click(target, this.clicks.get(game.frame) === target);
    const sf = game.sceneFrame;
    for (const k of this.scene) {
      if (k.scene !== game.sceneName) continue;
      if (sf >= k.a && (k.b === null || sf < k.b)) {
        for (const b of k.buttons) buttons.add(b);
        inp.axes = { ...inp.axes, ...k.axes };
        if (k.ptr) inp.pointer = { x: k.ptr[0], y: k.ptr[1] };
      }
      if (k.click !== undefined && (sf === k.a || sf === k.a + 1)) click(k.click, sf === k.a);
    }
    inp.buttons = buttons;
    return { input: inp, ...(warning ? { warning } : {}) };
  }
}
