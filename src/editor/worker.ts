// エディタのサーバーが使う作業スレッド。プロジェクトを1つ持ち、検証付きの編集を行う。
// ゲームコードが変わったらスレッドごと作り直す（モジュールのキャッシュを確実に捨てるため）。
import { versionNote } from '../project/version.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { Project } from '../project/project.ts';
import { readTouched, readLog, type Actor } from '../project/oplog.ts';
import type { Op } from '../core/patch.ts';

const port = parentPort!;
let project: Project;
let loadError = '';
try {
  project = await Project.load(workerData.dir);
} catch (e) {
  loadError = (e as Error).message;
}

/**
 * 重い中身（検証の ⚠・コードの中のアセットの場所）は、変える頼みが来るまで作り置く（エディタは変更のたびに state を取り直すので、毎回作ると1秒ほどかかっていた）。
 * コードが変わったときは、スレッドごと作り直すので作り置きも捨てられる
 */
let heavy: { issues: string[]; codeRefs: Record<string, string[]> } | null = null;
/** コードの中のアセットの場所は、アセットの一覧が同じなら同じ（コードが変わるとスレッドごと作り直す） */
let refs: { key: string; value: Record<string, string[]> } | null = null;
async function codeRefsCached(): Promise<Record<string, string[]>> {
  const key = project.assets.map((a) => a.path).join('\n');
  if (refs?.key !== key) refs = { key, value: Object.fromEntries(await project.codeRefs()) };
  return refs.value;
}
const READ_ONLY = new Set(['state', 'lockState', 'describe', 'lockCandidates', 'undoState', 'log']);

async function state() {
  if (loadError) return { error: loadError };
  const ver = versionNote(project.config.engine);
  heavy ??= { issues: [...project.validate(), ...project.projectChecks().map((m) => `⚠ ${m}`), ...(ver ? [`⚠ ${ver}`] : [])], codeRefs: await codeRefsCached() };
  return {
    config: project.config,
    scenes: Object.fromEntries(project.docs.scenes),
    prefabs: Object.fromEntries(project.docs.prefabs),
    touched: await readTouched(project.dir),
    locks: await project.effectiveLocks(),
    sheets: Object.fromEntries(project.registry.sheets),
    tables: Object.fromEntries(project.docs.tables),
    assets: project.assets,
    saves: [...project.saves.keys()],
    codeRefs: heavy.codeRefs,
    issues: heavy.issues,
    lockReport: project.lockReport,
    integrity: { ok: project.integrity.ok, reason: project.integrity.reason, diff: project.lockDiff(), hasBackup: !!project.integrity.backup },
  };
}

const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
  state,
  async apply(ops: Op[], actor: Actor) {
    const r = await project.apply(ops, actor);
    return { changes: r.changes, warnings: r.warnings };
  },
  async lock(paths: string[], actor: Actor, note?: string) {
    await project.lock(paths, actor, note);
  },
  async unlock(paths: string[], actor: Actor) {
    await project.unlock(paths, actor);
  },
  async approveLocks(actor: Actor) {
    await project.approveLocks(actor);
  },
  async restoreLocks(actor: Actor) {
    await project.restoreLocks(actor);
  },
  /** ロックの記録が外から変わったとき: 読み直して検査し、ロックを効かせ直す */
  async recheckLocks() {
    await project.reload();
    return { ok: project.integrity.ok, lockReport: project.lockReport };
  },
  async lockState() {
    return project.lockState();
  },
  async describe(path: string) {
    return project.describe(path);
  },
  async lockCandidates(text: string) {
    return project.lockCandidates(text);
  },
  async upload(actor: Actor, rel: string, data: Uint8Array) {
    return project.upload(rel, Buffer.from(data), actor);
  },
  async undo(actor: Actor, opts: { tx?: string; redo?: boolean }) {
    const r = await project.undo(actor, opts);
    return { changes: r.changes, label: r.label, warnings: r.warnings };
  },
  async undoState(actor: Actor) {
    return project.undoState(actor);
  },
  async replaceLockedFile(rel: string, data: Uint8Array, actor: Actor) {
    await project.replaceLockedFile(rel, Buffer.from(data), actor);
  },
  async humanTextEdit(actor: Actor) {
    return { changes: await project.humanTextEdit(actor) };
  },
  async externalEdit() {
    return project.externalEdit();
  },
  async log(limit: number) {
    const all = await readLog(project.dir);
    return all.slice(-limit);
  },
};

// 頼みは1つずつ順に処理する（patch の途中で次の patch が始まると、同じファイルを重ねて書いて壊すことがある）
let queue: Promise<void> = Promise.resolve();
port.on('message', (msg: { id: number; type: string; args: unknown[] }) => {
  queue = queue.then(() => handle(msg));
});

async function handle(msg: { id: number; type: string; args: unknown[] }): Promise<void> {
  try {
    if (loadError && msg.type !== 'state') throw new Error(`プロジェクトを読み込めません: ${loadError}`);
    if (!READ_ONLY.has(msg.type)) heavy = null;
    const result = await handlers[msg.type](...msg.args);
    const written = project ? Object.fromEntries(project.written) : {};
    project?.written.clear();
    port.postMessage({ id: msg.id, ok: true, result, written });
  } catch (e) {
    port.postMessage({ id: msg.id, ok: false, error: (e as Error).message });
  }
}

port.postMessage({ ready: true });
