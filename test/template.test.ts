// 公式テンプレート: プロジェクトを始めるときに、テンプレートから始めるかを聞く。選ぶと、動く骨組みの入ったプロジェクトができる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdInitPinned, cmdCheck, cmdRun, cmdAssets, cmdMap, TEMPLATES } = await import('../src/cli/ages.ts');
const { makeTools } = await import('../src/mcp/tools.ts');

test('ages init: --template がなければ、作らずにテンプレートの一覧を出す（使うかを使用者に聞く）', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-tpl-')), 'g');
  const out = await cmdInitPinned(dir, 'g');
  assert.match(out, /^テンプレートから始めますか？ 使用者に聞いて、--template を付けてもう一度（まだ何も作っていません）/);
  assert.match(out, /--template none   空から始める/);
  for (const t of TEMPLATES) assert.ok(out.includes(`--template ${t.name}   ${t.desc}`), t.name);
  assert.match(out, /面白さの核・手触り・個性は入っていない/);
  assert.ok(!existsSync(dir), '何も作らない');
  // MCP の ages_init も同じ
  const init = makeTools(dir).find((t) => t.name === 'ages_init')!;
  assert.match(String(await init.run({ dir, name: 'g' }, dir)), /^テンプレートから始めますか？/);
  assert.ok(!existsSync(dir));
  // ない名前
  await assert.rejects(cmdInit(dir, 'g', 'shoter'), /テンプレート shoter はありません（none shooter collect3d）.*shooter/);
  assert.ok(!existsSync(join(dir, 'ages.project.json')));
});

test('ages init --template none: 今までどおり、空のプロジェクト', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-tpl-')), 'g');
  const out = await cmdInitPinned(dir, 'g', false, 'none');
  assert.match(out, /^プロジェクト g を作りました/);
  assert.doesNotMatch(out, /テンプレート/);
  assert.doesNotMatch(await readFile(join(dir, 'EDITOR-PLAN.md'), 'utf8'), /## テンプレート/);
  assert.match(await cmdCheck(dir), /^ok（シーン1 プレハブ0/);
});

for (const t of TEMPLATES) {
  test(`ages init --template ${t.name}: 動く骨組みが入り、名前は新しいプロジェクトのもの。計画書に始め方が書かれる`, async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'ages-tpl-')), 'mygame');
    const out = await cmdInitPinned(dir, 'mygame', false, t.name);
    assert.match(out, /^プロジェクト mygame を作りました/);
    assert.match(out, new RegExp(`（テンプレート ${t.name}: \\d+ ファイル）`));
    assert.match(out, new RegExp(`次: テンプレート ${t.name}（`));
    const cfg = JSON.parse(await readFile(join(dir, 'ages.project.json'), 'utf8'));
    const src = JSON.parse(await readFile(new URL(`../${t.from}/ages.project.json`, import.meta.url), 'utf8'));
    assert.equal(cfg.name, 'mygame');
    assert.deepEqual([cfg.view, cfg.packages, cfg.languages], [src.view, src.packages, src.languages]);
    assert.ok(cfg.engine?.compat, '作ったときの版を残す');
    // そのまま読めて動く。手順書・起動用・型チェックの設定もある
    assert.match(await cmdCheck(dir), /^ok/);
    assert.doesNotMatch(await cmdCheck(dir), /error|出どころが未記入/);
    assert.match(await cmdRun(dir, { frames: '60' }), /^run main seed1 60f/);
    for (const f of ['AGENTS.md', 'tsconfig.json', '.mcp.json', '.gitignore', 'assets.origin.json']) assert.ok(existsSync(join(dir, f)), f);
    // 計画書は空のひな形（質問）に、テンプレートの始め方を足したもの。見本の計画書は写さない
    const plan = await readFile(join(dir, 'EDITOR-PLAN.md'), 'utf8');
    assert.match(plan, /^# エディタ計画書 — mygame/);
    assert.match(plan, new RegExp(`## テンプレート\\n\\nこのプロジェクトは、公式テンプレート \`${t.name}\``));
    assert.doesNotMatch(plan, /サンプル/);
    // 素材の出どころも引き継ぐ（未記入なし）。地図に見本の名前が残らない
    assert.match(await cmdAssets(dir, undefined, { origin: true }), /のうち未記入 0）/);
    const map = await cmdMap(dir);
    assert.match(map, /^⚠ EDITOR-PLAN.md がまだ合意されていません/);
    assert.match(map, /^# mygame /m);
    assert.ok(!existsSync(join(dir, '.ages', 'oplog.jsonl')), '見本の作業の記録は写さない');
  });
}
