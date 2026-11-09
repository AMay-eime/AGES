// ゲーム独自の検証（defineCheck）: ages check とエディタの ⚠ に出る。編集は止めない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, defineCheck } from '../src/core/registry.ts';
import { cmdCheck } from '../src/cli/ages.ts';
import { Project } from '../src/project/project.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

test('defineCheck: ages check に ⚠ で出て、編集は止めない。途中のエラーも知らせる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  const idx = join(dir, 'game/index.ts');
  await writeFile(idx, (await readFile(idx, 'utf8')).replace("import type { GameModule } from 'ages';", "import { defineCheck, type GameModule } from 'ages';") + `
export const checks: GameModule['checks'] = [
  defineCheck({ name: 'hp', desc: '敵の体力は 5 以下', run: (v) => v.prefabs().filter((p) => (p.components.Health?.hp ?? 0) > 5).map((p) => \`@\${p.name}.Health.hp: 体力が 5 より多い\`) }),
  defineCheck({ name: 'broken', desc: '壊れた検証', run: () => { throw new Error('わざと'); } }),
];
`);
  const p = await Project.load(dir);
  assert.deepEqual(p.projectChecks().filter((m) => m.startsWith('hp')), []);
  // 体力を 9 にしても編集は止まらず、ages check に ⚠ で出る
  await p.apply([{ op: 'set', path: '@enemy.Health.hp', value: 9 }], ai);
  const out = await cmdCheck(dir);
  assert.match(out, /^ok/);
  assert.match(out, /⚠ hp: @enemy\.Health\.hp: 体力が 5 より多い/);
  assert.match(out, /⚠ broken: 確かめの途中でエラー: わざと/);
  assert.throws(() => Registry.from({ components: [], systems: [], checks: [defineCheck({ name: 'a', desc: '', run: () => [] }), defineCheck({ name: 'a', desc: '', run: () => [] })] }), /検証 a が2回定義されています/);
});
