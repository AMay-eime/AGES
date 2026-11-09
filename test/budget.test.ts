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
