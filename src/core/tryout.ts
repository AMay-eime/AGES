// 試し: 選んだプレハブだけを、空のシーンに出して動かす（エディタの「試し」の窓と ages run --spawn が同じものを使う）。
// ふつうのシーンと同じゲームの決まり（システム・音・粒・当たり判定）で動くが、scenes で絞ったシステムは動かない。
import type { SceneDoc } from './docs.ts';
import type { Game } from './game.ts';

/** 試しのシーンの名前（ふつうのシーンには使えない名前） */
export const TRYOUT_SCENE = '$tryout';

export interface TryoutSpawn {
  prefab: string;
  /** 画面の真ん中からのずれ(px) */
  x?: number;
  y?: number;
  /** 出すときに変える値（{ 部品: { フィールド: 値 } }） */
  values?: Record<string, Record<string, unknown>>;
}

/** 空の試しのシーン */
export function tryoutScene(): SceneDoc {
  return { name: TRYOUT_SCENE, desc: '試し（選んだプレハブだけ）', entities: [] };
}

/** "enemy_fast,explosion@40,-20" → 出すものの並び（@ の後は真ん中からのずれ） */
export function parseSpawns(text: string): TryoutSpawn[] {
  return [...text.matchAll(/([A-Za-z0-9_-]+)(?:@(-?[\d.]+),(-?[\d.]+))?/g)].map((m) => ({ prefab: m[1], ...(m[2] !== undefined ? { x: Number(m[2]), y: Number(m[3]) } : {}) }));
}

/** 画面（設計の大きさ）の真ん中からのずれで出す。出した物の ID を返す */
export function spawnTryout(game: Game, spawns: TryoutSpawn[], width: number, height: number): string[] {
  return spawns.map((s) => {
    const pos = { x: width / 2 + (s.x ?? 0), y: height / 2 + (s.y ?? 0) };
    const e = game.world.spawn(s.prefab, { ...(s.values ?? {}), Transform: { ...(s.values?.Transform ?? {}), ...pos } });
    // 音のプレハブ（物が現れても鳴らないもの）は、ゲームのコードと同じく名前で1回鳴らす
    const snd = e.c.Sound as { playOnStart?: boolean } | undefined;
    if (snd && !snd.playOnStart) game.ctx.sound.play(s.prefab);
    return e.id;
  });
}

/** 出した物がすべて消えたか（消えるのはフレームの終わりなので、step の後に見る） */
export const tryoutGone = (game: Game, ids: string[]): boolean => ids.length > 0 && ids.every((id) => !game.world.entities.has(id));
