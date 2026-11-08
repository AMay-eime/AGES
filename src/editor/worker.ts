// エディタのサーバーが使う作業スレッド。プロジェクトを1つ持ち、検証付きの編集を行う。
// ゲームコードが変わったらスレッドごと作り直す（モジュールのキャッシュを確実に捨てるため）。
import { parentPort, workerData } from 'node:worker_threads';
import { Project } from '../project/project.ts';
import { appendLog, readTouched, readLog, type Actor } from '../project/oplog.ts';
import type { Change, Op } from '../core/patch.ts';

const port = parentPort!;
let project: Project;
let loadError = '';
try {
  project = await Project.load(workerData.dir);
} catch (e) {
  loadError = (e as Error).message;
}

async function state() {
  if (loadError) return { error: loadError };
  return {
    config: project.config,
    scenes: Object.fromEntries(project.docs.scenes),
    prefabs: Object.fromEntries(project.docs.prefabs),
    touched: await readTouched(project.dir),
    locks: await project.effectiveLocks(),
    sheets: Object.fromEntries(project.registry.sheets),
    tables: Object.fromEntries(project.docs.tables),
    assets: project.assets,
    codeRefs: Object.fromEntries(await project.codeRefs()),
    issues: project.validate(),
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
  /** エディタからファイルを取り込んだ・差し替えたことを操作ログに残す（AIが「人が画像を足した」と分かるように） */
  async logFiles(actor: Actor, changes: Change[]) {
    await appendLog(project.dir, actor, 'upload', changes);
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
  async fileLocked(rel: string) {
    return !!(await project.effectiveLocks())[`file:${rel}`];
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

port.on('message', async (msg: { id: number; type: string; args: unknown[] }) => {
  try {
    if (loadError && msg.type !== 'state') throw new Error(`プロジェクトを読み込めません: ${loadError}`);
    const result = await handlers[msg.type](...msg.args);
    const written = project ? Object.fromEntries(project.written) : {};
    project?.written.clear();
    port.postMessage({ id: msg.id, ok: true, result, written });
  } catch (e) {
    port.postMessage({ id: msg.id, ok: false, error: (e as Error).message });
  }
});

port.postMessage({ ready: true });
