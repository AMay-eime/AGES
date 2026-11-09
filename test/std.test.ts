// 段階2: 標準の部品（画像・スプライトシート・アニメーション・描く順番・クリックでの選択の形）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { frameCount, frameAt, sheetPathOf, checkSheet } from '../src/core/sheet.ts';
import { collectDrawables, cornersOf, pointInCorners } from '../src/render/geom.ts';
import { imageSize } from '../src/project/assets.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const TILES = 'assets/kenney-pixel-shmup/tiles.png';

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('スプライトシート: コマの数と位置（隙間・余白つき）', () => {
  assert.equal(sheetPathOf('a/b/ships.png'), 'a/b/ships.sheet.json');
  assert.equal(frameCount({ frame: [16, 16] }, 192, 160), 120);
  const s = { frame: [16, 16] as [number, number], spacing: 2, margin: 1 };
  // 1 + 16 + 2 + 16 ... → 横に 5 コマ（1+5*16+4*2+1 = 90）
  assert.equal(frameCount(s, 90, 36), 10);
  assert.deepEqual(frameAt(s, 90, 36, 6), { index: 6, x: 1 + 18, y: 1 + 18, w: 16, h: 16 });
  assert.equal(checkSheet('x.sheet.json', { frame: [0, 16] } as never).length, 1);
});

test('アセット: 画像の大きさをファイルの先頭から読み、シートとともに一覧に入る', async () => {
  const p = await Project.load(await fresh());
  const tiles = p.assets.find((a) => a.path === TILES)!;
  assert.deepEqual([tiles.kind, tiles.w, tiles.h], ['image', 192, 160]);
  assert.ok(p.registry.sheets.get(TILES)?.clips?.explode);
  assert.equal(imageSize(Buffer.from('not an image')), null);
  assert.deepEqual(p.validate(), []);
});

test('アニメーション: 決めたコマを順に進め、繰り返さない動きは最後で消える', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  const boom = g.world.spawn('explosion', { Transform: { x: 100, y: 100 } });
  const seen: number[] = [];
  for (let i = 0; i < 30 && g.world.get(boom.id); i++) {
    g.step();
    const f = g.world.get(boom.id)?.c.Sprite.frame;
    if (f !== undefined && seen.at(-1) !== f) seen.push(f);
  }
  assert.deepEqual(seen, [4, 5, 6, 7, 8]);
  assert.equal(g.world.get(boom.id), undefined);
});

test('検証: ないファイル・範囲外のコマ・ない動きの名前は、ヒント付きで拒否される', async () => {
  const p = await Project.load(await fresh());
  await assert.rejects(p.apply([{ op: 'set', path: '@bullet.Sprite.image', value: 'assets/kenney-pixel-shmup/tile.png' }], ai), /ファイル .*tile\.png がありません.*もしかして.*tiles\.png/s);
  await assert.rejects(p.apply([{ op: 'set', path: '@bullet.Sprite.frame', value: 120 }], ai), /範囲外.*120 コマ/);
  await assert.rejects(p.apply([{ op: 'set', path: '@explosion.Animator.clip', value: 'explod' }], ai), /explod.*ある名前: explode/);
  // 拒否された編集はファイルにも残らない
  const again = await Project.load(p.dir);
  assert.equal(again.docs.prefabs.get('bullet')!.components.Sprite.frame, 0);
  await p.apply([{ op: 'set', path: '@bullet.Sprite.frame', value: 119 }], ai);
});

test('検証: シートの定義ファイルが壊れていると知らせる', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'assets/kenney-pixel-shmup/tiles.sheet.json'), JSON.stringify({ frame: [16, 16], clips: { explode: { frames: [], fps: 15 } } }));
  const p = await Project.load(dir);
  assert.ok(p.validate().some((e) => /clips\.explode\.frames/.test(e)));
});

test('標準の部品と同じ名前のコンポーネントをゲーム側で作ると、分かるように止まる', async () => {
  const dir = await fresh();
  const file = join(dir, 'game/components.ts');
  // game/index.ts は components.ts の export をすべて登録する
  await writeFile(file, (await readFile(file, 'utf8')) + `\nexport const Sprite = defineComponent({ name: 'Sprite', desc: 'x', fields: {} });\n`);
  await assert.rejects(Project.load(dir), /Sprite.*標準/);
});

test('描く順番は 層 → 順番 → 入った順。選択は見えている形（回転・倍率込み）で判定する', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  const a = g.world.spawn('bullet', { Transform: { x: 50, y: 50 }, Sprite: { layer: 2 } });
  const b = g.world.spawn('bullet', { Transform: { x: 50, y: 50 }, Sprite: { layer: 2, order: -1 } });
  const ids = collectDrawables(g.world).map((d) => d.e.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), '同じ層では order の小さい方が奥');
  assert.deepEqual(ids.slice(-3), ['hud', 'hpGauge', 'hpLabel'], 'HUD は層 10 で一番手前（同じ層は入った順）');

  // 横長の箱を 90度回すと縦長になる
  const q = cornersOf({ x: 0, y: 0, rot: 90, sx: 2, sy: 1 }, 10, 4, 0.5, 0.5);
  assert.equal(pointInCorners(0, 9, q), true);
  assert.equal(pointInCorners(9, 0, q), false);
});

test('図形の線・枠と文字の縁取り・切り抜き（2-16）: 形の計算と標準の部品', async () => {
  const { lineCorners, strokeBands } = await import('../src/render/geom.ts');
  // 線: (10,20) から右へ 100、太さ 4 → 上下に 2 ずつ
  assert.deepEqual(lineCorners({ x: 10, y: 20 }, [100, 0], 4), [10, 22, 110, 22, 110, 18, 10, 18]);
  // 回転 90 度（y は下向き）: to は回って下へ伸びる
  const q = lineCorners({ x: 0, y: 0, rot: 90 }, [50, 0], 2).map((v) => Math.round(v * 1000) / 1000 + 0);
  assert.deepEqual(q, [-1, 0, -1, 50, 1, 50, 1, 0]);
  // 枠: 4本の帯。太すぎると塗りつぶしと同じ1枚
  assert.deepEqual(strokeBands(100, 50, 5), [[0, 0, 1, 0.1], [0, 0.9, 1, 1], [0, 0.1, 0.05, 0.9], [0.95, 0.1, 1, 0.9]]);
  assert.deepEqual(strokeBands(100, 50, 30), [[0, 0, 1, 1]]);
  // 標準の部品と既定値
  const dir = await fresh();
  const p = await Project.load(dir);
  const s = p.registry.components.get('Shape')!.fields;
  assert.deepEqual([s.kind.type === 'enum' && s.kind.options, s.stroke.default, s.to.default], [['rect', 'circle', 'line'], 0, [0, 0]]);
  const t = p.registry.components.get('Text')!.fields;
  assert.deepEqual([t.bold.default, t.outline.default, t.outlineColor.default, t.alpha.default], [false, 0, '#000000', 1]);
  assert.ok(p.registry.std.has('Clip'));
  const r = await p.apply([
    { op: 'addEntity', scene: 'main', entity: { id: 'beam', components: { Transform: { x: 10, y: 10 }, Shape: { kind: 'line', to: [0, 300], stroke: 6 }, Clip: { min: [0, 0], max: [100, 200] } } } },
    { op: 'set', path: 'main#hpLabel.Text.outline', value: 2 },
  ], ai);
  assert.equal(r.changes.length, 2);
  await assert.rejects(p.apply([{ op: 'set', path: 'main#beam.Shape.kind', value: 'ring' }], ai), /rect \| circle \| line/);
  await rm(dir, { recursive: true, force: true });
});

test('敷き詰め（Sprite.tile）: はみ出す1枚は切り、ずれで絵が流れる。Shape の重ね方', async () => {
  const { tileSpans } = await import('../src/render/geom.ts');
  // 長さ 100 を 40 ずつ: 40・40・20（最後の1枚は半分だけ）
  assert.deepEqual(tileSpans(100, 40, 0), [[0, 0.4, 0, 1], [0.4, 0.8, 0, 1], [0.8, 1, 0, 0.5]]);
  // 10 ずらす: 最初の1枚は絵の 1/4 から
  assert.deepEqual(tileSpans(100, 40, 10).slice(0, 2), [[0, 0.3, 0.25, 1], [0.3, 0.7, 0, 1]]);
  assert.deepEqual(tileSpans(100, 40, -30), tileSpans(100, 40, 10), '負のずれも同じ並び');
  assert.equal(tileSpans(1e6, 1, 0).length, 512, '多すぎるときは打ち切る');
  const dir = await fresh();
  const p = await Project.load(dir);
  const sp = p.registry.components.get('Sprite')!.fields, sh = p.registry.components.get('Shape')!.fields;
  assert.deepEqual([sp.tile.default, sp.tileOffset.default, sh.blend.default], [[0, 0], [0, 0], 'normal']);
  await rm(dir, { recursive: true, force: true });
});
