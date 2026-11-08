// 元に戻す・やり直しの記録（編集ごとに、変わった文書の前と後）。この端末の使用者のフォルダに置く（Git では共有しない）。
// 操作ログ（.ages/oplog.jsonl）は「何が変わったか」の要約、こちらは戻すための中身。
import { appendFile, mkdir, readFile, writeFile, copyFile, cp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { agesHome } from './seal.ts';
import type { Op } from '../core/patch.ts';

export interface DocState {
  /** 編集の前（null は無かった） */
  before: unknown;
  /** 編集の後（null は無くなった） */
  after: unknown;
}

/**
 * ファイルの操作（戻せる形）。trash は記録の置き場所に取った中身の控えの名前
 * move: 場所の変更 / delete: 消した（trash に中身） / create: 作った（trash の中身から） / replace: 中身の差し替え（old → new）
 */
export type FileMove =
  | { kind: 'move'; from: string; to: string; dir: boolean }
  | { kind: 'delete'; path: string; dir: boolean; trash: string }
  | { kind: 'create'; path: string; dir: boolean; trash: string }
  | { kind: 'replace'; path: string; oldTrash: string; newTrash: string };

/** 逆の操作（逆の順に行う） */
export function inverseFiles(list: FileMove[]): FileMove[] {
  return [...list].reverse().map((f) => f.kind === 'move' ? { ...f, from: f.to, to: f.from }
    : f.kind === 'delete' ? { ...f, kind: 'create' as const }
    : f.kind === 'create' ? { ...f, kind: 'delete' as const }
    : { ...f, oldTrash: f.newTrash, newTrash: f.oldTrash });
}

export interface TxRecord {
  id: string;
  t: string;
  who: string;
  kind: 'human' | 'ai' | 'system';
  win?: string;
  /** 何をしたか（短い要約。エディタの「元に戻す」の説明に出る） */
  label: string;
  /** 変わった文書（"scene:main" / "prefab:enemy" / "table:enemies" / "sheet:assets/x.png" / "config"） */
  docs: Record<string, DocState>;
  files?: FileMove[];
  /** 名前の変更・場所の変更だけの編集は、逆の操作で戻す（参照・ロック・★も付いて動くように） */
  ops?: Op[];
  inverse?: Op[];
  /** この記録が、どの編集を戻したものか・やり直したものか */
  undoOf?: string;
  redoOf?: string;
}

const MAX = 300;

export class Journal {
  readonly dir: string;
  constructor(root: string) {
    this.dir = join(agesHome(), 'undo', createHash('sha1').update(resolve(root)).digest('hex'));
  }
  private get file() { return join(this.dir, 'journal.jsonl'); }

  newId(): string {
    return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  }

  async read(): Promise<TxRecord[]> {
    try {
      return (await readFile(this.file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async append(rec: TxRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file, JSON.stringify(rec) + '\n');
    // 古いものは捨てる（控えのファイルも）
    const all = await this.read();
    if (all.length > MAX * 1.2) {
      const drop = all.slice(0, all.length - MAX);
      for (const r of drop) for (const f of r.files ?? []) for (const t of 'trash' in f ? [f.trash] : 'oldTrash' in f ? [f.oldTrash, f.newTrash] : []) await rm(join(this.dir, 'trash', t), { recursive: true, force: true });
      await writeFile(this.file, all.slice(-MAX).map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
  }

  /** ファイル（かフォルダ）の控えを取る。名前を返す */
  async keep(abs: string, dir: boolean): Promise<string> {
    const name = this.newId();
    const dest = join(this.dir, 'trash', name);
    await mkdir(dirname(dest), { recursive: true });
    if (dir) await cp(abs, dest, { recursive: true });
    else await copyFile(abs, dest);
    return name;
  }

  trashPath(name: string): string {
    return join(this.dir, 'trash', name);
  }

  /**
   * それぞれの編集の今の状態。done: 効いている / undone: 戻した / superseded: やり直しで置き換わった
   */
  static status(all: TxRecord[]): Map<string, 'done' | 'undone' | 'superseded'> {
    const st = new Map<string, 'done' | 'undone' | 'superseded'>();
    for (const r of all) {
      st.set(r.id, 'done');
      if (r.undoOf) st.set(r.undoOf, 'undone');
      if (r.redoOf) st.set(r.redoOf, 'superseded');
    }
    return st;
  }

  /** この人が次に「元に戻す」ときの編集と、「やり直す」ときの編集 */
  static next(all: TxRecord[], who: string, kind: string): { undo?: TxRecord; redo?: TxRecord } {
    const st = Journal.status(all);
    const mine = all.filter((r) => r.who === who && r.kind === kind && r.win !== 'lock-manager');
    const undo = [...mine].reverse().find((r) => !r.undoOf && st.get(r.id) === 'done');
    // やり直せるのは、戻した後にこの人が新しい編集をしていないときだけ（ふつうのエディタと同じ）
    let redo: TxRecord | undefined;
    for (let i = mine.length - 1; i >= 0; i--) {
      const r = mine[i];
      if (!r.undoOf && !r.redoOf) break; // 新しい編集があれば、やり直しの列は消える
      if (r.undoOf && st.get(r.id) === 'done') {
        const orig = all.find((x) => x.id === r.undoOf);
        if (orig && st.get(orig.id) === 'undone') { redo = orig; break; }
      }
    }
    return { undo, redo };
  }
}
