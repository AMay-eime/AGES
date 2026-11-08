// AGES エディタのサーバー（依存ゼロ）。
//   node src/editor/server.ts <プロジェクトのフォルダ> [--port 5170]
// - TypeScript はその場で型を取り除いてブラウザへ配る（コンパイル待ちなし）
// - ファイルの変更を監視し、ブラウザへ即座に知らせる（ホットリロード）
// - 外部（別のエディタやAI）による直接の編集も検出してログに残し、ロックされた値は即座に元に戻す
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { stripTypeScriptTypes } from 'node:module';
import { watch, existsSync } from 'node:fs';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve, join, relative, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, readLog } from '../project/oplog.ts';

process.removeAllListeners('warning');

const args = process.argv.slice(2);
const projectDir = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const port = Number(args[args.indexOf('--port') + 1]) || 5170;
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const EDITOR_DIR = fileURLToPath(new URL('.', import.meta.url));

if (!existsSync(join(projectDir, 'ages.project.json'))) {
  console.error(`error: ${projectDir} に ages.project.json がありません`);
  process.exit(1);
}

// ---------- 作業スレッド ----------
let version = 1;
let worker: Worker;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
/** このサーバーが書いたファイルの内容（監視で「自分の書き込み」を無視するため） */
const known = new Map<string, string>();

function startWorker(): Promise<void> {
  worker?.terminate();
  for (const p of pending.values()) p.reject(new Error('作業スレッドを再起動しました'));
  pending.clear();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { dir: projectDir } });
  return new Promise((ok) => {
    worker.on('message', (m) => {
      if (m.ready) return ok();
      for (const [path, text] of Object.entries(m.written ?? {})) known.set(path, text as string);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    });
    worker.on('error', (e: Error) => console.error('worker:', e.message));
  });
}

function call<T = any>(type: string, ...a: unknown[]): Promise<T> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, args: a });
  });
}

// ---------- ブラウザへの通知（Server-Sent Events） ----------
const clients = new Set<http.ServerResponse>();
function broadcast(ev: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(data);
}

// ---------- ファイルの監視 ----------
const changed = new Set<string>();
let timer: NodeJS.Timeout | undefined;
watch(projectDir, { recursive: true }, (_ev, name) => {
  if (!name) return;
  const rel = name.split(sep).join('/');
  // ロックの記録は外から書き換えられたら検査し直す（それ以外の .ages/ は無視）
  if (rel === '.ages/locks.json' || rel === '.ages/locks.seal') {
    clearTimeout(lockTimer);
    lockTimer = setTimeout(recheckLocks, 150);
    return;
  }
  if (rel.startsWith('.git/') || rel.startsWith('.ages/') || rel.includes('node_modules/')) return;
  changed.add(rel);
  clearTimeout(timer);
  timer = setTimeout(flushChanges, 120);
});

let lockTimer: NodeJS.Timeout | undefined;
let lastLockOk = true;
/** Gitパネルからのプル中は、ロックの記録の変化を「外部の書き換え」として扱わない（プルの後でまとめて処理する） */
let pulling = false;
async function recheckLocks(): Promise<void> {
  if (pulling) return;
  const r = await call<{ ok: boolean; lockReport: string[] }>('recheckLocks').catch(() => null);
  if (!r) return;
  // 状態が変わったとき、または問題があるときだけ知らせる（エディタ自身の書き込みでは何も起きない）
  if (!r.ok || r.ok !== lastLockOk) broadcast({ type: 'locks', integrity: r.ok, lockReport: r.lockReport });
  if (!r.ok && lastLockOk) console.log(r.lockReport.filter((l) => l.startsWith('⚠')).join('\n'));
  lastLockOk = r.ok;
}

let flushing = Promise.resolve();
function flushChanges(): void {
  const paths = [...changed];
  changed.clear();
  flushing = flushing.then(() => handleChanges(paths)).catch((e) => console.error(e));
}

async function handleChanges(paths: string[]): Promise<void> {
  const fresh: string[] = [];
  for (const rel of paths) {
    const abs = join(projectDir, rel);
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text !== null && known.get(abs) === text) continue; // 自分で書いたもの
    if (text !== null) known.set(abs, text);
    fresh.push(rel);
  }
  if (!fresh.length) return;
  const code = fresh.some((p) => p.endsWith('.ts') || p === 'ages.project.json');
  const docs = fresh.some((p) => /^(scenes|prefabs)\/.+\.json$/.test(p));
  if (code) {
    version++;
    await startWorker();
    broadcast({ type: 'code', version, paths: fresh });
    console.log(`コードが変わりました: ${fresh.join(', ')}（v${version}）`);
  } else if (docs) {
    const r = await call<{ changes: unknown[]; lockReport: string[] }>('externalEdit');
    broadcast({ type: 'docs', by: 'external', changes: r.changes, lockReport: r.lockReport });
    if (r.lockReport.length) console.log(r.lockReport.map((l) => '🔒 ' + l).join('\n'));
  } else {
    broadcast({ type: 'files', paths: fresh });
  }
}

// ---------- HTTP ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function inside(dir: string, rel: string): string {
  const root = resolve(dir);
  const abs = resolve(root, '.' + '/' + decodeURIComponent(rel));
  if (abs !== root && !abs.startsWith(root + sep)) throw Object.assign(new Error('フォルダの外は開けません'), { status: 403 });
  return abs;
}

async function serveFile(res: http.ServerResponse, abs: string): Promise<void> {
  const ext = extname(abs);
  let body: Buffer | string = await readFile(abs);
  if (ext === '.ts') body = stripTypeScriptTypes(body.toString('utf8'), { mode: 'strip' });
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

async function body(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const json = (res: http.ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

const human = (req: http.IncomingMessage, win: string) => ({
  who: decodeURIComponent(String(req.headers['x-ages-user'] ?? 'human')) || 'human',
  kind: 'human' as const,
  win,
});

async function listFiles(dir = projectDir, base = ''): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name === '.git' || name === 'node_modules' || name === '.ages') continue;
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const s = await stat(abs);
    if (s.isDirectory()) out.push(...(await listFiles(abs, rel)));
    else out.push({ path: rel, size: s.size });
  }
  return out;
}

function git(a: string[]): Promise<string> {
  return new Promise((ok) => {
    execFile('git', a, { cwd: projectDir }, (err, stdout, stderr) => ok((stdout + stderr).trim() || (err ? err.message : '')));
  });
}

async function gitDraft(): Promise<string> {
  const since = (await git(['log', '-1', '--format=%cI', '--', '.'])).trim();
  const entries = (await readLog(projectDir)).filter((e) => !since || /fatal|not a git/.test(since) || e.t > new Date(since).toISOString());
  if (!entries.length) return 'AGES: 編集';
  const who = [...new Set(entries.map((e) => e.who))].join(', ');
  return `AGES: ${entries.length}件の編集（${who}）\n\n${summarize(entries)}`;
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const m = req.method ?? 'GET';

  if (p === '/' || p === '/index.html') return serveFile(res, join(EDITOR_DIR, 'index.html'));
  if (p.startsWith('/editor/')) return serveFile(res, inside(EDITOR_DIR, p.slice('/editor/'.length)));
  // エンジン本体（src/core, src/render, src/index.ts）はルートに置く。エディタのコードの相対 import がそのまま通る
  if (/^\/(core|render)\//.test(p) || p === '/index.ts') return serveFile(res, inside(SRC_DIR, p.slice(1)));
  const proj = p.match(/^\/project@\d+\/(.*)$/);
  if (proj) return serveFile(res, inside(projectDir, proj[1]));

  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', version })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/state') return json(res, { ...(await call('state')), version, files: await listFiles() });
  if (p === '/api/log') return json(res, await call('log', Number(url.searchParams.get('limit') ?? 200)));

  if (m === 'POST' && p === '/api/patch') {
    const { ops, win } = JSON.parse((await body(req)).toString('utf8'));
    const r = await call('apply', ops, human(req, win ?? 'inspector'));
    broadcast({ type: 'docs', by: human(req, '').who, changes: r.changes });
    return json(res, r);
  }
  if (m === 'POST' && (p === '/api/locks/approve' || p === '/api/locks/restore')) {
    await call(p.endsWith('approve') ? 'approveLocks' : 'restoreLocks', human(req, 'lock-check'));
    lastLockOk = true;
    broadcast({ type: 'locks', integrity: true });
    return json(res, { ok: true });
  }
  if (m === 'POST' && (p === '/api/lock' || p === '/api/unlock')) {
    const { paths, note } = JSON.parse((await body(req)).toString('utf8'));
    await call(p === '/api/lock' ? 'lock' : 'unlock', paths, human(req, 'inspector'), note);
    broadcast({ type: 'locks' });
    return json(res, { ok: true });
  }
  if (p === '/api/file') {
    const rel = url.searchParams.get('path') ?? '';
    const abs = inside(projectDir, rel);
    if (m === 'GET') return json(res, { path: rel, text: await readFile(abs, 'utf8') });
    if (m === 'PUT') {
      const text = (await body(req)).toString('utf8');
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text);
      known.set(abs, text);
      const who = human(req, 'text');
      if (/^(scenes|prefabs)\/.+\.json$/.test(rel)) {
        const r = await call('humanTextEdit', who);
        broadcast({ type: 'docs', by: who.who, changes: r.changes });
      } else if (rel.endsWith('.ts') || rel === 'ages.project.json') {
        version++;
        await startWorker();
        broadcast({ type: 'code', version, paths: [rel] });
      } else broadcast({ type: 'files', paths: [rel] });
      return json(res, { ok: true });
    }
  }
  if (m === 'POST' && p === '/api/upload') {
    const rel = url.searchParams.get('path') ?? '';
    const abs = inside(projectDir, rel);
    const data = await body(req);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    known.set(abs, data.toString('utf8'));
    broadcast({ type: 'files', paths: [rel] });
    return json(res, { ok: true, path: rel });
  }
  if (p === '/api/layout') {
    const file = join(projectDir, '.ages', 'layout.json');
    if (m === 'GET') return json(res, JSON.parse(await readFile(file, 'utf8').catch(() => 'null')));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, (await body(req)).toString('utf8'));
    return json(res, { ok: true });
  }
  if (p.startsWith('/api/git/')) {
    const op = p.slice('/api/git/'.length);
    if (op === 'status') return json(res, { branch: await git(['branch', '--show-current']), status: await git(['status', '--short', '--', '.']), draft: await gitDraft() });
    if (m === 'POST' && op === 'commit') {
      const { message } = JSON.parse((await body(req)).toString('utf8'));
      const add = await git(['add', '-A', '--', '.']);
      return json(res, { out: add + '\n' + (await git(['commit', '-m', message || (await gitDraft())])) });
    }
    if (m === 'POST' && op === 'pull') {
      // 人が自分で取り込んだロックの変更は、一覧で知らせて自動で承認する。
      // ただし、プルの前からロックの記録が確認待ちだったとき（AIの書き換えなど）は承認しない
      const lockFile = join(projectDir, '.ages', 'locks.json');
      const okBefore = (await call<{ integrity?: { ok: boolean } }>('state')).integrity?.ok !== false;
      const before = await readFile(lockFile, 'utf8').catch(() => null);
      pulling = true;
      let out: string;
      let locks: unknown = null;
      try {
        out = await git(['pull', '--no-edit']);
        const after = await readFile(lockFile, 'utf8').catch(() => null);
        if (before !== after) {
          await call('recheckLocks');
          const st = await call<{ integrity?: { ok: boolean; diff: unknown } }>('state');
          if (okBefore && st.integrity && !st.integrity.ok) {
            await call('approveLocks', human(req, 'git-pull'));
            locks = { approved: true, diff: st.integrity.diff };
            lastLockOk = true;
          } else if (st.integrity && !st.integrity.ok) {
            locks = { approved: false, diff: st.integrity.diff };
            lastLockOk = false;
          }
        }
      } finally {
        pulling = false;
      }
      broadcast({ type: 'locks', integrity: lastLockOk, pulled: locks });
      return json(res, { out, locks });
    }
    if (m === 'POST' && op === 'push') return json(res, { out: await git(['push']) });
  }
  json(res, { error: `見つかりません: ${m} ${p}` }, 404);
}

await startWorker();
http
  .createServer((req, res) => {
    route(req, res).catch((e) => json(res, { error: (e as Error).message }, (e as { status?: number }).status ?? 400));
  })
  .listen(port, () => {
    console.log(`AGES エディタ: http://localhost:${port}  （プロジェクト: ${relative(process.cwd(), projectDir) || '.'}）`);
  });
