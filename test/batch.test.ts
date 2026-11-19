// 効果つきの物も、同じシェーダー・同じ値・同じコマの範囲ならまとめて描く（issue #146）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameMat } from '../src/render/batch.ts';

test('sameMat: 同じシェーダー・同じ値・同じコマの範囲なら、別の物でもまとめる', () => {
  const outline = {}, glow = {};
  const m = (params: Record<string, unknown>, rect = [0, 0, 1, 1], prog: object = outline) => ({ prog, params, rect });
  assert.ok(sameMat(null, null));
  assert.ok(!sameMat(m({}), null), '効果なしとは分ける');
  assert.ok(sameMat(m({ width: 1, color: '#fff' }), m({ width: 1, color: '#fff' })), '同じ値の別の物はまとめる');
  assert.ok(!sameMat(m({ width: 1 }), m({ width: 2 })), '値が1つ違えば分ける');
  assert.ok(!sameMat(m({ width: 1 }), m({ width: 1, color: '#fff' })), '値の数が違えば分ける');
  assert.ok(!sameMat(m({ width: 1 }), m({ other: 1 })), '名前が違えば分ける');
  assert.ok(sameMat(m({ tint: [1, 0.5, 0] }), m({ tint: [1, 0.5, 0] })), '配列の値は中身で比べる');
  assert.ok(!sameMat(m({ tint: [1, 0.5, 0] }), m({ tint: [1, 0.5, 1] })));
  assert.ok(!sameMat(m({}, [0, 0, 0.5, 1]), m({}, [0.5, 0, 1, 1])), 'コマの範囲が違えば分ける（u_rect は uniform）');
  assert.ok(!sameMat(m({}), m({}, undefined, glow)), 'シェーダーが違えば分ける');
});
