// AGES の版と互換の番号: 記録・違いの知らせ・直し方の記録（docs/MIGRATIONS.md）と番号がそろっているか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPAT, engineVersion, migrations, versionNote } from '../src/project/version.ts';
import { cmdInit, cmdVersion, cmdCheck } from '../src/cli/ages.ts';

test('互換の番号: docs/MIGRATIONS.md の項は 1 から順に並び、最後の番号が COMPAT', () => {
  const ms = migrations();
  assert.deepEqual(ms.map((m) => m.n), Array.from({ length: ms.length }, (_, i) => i + 1));
  assert.equal(ms[ms.length - 1].n, COMPAT, 'MIGRATIONS.md に項を足したら src/project/version.ts の COMPAT も上げる（逆も）');
  for (const m of ms) assert.match(m.title, /^\d{4}-\d{2}-\d{2} /, `${m.n} の見出しは「日付 何が変わったか」`);
});

test('互換の番号: 記録がない・同じ・古い・新しいときの知らせ', () => {
  const cur = { compat: 3, version: '0.1.0' };
  assert.match(versionNote(undefined, cur)!, /記録されていません.*--record/);
  assert.equal(versionNote({ compat: 3, version: '0.0.9' }, cur), null, '比べるのは互換の番号だけ');
  assert.match(versionNote({ compat: 5, version: '0.2.0' }, cur)!, /新しい AGES（互換5）.*本体を上げる/);
  const older = versionNote({ compat: 0, version: '0.1.0' }, { compat: 1, version: '0.1.0' })!;
  assert.match(older, /互換0 → 1.*ages version <dir>: 1\. 2026-11-10 記録の始まり/);
});

test('ages init は今の版を残し、ages version で見られる。記録が古ければ直し方を出し、--record で今に合わせる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-ver-'));
  try {
    const target = join(dir, 'g');
    assert.match(await cmdInit(target), new RegExp(`AGES 互換${COMPAT}・`));
    const cfg = JSON.parse(await readFile(join(target, 'ages.project.json'), 'utf8'));
    assert.equal(cfg.engine.compat, COMPAT);
    assert.equal(cfg.engine.version, engineVersion().version);
    assert.match(cfg.engine.recorded, /^\d{4}-\d{2}-\d{2}$/);
    assert.doesNotMatch(await cmdCheck(target), /互換/, '同じ番号なら check に出さない');
    // 古い記録にする
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(target, 'ages.project.json'), JSON.stringify({ ...cfg, engine: { compat: 0, version: '0.0.1' } }));
    assert.match(await cmdCheck(target), /AGES が新しくなっています（互換0 → /);
    const v = await cmdVersion(target, false);
    assert.match(v, /直すこと（互換0 → /);
    assert.match(v, /## 1\. 2026-11-10 記録の始まり/);
    assert.match(await cmdVersion(target, true), /記録しました/);
    assert.doesNotMatch(await cmdCheck(target), /互換/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
