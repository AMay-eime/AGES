// ages run --watch の [*]・[欄=値] と、--log（出来事の中身をフレームつきで）（issue #125）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdInit, cmdPatch, cmdRun } = await import('../src/cli/ages.ts');

async function project(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'ages-watch-')), 'g');
  await cmdInit(dir, 'g', 'none');
  await writeFile(join(dir, 'game', 'index.ts'), `import { defineComponent, defineSystem, type GameModule } from 'ages';
const Shot = defineComponent({ name: 'Shot', desc: '弾', fields: { kind: { type: 'string', default: 'normal' }, hits: { type: 'int', default: 0 } } });
// 10フレーム目に3発（2つ目だけ pierce）。毎フレーム hits を増やし、pierce は 3 で出来事を出す。20フレーム目に最初の1発を消す
const fire = defineSystem({ name: 'fire', desc: '撃つ', reads: ['Shot'], writes: ['Shot'], update(ctx) {
  if (ctx.frame === 10) for (const kind of ['normal', 'pierce', 'normal']) ctx.spawn('shot', { Shot: { kind } });
  for (const e of ctx.world.query('Shot')) {
    const s = e.c.Shot as { kind: string; hits: number };
    s.hits += s.kind === 'pierce' ? 2 : 1;
    if (s.kind === 'pierce' && s.hits === 6) ctx.emit('pierced', { id: e.id, hits: s.hits });
  }
  if (ctx.frame === 20) { const first = ctx.world.query('Shot')[0]; if (first) ctx.destroy(first.id); }
  if (ctx.frame === 25) ctx.emit('tick');
} });
export const components: GameModule['components'] = [Shot];
export const systems: GameModule['systems'] = [fire];
`);
  await cmdPatch(dir, [{ op: 'addPrefab', name: 'shot', components: { Shot: {} } } as any], false);
  return dir;
}

test('--watch: @プレハブ[*] は全部を ID つきで、[欄=値] は合う最初の1つ、[*欄=値]・[部品.欄!=値] も。ない欄は —', async () => {
  const dir = await project();
  const out = await cmdRun(dir, { frames: '15', watch: '@shot.Shot.hits,@shot[*].Shot.hits,@shot[kind=pierce].Shot.hits,@shot[*Shot.kind!=pierce].Shot.kind,@shot[kind=none].Shot.hits,@shot.Shot.nope', every: '12' });
  assert.match(out, /^watch @shot\.Shot\.hits: — → 5$/m, out);
  assert.match(out, /^watch @shot\[\*\]\.Shot\.hits: — → shot~\d+=5 shot~\d+=10 shot~\d+=5$/m);
  assert.match(out, /^watch @shot\[kind=pierce\]\.Shot\.hits: — → 10$/m);
  assert.match(out, /^watch @shot\[\*Shot\.kind!=pierce\]\.Shot\.kind: — → shot~\d+=normal shot~\d+=normal$/m);
  assert.match(out, /^watch @shot\[kind=none\]\.Shot\.hits: — → —$/m);
  assert.match(out, /^watch @shot\.Shot\.nope: — → —$/m);
  // --every の行にも
  assert.match(out, /^f12 hits=2 hits=shot~\d+=2 shot~\d+=4 shot~\d+=2 hits=4 /m);
  // 消えた物は出なくなる
  const later = await cmdRun(dir, { frames: '22', watch: '@shot[*].Shot.kind' });
  assert.match(later, /^watch @shot\[\*\]\.Shot\.kind: — → shot~\d+=pierce shot~\d+=normal$/m);
  await assert.rejects(cmdRun(dir, { frames: '15', watch: '@shot[kind].Shot.hits' }), /\[kind\] は 欄=値 か 部品\.欄=値/);
});

test('--log: 出来事の中身を、出たフレームごとに1行。* で全部。出なければそう言う', async () => {
  const dir = await project();
  let out = await cmdRun(dir, { frames: '30', log: 'pierced' });
  assert.match(out, /^f12 pierced \{"id":"shot~\d+","hits":6\}$/m, out);
  assert.doesNotMatch(out, /^f\d+ tick/m);
  out = await cmdRun(dir, { frames: '30', log: '*' });
  assert.match(out, /^f12 pierced /m);
  assert.match(out, /^f25 tick$/m);
  out = await cmdRun(dir, { frames: '30', log: 'nope' });
  assert.match(out, /^log: nope は1回も出ませんでした$/m);
});
