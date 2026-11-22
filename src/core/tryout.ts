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

// ---- シーンの中に出す（ages run --scene と --spawn。issue #149） ----

/** シーンの中に出す1つ: プレハブ@位置:フレーム{部品.欄=値,…} */
export interface SceneSpawn {
  prefab: string;
  /** ワールドの座標（2つか3つ）。from があれば、その物からのずれ */
  pos?: number[];
  from?: string;
  /** そのステップの始めに出す */
  frame: number;
  values: Record<string, Record<string, unknown>>;
}

/** "弾@0,1:120{Bullet.kind=big};弾@player+0.05,1:120;敵" → 出すものの並び（; で区切る） */
export function parseSceneSpawns(text: string): SceneSpawn[] {
  return text.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^([A-Za-z0-9_-]+)(?:@(?:([A-Za-z0-9_~$#/-]+)\+)?(-?[\d.]+(?:,-?[\d.]+){1,2}))?(?::(\d+))?(?:\{([^}]*)\})?$/.exec(s);
    if (!m) throw new Error(`--spawn の ${s}: プレハブ@x,y:フレーム{部品.欄=値,…} です（例 弾@0,1:120{Bullet.kind=big}。@物のID+dx,dy でその物からのずれ。@・:・{} は省ける）`);
    const values: Record<string, Record<string, unknown>> = {};
    for (const kv of (m[5] ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const e = /^([A-Za-z_]\w*)\.(\w+)=(.*)$/.exec(kv);
      if (!e) throw new Error(`--spawn の {${kv}}: 部品.欄=値 です（例 Bullet.kind=big）`);
      let v: unknown = e[3];
      try { v = JSON.parse(e[3]); } catch { /* 文字のまま */ }
      (values[e[1]] ??= {})[e[2]] = v;
    }
    return { prefab: m[1], ...(m[3] ? { pos: m[3].split(',').map(Number) } : {}), ...(m[2] ? { from: m[2] } : {}), frame: m[4] ? Number(m[4]) : 0, values };
  });
}

/** そのステップの始めに出すものを出す。出した物の ID（と出せなかった理由）を返す */
export function spawnInScene(game: Game, list: SceneSpawn[]): { prefab: string; id?: string; error?: string }[] {
  const out: { prefab: string; id?: string; error?: string }[] = [];
  for (const s of list.filter((x) => x.frame === game.frame)) {
    let base = [0, 0, 0];
    if (s.from) {
      const f = game.world.entities.get(s.from);
      if (!f) { out.push({ prefab: s.prefab, error: `@${s.from} がいません` }); continue; }
      const w = (f.c.Transform3D ?? game.ctx.worldOf?.(f) ?? f.c.Transform ?? {}) as { x?: number; y?: number; z?: number };
      base = [w.x ?? 0, w.y ?? 0, w.z ?? 0];
    }
    try {
      const e = game.world.spawn(s.prefab, s.values);
      if (s.pos) {
        const t = (e.c.Transform3D ?? e.c.Transform) as Record<string, unknown> | undefined;
        if (t) { t.x = base[0] + s.pos[0]; t.y = base[1] + s.pos[1]; if (e.c.Transform3D) t.z = base[2] + (s.pos[2] ?? 0); }
      }
      out.push({ prefab: s.prefab, id: e.id });
    } catch (err) {
      out.push({ prefab: s.prefab, error: (err as Error).message });
    }
  }
  return out;
}

/** 出した物がすべて消えたか（消えるのはフレームの終わりなので、step の後に見る） */
export const tryoutGone = (game: Game, ids: string[]): boolean => ids.length > 0 && ids.every((id) => !game.world.entities.has(id));
