// エディタで人が見ている所: エディタが書き、地図の先頭に1行・ages find の並びに使う。古いものは使わない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { writeFocus, readFocus, focusLine, withFocus, FOCUS_MAX_AGE_MS } = await import('../src/project/focus.ts');
const { cmdMap, cmdFind } = await import('../src/cli/ages.ts');
const { Project } = await import('../src/project/project.ts');

async function shooter(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('見ている所: 書いて読む・古ければ使わない・閉じたら消す。知らない形は捨てる', async () => {
  const dir = await shooter();
  try {
    const t0 = new Date('2026-11-10T09:00:00Z');
    await writeFocus(dir, { scene: 'main', selected: ['main#player', 3 as never], windows: [{ id: 'hp-hearts', title: '体力' }, { bad: 1 } as never] }, t0);
    const f = await readFocus(dir, t0.getTime() + 1000);
    assert.deepEqual(f, { at: t0.toISOString(), scene: 'main', selected: ['main#player'], windows: [{ id: 'hp-hearts', title: '体力' }] });
    assert.equal(await readFocus(dir, t0.getTime() + FOCUS_MAX_AGE_MS + 1), null, 'エディタを閉じた・しばらく触っていない');
    await writeFocus(dir, null);
    assert.equal(await readFocus(dir, t0.getTime()), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('地図の先頭に1行（選んでいる物の部品・ほかに選んでいる物・表の行・窓）', async () => {
  const dir = await shooter();
  try {
    const p = await Project.load(dir);
    const line = focusLine(p, { at: new Date().toISOString(), scene: 'main', selected: ['main#player', 'main#hud'], row: '$enemies.fast', windows: [{ id: 'hp-hearts', title: '体力' }] })!;
    assert.match(line, /^エディタで人が見ている所（\d\d:\d\d）: シーン main・選んでいる物 main#player \[Transform Sprite Player Health Collider\]（ほかに main#hud）・表の行 \$enemies\.fast・開いている窓 hp-hearts「体力」（人が「これ」/);
    assert.match(focusLine(p, { at: new Date().toISOString(), selected: ['@enemy'] })!, /選んでいる物 @enemy \[Transform Sprite Velocity Health Enemy Effect Collider\]/);
    assert.equal(focusLine(p, { at: new Date().toISOString() }), null);
    // エディタが開いていれば、地図の見出しのすぐ下に出る
    assert.doesNotMatch(await cmdMap(dir), /エディタで人が見ている所/);
    await writeFocus(dir, { scene: 'main', selected: ['main#spawner'] });
    const map = (await cmdMap(dir)).split('\n');
    assert.match(map[0], /^# shooter /);
    assert.match(map[1], /^エディタで人が見ている所（\d\d:\d\d）: シーン main・選んでいる物 main#spawner \[Spawner\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ages find: 見ている所に近いものを上に（最近の作業の場所より強く）', async () => {
  const dir = await shooter();
  try {
    const before = (await cmdFind(dir, 'se')).split('\n');
    await writeFocus(dir, { scene: 'main', selected: ['@se_hit'] });
    const after = (await cmdFind(dir, 'se')).split('\n');
    assert.match(after[0], /エディタで見ている所に近いものから/);
    assert.match(after[1], /^@se_hit /);
    assert.notEqual(before[1], after[1]);
    const store = withFocus({ n: 10, places: { '@enemy.Health': { hits: 4, last: 9 } } }, { at: '', selected: ['main#player'], row: '$enemies.fast' });
    assert.deepEqual(store.places['main#player'], { hits: 6, last: 10 });
    assert.deepEqual(store.places['$enemies'], { hits: 6, last: 10 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
