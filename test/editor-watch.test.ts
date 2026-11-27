// エディタのサーバー: 中身の変わらないファイルの知らせ（Windows の起動直後に、ウイルス対策・検索の索引などがファイルに触れると来る）で、
// コードを読み直したり、開いている画面を作り直したりしない。本当に変わったものだけを知らせる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, kill, waitFor } from '../src/cli/shot.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

async function files(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await files(dir, rel)));
    else out.push(rel);
  }
  return out;
}

test('エディタ: 中身も時刻も同じままの知らせ・時刻だけ変わったコードでは読み直さない。中身が変われば読み直す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-watch-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const port = await freePort(), lock = await freePort();
  const ed = spawn(process.execPath, [new URL('../src/editor/server.ts', import.meta.url).pathname, dir, '--port', String(port), '--lock-port', String(lock), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let out = '';
  ed.stdout!.on('data', (d) => { out += d; });
  ed.stderr!.on('data', (d) => { out += d; });
  try {
    await waitFor('editor', 20_000, async () => (await fetch(`http://127.0.0.1:${port}/api/who`).then((r) => r.ok).catch(() => false)) || undefined);
    // すべてのファイルを同じ中身で書き直し、時刻を元に戻す（知らせは来るが、何も変わっていない）
    for (const f of await files(dir)) {
      if (f.startsWith('.git/')) continue;
      const abs = join(dir, f), s = await stat(abs);
      await writeFile(abs, await readFile(abs));
      await utimes(abs, s.atime, s.mtime);
    }
    // コードは時刻だけ新しくする
    const idx = join(dir, 'game', 'index.ts');
    await writeFile(idx, await readFile(idx));
    await new Promise((r) => setTimeout(r, 1500));
    assert.doesNotMatch(out, /コードが変わりました/, out);
    const v0 = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).version;
    // 本当に変えたら読み直す
    await writeFile(idx, (await readFile(idx, 'utf8')) + '\n// 変えた\n');
    await waitFor('読み直し', 20_000, async () => (/コードが変わりました: game\/index\.ts（v\d+）/.test(out) ? true : undefined));
    assert.notEqual((await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).version, v0);
  } finally {
    kill(ed);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
