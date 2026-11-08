// 画像の切り方（スプライトシート）: 自由な矩形・名前・基準点、切り出しの計算、PNG、差分編集・ロック・★
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { Project, formatSheet } from '../src/project/project.ts';
import { decodePng } from '../src/project/png.ts';
import { autoRects, carryClips, frameMapper, gridRects, nameFrames, type Pixels } from '../src/core/slice.ts';
import { checkSheet, findFrame, frameCount } from '../src/core/sheet.ts';
import { spriteGeometry } from '../src/render/geom.ts';
import { cmdSheet, cmdSlice } from '../src/cli/ages.ts';
import { readLog, readTouched, summarize } from '../src/project/oplog.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const human = { who: 'yamamoto', kind: 'human' as const, win: 'sprite' };
const keeper = { who: 'yamamoto', kind: 'human' as const, win: 'lock-manager' };
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };
const SHIPS = 'assets/kenney-pixel-shmup/ships.png';

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

/** テスト用に PNG を作る（RGBA 8bit、フィルタなし） */
function encodePng(px: Pixels): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px.w, 0); ihdr.writeUInt32BE(px.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((px.w * 4 + 1) * px.h);
  for (let y = 0; y < px.h; y++) Buffer.from(px.data.buffer, px.data.byteOffset + y * px.w * 4, px.w * 4).copy(raw, y * (px.w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 透明な画像に、指定の矩形を塗る */
function paint(w: number, h: number, rects: [number, number, number, number][]): Pixels {
  const data = new Uint8Array(w * h * 4);
  for (const [x, y, rw, rh] of rects) for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) data.set([255, 255, 255, 255], (yy * w + xx) * 4);
  return { w, h, data };
}

test('切り出し: 格子（大きさ・数・隙間・余白・空のコマを除く）', () => {
  assert.deepEqual(gridRects(10, 4, { cell: [4, 4], spacing: 2 }), [[0, 0, 4, 4], [6, 0, 4, 4]]);
  assert.deepEqual(gridRects(12, 6, { count: [3, 1], margin: 1 }), [[1, 1, 3, 4], [4, 1, 3, 4], [7, 1, 3, 4]]);
  const px = paint(8, 4, [[5, 1, 2, 2]]);
  assert.deepEqual(gridRects(8, 4, { cell: [4, 4], skipEmpty: true }, px), [[4, 0, 4, 4]]);
  assert.throws(() => gridRects(8, 4, {}), /cell.*count/);
});

test('切り出し: 自動（かたまりごと・近いものをまとめる・小さいごみを捨てる・行ごとに左から）', () => {
  // 2行: 上の行に2つ（右の方が少し下にずれている）、下の行に1つ。点のごみが1つ
  const px = paint(40, 30, [[20, 2, 6, 6], [2, 1, 5, 5], [3, 18, 8, 8], [35, 28, 1, 1]]);
  assert.deepEqual(autoRects(px), [[2, 1, 5, 5], [20, 2, 6, 6], [3, 18, 8, 8]]);
  // 離れた部品をまとめる
  const parts = paint(20, 10, [[1, 1, 3, 3], [6, 1, 3, 3]]);
  assert.equal(autoRects(parts).length, 2);
  assert.deepEqual(autoRects(parts, { gap: 2 }), [[1, 1, 8, 3]]);
  assert.deepEqual(autoRects(parts, { pad: 1 })[0], [0, 0, 5, 5]);
});

test('切り出し: 切り直しても、同じ場所のコマは名前と基準点を引き継ぐ。動きも新しい切り方へ移る', () => {
  const old = [{ name: 'hero', rect: [0, 0, 10, 10] as [number, number, number, number], pivot: [0.5, 1] as [number, number] }, { name: 'gone', rect: [50, 0, 10, 10] as [number, number, number, number] }];
  const next = nameFrames([[1, 0, 10, 10], [20, 0, 8, 8]], 'pic', old);
  assert.deepEqual(next, [{ name: 'hero', rect: [1, 0, 10, 10], pivot: [0.5, 1] }, { name: 'pic_0', rect: [20, 0, 8, 8] }]);
  // 格子 → 自由な矩形: 番号は場所の重なりで追う
  const grid = { frame: [16, 16] as [number, number], clips: { walk: { frames: [1, 0], fps: 8 } } };
  const free = { frames: [{ name: 'b', rect: [18, 2, 12, 12] as [number, number, number, number] }, { name: 'a', rect: [2, 2, 12, 12] as [number, number, number, number] }] };
  const map = frameMapper(grid, free, 32, 16);
  assert.deepEqual([map(0), map(1)], [1, 0]);
  assert.deepEqual(carryClips(grid, free, 32, 16).clips, { walk: { frames: ['b', 'a'], fps: 8 } });
  assert.deepEqual(carryClips(grid, { frames: [free.frames[0]] }, 32, 16).missing, ['walk の #0']);
});

test('PNG: パレット（4bit・透明あり）と RGBA を読める', async () => {
  const ships = decodePng(await readFile(new URL(`../examples/shooter/${SHIPS}`, import.meta.url)));
  assert.deepEqual([ships.w, ships.h, ships.data[3]], [128, 192, 0]);
  assert.equal(autoRects(ships).length > 15, true);
  const px = paint(5, 3, [[1, 1, 2, 1]]);
  const back = decodePng(encodePng(px));
  assert.deepEqual([...back.data], [...px.data]);
});

test('シートの検証: 名前の重複・数字だけの名前・はみ出し・ないコマを使う動き', async () => {
  const errs = checkSheet('x.sheet.json', { frames: [{ name: 'a', rect: [0, 0, 4, 4] }, { name: 'a', rect: [0, 0, 4, 4] }, { name: '3', rect: [0, 0, 4, 4] }], clips: { run: { frames: ['zz'], fps: 4 } } });
  assert.equal(errs.length, 3);
  const p = await Project.load(await fresh());
  await assert.rejects(p.apply([{ op: 'setFrame', image: SHIPS, frame: 'huge', rect: [100, 0, 64, 10] }], ai), /はみ出し/);
  await assert.rejects(p.apply([{ op: 'set', path: '@enemy.Sprite.frame', value: 'nope' }], ai), /格子のシートなので番号/);
});

test('ages slice --auto: 自由な矩形に切り、番号で指定していたコマは名前に直す', async () => {
  const dir = await fresh();
  const out = await cmdSlice(dir, SHIPS, { auto: true });
  assert.match(out, /自由 2\dコマ/);
  assert.match(out, /@enemy\.Sprite\.frame 18→ships_\d+/);
  const p = await Project.load(dir);
  assert.deepEqual(p.validate(), []);
  const ref = p.docs.prefabs.get('enemy')!.components.Sprite.frame as string;
  const f = findFrame(p.docs.sheets.get(SHIPS)!, 128, 192, ref)!;
  // 元の18番（4列の格子の 5行目・3列目 = x 64..96, y 128..160）の中にある
  assert.ok(f.x >= 64 && f.x + f.w <= 96 && f.y >= 128 && f.y + f.h <= 160, JSON.stringify(f));
  // 切り直した変更は、人の調整（★）ではない
  assert.deepEqual(await readTouched(dir), {});
  assert.match(summarize(await readLog(dir)), /切り方 \d+件変更/);
  assert.match(await cmdSheet(dir, SHIPS), new RegExp(`#\\d+ ${ref} \\d+,\\d+ \\d+x\\d+`));
  // ファイルは1行1コマ
  assert.equal(formatSheet(p.docs.sheets.get(SHIPS)!).split('\n').filter((l) => l.includes('"rect"')).length, frameCount(p.docs.sheets.get(SHIPS)!, 128, 192));
});

test('setFrame: 名前を変えると参照も直る。使われているコマは消せない。消すと後ろの番号の指定も直る', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  // 格子のシートに名前を付ける（格子は同じ並びの自由な矩形になる）
  await p.apply([{ op: 'setFrame', image: SHIPS, frame: 18, name: 'enemy_gray', pivot: [0.5, 1] }], ai);
  const sheet = p.docs.sheets.get(SHIPS)!;
  assert.equal(sheet.frames!.length, 24);
  assert.equal(p.docs.prefabs.get('enemy')!.components.Sprite.frame, 18, '番号はずれていないので番号のまま');
  await p.apply([{ op: 'set', path: '@enemy.Sprite.frame', value: 'enemy_gray' }], ai);
  await p.apply([{ op: 'setClip', image: SHIPS, clip: 'blink', frames: ['enemy_gray', 19], fps: 4 }], ai);
  await p.apply([{ op: 'setFrame', image: SHIPS, frame: 'enemy_gray', name: 'enemy_a' }], ai);
  assert.equal(p.docs.prefabs.get('enemy')!.components.Sprite.frame, 'enemy_a');
  assert.deepEqual(p.docs.sheets.get(SHIPS)!.clips!.blink.frames, ['enemy_a', 19]);
  // 使われているコマは消せない（ファイルも変わらない）
  await assert.rejects(p.apply([{ op: 'setFrame', image: SHIPS, frame: 0, remove: true }], ai), /main#player\.Sprite\.frame=0 のコマ/);
  // 5番を消すと、19番は18番になる → 動きの指定は名前に直る
  await p.apply([{ op: 'setFrame', image: SHIPS, frame: 5, remove: true }], ai);
  assert.deepEqual(p.docs.sheets.get(SHIPS)!.clips!.blink.frames, ['enemy_a', 'ships_19']);
  const again = await Project.load(dir);
  assert.deepEqual(again.validate(), []);
  assert.equal(again.docs.sheets.get(SHIPS)!.frames!.length, 23);
});

test('切り方の★と🔒: 人が切った画像は確認が要り、ロックした画像はAIからも人のエディタからも変えられない。直接の書き換えは戻る', async () => {
  const dir = await fresh();
  const p = await Project.load(dir);
  await p.apply([{ op: 'setSheet', image: SHIPS, sheet: { frames: [{ name: 'a', rect: [0, 0, 32, 32] }, { name: 'e', rect: [64, 128, 32, 32] }] } }], human);
  assert.equal(p.docs.prefabs.get('enemy')!.components.Sprite.frame, 'e', '18番の場所のコマに名前で付け替わる');
  await assert.rejects(cmdSlice(dir, SHIPS, { grid: '32x32' }), /人が調整した値/);
  await cmdSlice(dir, SHIPS, { grid: '32x32', force: true });
  const q = await Project.load(dir);
  assert.equal(q.docs.sheets.get(SHIPS)!.frames!.length, 24, '前が自由な矩形なので、格子で切っても自由な矩形（名前を引き継ぐ）');
  assert.equal(q.docs.sheets.get(SHIPS)!.frames![0].name, 'a');
  assert.equal(q.docs.sheets.get(SHIPS)!.frames![18].name, 'e');
  await q.lock([`sheet:${SHIPS}`], keeper);
  await assert.rejects(cmdSlice(dir, SHIPS, { auto: true, force: true }), /🔒/);
  await assert.rejects(q.apply([{ op: 'setFrame', image: SHIPS, frame: 'a', name: 'b' }], ai, { force: true }), /🔒/);
  // AIがファイルを直接書き換えても、次の読み込みで戻る
  const file = join(dir, 'assets/kenney-pixel-shmup/ships.sheet.json');
  await writeFile(file, JSON.stringify({ frame: [8, 8] }));
  const r = await Project.load(dir);
  assert.ok(r.lockReport.some((l) => /切り方/.test(l)), r.lockReport.join('\n'));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).frames.length, 24);
  // 人もエディタからは変えられない。ロックマネージャーから変えると、ロックの値も新しい切り方になる
  await assert.rejects(r.apply([{ op: 'setFrame', image: SHIPS, frame: 'a', pivot: [0.5, 1] }], human), /🔒 ロックされています: sheet:/);
  await r.apply([{ op: 'setFrame', image: SHIPS, frame: 'a', pivot: [0.5, 1] }], keeper);
  const s = await Project.load(dir);
  assert.deepEqual(s.lockReport, []);
  assert.deepEqual(s.docs.sheets.get(SHIPS)!.frames![0].pivot, [0.5, 1]);
});

test('描き方: コマの基準点は Sprite.anchor より優先。大きさの指定がなければコマの大きさ', () => {
  const sheet = { frames: [{ name: 'a', rect: [10, 0, 20, 10] as [number, number, number, number], pivot: [0.5, 1] as [number, number] }, { name: 'b', rect: [0, 0, 8, 8] as [number, number, number, number] }] };
  assert.deepEqual(spriteGeometry({ frame: 'a', anchor: [0, 0] }, sheet, 64, 64), { w: 20, h: 10, ax: 0.5, ay: 1, src: { x: 10, y: 0, w: 20, h: 10 } });
  assert.deepEqual(spriteGeometry({ frame: 1, anchor: [0, 0], size: [16, 0] }, sheet, 64, 64)?.ax, 0);
  assert.equal(spriteGeometry({ frame: 'zz' }, sheet, 64, 64), null);
  assert.deepEqual(spriteGeometry({}, undefined, 30, 20)?.src, { x: 0, y: 0, w: 30, h: 20 });
});
