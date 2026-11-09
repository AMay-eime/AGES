// 段階2-6: アセット（一覧・使っている所・場所の変更・削除・音の長さ）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { readLog, readTouched, readLocks } from '../src/project/oplog.ts';
import { checkAssetPath, codeRefs, freeName } from '../src/core/assets.ts';
import { m4aSeconds, mp3Seconds, oggSeconds } from '../src/project/assets.ts';
import { cmdAssets, cmdMap } from '../src/cli/ages.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const human = { who: 'yamamoto', kind: 'human' as const, win: 'assets' };
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const SHIPS = 'assets/kenney-pixel-shmup/ships.png';
const TILES = 'assets/kenney-pixel-shmup/tiles.png';

/** サンプルの写しに、画像のリストを持つ表（入れ子の中の参照）を足したもの */
async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const file = join(dir, 'game/tables.ts');
  await writeFile(file, (await readFile(file, 'utf8')) + `
export const looks = defineTable({ name: 'looks', columns: {
  pics: { type: 'list', of: { type: 'asset', kind: 'image', default: '' }, default: [] },
} });
`);
  await writeFile(join(dir, 'data/looks.table.json'), `{\n  "name": "looks",\n  "rows": [\n    {"id":"a","pics":["${SHIPS}","${TILES}"]}\n  ]\n}\n`);
  return dir;
}
const sceneOf = async (dir: string) => JSON.parse(await readFile(join(dir, 'scenes/main.scene.json'), 'utf8'));
const player = async (dir: string) => (await sceneOf(dir)).entities.find((e: { id: string }) => e.id === 'player').components.Sprite.image;

test('場所を変えると、使っている値（入れ子の中も）と画像の切り方も一緒に動く', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  assert.deepEqual(p.validate(), []);
  const r = await p.apply([{ op: 'moveAsset', from: SHIPS, to: 'assets/ships/player.png' }], ai);
  assert.deepEqual(r.changes.filter((c) => c.auto).map((c) => c.path).sort(), ['$looks.a.pics', '@enemy.Sprite.image', 'main#player.Sprite.image']);
  assert.ok(existsSync(join(dir, 'assets/ships/player.png')) && !existsSync(join(dir, SHIPS)));
  assert.ok(existsSync(join(dir, 'assets/ships/player.sheet.json')) && !existsSync(join(dir, 'assets/kenney-pixel-shmup/ships.sheet.json')), '切り方も一緒に');
  assert.equal(await player(dir), 'assets/ships/player.png');
  const q = await Project.load(dir);
  assert.deepEqual(q.validate(), [], '読み直しても問題なし');
  assert.deepEqual(q.docs.tables.get('looks')!.rows[0].pics, ['assets/ships/player.png', TILES]);
  assert.ok(q.registry.sheets.get('assets/ships/player.png')?.frame, '切り方は新しい場所で読める');
  const log = await readLog(dir);
  assert.ok(log.some((e) => e.path === `file:${SHIPS}` && e.to === 'assets/ships/player.png' && e.op === 'moveAsset'));
});

test('フォルダごと動かせる（中のアセット以外のファイルも）。決まりに合わない移動は理由付きで止める', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'moveAsset', from: 'assets/kenney-pixel-shmup/', to: 'assets/kenney' }], ai);
  assert.ok(existsSync(join(dir, 'assets/kenney/License.txt')) && existsSync(join(dir, 'assets/kenney/tiles.sheet.json')));
  assert.equal(await player(dir), 'assets/kenney/ships.png');
  assert.deepEqual((await Project.load(dir)).validate(), []);
  const no = (op: object, re: RegExp) => assert.rejects(p.apply([op as never], ai), re);
  await no({ op: 'moveAsset', from: 'assets/kenney/ships.png', to: 'assets/kenney/ships.webp' }, /拡張子は変えられません/);
  await no({ op: 'moveAsset', from: 'assets/kenney/ships.png', to: 'game/ships.png' }, /game\/ はプロジェクトの決まった置き場所/);
  await no({ op: 'moveAsset', from: 'assets/kenney/ships.png', to: '../ships.png' }, /プロジェクトの中の場所で/);
  await no({ op: 'moveAsset', from: 'assets/kenney/ships.png', to: 'assets/kenney/tiles.png' }, /tiles\.png はすでにあります/);
  await no({ op: 'moveAsset', from: 'assets/kenney', to: 'assets/kenney/inner' }, /その中.*へは移せません/);
  await no({ op: 'moveAsset', from: 'assets/kenny/ships.png', to: 'a.png' }, /ありません。もしかして: assets\/kenney\/ships\.png/);
  await no({ op: 'moveAsset', from: 'assets/kenney/ships.png', to: 'assets/sounds' }, /assets\/sounds はフォルダです/);
});

test('使われているものは消せない。使われていなければ切り方ごと消える。コードの中で使っているものも消せない', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await assert.rejects(p.apply([{ op: 'removeAsset', path: SHIPS }], ai), /使われているので消せません: .*main#player\.Sprite\.image/);
  await cp(join(dir, SHIPS), join(dir, 'assets/spare.png'));
  await writeFile(join(dir, 'assets/spare.sheet.json'), '{ "frame": [32, 32] }\n');
  const q = await Project.load(dir);
  await q.apply([{ op: 'removeAsset', path: 'assets/spare.png' }], ai);
  assert.ok(!existsSync(join(dir, 'assets/spare.png')) && !existsSync(join(dir, 'assets/spare.sheet.json')));
  // コードの中で場所を書いている音（ctx.sound.play('assets/...') で直接鳴らせる）
  await cp(join(dir, 'assets/sounds/hit.wav'), join(dir, 'assets/sounds/coin.wav'));
  const sys = join(dir, 'game/systems.ts');
  await writeFile(sys, (await readFile(sys, 'utf8')) + "\nexport const COIN = 'assets/sounds/coin.wav';\n");
  const r = await Project.load(dir);
  assert.match(await cmdAssets(dir, undefined, { refs: 'assets/sounds/coin.wav' }), /coin\.wav: game\/systems\.ts:\d+（コード）/);
  await assert.rejects(r.apply([{ op: 'removeAsset', path: 'assets/sounds/coin.wav' }], ai), /コードの中で使われているので消せません: game\/systems\.ts:\d+/);
  assert.ok(existsSync(join(dir, 'assets/sounds/coin.wav')), '止めたらファイルも残る');
  const mv = await r.apply([{ op: 'moveAsset', from: 'assets/sounds/coin.wav', to: 'assets/se/coin.wav' }], ai);
  assert.match(mv.warnings?.join() ?? '', /コードの中にも書かれています（game\/systems\.ts:\d+）。.*assets\/se\/coin\.wav に書き換えて/);
});

test('ロック: AIは、ロックされた値や切り方に関わるアセットを動かせない。人が動かすとロックと★も付いていく', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.lock(['main#player.Sprite.image'], keeper);
  await assert.rejects(p.apply([{ op: 'moveAsset', from: SHIPS, to: 'assets/s.png' }], ai), /🔒 この操作は、ロックされた値も変えてしまいます: main#player\.Sprite\.image/);
  assert.ok(existsSync(join(dir, SHIPS)), 'ファイルは動いていない');
  assert.equal(await player(dir), SHIPS);
  await p.unlock(['main#player.Sprite.image'], keeper);
  await p.lock([`sheet:${TILES}`], keeper);
  await p.apply([{ op: 'setFrame', image: SHIPS, frame: 0, name: 'hero' }], human);
  await assert.rejects(p.apply([{ op: 'moveAsset', from: 'assets/kenney-pixel-shmup', to: 'assets/k' }], ai), /🔒 ロックされた値は変更できません: sheet:assets\/kenney-pixel-shmup\/tiles\.png/);
  await p.apply([{ op: 'moveAsset', from: 'assets/kenney-pixel-shmup', to: 'assets/k' }], human);
  const locks = await readLocks(dir);
  assert.ok(locks['sheet:assets/k/tiles.png'] && !locks[`sheet:${TILES}`], 'ロックも付け替え');
  const touched = await readTouched(dir);
  assert.ok(touched['sheet:assets/k/ships.png'] && !touched[`sheet:${SHIPS}`], '★も付け替え');
  assert.ok(!Object.keys(touched).some((k) => k.startsWith('file:')), '場所の変更そのものには★を付けない');
  const q = await Project.load(dir);
  assert.deepEqual(q.lockReport, [], 'ロックの記録は封印と一致');
  await assert.rejects(q.apply([{ op: 'setFrame', image: 'assets/k/tiles.png', frame: 0, name: 'x' }], ai), /🔒/);
});

test('一覧: フォルダごとに、大きさ・長さ・使っている所の数。未使用だけも出せる。地図にも未使用の印', async () => {
  const dir = await fresh();
  await mkdir(join(dir, 'assets/extra'));
  await cp(join(dir, 'assets/sounds/hit.wav'), join(dir, 'assets/extra/unused.wav'));
  const list = await cmdAssets(dir, undefined, {});
  assert.match(list, /^アセット 7件/);
  assert.match(list, /assets\/kenney-pixel-shmup\/\n {2}ships\.png 128x192 シート 格子32x32×24 3か所/);
  assert.match(list, /assets\/sounds\/\n {2}bgm\.wav 6\.4s 1か所/);
  assert.match(list, / {2}unused\.wav 0\.28s 未使用/);
  assert.equal(await cmdAssets(dir, undefined, { unused: true }), 'アセット 1件（未使用）。場所を変える: patch の moveAsset（使っている値も直る）／消す: removeAsset（使っていないものだけ）\nassets/extra/\n  unused.wav 0.28s 未使用');
  assert.match(await cmdAssets(dir, 'assets/sounds', { kind: 'sound' }), /アセット 4件/);
  assert.equal(await cmdAssets(dir, undefined, { refs: SHIPS }), `${SHIPS}: main#player.Sprite.image @enemy.Sprite.image $looks.a.pics[0]`);
  assert.match(await cmdMap(dir), / {2}unused\.wav 0\.28s 未使用/);
  await assert.rejects(cmdAssets(dir, undefined, { kind: 'img' }), /もしかして: image/);
});

test('場所の決まりと、空いている名前', () => {
  assert.equal(checkAssetPath('assets/a.png'), null);
  assert.match(checkAssetPath('/etc/a.png')!, /プロジェクトの中/);
  assert.match(checkAssetPath('assets//a.png')!, /プロジェクトの中/);
  assert.match(checkAssetPath('scenes/a.png')!, /決まった置き場所/);
  assert.match(checkAssetPath('assets/a?.png')!, /使えない文字/);
  const taken = new Set(['a/x.png', 'a/x-2.png']);
  assert.equal(freeName('a/x.png', (p) => taken.has(p)), 'a/x-3.png');
  assert.equal(freeName('a/y.png', (p) => taken.has(p)), 'a/y.png');
  const refs = codeRefs([['game/a.ts', "play('assets/x.wav');\nconst y = \"assets/y.png\";\nconst z = 'assets/x.wav.bak';"]], ['assets/x.wav', 'assets/y.png']);
  assert.deepEqual(Object.fromEntries(refs), { 'assets/x.wav': ['game/a.ts:1'], 'assets/y.png': ['game/a.ts:2'] });
});

test('音の長さ: OGG（Vorbis / Opus）・MP3（Xing と固定の速さ）・M4A をファイルの情報から読む', () => {
  const page = (granule: bigint, packet: Buffer) => {
    const head = Buffer.alloc(27 + 1);
    head.write('OggS', 0);
    head.writeBigInt64LE(granule, 6);
    head[26] = 1;
    head[27] = packet.length;
    return Buffer.concat([head, packet]);
  };
  const vorbis = Buffer.alloc(30); vorbis[0] = 1; vorbis.write('vorbis', 1); vorbis.writeUInt32LE(44100, 12);
  const v = Buffer.concat([page(0n, vorbis), Buffer.alloc(40), page(110250n, Buffer.alloc(4))]);
  assert.equal(oggSeconds(v, v), 2.5);
  const opus = Buffer.alloc(19); opus.write('OpusHead', 0); opus.writeUInt16LE(312, 10);
  const o = Buffer.concat([page(0n, opus), Buffer.alloc(40), page(120000n + 312n, Buffer.alloc(4))]);
  assert.equal(oggSeconds(o, o), 2.5);
  // MP3: MPEG1 Layer III 128kbps 44.1kHz ステレオ
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const xing = Buffer.alloc(200); frame.copy(xing, 0); xing.write('Xing', 4 + 32); xing.writeUInt32BE(1, 4 + 32 + 4); xing.writeUInt32BE(100, 4 + 32 + 8);
  assert.equal(mp3Seconds(xing, 10000), (100 * 1152) / 44100);
  const id3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x0a', 'latin1'), Buffer.alloc(10), frame, Buffer.alloc(100)]);
  assert.equal(mp3Seconds(id3, 20 + 16000), (16000 * 8) / 128000, '固定の速さなら大きさから（ID3 の分は除く）');
  // M4A: mvhd の時間の単位と長さ
  const mvhd = Buffer.alloc(40); mvhd.write('mvhd', 0); mvhd.writeUInt32BE(1000, 16); mvhd.writeUInt32BE(2500, 20);
  assert.equal(m4aSeconds(Buffer.alloc(10), Buffer.concat([Buffer.alloc(8), mvhd])), 2.5);
  assert.equal(oggSeconds(Buffer.from('nope'), Buffer.alloc(0)), null);
});

test('地図: アセットが多いと、フォルダごとの数にまとめる（1つずつは ages assets）', async () => {
  const dir = await fresh();
  const png = await readFile(join(dir, SHIPS));
  await mkdir(join(dir, 'assets/many/sub'), { recursive: true });
  for (let i = 0; i < 45; i++) await writeFile(join(dir, `assets/many/sub/p${i}.png`), png);
  const map = await cmdMap(dir);
  assert.match(map, /## assets（\d+個。フォルダごとの数。1つずつは ages assets/);
  assert.match(map, /^ {2}assets\/many\/sub\/ 画像45 未使用45$/m);
  assert.match(map, /^ {2}assets\/kenney-pixel-shmup\/ 画像2（シート2）$/m);
  assert.doesNotMatch(map, /p12\.png/);
  assert.match(await cmdAssets(dir, 'assets/many', {}), /p12\.png \d+x\d+ 未使用/);
  await rm(dir, { recursive: true, force: true });
});
