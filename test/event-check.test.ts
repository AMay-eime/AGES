// 出来事のつながりの検証（ages check）: 受けているのに、どこからも出していない出来事を ⚠ に
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeEmits, eventWarnings } from '../src/project/events.ts';
import { cmdCheck } from '../src/cli/ages.ts';

test('出している出来事: emit の名前（式の中の名前も）・トゥイーンの emit。名前を式で出している所は分ける。注釈は見ない', () => {
  const files: [string, string][] = [['game/a.ts', [
    "ctx.emit('enemyKilled', { id });",
    "emit(boss ? 'bossKilled' : 'enemyKilled');",
    "ctx.tween(id, 'Transform', { y: 0 }, { time: 1, emit: 'arrived' });",
    'ctx.emit(name, data);',
    'ctx.emit(`hit.${kind}`);',
    "// ctx.emit('commented')",
  ].join('\n')]];
  const { names, dynamic } = codeEmits(files);
  assert.deepEqual([...names.keys()].sort(), ['arrived', 'bossKilled', 'enemyKilled']);
  assert.deepEqual(names.get('enemyKilled'), ['game/a.ts:1', 'game/a.ts:2']);
  assert.deepEqual(dynamic, ['game/a.ts:4', 'game/a.ts:5']);
});

test('受けているのに出していない出来事は ⚠（本体が出す scene・ui.click は除く。名前を式で出す所があれば添える）', () => {
  const systems = [{ name: 'hud', on: { stageStart() {}, enemyKiled() {}, scene() {}, 'ui.click'() {} } }];
  const files: [string, string][] = [['game/a.ts', "ctx.emit('stageStart');\nctx.emit('enemyKilled');"]];
  const w = eventWarnings(systems, files, new Map([['system:hud', 'game/hud.ts:12']]));
  assert.equal(w.length, 1);
  assert.match(w[0], /^出来事 enemyKiled を hud（game\/hud\.ts:12）が受けているが、どこからも出していない/);
  assert.doesNotMatch(w[0], /式で出している/);
  const w2 = eventWarnings(systems, [...files, ['game/b.ts', 'ctx.emit(name);']]);
  assert.match(w2[0], /名前を式で出している emit が 1か所（game\/b\.ts:1）/);
});

test('ages check: 受けている出来事の名前の書き間違いを ⚠ で知らせる（エラーではない）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  try {
    // 同じ場所のコードは読み込みが残るので、書き換える前の確かめは別の写しで
    await cp(new URL('../examples/shooter', import.meta.url), join(dir, 'a'), { recursive: true });
    assert.doesNotMatch(await cmdCheck(join(dir, 'a')), /出来事/);
    await cp(new URL('../examples/shooter', import.meta.url), join(dir, 'b'), { recursive: true });
    const f = join(dir, 'b', 'game', 'systems.ts');
    const s = await readFile(f, 'utf8');
    await writeFile(f, s.replace("  name: 'spawner',\n", "  name: 'spawner',\n  on: { enemyKiled() {} },\n"));
    const out = await cmdCheck(join(dir, 'b'));
    assert.match(out, /^ok/);
    assert.match(out, /^⚠ 出来事 enemyKiled を spawner（game\/systems\.ts:\d+）が受けているが、どこからも出していない/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
