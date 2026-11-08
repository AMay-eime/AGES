// プロジェクト独自のエディタウインドウ（editor/*.window.ts）が使うAPI。
// UnityのEditorWindowに相当する。AIに「この調整用のウインドウを作って」と頼めば、このAPIで書ける。
import type { Op, Change } from '../core/patch.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { GameEvent } from '../core/game.ts';

export interface EditorApi {
  /** 現在のプロジェクトの内容（読み取り専用として扱う） */
  readonly state: {
    config: ProjectConfig;
    scenes: Record<string, SceneDoc>;
    prefabs: Record<string, PrefabDoc>;
    locks: Record<string, { who: string; t: string; value: unknown; note?: string }>;
    touched: Record<string, { who: string; t: string }>;
  };
  /** エディタを使っている人の名前 */
  readonly user: string;
  readonly playing: boolean;
  /** 値を変える。操作ログには「window:<id>」から人が変更したと記録される */
  patch(ops: Op[]): Promise<Change[] | null>;
  /** アドレスの値を読む（例: main#spawner.Spawner.interval）。省略されていれば既定値 */
  get(path: string): unknown;
  /** インスペクタで選ぶ（例: main#player / @enemy） */
  select(address: string): void;
  /** 画面なしで試し実行する。keys は ages run --keys と同じ書き方（"0-600:@fire;100-200:ArrowLeft"） */
  simulate(frames: number, keys?: string, seed?: number): { counts: Record<string, number>; frame: number; ms: number };
  on(event: 'change' | 'select' | 'play' | 'frame', fn: () => void): () => void;
  on(event: 'gameEvent', fn: (ev: GameEvent) => void): () => void;
  /** DOMを作る小さなヘルパー: h('div', { class: 'x', onclick }, '中身', ...) */
  h: (tag: string, attrs?: Record<string, unknown>, ...children: unknown[]) => HTMLElement;
}

export interface EditorWindow {
  id: string;
  title: string;
  /** el に中身を作る。後片付けが必要なら関数を返す */
  mount(el: HTMLElement, api: EditorApi): void | (() => void);
}

export function defineWindow(w: EditorWindow): EditorWindow {
  return w;
}
