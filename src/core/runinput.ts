// ages run の入力（--keys・--input・click=ボタンのID）を、フレームごとの入力にする。
// CLI の ages run と、画面を撮るページ（editor/shot.ts）が同じものを使い、同じフレームで同じ状態になるようにする。
import type { FrameInput, InputPlayback } from './input.ts';
import type { Game } from './game.ts';
import { layoutUI } from './ui.ts';

/**
 * そのフレームの入力。clicks は「フレーム → ボタンの ID」（そのフレームで押し、次のフレームで離す）。
 * ボタンが見つからないときは warning を返す（押したフレームだけ）
 */
export function frameInput(game: Game, play: InputPlayback, clicks: Map<number, string>, width: number, height: number): { input: FrameInput; warning?: string } {
  const inp = play.at(game.frame);
  const target = clicks.get(game.frame) ?? clicks.get(game.frame - 1);
  if (!target) return { input: inp };
  const r = layoutUI(game.world, width, height).get(target);
  if (!r) return { input: inp, ...(clicks.get(game.frame) ? { warning: target } : {}) };
  inp.pointer = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  if (clicks.get(game.frame) === target) inp.buttons = [...inp.buttons, 'Mouse0'];
  else inp.buttons = [...inp.buttons].filter((b) => b !== 'Mouse0');
  return { input: inp };
}
