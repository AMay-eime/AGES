// エディタのサーバーが使う作業スレッド。プロジェクトを1つ持ち、検証付きの編集を行う。
// ゲームコードが変わったらスレッドごと作り直す（モジュールのキャッシュを確実に捨てるため）。
import { parentPort, workerData } from 'node:worker_threads';
import { Project } from '../project/project.ts';
import { readLocks, readTouched, readLog, type Actor } from '../project/oplog.ts';
import type { Op } from '../core/patch.ts';

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
    locks: await readLocks(project.dir),
    issues: project.validate(),
    lockReport: project.lockReport,
  };
}

const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
  state,
  async apply(ops: Op[], actor: Actor) {
    const r = await project.apply(ops, actor);
    return { changes: r.changes };
  },
  async lock(paths: string[], actor: Actor, note?: string) {
    await project.lock(paths, actor, note);
  },
  async unlock(paths: string[], actor: Actor) {
    await project.unlock(paths, actor);
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
