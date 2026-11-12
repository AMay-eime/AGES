// 書き出しにファイルごとの一覧（場所・大きさ・sha1）を入れ、前の書き出しとの違いを出す（issue #127）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdExport, cmdPatch } = await import('../src/cli/ages.ts');

test('ages export: .ages-export に一覧。2回目は前との違い（増えた・変わった・消えた）、--diff でほかの一覧と', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-exp-')), 'g');
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(dir, 'assets', 'old.png'), png);
  const out = join(dir, 'dist');
  let r = await cmdExport(dir, { out });
  assert.match(r, /ファイルの一覧（場所・大きさ・sha1）は \.ages-export。次からは前の書き出しとの違いが出る/);
  const mark = JSON.parse(await readFile(join(out, 'web', '.ages-export'), 'utf8'));
  assert.equal(mark.engine, 'AGES');
  const html = await readFile(join(out, 'web', 'index.html'));
  assert.deepEqual(mark.files['index.html'], { bytes: html.length, sha1: createHash('sha1').update(html).digest('hex') });
  assert.ok(mark.files['project.json'] && mark.files['engine/player/main.js']);
  assert.ok(!mark.files['.ages-export'], '印そのものは入れない');
  const first = join(dir, 'first.ages-export');
  await writeFile(first, JSON.stringify(mark));

  // 同じなら違いなし
  r = await cmdExport(dir, { out });
  assert.match(r, /前の書き出し（.+）との違い: なし（すべて同じ）/);

  // データを変える（project.json）・アセットを消す・足す
  await cmdPatch(dir, [{ op: 'set', path: '@enemy.Health.hp', value: 7 }], false);
  await rm(join(dir, 'assets', 'old.png'));
  await writeFile(join(dir, 'assets', 'extra.png'), png);
  r = await cmdExport(dir, { out });
  assert.match(r, /との違い: 増えた 1・変わった 1・消えた 1（同じ \d+）/);
  assert.match(r, /^    - assets\/old\.png$/m);
  assert.match(r, /^    \+ assets\/extra\.png$/m);
  assert.match(r, /^    ~ project\.json$/m);

  // --diff: 最初の書き出しの一覧と比べる
  r = await cmdExport(dir, { out, diff: first });
  assert.match(r, /first\.ages-exportとの違い: 増えた 1・変わった 1・消えた 1/);
  await assert.rejects(cmdExport(dir, { out, diff: join(dir, 'none.json') }), /--diff の .*none\.json が読めません/);
});
