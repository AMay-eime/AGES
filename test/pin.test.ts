// 版だけ同梱（ages pin・ages.mjs）: 本体は .ages/engine に取ってきて動かし、書き換えられていたら戻す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cmdInit, cmdPin } from '../src/cli/ages.ts';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
let head = '';
try { head = execFileSync('git', ['-C', ENGINE, 'rev-parse', 'HEAD']).toString().trim(); } catch { /* git がない */ }

test('ages pin: 起動用と版を入れ、ages.mjs が本体を取ってきて動かす。書き換えられた本体は戻す', { skip: !head && 'git がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-pin-'));
  try {
    const g = join(dir, 'g');
    await cmdInit(g);
    // GitHub の代わりに手元の本体のリポジトリから取る
    assert.match(await cmdPin(g, ENGINE, head), /版だけ同梱の形にしました/);
    const cfg = JSON.parse(await readFile(join(g, 'ages.project.json'), 'utf8'));
    assert.deepEqual(cfg.engineSource, { repo: ENGINE, commit: head });
    assert.match(await readFile(join(g, '.gitignore'), 'utf8'), /^\.ages\/engine\/$/m);
    assert.match(await readFile(join(g, 'AGENTS.md'), 'utf8'), /`ages` は `node ages\.mjs`.*本体は書き換えない/);
    assert.deepEqual(JSON.parse(await readFile(join(g, '.mcp.json'), 'utf8')).mcpServers.ages.args, ['ages.mjs', 'mcp']);
    const run = (...a: string[]) => spawnSync(process.execPath, ['ages.mjs', ...a], { cwd: g, encoding: 'utf8' });
    const first = run('check', '.');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /AGES 本体を取ってきます/);
    assert.match(first.stdout, /^ok/);
    // 本体を書き換えても、次に動かす前に戻る
    await appendFile(join(g, '.ages', 'engine', 'src', 'index.ts'), '\n// 書き換え\n');
    const second = run('check', '.');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /書き換えられていたので戻しました: src\/index\.ts/);
    assert.equal(execFileSync('git', ['-C', join(g, '.ages', 'engine'), 'status', '--porcelain']).toString(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
