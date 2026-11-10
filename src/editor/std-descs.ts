// 本体の標準の部品・表・シェーダーの説明（エディタで見せるもの）。エディタの言葉で訳すため、鍵の一覧をここで作る（test/editor-i18n.test.ts が訳の抜けを見る）。
// ゲームのプロジェクトが書いた説明は、そのプロジェクトの言葉のまま（訳さない）
import { STD_COMPONENTS } from '../std/components.ts';
import { STD_TABLES } from '../std/tables.ts';
import { STD_SHADERS } from '../core/shader.ts';
import type { Field } from '../core/schema.ts';

/** 標準の説明の文（重なりなし） */
export function stdDescs(): string[] {
  const out = new Set<string>();
  const add = (s: string | undefined) => { if (s && /[぀-ヿ一-鿿]/.test(s)) out.add(s); };
  const field = (f: Field) => {
    add(f.desc);
    const x = f as Field & { fields?: Record<string, Field>; of?: Field; variants?: Record<string, { desc?: string; fields?: Record<string, Field> }> };
    for (const sf of Object.values(x.fields ?? {})) field(sf);
    if (x.of) field(x.of);
    for (const v of Object.values(x.variants ?? {})) { add(v.desc); for (const sf of Object.values(v.fields ?? {})) field(sf); }
  };
  for (const c of STD_COMPONENTS) { add(c.desc); for (const f of Object.values(c.fields)) field(f); }
  for (const t of STD_TABLES) { add(t.desc); for (const f of Object.values(t.columns)) field(f); }
  for (const s of STD_SHADERS.values()) { add(s.desc); for (const f of Object.values(s.uniforms)) field(f); }
  return [...out];
}
