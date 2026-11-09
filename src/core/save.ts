// セーブ（進み具合と設定の保存・読み込み）。
// 置き場所（ストア）は差し替えられる: ブラウザでは localStorage、画面なしの実行ではメモリ（ファイルから始められる）。
// ゲームのコードは ctx.save だけを使うので、どこで動かしても同じに書ける。
// 設定（キーの割り当て・音量）は、変えたら自動で保存し、始めるときに自動で戻す（config.save.settings を 'manual' にすると止まる）。
import type { World } from './world.ts';
import type { Registry } from './registry.ts';
import { checkAt, suggest } from './schema.ts';

/** 保存の置き場所（キー → JSON の文字列） */
export interface SaveStore {
  /** 今ある全部 */
  load(): Record<string, string>;
  /** 書く（null なら消す） */
  write(key: string, json: string | null): void;
}

/** メモリに置く（画面なしの実行・テスト。ファイルの中身から始められる） */
export class MemoryStore implements SaveStore {
  data: Record<string, string>;
  constructor(init: Record<string, unknown> = {}) {
    this.data = Object.fromEntries(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  }
  load(): Record<string, string> {
    return { ...this.data };
  }
  write(key: string, json: string | null): void {
    if (json === null) delete this.data[key];
    else this.data[key] = json;
  }
  /** 中身を値で（保存データのファイルに書き出す用） */
  values(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.data).map(([k, v]) => [k, JSON.parse(v)]));
  }
}

/** 設定を入れるキー（エンジンが使う。$ で始まるキーはゲームのコードからは書けない） */
export const SETTINGS_KEY = '$settings';

export interface SaveApi {
  /** 値を読む（なければ fallback）。返すのは写しなので、変えたら set で書く */
  get<T = unknown>(key: string, fallback?: T): T;
  /** 値を書く（すぐ保存される）。JSON にできる値（数・文字・true/false・null・配列・オブジェクト）だけ */
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  remove(key: string): void;
  /** キーの一覧（prefix で絞る。スロットは 'slot1/progress' のように / で分ける） */
  keys(prefix?: string): string[];
  /** 物をまとめて保存する（タグか ID で選ぶ）。保存した数を返す */
  saveWorld(key: string, pick: { tags?: string[]; ids?: string[] }): number;
  /**
   * saveWorld で保存した物を戻す。同じ ID の物は置きかえ、ない物は足し、選び方に合うのに保存にない物は消す。
   * 今のコンポーネントの型に合わせる（なくなった値は捨て、足された値は既定値）。戻した数を返す
   */
  loadWorld(key: string): number;
}

/** saveWorld の中身 */
interface WorldSnapshot {
  $world: 1;
  pick: { tags?: string[]; ids?: string[] };
  entities: { id: string; name: string; prefab?: string; tags: string[]; c: Record<string, Record<string, unknown>> }[];
}

/** JSON にできる値か（できなければ、どこがだめかを返す） */
function notJson(v: unknown, at = ''): string | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${at || '値'} が ${v}（数でない）`;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const e = notJson(v[i], `${at}[${i}]`); if (e) return e; } return null; }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v as object)) { const e = notJson(x, at ? `${at}.${k}` : k); if (e) return e; }
    return null;
  }
  return `${at || '値'} は保存できない種類です（${typeof v === 'object' ? (v as object).constructor?.name ?? 'object' : typeof v}）`;
}

export class SaveData {
  private cache = new Map<string, unknown>();
  /** 書いた回数（キー → 回数。ages run の要約用） */
  writes = new Map<string, number>();
  readonly store: SaveStore;
  constructor(store: SaveStore = new MemoryStore()) {
    this.store = store;
    for (const [k, v] of Object.entries(store.load())) {
      try { this.cache.set(k, JSON.parse(v)); } catch { /* 壊れた値は読まない */ }
    }
  }

  read(key: string): unknown {
    return this.cache.has(key) ? structuredClone(this.cache.get(key)) : undefined;
  }

  write(key: string, value: unknown): void {
    const bad = notJson(value);
    if (bad) throw new Error(`ctx.save.set("${key}"): ${bad}。JSON にできる値（数・文字・true/false・null・配列・オブジェクト）だけ保存できます`);
    const json = JSON.stringify(value);
    this.cache.set(key, JSON.parse(json));
    this.store.write(key, json);
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
  }

  delete(key: string): void {
    if (!this.cache.has(key)) return;
    this.cache.delete(key);
    this.store.write(key, null);
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
  }

  keys(): string[] {
    return [...this.cache.keys()].sort();
  }

  /** 全部（保存データのファイル・hash 用） */
  all(): Record<string, unknown> {
    return Object.fromEntries(this.keys().map((k) => [k, this.cache.get(k)]));
  }

  /** ゲームのコードに渡す口。warn は止めずに知らせる */
  api(world: World, registry: Registry, warn: (msg: string) => void): SaveApi {
    const userKey = (where: string, key: string) => {
      if (typeof key !== 'string' || !key) throw new Error(`ctx.save.${where}: キーは空でない文字にします`);
      if (key.startsWith('$')) throw new Error(`ctx.save.${where}("${key}"): $ で始まるキーは AGES が使います（設定は自動で保存されます）`);
      return key;
    };
    return {
      get: <T>(key: string, fallback?: T) => {
        const v = this.read(key);
        return (v === undefined ? fallback : v) as T;
      },
      set: (key, value) => this.write(userKey('set', key), value),
      has: (key) => this.cache.has(key),
      remove: (key) => this.delete(userKey('remove', key)),
      keys: (prefix = '') => this.keys().filter((k) => k.startsWith(prefix) && !k.startsWith('$')),
      saveWorld: (key, pick) => {
        userKey('saveWorld', key);
        if (!pick || (!pick.tags?.length && !pick.ids?.length)) throw new Error(`ctx.save.saveWorld("${key}"): 保存する物を { tags: ['save'] } か { ids: ['player'] } で選んでください`);
        const chosen = [...world.entities.values()].filter((e) => world.isAlive(e.id) && match(e, pick));
        const snap: WorldSnapshot = {
          $world: 1,
          pick: structuredClone(pick),
          entities: chosen.map((e) => ({ id: e.id, name: e.name, ...(e.prefab ? { prefab: e.prefab } : {}), tags: [...e.tags], c: structuredClone(e.c) })),
        };
        this.write(key, snap);
        return chosen.length;
      },
      loadWorld: (key) => {
        userKey('loadWorld', key);
        const snap = this.cache.get(key) as WorldSnapshot | undefined;
        if (snap === undefined) {
          warn(`ctx.save.loadWorld("${key}"): 保存がありません${suggest(key, this.keys().filter((k) => !k.startsWith('$')))}（初めて遊ぶときは、ないのが普通です。has で確かめてから呼ぶ）`);
          return 0;
        }
        if (snap?.$world !== 1) throw new Error(`ctx.save.loadWorld("${key}"): saveWorld で保存した値ではありません`);
        const saved = new Set(snap.entities.map((e) => e.id));
        // 選び方に合うのに保存にない物は消す（拾ったアイテムが戻らないように）
        for (const e of [...world.entities.values()]) if (world.isAlive(e.id) && match(e, snap.pick) && !saved.has(e.id)) world.destroy(e.id);
        for (const s of snap.entities) {
          const comps: Record<string, Record<string, unknown>> = {};
          for (const [name, values] of Object.entries(s.c)) {
            const def = registry.components.get(name);
            if (!def) { warn(`ctx.save.loadWorld("${key}"): ${s.id} の ${name} は今はないコンポーネントなので戻しません${suggest(name, [...registry.components.keys()])}`); continue; }
            const ok: Record<string, unknown> = {};
            for (const [f, v] of Object.entries(values)) {
              const fd = def.fields[f];
              if (!fd) continue; // なくなった値は捨てる
              if (checkAt(`${name}.${f}`, fd, v)) { warn(`ctx.save.loadWorld("${key}"): ${s.id} の ${name}.${f} は今の型に合わないので既定値にします`); continue; }
              ok[f] = v;
            }
            comps[name] = ok;
          }
          const cur = world.get(s.id);
          if (cur && world.isAlive(s.id)) {
            for (const [name, values] of Object.entries(comps)) cur.c[name] = registry.build(name, values, s.id);
            for (const name of Object.keys(cur.c)) if (!(name in comps) && registry.components.has(name)) delete cur.c[name];
            cur.tags = [...s.tags];
          } else {
            world.add({ id: s.id, name: s.name, tags: [...s.tags], components: comps, ...(s.prefab ? { prefab: s.prefab } : {}) } as never);
          }
        }
        return snap.entities.length;
      },
    };
  }
}

function match(e: { id: string; tags: string[] }, pick: { tags?: string[]; ids?: string[] }): boolean {
  return (pick.ids?.includes(e.id) ?? false) || (pick.tags?.some((t) => e.tags.includes(t)) ?? false);
}

/** ブラウザの localStorage に置く（prefix でプロジェクトごとに分ける） */
export class LocalStore implements SaveStore {
  private prefix: string;
  private ls: Storage;
  constructor(prefix: string, ls: Storage) {
    this.prefix = prefix;
    this.ls = ls;
  }
  load(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < this.ls.length; i++) {
        const k = this.ls.key(i);
        if (k?.startsWith(this.prefix)) out[k.slice(this.prefix.length)] = this.ls.getItem(k) ?? 'null';
      }
    } catch { /* 使えないブラウザでは空から */ }
    return out;
  }
  write(key: string, json: string | null): void {
    try {
      if (json === null) this.ls.removeItem(this.prefix + key);
      else this.ls.setItem(this.prefix + key, json);
    } catch (e) {
      console.warn('セーブを書けませんでした', e);
    }
  }
  /** 全部消す */
  clear(): void {
    for (const k of Object.keys(this.load())) this.write(k, null);
  }
}
