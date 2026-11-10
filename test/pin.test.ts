// 版だけ同梱（ages pin・ages.mjs）: 本体は .ages/engine に取ってきて動かし、書き換えられていたら戻す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, appendFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cmdInit, cmdPin, cmdVersion } from '../src/cli/ages.ts';

const ENGINE = fileURLToPath(new URL('..', import.meta.url));
const mark = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12);
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
    assert.deepEqual(cfg.engineSource, { repo: ENGINE, commit: head, agents: mark(await readFile(join(g, 'AGENTS.md'), 'utf8')) });
    assert.match(await readFile(join(g, '.gitignore'), 'utf8'), /^\.ages\/engine\/$/m);
    assert.match(await readFile(join(g, 'AGENTS.md'), 'utf8'), /`ages` は `node ages\.mjs`.*本体は書き換えない\*\*。ages\.mjs と \.ages\/ は起動の仕組みなので読まなくてよい/);
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

test('ages pin を当て直すと、AGENTS.md は手で直されていなければ本体の版のものに合わせ、直されていれば残す（--force で合わせる）', { skip: !head && 'git がない' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-pin-'));
  try {
    const g = join(dir, 'g');
    await cmdInit(g);
    await cmdPin(g, ENGINE, head);
    const now = await readFile(join(g, 'AGENTS.md'), 'utf8');
    const cfgFile = join(g, 'ages.project.json');
    const setOld = async (text: string, m: string) => {
      await writeFile(join(g, 'AGENTS.md'), text);
      const cfg = JSON.parse(await readFile(cfgFile, 'utf8'));
      cfg.engineSource.agents = m;
      await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
    };
    // 前の版の本体が写したまま（印と同じ）→ 新しい版のものに
    await setOld('# 前の版の手順\n', mark('# 前の版の手順\n'));
    assert.match(await cmdPin(g, ENGINE, head), /^ {2}AGENTS\.md（本体のこの版の手順）$/m);
    assert.equal(await readFile(join(g, 'AGENTS.md'), 'utf8'), now);
    // 手で直した（印と違う）→ そのまま。印も前のまま
    await setOld('# 前の版の手順\n- 手で足した決まり\n', mark('# 前の版の手順\n'));
    assert.match(await cmdPin(g, ENGINE, head), /AGENTS\.md は手で直されているので、そのままにした/);
    assert.match(await readFile(join(g, 'AGENTS.md'), 'utf8'), /手で足した決まり/);
    assert.equal(JSON.parse(await readFile(cfgFile, 'utf8')).engineSource.agents, mark('# 前の版の手順\n'));
    // --force で合わせる
    await cmdPin(g, ENGINE, head, true);
    assert.equal(await readFile(join(g, 'AGENTS.md'), 'utf8'), now);
    assert.equal(JSON.parse(await readFile(cfgFile, 'utf8')).engineSource.agents, mark(now));
    // 起動用が前の版のもの（前の起動用で upgrade した）なら、ages version が当て直し方を出す
    assert.doesNotMatch(await cmdVersion(g, false), /起動用の ages\.mjs/);
    await appendFile(join(g, 'ages.mjs'), '// 前の版\n');
    assert.match(await cmdVersion(g, false), new RegExp(`^起動用の ages\\.mjs がこの版のものと違う。.*: node \\.ages/engine/bin/ages\\.js pin \\. --repo .* --commit ${head}$`, 'm'));
    // 前に印のない（この仕組みの前に当てた）ものは合わせる
    await setOld('# 前の版の手順\n- 手で足した決まり\n', '');
    const cfg = JSON.parse(await readFile(cfgFile, 'utf8'));
    delete cfg.engineSource.agents;
    await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
    await cmdPin(g, ENGINE, head);
    assert.equal(await readFile(join(g, 'AGENTS.md'), 'utf8'), now);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
