// エディタの人と AI のやり取り（ages talk）・AI の変更を確かめた印・行の差分
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const { cmdTalk, cmdPatch, useActiveTask, withTalkNotice, talkArgs } = await import('../src/cli/ages.ts');
const { appendTalk, foldTalk, readTalk, activeTask, TASK_STALE_MS } = await import('../src/project/talk.ts');
const { lineDiff, ackReview, readReview, isAcked, entryKey } = await import('../src/project/review.ts');

async function shooter(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-talk-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('ages talk: 作業を始める・段階・終える。作業中の AI の変更には作業の ID が付く', async () => {
  const dir = await shooter();
  assert.match(await cmdTalk(dir, { task: '敵の体力を調整', steps: ['見る', '変える'], touch: ['@enemy', '@nope'] }), /作業 t\w{4} を始めた: 敵の体力を調整（1\/2 見る）\n⚠ @nope が見つかりません/);
  assert.match(await cmdTalk(dir, { step: 2 }), /2\/2 変える/);
  await assert.rejects(cmdTalk(dir, { step: 3 }), /--step は 1〜2/);
  await useActiveTask(dir);
  await cmdPatch(dir, [{ op: 'set', path: '@enemy.Health.hp', value: 3 }], false);
  const k = activeTask(foldTalk(await readTalk(dir)), 'ai')!;
  const last = JSON.parse((await readFile(join(dir, '.ages', 'oplog.jsonl'), 'utf8')).trim().split('\n').pop()!);
  assert.equal(last.task, k.id);
  // 新しい作業は前の作業を終える
  await cmdTalk(dir, { task: '次の作業' });
  const s = foldTalk(await readTalk(dir));
  assert.ok(s.tasks.find((x) => x.id === k.id)!.done);
  await cmdTalk(dir, { done: '済んだ' });
  assert.equal(activeTask(foldTalk(await readTalk(dir)), 'ai'), undefined);
  await assert.rejects(cmdTalk(dir, { done: true }), /いまの作業がありません/);
  // 長く動きのない作業は「いまの作業」にしない
  const old = foldTalk([{ t: new Date(Date.now() - TASK_STALE_MS - 1000).toISOString(), who: 'ai', kind: 'ai', ev: 'task', id: 'tz', title: '古い' }]);
  assert.equal(activeTask(old, 'ai'), undefined);
});

test('ages talk: 質問と答え・付箋と返事。読んでいない人の書き込みは、ほかの出力の先頭に1行', async () => {
  const dir = await shooter();
  assert.match(await cmdTalk(dir, { ask: '弾の速さは？', choices: ['A', 'B'], about: '@bullet' }), /質問 q\w{4} を出した[\s\S]*答えを待っている質問: q\w{4}「弾の速さは？」/);
  const q = foldTalk(await readTalk(dir)).asks[0];
  assert.deepEqual([q.choices, q.about], [['A', 'B'], '@bullet']);
  assert.equal(await withTalkNotice(dir, 'map', 'OUT'), 'OUT');
  await appendTalk(dir, { who: 'yamamoto', kind: 'human' }, { ev: 'answer', id: q.id, text: 'B' });
  await appendTalk(dir, { who: 'yamamoto', kind: 'human' }, { ev: 'note', id: 'n1', text: 'ボスが硬い', about: '@enemy' });
  assert.equal(await withTalkNotice(dir, 'map', 'OUT'), '📌 エディタの人から: 付箋 1・答え 1（ages talk で読む）\nOUT');
  const view = await cmdTalk(dir, {});
  assert.match(view, /付箋（人から。片付けたら --reply ID "一言"）:\n {2}新 n1 \[@enemy\] ボスが硬い（yamamoto/);
  assert.match(view, /答え:\n {2}q\w{4} 「弾の速さは？」→ B/);
  // 読んだら知らせは消える・付箋は済にするまで残る（「新」は消える）
  assert.equal(await withTalkNotice(dir, 'map', 'OUT'), 'OUT');
  assert.match(await cmdTalk(dir, {}), /^ {2}n1 \[@enemy\]/m);
  await assert.rejects(cmdTalk(dir, { reply: 'n9' }), /付箋 n9 はありません/);
  assert.match(await cmdTalk(dir, { reply: 'n1', text: '体力を半分に' }), /付箋 n1 を済にした\n人からの書き込みはありません/);
  assert.equal(foldTalk(await readTalk(dir)).notes[0].reply?.text, '体力を半分に');
});

test('ages talk の引数: --steps は |、--touch は ,（行列のセルの , では切らない）', () => {
  const a = talkArgs({ task: 'x', steps: 'a | b|c', touch: '@e,main#s.Spawner.formation[2,3], $t.r', done: true }, undefined);
  assert.deepEqual([a.steps, a.touch, a.done], [['a', 'b', 'c'], ['@e', 'main#s.Spawner.formation[2,3]', '$t.r'], true]);
});

test('確かめた印: 1回の編集ごと・すべて。すべての時刻より古いものは捨てる', async () => {
  const dir = await shooter();
  const e1 = { t: '2026-11-11T01:00:00.000Z', path: '@a.B.c', tx: 'x1' }, e2 = { t: '2026-11-11T02:00:00.000Z', path: '@a.B.d' };
  await ackReview(dir, { keys: { [entryKey(e1)]: e1.t } });
  let r = await readReview(dir);
  assert.deepEqual([isAcked(r, entryKey(e1), e1.t), isAcked(r, entryKey(e2), e2.t)], [true, false]);
  await ackReview(dir, { all: '2026-11-11T03:00:00.000Z' });
  r = await readReview(dir);
  assert.deepEqual([isAcked(r, entryKey(e2), e2.t), Object.keys(r.ack).length], [true, 0]);
});

test('行の差分: 足した・消した行と前後2行。離れた同じ行は省く', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l3', 'L3').replace('l15\n', '');
  const d = lineDiff(before, after);
  assert.deepEqual([d.plus, d.minus], [1, 2]);
  assert.equal(d.text, ['@@ 2 行目から', ' l1', ' l2', '-l3', '+L3', ' l4', ' l5', '@@ 14 行目から', ' l13', ' l14', '-l15', ' l16', ' l17'].join('\n'));
  assert.deepEqual([lineDiff('', 'a\nb').plus, lineDiff('a', '').minus], [2, 1]);
});
