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
  instructions: 1200, // MCP の initialize で渡る説明（2026-11-11 段階5 ages_talk の1行で 1100 → 1200）
  tools: 7700, // MCP の道具の定義（tools/list の JSON。2026-11-11 段階5 ages_talk で 6500 → 7200、ages_code で 7200 → 7600、ages_init のテンプレートで 7600 → 7700）
  agents: 4400, // AGENTS.md（2026-11-10 位置の親子の1行で 3800 → 3900。2026-11-11 段階5 ages talk で 3900 → 4250、速さの道具の1行で 4250 → 4300、ages code の案内で 4300 → 4400）
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
  // 名前が短く収まる節は、名前を全部（まとめなし）
  assert.match(index, /^## components \d+個: .*\bHealth\b/m);
  assert.match(index, /^## systems \d+個（番号.名前 の番号は実行順）: 1\.playerControl 2\.spawner /m);
  assert.match(index, /^## tables \d+個（\$表\.行\.列）: .*\$enemies\(\d+行\)/m);
  assert.match(index, /^## prefabs \d+個（@名前）: .*\bse_shot\b/m);
  assert.match(index, /^## scenes 2個: main\(\d+体・開始\) result\(\d+体\)$/m);
  assert.doesNotMatch(index, /hp:int|invincibleOnHit/, '目次にはフィールドを出さない');
  // エディタ拡張は目次でも残すが、名前と見出しだけ（説明・変える値・欄は節で引く）
  const wins = [{ path: 'editor/hp-hearts.ext.ts', id: 'hp-hearts', title: '体力', desc: '体力を ♥ の数で見せる。−・＋ で1つずつ変える', fields: ['Health.hp'], edits: [] }];
  const withExt = renderMap(p, {}, {}, new Map(), wins, new Map(), 100);
  assert.match(withExt, /^## editor extensions 1個（作る前にここを見て、近いものがあれば直す）: hp-hearts「体力」$/m);
  assert.match(renderMapSection(p, 'extensions', { windows: wins }, 100), /^hp-hearts「体力」 体力を ♥ の数で見せる。−・＋ で1つずつ変える \| 変える: なし（見るだけ） \| 欄:Health\.hp \| editor\/hp-hearts\.ext\.ts$/m);
  // 節を1つ: 小さいプロジェクトなので詳しい形
  assert.match(renderMapSection(p, 'components'), /^Health 体力。0で倒れる \| hp:int/m);
  assert.match(renderMapSection(p, 'tables', {}, 100), /^\$enemies \d+行 .* \| /m, '大きいプロジェクトでは要約の形');
  assert.match(renderMapSection(p, 'prefabs/se', {}, 100), /^## prefabs\/se 4個（.*\n@se .*\n@se_explosion /);
  assert.match(renderMapSection(p, 'scenes/main', {}, 100), /^#hpGauge "HP Gauge" \[UI Gauge\]$/m);
  assert.throws(() => renderMapSection(p, 'prefabs/sx', {}, 100), /地図の prefabs\/sx はありません。もしかして: se/);
  assert.throws(() => renderMapSection(p, 'scene'), /地図の節 scene はありません。もしかして: scenes/);
  assert.match(await cmdMap(dir, 'prefabs'), /^@se_shot /m);
  // 名前と説明から探す。語は全部を含むもの。シーンをまたぐ同じ物は1行に
  const hp = await cmdFind(dir, '体力');
  assert.match(hp, /^部品 Health（game\/components\.ts:\d+） — 体力/m);
  assert.match(hp, /^Health\.hp int 0\.\.999=3 — /m);
  assert.match(await cmdFind(dir, 'Health hp'), /^Health\.hp /m);
  assert.doesNotMatch(await cmdFind(dir, 'Health hp'), /^部品 Health/m);
  assert.match(await cmdFind(dir, 'se_shot'), /^@se_shot /m);
  assert.match(await cmdFind(dir, 'zzzz'), /見つかりませんでした/);
  await rm(dir, { recursive: true, force: true });
});

test('入れ子の目次: プロジェクトが大きくなると名前をまとめにし、まとめが大きくなるとさらに入れ子に。中身は ages map <dir> 節/まとめ', async () => {
  const { renderMap, renderMapSection, indexDepth } = await import('../src/project/map.ts');
  const { Project } = await import('../src/project/project.ts');
  const { cmdMap } = await import('../src/cli/ages.ts');
  const { readRecent } = await import('../src/project/recent.ts');
  const dir = await shooter();
  const p = await Project.load(dir);
  const before = renderMap(p, {}, {}, new Map(), [], new Map(), 100);
  assert.equal(indexDepth(p, {}, 100), 1, 'se のまとめ1段');
  // 敵を60種（2つの波）・弾を12種足す
  const ops = [
    ...[...Array(30)].map((_, i) => ({ op: 'addPrefab', name: `enemy_wave_a_${i}`, copy: 'enemy' })),
    ...[...Array(30)].map((_, i) => ({ op: 'addPrefab', name: `enemy_wave_b_${i}`, copy: 'enemy' })),
    ...[...Array(12)].map((_, i) => ({ op: 'addPrefab', name: `bullet_kind${i}`, copy: 'bullet' })),
  ];
  await p.apply(ops as never, { who: 'ai', kind: 'ai', win: 'cli' });
  const index = renderMap(p, {}, {}, new Map(), [], new Map(), 100);
  assert.match(index, /^## prefabs 80個（@名前）: bgm {2}bullet\/\(13\) {2}enemy\/\(61\) {2}explosion {2}se\/\(4\)$/m, '名前が収まらないので、まとめと数');
  assert.match(index, /中身は ages map <dir> 節\/名前（例 prefabs\/enemy）/);
  assert.ok(index.length < before.length + 60, '名前が72個増えても、地図はほとんど増えない');
  // まとめを引く: 大きすぎるまとめは、下のまとめを1行ずつ。まとめが大きくなるほど入れ子が深い（連番は 最初〜最後）
  const enemy = renderMapSection(p, 'prefabs/enemy', {}, 100);
  assert.match(enemy, /^## prefabs\/enemy 61個（/);
  assert.match(enemy, /^@enemy まっすぐ落ちてくる敵 /m);
  assert.match(enemy, /^enemy_wave\/ 60個: enemy_wave_a\/\(30\) {2}enemy_wave_b\/\(30\)$/m);
  assert.match(enemy, /（名前\/ はまとめ。中身は ages map <dir> prefabs\/enemy\/名前）/);
  assert.match(renderMapSection(p, 'prefabs/enemy/enemy_wave', {}, 100), /^enemy_wave_b\/ 30個: enemy_wave_b_0〜enemy_wave_b_29$/m);
  assert.match(renderMapSection(p, 'prefabs/enemy/enemy_wave/enemy_wave_b', {}, 100), /^@enemy_wave_b_29 /m);
  assert.match(renderMapSection(p, 'prefabs/enemy_wave_a', {}, 100), /^@enemy_wave_a_0 /m, '途中を省いても引ける');
  assert.equal(renderMapSection(p, 'prefabs/bullet_kind3', {}, 100).split('\n')[1].slice(0, 14), '@bullet_kind3 ');
  assert.equal(indexDepth(p, {}, 100), 3);
  // 引いたまとめは最近の作業の場所に（次に地図から直接行ける）
  await cmdMap(dir, 'prefabs/enemy');
  assert.deepEqual(Object.keys((await readRecent(dir)).places), ['map:prefabs/enemy']);
  await rm(dir, { recursive: true, force: true });
});

test('最近の作業の場所: 見る・変えるで覚え、目次の地図に上位を出し、ages find の並びに使う。操作の回数で古いものを忘れる', async () => {
  const { cmdFind, cmdGet, cmdMap, cmdPatch } = await import('../src/cli/ages.ts');
  const { readRecent, placeOf, RECENT_WINDOW, RECENT_KEEP, noteRecent, recentFor, topRecent } = await import('../src/project/recent.ts');
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
  const old = await readRecent(dir);
  assert.deepEqual(topRecent(old).map((r) => r.place), ['x'], '地図と ages find では直近の分だけ');
  assert.ok(old.places['@enemy.Health'], '覚えておくのはもっと長い（入れ子の深い目次で使う）');
  assert.deepEqual(topRecent(old, 10, recentFor(3).window).map((r) => r.place), ['@enemy.Health', 'x']);
  for (let i = 0; i < RECENT_KEEP; i++) await noteRecent(dir, i === RECENT_KEEP - 1 ? ['y'] : []);
  assert.deepEqual(Object.keys((await readRecent(dir)).places), ['y']);
  // 入れ子が深いほど多く・長く見せる（深さ1までは今までどおり）
  assert.deepEqual(recentFor(1), { show: 10, window: 50 });
  assert.deepEqual(recentFor(3), { show: 20, window: 150 });
  assert.deepEqual(recentFor(9), { show: 30, window: 200 });
  await rm(dir, { recursive: true, force: true });
});

test('地図の systems の行と ages find に、コードの宣言の場所（ファイル:行）を出す', async () => {
  const { cmdFind, cmdMap } = await import('../src/cli/ages.ts');
  const dir = await shooter();
  assert.match(await cmdMap(dir), /^1 playerControl（game\/systems\.ts:\d+） /m);
  assert.match(await cmdFind(dir, 'Health'), /^部品 Health（game\/components\.ts:\d+） — /m);
  assert.match(await cmdFind(dir, 'spawner'), /^システム \d+ spawner（game\/systems\.ts:\d+） — /m);
  await rm(dir, { recursive: true, force: true });
});
