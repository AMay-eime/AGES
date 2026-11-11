// コードを引く（ages code）: 宣言の場所と範囲・使っている所・欄と列の見分け・ファイルの目次・コメントからの検索
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdCode, cmdMap } = await import('../src/cli/ages.ts');
const { maskCode, indexFile, findUses, pathName } = await import('../src/project/codeindex.ts');

test('伏せる: 文字列・コメント・正規表現の中身は空白に（長さはそのまま）。テンプレートの ${ } の中はコード', () => {
  const src = "const a = 'x{y'; // c{\nconst r = /[/{]+/g; const d = a / 2; /* { */\nconst t = `p{ ${ f({ k: '}' }) } }q`;\n";
  const { code, bare } = maskCode(src);
  assert.equal(code.length, src.length);
  assert.equal(code.split('\n')[0], "const a = '   ';      ");
  assert.equal(code.split('\n')[1], 'const r = /     /g; const d = a / 2;        ');
  assert.equal(code.split('\n')[2], "const t = `   ${ f({ k: ' ' }) }   `;");
  assert.equal(bare.split('\n')[0], "const a = 'x{y';      ", 'コメントだけ伏せたもの');
});

const SRC = `import { defineSystem } from 'ages';
import { helper } from './util.ts';

/** 速さの上限 */
export const MAX_SPEED = 12;
type Row = Record<string, any>;
export interface Shot { speed: number; way: number }

/**
 * 弾を撃つ
 * 2行目
 */
export function fire(ctx: Ctx, p: Row, def: Row): number {
  const speed = p.speed >= 0 ? p.speed : def.defaultSpeed;
  if (speed > MAX_SPEED) return fire(ctx, { ...p, speed: MAX_SPEED }, def);
  return helper(speed) * p.way + p.angle;
}

// 2倍にする
const twice = (x: number) => x * 2;
export const clamp = (v: number, lo: number, hi: number): number => {
  return Math.min(hi, Math.max(lo, v));
};

export class Pool {
  private items: number[] = [];
  take(n: number): number {
    if (n > 3) { this.items.pop(); }
    return twice(n);
  }
}

export const mover = defineSystem({
  name: 'move.bullets',
  desc: '弾を動かす',
  update(ctx) {
    for (const e of ctx.world.query('Bullet')) {
      const b = e.c.Bullet as Row;
      b.speed += b.accel * ctx.dt;
      e.c.Transform.x += b.speed;
      if (e.c.Enemy.speed > 3) e.c.Enemy.speed = clamp(b.speed, 0, MAX_SPEED);
    }
  },
  on: {
    hit: (ctx, data) => { ctx.spawn('boom', { Bullet: { speed: 0, accel: 1 } }); },
  },
});
`;

test('宣言を読む: 関数・矢印の関数・クラスとメソッド・システムと update・型・定数。範囲と親と直前のコメント', () => {
  const f = indexFile('/game/a.ts', SRC);
  const by = (name: string) => f.blocks.find((b) => pathName(b) === name)!;
  const row = (name: string) => { const b = by(name); return [b.kind, b.line, b.endLine, b.doc]; };
  assert.equal(f.path, 'game/a.ts');
  assert.deepEqual(row('MAX_SPEED'), ['const', 5, 5, '速さの上限']);
  assert.deepEqual(row('Row'), ['type', 6, 6, '']);
  assert.deepEqual(row('Shot'), ['type', 7, 7, '']);
  assert.deepEqual(row('fire'), ['function', 13, 17, '弾を撃つ']);
  assert.equal(by('fire').head, 'export function fire(ctx: Ctx, p: Row, def: Row): number');
  assert.deepEqual(row('twice'), ['function', 20, 20, '2倍にする']);
  assert.deepEqual(row('clamp'), ['function', 21, 23, '']);
  assert.deepEqual(row('Pool'), ['class', 25, 31, '']);
  assert.deepEqual(row('Pool.take'), ['method', 27, 30, '']);
  // システムは name: の名前で呼ぶ（変数の名前でも引ける）
  assert.deepEqual([...row('move.bullets'), by('move.bullets').alias], ['system', 33, 47, '', 'mover']);
  assert.deepEqual(row('move.bullets.update'), ['method', 36, 43, '']);
  assert.deepEqual(row('move.bullets.hit'), ['method', 45, 45, '']);
  assert.ok(!f.blocks.some((b) => ['if', 'for', 'query', 'min'].includes(b.name)), '制御の文・呼び出しは宣言ではない');
});

test('使っている所: 読む・書く・入れる・呼ぶ。自分の宣言と import は数えない。欄としては .名前・{ 名前: } だけ', () => {
  const f = indexFile('game/a.ts', SRC);
  const rows = (ident: string, field = false) => findUses([f], ident, field).map((u) => `${u.line}${u.how}${u.block ? ' ' + pathName(u.block) : ''}`);
  assert.deepEqual(rows('fire'), ['15呼 fire']);
  assert.deepEqual(rows('twice'), ['29呼 Pool.take']);
  assert.deepEqual(rows('helper'), ['16呼 fire'], 'import の行は数えない');
  assert.deepEqual(rows('MAX_SPEED'), ['15読 fire', '15読 fire', '41読 move.bullets.update']);
  assert.deepEqual(rows('mover'), [], '宣言だけ');
  // 欄として: 変数の speed（14行目の const speed・16行目の helper(speed)）は拾わない
  assert.deepEqual(rows('speed', true), ['7型 Shot', '14読 fire', '14読 fire', '15値 fire', '39書 move.bullets.update', '40読 move.bullets.update', '41読 move.bullets.update', '41書 move.bullets.update', '41読 move.bullets.update', '45値 move.bullets.hit']);
});

async function project(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-code-')), 'g');
  await cmdInit(dir, 'g');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineComponent, defineSystem, defineTable, type GameModule } from 'ages';
import { fire } from './shot.ts';

const Bullet = defineComponent({ name: 'Bullet', desc: '弾', fields: {
  speed: { type: 'number', default: 0, desc: '速さ' },
  accel: { type: 'number', default: 0, desc: '加速' },
  angle: { type: 'number', default: 0, desc: '向き' },
} });
const Enemy = defineComponent({ name: 'Enemy', desc: '敵', fields: {
  speed: { type: 'number', default: 1, desc: '移動の速さ' },
  hp: { type: 'int', default: 3, desc: '体力' },
} });
export const patterns = defineTable({ name: 'patterns', desc: '撃ち方', columns: {
  speed: { type: 'number', default: -1, desc: '撃つ速さ' },
  way: { type: 'int', default: 1, desc: '同時に撃つ数' },
  angle: { type: 'number', default: 180, desc: '向き' },
  bullet: { type: 'string', default: '', desc: '弾の種類' },
} });

type Row = Record<string, any>;
/** 弾を進める（加速して動かす） */
function advance(b: Row, dt: number): void {
  b.speed += b.accel * dt;
  b.angle += 1;
}
const moveBullets = defineSystem({ name: 'moveBullets', desc: '弾を動かす', reads: [], writes: ['Bullet'], update(ctx) {
  for (const e of ctx.world.query('Bullet')) advance(e.c.Bullet as Row, ctx.dt);
} });
const enemies = defineSystem({ name: 'enemies', desc: '敵を動かして撃たせる', reads: [], writes: ['Enemy'], update(ctx) {
  for (const e of ctx.world.query('Enemy')) {
    const en = e.c.Enemy as Row;
    if (en.hp > 0 && en.speed > 0) fire(ctx, ctx.table('patterns').get('basic'));
    e.c.Enemy.speed = 2;
  }
} });
export const components: GameModule['components'] = [Bullet, Enemy];
export const tables: GameModule['tables'] = [patterns];
export const systems: GameModule['systems'] = [moveBullets, enemies];
`);
  await writeFile(join(dir, 'game', 'shot.ts'), `type Row = Record<string, any>;
/** 撃つ: 撃ち方の行から弾を出す */
export function fire(ctx: any, p: Row): void {
  // 速さは撃ち方の speed
  const speed = p.speed >= 0 ? p.speed : 3;
  for (let i = 0; i < p.way; i++) ctx.spawn('bullet', { Bullet: { speed, angle: p.angle + i * 10 } });
}
/** 画面の端までの時間 */
export function eta(view: Row): number {
  return view.height / view.speed;
}
`);
  return dir;
}

test('ages code: 欄・列は、型がなくても形から見分ける（手前の名前・同じ変数から読むほかの欄）。名前だけ同じ所は数だけ', async () => {
  const dir = await project();
  // 部品の欄: e.c.Bullet as Row を受けた b（accel・angle も読む）と、{ Bullet: { speed } }。Enemy.speed・撃ち方の p.speed・view.speed は別
  let out = await cmdCode(dir, ['Bullet.speed']);
  assert.match(out, /^Bullet\.speed — 部品 Bullet の欄 .*（game\/index\.ts:5） 速さ$/m);
  assert.match(out, /^使っている所 2（Bullet のものと分かる所だけ。名前だけ同じ所がほかに 4: --all で出す）$/m);
  assert.match(out, /^game\/index\.ts\n  advance\(22-25\)\n    23 書  b\.speed \+= b\.accel \* dt;$/m);
  assert.match(out, /^game\/shot\.ts\n  fire\(3-7\)\n    6 読  for \(let i = 0; i < p\.way; i\+\+\) ctx\.spawn/m);
  assert.doesNotMatch(out, /en\.speed|view\.speed|p\.speed >= 0/);

  out = await cmdCode(dir, ['Enemy.speed']);
  assert.match(out, /^使っている所 2（Enemy のものと分かる所だけ/m);
  assert.match(out, /  enemies\(29-35\)\n    32 読  if \(en\.hp > 0 && en\.speed > 0\).*\n    33 書  e\.c\.Enemy\.speed = 2;$/m);

  // 表の列: 同じ変数 p から way・angle も読んでいる
  out = await cmdCode(dir, ['$patterns.speed']);
  assert.match(out, /^\$patterns\.speed — 表 \$patterns の列 .*（game\/index\.ts:14） 撃つ速さ$/m);
  assert.match(out, /^使っている所 1（patterns のものと分かる所だけ。名前だけ同じ所がほかに 5: --all で出す）\ngame\/shot\.ts\n  fire\(3-7\)\n    5 読  const speed = p\.speed >= 0 \? p\.speed : 3;$/m);
  // --all で全部
  out = await cmdCode(dir, ['$patterns.speed'], { all: true });
  assert.match(out, /^使っている所 6$/m);
  assert.match(out, /view\.height \/ view\.speed/);
  // ない表・ない列
  assert.match(await cmdCode(dir, ['$pattern.speed']), /表 \$pattern はありません（近いもの: \$patterns）/);
  assert.match(await cmdCode(dir, ['$patterns.sped']), /表 \$patterns に列 sped はありません（あるのは speed way angle bullet）/);
});

test('ages code: 名前で宣言と使っている所（--body で中身）・ファイルの目次・コメントから探す・ないときの案内', async () => {
  const dir = await project();
  let out = await cmdCode(dir, ['fire']);
  assert.match(out, /^fire — 関数（game\/shot\.ts:3-7・5行） 撃つ: 撃ち方の行から弾を出す\n  export function fire\(ctx: any, p: Row\): void\n使っている所 1\ngame\/index\.ts\n  enemies\(29-35\)\n    32 呼  /m);
  out = await cmdCode(dir, ['fire'], { body: true });
  assert.match(out, /^3\| export function fire\(ctx: any, p: Row\): void \{\n4\|   \/\/ 速さは撃ち方の speed\n/m);
  assert.match(out, /^7\| \}$/m);
  // システムは名前で。親.名前 が見つからなければ（1行に書いた update）、親を出す
  assert.match(await cmdCode(dir, ['moveBullets']), /^moveBullets — システム（game\/index\.ts:26-28）/m);
  assert.match(await cmdCode(dir, ['enemies.update'], { body: true }), /^enemies — システム（game\/index\.ts:29-35・7行）\n29\| const enemies = defineSystem/m);
  // 同じ名前の宣言がいくつもあるとき（Row）はそれぞれ
  assert.match(await cmdCode(dir, ['Row']), /Row — 型（game\/index\.ts:20）[\s\S]*Row — 型（game\/shot\.ts:1）/);

  // ファイルの目次
  out = await cmdCode(dir, ['game/shot.ts']);
  assert.match(out, /^game\/shot\.ts（12行）\n  1 type Row = Record<string, any>;\n  3-7 export function fire\(ctx: any, p: Row\): void — 撃つ: 撃ち方の行から弾を出す\n  9-11 export function eta\(view: Row\): number — 画面の端までの時間$/m);
  assert.match(await cmdCode(dir, ['shot.ts']), /^game\/shot\.ts（12行）/, '名前だけでも');
  assert.match(await cmdCode(dir, ['game/shoot.ts']), /というファイルはコード（game\/・editor\/）にありません/);

  // 日本語の語: 説明にある宣言を先に、ほかの行は後に（語はまとめて、全部を含むもの）
  out = await cmdCode(dir, ['撃ち方', '弾']);
  assert.match(out, /^「撃ち方 弾」が説明にある宣言 1\n  game\/shot\.ts:3-7 fire — 撃つ: 撃ち方の行から弾を出す$/m);
  out = await cmdCode(dir, ['速さ', 'speed']);
  assert.match(out, /「速さ」を含む行 \d+（コメント・文字列）/);
  assert.match(out, /    4  \/\/ 速さは撃ち方の speed/);

  // ないとき: 名前に含むものを出す。なければ ages find を案内
  assert.match(await cmdCode(dir, ['bullets']), /「bullets」という名前はありません。名前に含むもの 2:\n  game\/index\.ts:4-8 Bullet\n  game\/index\.ts:26-28 moveBullets/);
  assert.match(await cmdCode(dir, ['zzz']), /「zzz」はコード（game\/・editor\/）にありません（データの名前・説明から探すのは ages find/);
  await assert.rejects(() => cmdCode(dir, []), /引くものを書いてください/);
  assert.ok((await cmdMap(dir)).length > 0);
});
