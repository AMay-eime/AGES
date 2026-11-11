// エディタの人と AI のやり取り（.ages/talk.jsonl）。操作ログと同じく追記だけで、Git で共有する（統合では両方の行を残す）。
// - AI の作業: 何をしているか・段階・触る予定の場所（エディタの上に出し、操作ログの AI の変更を作業ごとにまとめる）
// - AI からの質問と人の答え（手触り・面白さなど人が決めること。AI は答えを待たずに次へ進み、次の区切りで読む）
// - 人からの付箋と AI の返事（物・欄・行・画面に貼る。AI が片付けたら「済」）
// AI は ages talk で読む。読んでいない人の書き込みがあると、ほかの ages の出力の先頭に1行出る（talkNotice）
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

interface Base { t: string; who: string; kind: 'human' | 'ai' }
export type TalkEvent = Base & (
  | { ev: 'task'; id: string; title: string; steps?: string[]; touch?: string[] }
  | { ev: 'step'; id: string; step?: number; touch?: string[] }
  | { ev: 'done'; id: string; text?: string }
  | { ev: 'ask'; id: string; text: string; choices?: string[]; about?: string; task?: string }
  | { ev: 'answer'; id: string; text: string }
  | { ev: 'note'; id: string; text: string; about?: string }
  | { ev: 'reply'; id: string; text?: string }
  | { ev: 'drop'; id: string }
);
type Draft<E> = E extends Base ? Omit<E, keyof Base> : never;
export type TalkDraft = Draft<TalkEvent>;

export interface Task { id: string; who: string; t: string; last: string; title: string; steps: string[]; step: number; touch: string[]; done?: { t: string; text?: string } }
export interface Ask { id: string; who: string; t: string; text: string; choices: string[]; about?: string; task?: string; answer?: { t: string; who: string; text: string }; dropped?: boolean }
export interface Note { id: string; who: string; t: string; text: string; about?: string; reply?: { t: string; who: string; text?: string }; dropped?: boolean }
export interface TalkState { tasks: Task[]; asks: Ask[]; notes: Note[] }

/** これより前に動きのない作業は、終わっていなくても「いまの作業」にしない（AI が done を忘れた・止まった） */
export const TASK_STALE_MS = 3 * 60 * 60_000;

const fileOf = (root: string) => join(root, '.ages', 'talk.jsonl');
const cursorOf = (root: string) => join(root, '.ages', 'talk-cursor');

export async function readTalk(root: string): Promise<TalkEvent[]> {
  try {
    return (await readFile(fileOf(root), 'utf8')).split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as TalkEvent]; } catch { return []; } });
  } catch {
    return [];
  }
}

/** 新しい ID（t・q・n と、短い乱数。別の端末で同時に書いても重ならない程度） */
export function newId(prefix: 't' | 'q' | 'n'): string {
  return prefix + randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(0, 4);
}

export async function appendTalk(root: string, actor: { who: string; kind: 'human' | 'ai' }, ev: TalkDraft, now = new Date()): Promise<TalkEvent> {
  const e = { t: now.toISOString(), who: actor.who, kind: actor.kind, ...ev } as TalkEvent;
  await mkdir(join(root, '.ages'), { recursive: true });
  await appendFile(fileOf(root), JSON.stringify(e) + '\n');
  return e;
}

export function foldTalk(events: TalkEvent[]): TalkState {
  const tasks = new Map<string, Task>(), asks = new Map<string, Ask>(), notes = new Map<string, Note>();
  for (const e of [...events].sort((a, b) => a.t.localeCompare(b.t))) {
    if (e.ev === 'task') tasks.set(e.id, { id: e.id, who: e.who, t: e.t, last: e.t, title: e.title, steps: e.steps ?? [], step: e.steps?.length ? 1 : 0, touch: e.touch ?? [] });
    else if (e.ev === 'step' || e.ev === 'done') {
      const k = tasks.get(e.id);
      if (!k) continue;
      k.last = e.t;
      if (e.ev === 'done') k.done = { t: e.t, ...(e.text ? { text: e.text } : {}) };
      else {
        if (typeof e.step === 'number') k.step = e.step;
        if (e.touch?.length) k.touch = [...new Set([...k.touch, ...e.touch])];
      }
    } else if (e.ev === 'ask') asks.set(e.id, { id: e.id, who: e.who, t: e.t, text: e.text, choices: e.choices ?? [], ...(e.about ? { about: e.about } : {}), ...(e.task ? { task: e.task } : {}) });
    else if (e.ev === 'answer') { const a = asks.get(e.id); if (a) a.answer = { t: e.t, who: e.who, text: e.text }; }
    else if (e.ev === 'note') notes.set(e.id, { id: e.id, who: e.who, t: e.t, text: e.text, ...(e.about ? { about: e.about } : {}) });
    else if (e.ev === 'reply') { const n = notes.get(e.id); if (n) n.reply = { t: e.t, who: e.who, ...(e.text ? { text: e.text } : {}) }; }
    else if (e.ev === 'drop') { const x = asks.get(e.id) ?? notes.get(e.id); if (x) x.dropped = true; }
  }
  return { tasks: [...tasks.values()], asks: [...asks.values()], notes: [...notes.values()] };
}

/** いまの作業（その AI の、終わっていない新しいもの。who を省くとどの AI でも） */
export function activeTask(s: TalkState, who?: string, now = Date.now()): Task | undefined {
  return s.tasks.filter((k) => !k.done && (!who || k.who === who) && now - Date.parse(k.last) < TASK_STALE_MS).sort((a, b) => b.last.localeCompare(a.last))[0];
}

/** AI が読んだ所（時刻）。共有しない（.gitignore） */
export async function readTalkCursor(root: string): Promise<string> {
  try { return (await readFile(cursorOf(root), 'utf8')).trim(); } catch { return ''; }
}
export async function writeTalkCursor(root: string, t = new Date().toISOString()): Promise<void> {
  await mkdir(join(root, '.ages'), { recursive: true });
  await writeFile(cursorOf(root), t + '\n');
}

/** AI がまだ読んでいない人の書き込み（付箋・答え） */
export function unread(events: TalkEvent[], cursor: string): { notes: number; answers: number } {
  const fresh = events.filter((e) => e.kind === 'human' && e.t > cursor);
  return { notes: fresh.filter((e) => e.ev === 'note').length, answers: fresh.filter((e) => e.ev === 'answer').length };
}

/** ほかの ages の出力の先頭に付ける1行（なければ空） */
export async function talkNotice(root: string): Promise<string> {
  const events = await readTalk(root);
  if (!events.length) return '';
  const u = unread(events, await readTalkCursor(root));
  const parts = [u.notes ? `付箋 ${u.notes}` : '', u.answers ? `答え ${u.answers}` : ''].filter(Boolean);
  return parts.length ? `📌 エディタの人から: ${parts.join('・')}（ages talk で読む）` : '';
}

const hhmm = (t: string) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const about = (a?: string) => (a ? `[${a}] ` : '');

/** AI が読む形（短く）。cursor より新しいものに「新」 */
export function talkView(s: TalkState, who: string, cursor: string, now = Date.now()): string {
  const out: string[] = [];
  const k = activeTask(s, who, now);
  if (k) out.push(`いまの作業 ${k.id}: ${k.title}${k.steps.length ? `（${k.step}/${k.steps.length} ${k.steps[k.step - 1] ?? ''}）` : ''}`);
  const fresh = (t: string) => (t > cursor ? '新 ' : '');
  const open = s.notes.filter((n) => !n.reply && !n.dropped);
  if (open.length) out.push('付箋（人から。片付けたら --reply ID "一言"）:', ...open.map((n) => `  ${fresh(n.t)}${n.id} ${about(n.about)}${n.text}（${n.who} ${hhmm(n.t)}）`));
  const answered = s.asks.filter((a) => a.who === who && a.answer && !a.dropped && a.answer.t > cursor);
  if (answered.length) out.push('答え:', ...answered.map((a) => `  ${a.id} 「${a.text}」→ ${a.answer!.text}（${a.answer!.who} ${hhmm(a.answer!.t)}）`));
  const waiting = s.asks.filter((a) => a.who === who && !a.answer && !a.dropped);
  if (waiting.length) out.push(`答えを待っている質問: ${waiting.map((a) => `${a.id}「${a.text}」`).join(' ')}`);
  const dropped = s.notes.filter((n) => n.dropped && !n.reply && n.t > cursor);
  if (dropped.length) out.push(`取り下げられた付箋: ${dropped.map((n) => n.id).join(' ')}`);
  return out.length ? out.join('\n') : '人からの書き込みはありません';
}
