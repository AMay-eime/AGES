// 毎回読む量の上限: AIが作業のたびに読むもの（MCPの道具の定義と説明・AGENTS.md・地図）の文字数を測り、
// 上限を超えたら止める。機能を足して増えたら、ここで気づく（上げるときは docs/DECISIONS.md に理由を書く）。
// 詳しい手順は docs/GUIDE.md（ages schema guide:項目）、op の一覧は ages schema ops に置き、要るときに引く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeInstructions, makeTools } from '../src/mcp/tools.ts';
import { cmdInit, cmdMap, cmdSchema } from '../src/cli/ages.ts';
import { parseGuide } from '../src/project/guide.ts';
import { STD_COMPONENTS } from '../src/std/components.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));

/** 上限（文字数）。2026-11-09 段階2-14.5 の値に1〜2割の余裕 */
const BUDGET = {
  instructions: 1100, // MCP の initialize で渡る説明
  tools: 6500, // MCP の道具の定義（tools/list の JSON）
  agents: 3800, // AGENTS.md
  mapBlank: 600, // ages init したばかりのプロジェクトの地図
  mapShooter: 4300, // 見本（examples/shooter）の地図
};

async function shooter(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

async function measure(): Promise<Record<keyof typeof BUDGET, number>> {
  const tools = makeTools('/p').map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const blank = join(await mkdtemp(join(tmpdir(), 'ages-')), 'g');
  await cmdInit(blank, 'g');
  return {
    instructions: makeInstructions('/p').length,
    tools: JSON.stringify(tools).length,
    agents: (await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')).length,
    mapBlank: (await cmdMap(blank)).length,
    mapShooter: (await cmdMap(await shooter())).length,
  };
}

test('毎回読む量（道具の定義・説明・AGENTS.md・地図）が上限の中にある', async (t) => {
  const m = await measure();
  t.diagnostic(`毎回読む量（文字）: ${Object.entries(m).map(([k, v]) => `${k} ${v}/${BUDGET[k as keyof typeof BUDGET]}`).join('  ')}  計(見本) ${m.instructions + m.tools + m.agents + m.mapShooter}`);
  for (const [k, v] of Object.entries(m)) assert.ok(v <= BUDGET[k as keyof typeof BUDGET], `${k} が ${v} 文字で、上限 ${BUDGET[k as keyof typeof BUDGET]} を超えています。詳しい説明は docs/GUIDE.md（guide:項目）や ops に移し、毎回読むところには1行だけ置く`);
});

test('AGENTS.md の目次と docs/GUIDE.md の項目が合っている。部品は標準のコンポーネント', async () => {
  const guide = parseGuide(await readFile(new URL('../docs/GUIDE.md', import.meta.url), 'utf8'));
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const toc = [...agents.matchAll(/→ `([a-z0-9-]+)`$/gm)].map((m) => m[1]);
  assert.deepEqual([...toc].sort(), [...guide.keys()].sort());
  const std = new Set(STD_COMPONENTS.map((c) => c.name));
  for (const t of guide.values()) for (const part of t.parts) assert.ok(std.has(part), `guide:${t.name} の部品 ${part} は標準のコンポーネントではありません`);
});

test('ages schema: ops・guide・guide:項目を引ける。コンポーネントには使い方の項目が出る', async () => {
  const dir = await shooter();
  assert.match(await cmdSchema(dir, ['ops']), /^ {2}dockUI\{target,edge,margin\?\}/m);
  assert.match(await cmdSchema(dir, ['guide']), /^ {2}ui: 画面に固定するもの.*（UI Layout Button Gauge）$/m);
  assert.match(await cmdSchema(dir, ['guide:ui']), /^## ui: .*\n- 物に UI を付けて/);
  assert.match(await cmdSchema(dir, ['UI']), /^UI: .*（使い方: guide:ui）$/m);
  await assert.rejects(cmdSchema(dir, ['guide:uii']), /手順の項目 uii はありません。もしかして: ui/);
  await assert.rejects(cmdSchema(dir, ['ui']), /機能の手順なら guide:ui/);
  // 見本の外にあるプロジェクトでも、手本の場所は AGES 本体を指す
  assert.doesNotMatch(await cmdSchema(dir, ['guide:window']), /`examples\//);
});

test('地図: 実行中に変わる値（desc に「自動で変化」）は名前だけを最後にまとめる', async () => {
  const { cmdMap } = await import('../src/cli/ages.ts');
  const map = await cmdMap(new URL('../examples/shooter', import.meta.url).pathname);
  assert.match(map, /^Health 体力。0で倒れる \| hp:int 0\.\.999=3 invincibleOnHit:int 0\.\.600=60 \| 自動:invincible$/m);
  assert.match(map, /^Score 得点の表示 \| （フィールドなし） \| 自動:value$/m);
});

test('地図: 大きなプロジェクトでは要約の地図（型・説明を省く・プレハブは部品の組ごと・前のシーンと同じ物は繰り返さない）', async () => {
  const { renderMap, buildMap } = await import('../src/project/map.ts');
  const { Project } = await import('../src/project/project.ts');
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const p = await Project.load(dir);
  await p.apply([{ op: 'addScene', name: 'main2', copy: 'main' }], { who: 'ai', kind: 'ai', win: 'cli' });
  const full = renderMap(p);
  assert.match(full, /^Health 体力。0で倒れる \| hp:int/m, '小さいうちは今までどおり');
  const small = buildMap(p, {}, 'compact');
  assert.equal(renderMap(p, {}, {}, new Map(), [], new Map(), small.length), small, '詳しい地図が上限を超え、要約が収まるなら要約');
  assert.match(small, /要約の地図/);
  assert.match(small, /^Health 体力 \| hp invincibleOnHit \| 自動:invincible$/m);
  assert.match(small, /^\[Sound\] \d+: .*se_shot/m);
  assert.match(small, /^ {2}ほか\d+体は main と同じ$/m);
  assert.ok(small.length < full.length);
  await rm(dir, { recursive: true, force: true });
});

test('地図: 要約でも上限を超えるときは目次の地図。中身は ages map <dir> 節 と ages find で引く', async () => {
  const { renderMap, renderMapSection } = await import('../src/project/map.ts');
  const { Project } = await import('../src/project/project.ts');
  const { cmdFind, cmdMap } = await import('../src/cli/ages.ts');
  const dir = await shooter();
  const p = await Project.load(dir);
  const index = renderMap(p, {}, {}, new Map(), [], new Map(), 100);
  assert.match(index, /目次の地図/);
  assert.match(index, /^## components \d+個: .*\bHealth\b/m);
  assert.match(index, /^## systems 実行順: /m);
  assert.match(index, /^## tables（\$表\.行\.列）: .*\$enemies \d+行/m);
  assert.match(index, /^## prefabs \d+個（主な部品ごとの数）: .*Sound \d+/m);
  assert.match(index, /^## scenes: main\(\d+体・開始\)/m);
  assert.doesNotMatch(index, /hp:int|invincibleOnHit/, '目次にはフィールドを出さない');
  // 節を1つ: 小さいプロジェクトなので詳しい形
  assert.match(renderMapSection(p, 'components'), /^Health 体力。0で倒れる \| hp:int/m);
  assert.match(renderMapSection(p, 'tables', {}, 100), /^\$enemies \d+行 .* \| /m, '大きいプロジェクトでは要約の形');
  assert.throws(() => renderMapSection(p, 'scene'), /地図の節 scene はありません。もしかして: scenes/);
  assert.match(await cmdMap(dir, 'prefabs'), /^@se_shot /m);
  // 名前と説明から探す。語は全部を含むもの。シーンをまたぐ同じ物は1行に
  const hp = await cmdFind(dir, '体力');
  assert.match(hp, /^部品 Health — 体力/m);
  assert.match(hp, /^Health\.hp int 0\.\.999=3 — /m);
  assert.match(await cmdFind(dir, 'Health hp'), /^Health\.hp /m);
  assert.doesNotMatch(await cmdFind(dir, 'Health hp'), /^部品 Health/m);
  assert.match(await cmdFind(dir, 'se_shot'), /^@se_shot /m);
  assert.match(await cmdFind(dir, 'zzzz'), /見つかりませんでした/);
  await rm(dir, { recursive: true, force: true });
});

test('最近の作業の場所: 見る・変えるで覚え、目次の地図に上位を出し、ages find の並びに使う。操作の回数で古いものを忘れる', async () => {
  const { cmdFind, cmdGet, cmdMap, cmdPatch } = await import('../src/cli/ages.ts');
  const { readRecent, placeOf, RECENT_WINDOW, noteRecent } = await import('../src/project/recent.ts');
  const { renderMap } = await import('../src/project/map.ts');
  const { Project } = await import('../src/project/project.ts');
  const dir = await shooter();
  assert.equal(placeOf('$enemies.basic.hp'), '$enemies.hp');
  assert.equal(placeOf('main#spawner.Spawner.waves[2].count'), 'main#spawner.Spawner');
  assert.equal(placeOf('prefab:enemy'), '@enemy');
  // 探すだけでは場所を覚えない（回数だけ数える）
  await cmdFind(dir, 'hp');
  assert.deepEqual((await readRecent(dir)).places, {});
  await cmdGet(dir, ['@enemy.Health.hp']);
  await cmdPatch(dir, [{ op: 'set', path: '@enemy.Health.hp', value: 5 }], false);
  const s = await readRecent(dir);
  assert.equal(s.n, 3);
  assert.deepEqual(s.places['@enemy.Health'], { hits: 2, last: 3 });
  // 目次の地図だけに出す（小さいプロジェクトの地図は今までどおり）
  assert.doesNotMatch(await cmdMap(dir), /最近の作業の場所/);
  const p = await Project.load(dir);
  assert.match(renderMap(p, {}, {}, new Map(), [], new Map(), 100, [{ place: '@enemy.Health', hits: 2 }]), /^最近の作業の場所（直近\d+回.*）: @enemy\.Health\(2\)$/m);
  // ages find は最近の場所に近いものを上に
  const found = await cmdFind(dir, 'Health');
  assert.match(found, /最近の作業の場所に近いものから/);
  assert.match(found.split('\n')[1], /^Health\.hp |^部品 Health/);
  // 操作の回数で古いものを忘れる
  for (let i = 0; i < RECENT_WINDOW; i++) await noteRecent(dir, i === RECENT_WINDOW - 1 ? ['x'] : []);
  assert.deepEqual(Object.keys((await readRecent(dir)).places), ['x']);
  await rm(dir, { recursive: true, force: true });
});
