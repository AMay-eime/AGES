// エディタの言葉: すべての文に、すべての言語の訳があるか（抜け・使っていない訳・差し込みの数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EDITOR_LANGS, pickLang, translate, type Dict } from '../src/editor/i18n.ts';
import { trFor } from '../src/editor/i18n-node.ts';
import { stdDescs } from '../src/editor/std-descs.ts';

const EDITOR = new URL('../src/editor', import.meta.url).pathname;

/** エディタの文の鍵: ブラウザ側の T('...')・サーバー側の tr('...')・HTML の data-t="..." */
function editorKeys(): Map<string, string> {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) { if (e !== 'locales') walk(f); }
      else if (/\.(ts|html)$/.test(f) && !/i18n(-node)?\.ts$/.test(f)) files.push(f);
    }
  };
  walk(EDITOR);
  const keys = new Map<string, string>();
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\b(?:T|tr)\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const k = JSON.parse('"' + m[1].replace(/\\'/g, "'").replace(/"/g, '\\"') + '"') as string;
      if (!keys.has(k)) keys.set(k, f.slice(EDITOR.length + 1));
    }
    for (const m of s.matchAll(/data-t(?:-title)?="([^"]*)"/g)) if (!keys.has(m[1])) keys.set(m[1], f.slice(EDITOR.length + 1));
  }
  return keys;
}

const placeholders = (s: string) => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort().join(',');

test('エディタの言葉: すべての文に、すべての言語の訳がある（新しい文を足したら locales にも足す）', async () => {
  const keys = editorKeys();
  assert.ok(keys.size > 600, `文が少なすぎる: ${keys.size}`);
  // 本体の標準の部品・表・シェーダーの説明も（エディタで見せるので）
  for (const d of stdDescs()) if (!keys.has(d)) keys.set(d, 'std（部品・表・シェーダーの説明）');
  for (const lang of EDITOR_LANGS.filter((l) => l !== 'ja')) {
    const dict = (await import(`../src/editor/locales/${lang}.ts`)).default as Dict;
    const missing = [...keys.keys()].filter((k) => !(k in dict));
    assert.deepEqual(missing.map((k) => `${keys.get(k)}: ${k}`), [], `${lang} に訳がない`);
    const unused = Object.keys(dict).filter((k) => !keys.has(k));
    assert.deepEqual(unused, [], `${lang} に使っていない訳（文を消したら訳も消す）`);
    for (const [k, v] of Object.entries(dict)) assert.equal(placeholders(v), placeholders(k), `${lang}: 差し込みの数が違う: ${k} → ${v}`);
    // 繁体字に簡体字が混ざっていない（よく出る字）
    if (lang === 'zh-Hant') for (const [k, v] of Object.entries(dict)) assert.doesNotMatch(v, /[这个们时说对会过还进没里么点开关问间无实现见经头动应样从体机号当长让认设话该门车东边灵线风气区发细终]/, `繁体字に簡体字: ${k} → ${v}`);
    // 日本語のかなが残っていない（訳し忘れ。中国語には かな を使わない）
    for (const [k, v] of Object.entries(dict)) assert.doesNotMatch(v, /[\u3040-\u30fa\u30fc-\u30ff]/, `${lang}: かなが残っている: ${k} → ${v}`);
  }
});

test('言語の選び方と、訳の差し込み', () => {
  assert.equal(pickLang(['ja-JP']), 'ja');
  assert.equal(pickLang(['zh-TW']), 'zh-Hant');
  assert.equal(pickLang(['zh-Hant-HK']), 'zh-Hant');
  assert.equal(pickLang(['zh-CN']), 'zh-Hans');
  assert.equal(pickLang(['de-AT', 'en']), 'de');
  assert.equal(pickLang(['fr-CA']), 'fr');
  assert.equal(pickLang(['ko-KR', 'es']), 'en', '知らない言語は英語');
  assert.equal(pickLang([]), 'en');
  assert.equal(translate([{ 'a{0}b{1}': 'X{1}Y{0}' }], 'a{0}b{1}', [1, 2]), 'X2Y1', '言葉の順が違っても差し込める');
  assert.equal(translate([undefined, { k: 'en' }], 'k', []), 'en', 'ない言語は英語へ');
  assert.equal(translate([], 'そのまま{0}', ['!']), 'そのまま!', '訳がなければ日本語のまま');
  assert.equal(trFor('fr')('保存する'), 'Enregistrer');
  assert.equal(trFor('xx')('保存する'), '保存する');
});
