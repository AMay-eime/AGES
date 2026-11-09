// 段階2-14: 多言語（表 $text・ctx.t・Text.key・言語の切り替え）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/core/registry.ts';
import { Game } from '../src/core/game.ts';
import type { ProjectConfig, SceneDoc } from '../src/core/docs.ts';
import { format, missingText } from '../src/core/i18n.ts';
import { MemoryStore, SETTINGS_KEY } from '../src/core/save.ts';
import { Project } from '../src/project/project.ts';
import { cmdCheck, cmdMap, cmdRun, cmdTable } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const CONFIG: ProjectConfig = { name: 't', fps: 60, seed: 1, view: { width: 400, height: 300, background: '#000' }, startScene: 'a', game: 'game/index.ts', languages: ['ja', 'en'] };

function game(opts: { store?: MemoryStore; lang?: string } = {}) {
  const reg = Registry.from({ components: [], systems: [] });
  reg.tableData.set('text', { name: 'text', rows: [
    { id: 'hello', ja: 'こんにちは {name}', en: 'Hello {name}' },
    { id: 'onlyJa', ja: 'まだ訳していない', en: '' },
  ] } as never);
  const scene: SceneDoc = { name: 'a', entities: [{ id: 'label', name: 'label', components: { Transform: {}, Text: { key: 'hello', text: '仮' } } }] };
  reg.scenes.set('a', scene);
  return new Game(reg, CONFIG, scene, 1, opts);
}

test('言葉: {名前} に値を入れる。表の列は config.languages から作る。未訳は言語ごとに分かる', () => {
  assert.equal(format('SCORE {score} / {none}', { score: 10 }), 'SCORE 10 / {none}');
  const g = game();
  assert.deepEqual(Object.keys(g.registry.table('text').columns), ['ja', 'en', 'desc']);
  assert.deepEqual([...missingText(g.registry.tableView('text').rows as never, ['ja', 'en'])], [['en', ['onlyJa']]]);
});

test('ctx.t と Text.key: 今の言語で引き、訳がなければ既定の言語で出して ⚠。setLang で切り替わり、設定として保存される', () => {
  const store = new MemoryStore();
  const g = game({ store });
  assert.equal(g.lang, 'ja');
  assert.equal(g.world.get('label')!.c.Text.text, 'こんにちは {name}', '始めから Text.key の言葉が入る（エディタの止めた画面にも）');
  assert.equal(g.ctx.t('hello', { name: 'AGES' }), 'こんにちは AGES');
  g.ctx.setLang('en');
  assert.equal(g.world.get('label')!.c.Text.text, 'Hello {name}', 'すぐ変わる');
  assert.equal(g.ctx.t('onlyJa'), 'まだ訳していない');
  assert.ok([...g.warnings].some((w) => /\$text\.onlyJa に en の訳がありません（ja で出しています）/.test(w)));
  assert.equal(g.ctx.t('helo'), 'helo');
  assert.ok([...g.warnings].some((w) => /"helo" の行がありません。もしかして: hello/.test(w)));
  assert.throws(() => g.ctx.setLang('fr'), /言語 fr はありません/);
  g.step();
  assert.equal(JSON.parse(store.data[SETTINGS_KEY]).lang, 'en');
  // 次に始めると、保存した言語。エディタ・ages run で決めた言語はそれより先
  assert.equal(game({ store }).lang, 'en');
  assert.equal(game({ store, lang: 'ja' }).lang, 'ja');
  // このフレームに出た物も、描く前に言葉が入る
  g.world.add({ id: 'b', name: 'b', components: { Transform: {}, Text: { key: 'hello' } } } as never);
  g.step();
  assert.equal(g.world.get('b')!.c.Text.text, 'Hello {name}');
});

test('サンプル: --lang で言語を選んで確かめる。Text.key・t() の名前の間違いと、言語の名前は検証で分かる。未訳は check・地図・--empty に出る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const en = await cmdRun(dir, { scene: 'result', frames: '3', lang: 'en', watch: 'retry.Text.text,prompt.Text.text' });
  assert.match(en, /watch retry\.Text\.text: Retry → Retry/);
  assert.match(en, /watch prompt\.Text\.text: Press fire to retry/);
  await assert.rejects(cmdRun(dir, { frames: '1', lang: 'fr' }), /言語 fr はありません/);
  assert.match(await cmdMap(dir), /多言語（表 \$text・ctx\.t\('名前'\)・Text\.key）: ja en（既定 ja）。未訳なし/);
  const p = await Project.load(dir);
  await p.apply([{ op: 'addRow', table: 'text', row: { id: 'pause', ja: 'ポーズ' } }], ai);
  assert.match(await cmdCheck(dir), /未訳: en 1件/);
  assert.match(await cmdTable(dir, 'text', { empty: 'en' }), /pause/);
  await assert.rejects(p.apply([{ op: 'set', path: 'result#retry.Text.key', value: 'retyr' }], ai), /表 \$text に "retyr" の行がありません。もしかして: retry/);
  // コードの t('名前') も確かめる
  const sys = join(dir, 'game/systems.ts');
  await writeFile(sys, (await readFile(sys, 'utf8')).replace("t('score',", "t('scor',"));
  assert.match(await cmdCheck(dir), /t\('scor'\) の行が表 \$text にありません。もしかして: score/);
  const cfg = join(dir, 'ages.project.json');
  await writeFile(cfg, (await readFile(cfg, 'utf8')).replace('"en"', '"English"'));
  assert.match(await cmdCheck(dir), /languages の "English" は言語の名前として使えません/);
});
