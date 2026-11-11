// エディタの「AI」: AI の作業・質問・付箋（.ages/talk.jsonl）と、AI の変更（操作ログの AI の行・エディタの外で変わったコード）を、
// 人が確かめたか。印（未確認・AI が触る予定・付箋）をパネル・インスペクタ・階層・表に出すための索引も持つ。
import type { TalkState, Task, Ask, Note } from '../project/talk.ts';
import type { CodeChange } from '../project/review.ts';
import { parseAddress } from '../core/docs.ts';
import { toast } from './ui/dom.ts';
import { T } from './i18n.ts';
import type { App } from './app.ts';

export type { Task, Ask, Note, CodeChange };

export interface AiEntry { t: string; who: string; kind: string; win?: string; op: string; path: string; from?: unknown; to?: unknown; auto?: boolean; tx?: string; task?: string }

/** 確かめる単位: 1回の編集（操作ログの行のまとまり）か、コードの1つの変更 */
export type AiItem =
  | { kind: 'edit'; key: string; t: string; who: string; tx?: string; task?: string; entries: AiEntry[] }
  | { kind: 'code'; key: string; t: string; who?: string; task?: string; change: CodeChange };

export interface AiGroup { key: string; task?: Task; items: AiItem[] }

/** これより前に動きのない作業は「いまの作業」にしない（サーバーの TASK_STALE_MS と同じ） */
const STALE_MS = 3 * 60 * 60_000;
/** AI の変更が来てからこの間は、印を光らせる */
export const FRESH_MS = 8000;

/** 住所の、外側から順の住所（main#player.Transform.x → main#player, main#player.Transform, main#player.Transform.x） */
export function prefixes(addr: string): string[] {
  const out: string[] = [];
  for (let i = 1; i < addr.length; i++) if ('.[|'.includes(addr[i])) out.push(addr.slice(0, i));
  out.push(addr);
  return out;
}
const under = (a: string, b: string) => b === a || b.startsWith(a + '.') || b.startsWith(a + '[') || b.startsWith(a + '|');

export class AiModel {
  talk: TalkState = { tasks: [], asks: [], notes: [] };
  review: { all?: string; ack: Record<string, string> } = { ack: {} };
  code: CodeChange[] = [];
  log: AiEntry[] = [];
  /** 来たばかりの AI の変更の住所（外側の住所も）と、光らせる期限 */
  private freshSet = new Set<string>();
  private freshUntil = 0;
  private newSet = new Set<string>();
  private touchSet = new Set<string>();
  private touchList: string[] = [];
  private noteMap = new Map<string, Note[]>();
  private unseenCache: AiItem[] = [];
  private loaded = false;

  private app: App;
  constructor(app: App) { this.app = app; }

  async refresh(): Promise<void> {
    try {
      const r = await this.app.api<{ talk: TalkState; review: AiModel['review']; code: CodeChange[]; log: AiEntry[] }>('/api/ai');
      const before = new Set(this.unseenCache.map((x) => x.key));
      const askBefore = new Set(this.waitingAsks().map((a) => a.id));
      this.talk = r.talk;
      this.review = r.review;
      this.code = r.code;
      this.log = r.log;
      this.index();
      // 読み込んでから新しく来たもの: 光らせる・質問は知らせる
      if (this.loaded) {
        const came = this.unseenCache.filter((x) => !before.has(x.key));
        if (came.length) {
          this.freshSet = new Set(came.flatMap((x) => (x.kind === 'edit' ? x.entries.flatMap((e) => prefixes(e.path)) : [])));
          this.freshUntil = Date.now() + FRESH_MS;
        }
        for (const a of this.waitingAsks()) if (!askBefore.has(a.id)) toast(T('🤖 AI から質問: {0}', a.text), '', 8000);
      }
      this.loaded = true;
      this.app.emit('ai');
    } catch { /* 起動直後・古いサーバー */ }
  }

  private acked(key: string, t: string): boolean {
    return (!!this.review.all && t <= this.review.all) || key in this.review.ack;
  }

  private index(): void {
    // 確かめていない AI の変更（1回の編集ごと）とコード
    const byKey = new Map<string, Extract<AiItem, { kind: 'edit' }>>();
    for (const e of this.log) {
      const key = e.tx ? `tx:${e.tx}` : `e:${e.t}|${e.path}`;
      if (this.acked(key, e.t)) continue;
      const cur = byKey.get(key);
      if (cur) cur.entries.push(e);
      else byKey.set(key, { kind: 'edit', key, t: e.t, who: e.who, ...(e.tx ? { tx: e.tx } : {}), ...(e.task ? { task: e.task } : {}), entries: [e] });
    }
    const code: AiItem[] = this.code.filter((c) => !this.acked(`code:${c.id}`, c.t)).map((c) => ({ kind: 'code', key: `code:${c.id}`, t: c.t, ...(c.who ? { who: c.who } : {}), ...(c.task ? { task: c.task } : {}), change: c }));
    this.unseenCache = [...byKey.values(), ...code].sort((a, b) => b.t.localeCompare(a.t));
    this.newSet = new Set(this.unseenCache.flatMap((x) => (x.kind === 'edit' ? x.entries.flatMap((e) => prefixes(e.path)) : [])));
    this.touchList = this.activeTasks().flatMap((k) => k.touch);
    this.touchSet = new Set(this.touchList.flatMap(prefixes));
    this.noteMap = new Map();
    for (const n of this.openNotes()) if (n.about) for (const p of prefixes(n.about)) this.noteMap.set(p, [...(this.noteMap.get(p) ?? []), n]);
  }

  /** 確かめていない AI の変更（新しい順） */
  unseen(): AiItem[] { return this.unseenCache; }

  /** 作業ごとのまとめ（作業名のない変更は1つにまとめる）。新しい作業が先 */
  groups(): AiGroup[] {
    const map = new Map<string, AiGroup>();
    for (const x of this.unseenCache) {
      const key = x.task ?? '';
      if (!map.has(key)) map.set(key, { key, ...(x.task ? { task: this.talk.tasks.find((k) => k.id === x.task) } : {}), items: [] });
      map.get(key)!.items.push(x);
    }
    return [...map.values()];
  }

  /** いまの作業（終わっていない・止まっていないもの） */
  activeTasks(now = Date.now()): Task[] {
    return this.talk.tasks.filter((k) => !k.done && now - Date.parse(k.last) < STALE_MS).sort((a, b) => b.last.localeCompare(a.last));
  }
  /** 終わった作業（新しい順） */
  doneTasks(): Task[] { return this.talk.tasks.filter((k) => k.done).sort((a, b) => b.done!.t.localeCompare(a.done!.t)); }
  waitingAsks(): Ask[] { return this.talk.asks.filter((a) => !a.answer && !a.dropped); }
  answeredAsks(): Ask[] { return this.talk.asks.filter((a) => a.answer && !a.dropped).sort((a, b) => b.answer!.t.localeCompare(a.answer!.t)); }
  openNotes(): Note[] { return this.talk.notes.filter((n) => !n.reply && !n.dropped); }
  doneNotes(): Note[] { return this.talk.notes.filter((n) => n.reply && !n.dropped).sort((a, b) => b.reply!.t.localeCompare(a.reply!.t)); }

  /** 住所の印: AI が変えて確かめていない（fresh は来たばかり）・AI が触る予定・人の付箋 */
  mark(addr: string): { unseen: boolean; fresh: boolean; touch: boolean; notes: Note[] } {
    const unseen = this.newSet.has(addr);
    const fresh = unseen && Date.now() < this.freshUntil && this.freshSet.has(addr);
    // 触る予定は、その物と外側だけに（中の欄すべてに付けると、インスペクタ全体が塗られて見分けにくい）
    return { unseen, fresh, touch: this.touchSet.has(addr), notes: this.noteMap.get(addr) ?? [] };
  }

  /** AI が触る予定の所か（中の欄も。人が入力を始めたときに知らせる） */
  touches(addr: string): boolean {
    return this.touchSet.has(addr) || this.touchList.some((t) => under(t, addr));
  }

  async ack(items: AiItem[]): Promise<void> {
    if (!items.length) return;
    await this.app.api('/api/ai/ack', { body: { keys: Object.fromEntries(items.map((x) => [x.key, x.t])) } });
    await this.refresh();
  }
  async ackAll(): Promise<void> {
    await this.app.api('/api/ai/ack', { body: { all: true } });
    await this.refresh();
  }
  async diff(id: string): Promise<string> {
    return (await this.app.api<{ diff: string }>(`/api/ai/diff?id=${encodeURIComponent(id)}`)).diff;
  }

  /** 戻す（1回の編集ずつ、新しい順に。途中で止まったらそこまで）。コードの変更は戻せない */
  async undo(items: AiItem[]): Promise<void> {
    for (const x of [...items].sort((a, b) => b.t.localeCompare(a.t))) {
      if (x.kind !== 'edit' || !x.tx) continue;
      try {
        await this.app.api('/api/undo', { body: { tx: x.tx } });
      } catch (e) {
        toast((e as Error).message, 'bad', 8000);
        break;
      }
    }
    await this.app.refresh();
    await this.ack(items.filter((x) => x.kind === 'edit' && x.tx));
  }

  async answer(id: string, text: string): Promise<void> { await this.talkPost({ ev: 'answer', id, text }); }
  async note(text: string, about?: string): Promise<void> { await this.talkPost({ ev: 'note', text, ...(about ? { about } : {}) }); toast(T('📌 付箋を貼りました（AI は次の作業の区切りで読みます）')); }
  async drop(id: string): Promise<void> { await this.talkPost({ ev: 'drop', id }); }
  private async talkPost(b: Record<string, string>): Promise<void> {
    try { await this.app.api('/api/talk', { body: b }); } catch (e) { toast((e as Error).message, 'bad'); }
    await this.refresh();
  }

  /** その住所の所を見せる（物・プレハブはインスペクタ、表は表のエディタ、画像は切り方、ファイルはテキスト） */
  reveal(addr: string): void {
    if (addr.startsWith('sheet:')) { this.app.emit('openSprite', addr.slice(6).split('|')[0]); return; }
    if (addr.startsWith('file:')) { this.app.emit('openText', addr.slice(5)); return; }
    if (/\.(ts|md|frag|glsl|json)$/.test(addr) && !addr.includes('#') && !addr.startsWith('@') && !addr.startsWith('$')) { this.app.emit('openText', addr); return; }
    try {
      const a = parseAddress(addr.replace(/^scene:/, ''));
      if (a.kind === 'table') { this.app.emit('openTable', { name: a.doc, row: a.entity }); return; }
      if (a.kind === 'prefab') this.app.select({ kind: 'prefab', name: a.doc });
      else if (a.entity) this.app.select({ kind: 'scene', scene: a.doc, id: a.entity });
      else { this.app.scene = a.doc; this.app.select(null); }
      this.app.emit('showPanel', 'inspector');
    } catch { /* 読めない住所 */ }
  }
}
