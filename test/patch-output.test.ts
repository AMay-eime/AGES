// ages patch の出力: 長い値は短く（#159）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortPair } from '../src/cli/ages.ts';

test('patch の出力: 長い配列は件数と増減、長い文字は頭だけ。--full なら全部', () => {
  const a = Array.from({ length: 30 }, (_, i) => ({ x: i, y: i * 2 }));
  const b = [...a, ...Array.from({ length: 5 }, (_, i) => ({ x: 100 + i, y: 0 }))];
  assert.deepEqual(shortPair(a, b), ['[30件]', '[35件]（+5）']);
  const c = a.map((v, i) => (i < 3 ? { ...v, y: -1 } : v));
  assert.deepEqual(shortPair(a, c), ['[30件]', '[30件]（3件が変わった）']);
  const s = 'あ'.repeat(200);
  assert.match(shortPair(s, 'い')[0], /^あ{40}…（200字）$/);
  assert.equal(shortPair(s, 'い')[1], 'い');
  assert.deepEqual(shortPair(1, 2), ['1', '2']);
  assert.equal(shortPair(a, b, true)[1], JSON.stringify(b));
});

test('patch の出力: 無かった値（undefined）でも落ちない', () => {
  assert.deepEqual(shortPair(undefined, 1), ['undefined', '1']);
});
