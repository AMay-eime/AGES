// 出来事の受け取り（defineSystem の on）・日時（ctx.date）・ages run のシーンからのフレームの入力・図形の塗り＋枠と破線
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, defineSystem } from '../src/core/registry.ts';
import { Game, GameError, type Ctx } from '../src/core/game.ts';
import type { ProjectConfig, SceneDoc } from '../src/core/docs.ts';
import { dateAt, formatDate, parseDate } from '../src/core/clock.ts';
import { parseRunKeys } from '../src/core/runinput.ts';
import { dashSpans, dashedBands, ellipsePerimeter, lineCorners, ringPiece } from '../src/render/geom.ts';
import { lerpValue } from '../src/core/tween.ts';
import { cmdMap, cmdRun } from '../src/cli/ages.ts';
import { findInProject } from '../src/project/find.ts';
import { Project } from '../src/project/project.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const CONFIG: ProjectConfig = { name: 't', fps: 10, seed: 1, view: { width: 100, height: 100, background: '#000' }, startScene: 'a', game: 'game/index.ts' };
const A: SceneDoc = { name: 'a', entities: [] };
const B: SceneDoc = { name: 'b', entities: [] };

function game(systems: ReturnType<typeof defineSystem>[], opts: ConstructorParameters<typeof Game>[4] = {}) {
  const reg = Registry.from({ components: [], systems });
  reg.scenes.set('a', A);
  reg.scenes.set('b', B);
  return new Game(reg, CONFIG, A, 1, opts);
}

test('on: 出した出来事を、ほかのシステムがその場で受ける（実行順・シーンを選ぶ・入れ子・出来事だけのシステム）', () => {
  const log: string[] = [];
  const g = game([
    defineSystem({ name: 'combat', desc: '', update: (c: Ctx) => { if (c.frame === 1) { c.emit('enemyKilled', { score: 10 }); log.push('combat:after'); } } }),
    defineSystem({ name: 'story', desc: '', on: { enemyKilled: (c: Ctx, d: { score: number }) => { log.push(`story:${d.score}@${c.frame}`); c.emit('flag', 'boss'); } } }),
    defineSystem({ name: 'onlyB', desc: '', scenes: ['b'], on: { enemyKilled: () => { log.push('onlyB'); } } }),
    defineSystem({ name: 'flags', desc: '', on: { flag: (_c: Ctx, d: string) => { log.push(`flag:${d}`); } } }),
  ]);
  g.step(); g.step();
  assert.deepEqual(log, ['story:10@1', 'flag:boss', 'combat:after'], 'emit の中で受け、入れ子の出来事も受ける。シーン b だけのシステムは受けない');
  assert.equal(g.counts.get('enemyKilled'), 1);
});

test('on: 標準の出来事（scene）を受ける。止まらない出来事の輪・受けた先のエラーは、どこで起きたかを出す', () => {
  const log: string[] = [];
  const g = game([
    defineSystem({ name: 'go', desc: '', update: (c: Ctx) => { if (c.frame === 0) c.scene.goto('b'); } }),
    defineSystem({ name: 'music', desc: '', on: { scene: (_c: Ctx, d: { from: string; to: string }) => { log.push(`${d.from}->${d.to}`); } } }),
  ]);
  g.step(); g.step();
  assert.deepEqual(log, ['a->b']);
  const loop = game([
    defineSystem({ name: 'ping', desc: '', update: (c: Ctx) => c.emit('ping'), on: { pong: (c: Ctx) => c.emit('ping') } }),
    defineSystem({ name: 'pong', desc: '', on: { ping: (c: Ctx) => c.emit('pong') } }),
  ]);
  assert.throws(() => loop.step(), (e: unknown) => e instanceof GameError && /16段を超えました/.test(e.message));
  const bad = game([
    defineSystem({ name: 'a', desc: '', update: (c: Ctx) => c.emit('hit') }),
    defineSystem({ name: 'b', desc: '', on: { hit: () => { throw new Error('壊れた'); } } }),
  ]);
  assert.throws(() => bad.step(), (e: unknown) => e instanceof GameError && e.system === 'b.on.hit' && /壊れた/.test(e.message));
  assert.throws(() => Registry.from({ components: [], systems: [defineSystem({ name: 'x', desc: '', on: { hit: 1 as never } })] }), /on\.hit が関数ではありません/);
  assert.throws(() => Registry.from({ components: [], systems: [defineSystem({ name: 'x', desc: '' })] }), /update・on・start・exit のどれもありません/);
});

test('on: 地図と find に、受ける出来事が出る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const file = join(dir, 'game/systems.ts');
  await writeFile(file, (await readFile(file, 'utf8')) + `
export const killLog = defineSystem({ name: 'killLog', desc: '倒した数を数える', on: { enemyKilled: () => {} } });
`);
  const idx = join(dir, 'game/index.ts');
  await writeFile(idx, (await readFile(idx, 'utf8')).replace('S.resultScreen]', 'S.resultScreen, S.killLog]'));
  assert.match(await cmdMap(dir, 'systems'), /killLog（game\/systems\.ts:\d+） 倒した数を数える 受ける:enemyKilled/);
  const p = await Project.load(dir);
  assert.match(findInProject(p, 'enemyKilled').text, /システム \d+ killLog.* 受ける:enemyKilled/);
});

test('日時: 読む書き方・始めの日時からゲームの中の時間で進む・記録の形', () => {
  assert.deepEqual(parseDate('2026-12-25T09:00'), { ms: Date.UTC(2026, 11, 25, 9, 0), tz: 0 });
  const jst = parseDate('2026-12-25 09:00:30+09:00');
  assert.deepEqual(jst, { ms: Date.UTC(2026, 11, 25, 0, 0, 30), tz: 540 });
  assert.equal(formatDate(jst), '2026-12-25T09:00:30+09:00');
  assert.deepEqual(parseDate(formatDate(parseDate('2026-03-01T23:59-05:30'))), parseDate('2026-03-01T23:59-05:30'));
  assert.throws(() => parseDate('2026-02-30'), /はありません/);
  assert.throws(() => parseDate('12/25'), /書き方が違います/);
  const d = dateAt(jst, 15 * 60 * 1000);
  assert.deepEqual({ ...d, ms: 0 }, { year: 2026, month: 12, day: 25, hour: 9, minute: 15, second: 30, weekday: 5, ms: 0 }, '書いた日時がそのままゲームの日時（金曜）');
  // ゲームの中: frame が進むと時刻も進む（fps10 で 600 フレーム = 1分）
  const seen: string[] = [];
  const g = game([defineSystem({ name: 'clock', desc: '', update: (c: Ctx) => { if (c.frame % 600 === 0) seen.push(`${c.date.hour}:${c.date.minute}`); } })], { date: parseDate('2026-12-31T23:59') });
  for (let i = 0; i < 601; i++) g.step();
  assert.deepEqual(seen, ['23:59', '0:0']);
  assert.equal(g.ctx.date.year, 2027, '年をまたぐ');
  assert.ok(g.dateUsed);
});

test('ages run: --date と、シーンに入るたびの入力（title+30:…）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const file = join(dir, 'game/systems.ts');
  await writeFile(file, (await readFile(file, 'utf8')) + `
export const today = defineSystem({ name: 'today', desc: '日付', update: (c) => { if (c.frame === 0) c.emit(\`d\${c.date.month}_\${c.date.day}\`); } });
`);
  const idx = join(dir, 'game/index.ts');
  await writeFile(idx, (await readFile(idx, 'utf8')).replace('S.resultScreen]', 'S.resultScreen, S.today]'));
  const plain = await cmdRun(dir, { frames: '2' });
  assert.match(plain, /events: .*d1_1×1/, '省くと決まった日時（2026-01-01）');
  assert.match(plain, /date: 2026-01-01T12:00:00\+00:00 から/);
  assert.match(await cmdRun(dir, { frames: '2', date: '2026-12-25' }), /d12_25×1/);
  // 記録に入っている日時で再現する
  await writeFile(join(dir, 'recordings/d.input.json'), JSON.stringify({ seed: 1, scene: 'main', frames: 2, date: '2026-07-07T10:00:00+09:00', events: [] }));
  assert.match(await cmdRun(dir, { frames: '2', input: 'recordings/d.input.json' }), /d7_7×1/);

  // シーンに入るたびに、入ってから数える: main では撃ちながら動き、result では 40 フレーム目に fire（もう一度 main へ）
  const moves = '0-150:@move_x=-1;150-450:@move_x=1;450-750:@move_x=-1;750-1050:@move_x=1;1050-1350:@move_x=-1';
  const each = moves.split(';').map((x) => 'main+' + x).join(';');
  const again = await cmdRun(dir, { frames: '3000', keys: `main+0-1080:@fire;${each};result+40-41:@fire` });
  assert.match(again, /scenes: main@0 → result@1092 → main@1150 → result@\d+ → main@\d+/);
  const byClick = await cmdRun(dir, { frames: '1200', keys: `0-1100:@fire;${moves};result+40:click=retry` });
  assert.match(byClick, /scenes: main@0 → result@1092 → main@\d+/);
  assert.match(byClick, /ui: 押されたボタン retry×1/);
  assert.match(await cmdRun(dir, { frames: '10', keys: 'result+5:@fire' }), /⚠ --keys の result\+5: そのシーンに入りませんでした/);
  await assert.rejects(cmdRun(dir, { frames: '10', keys: 'reslt+5:@fire' }), /シーン reslt はありません。もしかして: result/);
});

test('parseRunKeys: 始めからのフレームと、シーンからのフレームを分ける', () => {
  const k = parseRunKeys('0-10:KeyZ;5:click=start;title+30-32:KeyX+ptr=4,5;menu+3:click=ok;menu+7:click=10,20');
  assert.deepEqual(k.clicks, [[5, 'start']]);
  assert.deepEqual(k.scene, [
    { scene: 'title', a: 30, b: 32, buttons: ['KeyX'], axes: {}, ptr: [4, 5] },
    { scene: 'menu', a: 3, b: null, buttons: [], axes: {}, click: 'ok' },
    { scene: 'menu', a: 7, b: null, buttons: [], axes: {}, click: [10, 20] },
  ]);
  assert.deepEqual(k.events.map((e) => e.f), [0, 10]);
  assert.throws(() => parseRunKeys('title+30-10:KeyX'), /終わりのフレームは始めより後/);
});

test('図形: 破線の模様・四角の枠の破線はひと回りでつながる・円の一切れ・線の一部', () => {
  assert.deepEqual(dashSpans(10, 0, 0), [[0, 1]], 'dash [0,0] は実線');
  assert.deepEqual(dashSpans(10, 3, 2), [[0, 0.3], [0.5, 0.8]]);
  assert.deepEqual(dashSpans(10, 3, 2, 4), [[0.1, 0.4], [0.6, 0.9]], 'ずらしても長さの中だけ');
  assert.deepEqual(dashSpans(10, 3, 2, 1), [[0, 0.2], [0.4, 0.7], [0.9, 1]]);
  // 100x50 の四角、太さ 5、線 10・すきま 10。上の辺の後、右の辺は 100 の続き（100 は周期 20 の倍数なので線から始まる）
  const bands = dashedBands(100, 50, 5, 10, 10);
  assert.deepEqual(bands[0], [0, 0, 0.1, 0.1]);
  assert.equal(bands.filter((b) => b[1] === 0 && b[3] === 0.1).length, 5, '上の辺に5本');
  assert.deepEqual(dashedBands(10, 10, 5, 2, 2), [[0, 0, 1, 1]], '太すぎるときは塗りつぶし');
  assert.ok(Math.abs(ellipsePerimeter(10, 10) - 2 * Math.PI * 10) < 1e-9);
  const q = ringPiece({ x: 0, y: 0 }, 20, 20, 2, 0, Math.PI / 2);
  assert.deepEqual(q.map((v) => Math.round(v * 1000) / 1000), [10, 0, 0, 10, 0, 8, 8, 0]);
  assert.deepEqual(lineCorners({ x: 0, y: 0 }, [10, 0], 2, 0.5, 1), [5, 1, 10, 1, 10, -1, 5, -1]);
});

test('色の透け具合（#rrggbbaa）: トゥイーンで変えられ、片方にだけあれば不透明から', () => {
  assert.equal(lerpValue('#ff000000', '#ff0000ff', 0.5), '#ff000080');
  assert.equal(lerpValue('#000000', '#ffffff00', 1), '#ffffff00');
  assert.equal(lerpValue('#000000', '#ffffff', 0.5), '#808080', '6桁どうしは6桁のまま');
});
