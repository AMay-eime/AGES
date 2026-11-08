// シェーダー（画像ごとの効果と、画面全体の後処理）。ファイルは関数1つと、調整できる値（uniform）の宣言だけ。
// 値の宣言は行の終わりのコメントで、範囲・既定値・説明を書く。エディタはそこから欄を作り、AI は地図で1行で読める。
//
//   // 白く光らせる
//   uniform float amount; // 0..1 =0 光る強さ
//   uniform vec3 color;   // =#ffffff 光る色
//   vec4 effect(vec4 c, vec2 uv) { return vec4(mix(c.rgb, color, amount), c.a); }
//
// c はその点の色（画像の色 × Sprite の tint・alpha。画面全体なら画面の色）、uv はテクスチャの座標。
// 使えるもの: frameUV(uv)（コマの中の 0〜1。左上が 0）、pick(uv)（その座標の色。コマの外は透明）、
// u_texel（1ピクセルの大きさ）、u_res（描く先の大きさ px）、u_time（秒）
import type { Field, StructField } from './schema.ts';

export interface ShaderDef {
  /** ファイルの場所（標準のものは std:名前） */
  path: string;
  /** 先頭のコメント */
  desc: string;
  /** 調整できる値（宣言の順） */
  uniforms: Record<string, Field>;
  /** uniform の GLSL の型 */
  glsl: Record<string, string>;
  /** ファイルの中身そのまま */
  code: string;
  /** 読めなかったところ（あると使えない） */
  errors: string[];
}

/** シェーダーの中で使う名前（uniform には使えない） */
export const RESERVED = ['effect', 'frameUV', 'pick', 'main'];

const UNIFORM = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([A-Za-z_]\w*)\s*;\s*(?:\/\/\s*(.*))?$/;
const TYPES = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'sampler2D'];
const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)`;

/** シェーダーのファイルを読む（宣言を調べるだけ。コンパイルできるかはエディタで確かめる） */
export function parseShader(path: string, code: string): ShaderDef {
  const def: ShaderDef = { path, desc: '', uniforms: {}, glsl: {}, code, errors: [] };
  const lines = code.split(/\r?\n/);
  const desc: string[] = [];
  let head = true;
  lines.forEach((line, i) => {
    const at = `${path}:${i + 1}`;
    const t = line.trim();
    if (head) {
      if (t.startsWith('//')) { desc.push(t.replace(/^\/\/\s?/, '')); return; }
      if (t) head = false;
    }
    if (!/^\s*uniform\b/.test(line)) return;
    const m = UNIFORM.exec(line);
    if (!m) { def.errors.push(`${at}: uniform は1行に1つ、「uniform 型 名前; // 範囲 =既定値 説明」の形で書きます`); return; }
    const [, type, name, comment = ''] = m;
    if (!TYPES.includes(type)) { def.errors.push(`${at}: uniform の型 ${type} は使えません（使える型: ${TYPES.join(' ')}）`); return; }
    if (name.startsWith('u_') || RESERVED.includes(name)) { def.errors.push(`${at}: ${name} は AGES が使う名前です（u_ で始まる名前・${RESERVED.join('・')} 以外にします）`); return; }
    if (name in def.uniforms) { def.errors.push(`${at}: ${name} が2回宣言されています`); return; }
    const f = fieldOf(type, comment, at, def.errors);
    if (!f) return;
    def.uniforms[name] = f;
    def.glsl[name] = type;
  });
  def.desc = desc.join(' ').trim();
  if (!/\bvec4\s+effect\s*\(\s*(?:in\s+)?vec4\s+\w+\s*,\s*(?:in\s+)?vec2\s+\w+\s*\)/.test(code)) {
    def.errors.push(`${path}: 関数 vec4 effect(vec4 c, vec2 uv) がありません（その点の色 c を受け取って、描く色を返す関数）`);
  }
  if (/\bvoid\s+main\s*\(/.test(code)) def.errors.push(`${path}: main は書きません（AGES が用意します。書くのは effect だけ）`);
  if (/^\s*#version/m.test(code) || /^\s*precision\s/m.test(code)) def.errors.push(`${path}: #version・precision は書きません（AGES が用意します）`);
  return def;
}

/** 行の終わりのコメント（範囲 =既定値 説明）から、値の型を作る */
function fieldOf(type: string, comment: string, at: string, errors: string[]): Field | null {
  let rest = comment.trim();
  let min: number | undefined, max: number | undefined, def: string | undefined;
  const range = new RegExp(`^(${NUM})?\\.\\.(${NUM})?(?:\\s+|$)`).exec(rest);
  if (range) {
    if (range[1] !== undefined) min = Number(range[1]);
    if (range[2] !== undefined) max = Number(range[2]);
    rest = rest.slice(range[0].length);
  }
  const dm = /^=(\S+)(?:\s+|$)/.exec(rest);
  if (dm) { def = dm[1]; rest = rest.slice(dm[0].length); }
  const desc = rest.trim() || undefined;
  const bad = (why: string) => { errors.push(`${at}: ${why}`); return null; };
  switch (type) {
    case 'float':
    case 'int': {
      const d = def === undefined ? (min ?? 0) : Number(def);
      if (!Number.isFinite(d)) return bad(`既定値 =${def} は数ではありません`);
      if (type === 'int' && !Number.isInteger(d)) return bad(`int の既定値 =${def} は整数にします`);
      if ((min !== undefined && d < min) || (max !== undefined && d > max)) return bad(`既定値 ${d} が範囲 ${min ?? ''}..${max ?? ''} の外です`);
      return type === 'int'
        ? { type: 'int', default: d, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(desc ? { desc } : {}) }
        : { type: 'number', default: d, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(min !== undefined && max !== undefined ? { step: (max - min) / 100 } : {}), ...(desc ? { desc } : {}) };
    }
    case 'bool':
      if (def !== undefined && def !== 'true' && def !== 'false') return bad(`bool の既定値は =true か =false です`);
      return { type: 'bool', default: def === 'true', ...(desc ? { desc } : {}) };
    case 'vec2': {
      const v = def === undefined ? [0, 0] : def.split(',').map(Number);
      if (v.length !== 2 || v.some((x) => !Number.isFinite(x))) return bad(`vec2 の既定値は =1,2 の形で書きます`);
      return { type: 'vec2', default: v as [number, number], ...(desc ? { desc } : {}) };
    }
    case 'vec3':
    case 'vec4': {
      // vec3・vec4 は色（vec4 の a は 1）。既定値は #rrggbb
      const d = def ?? '#ffffff';
      if (!/^#[0-9a-fA-F]{6}$/.test(d)) return bad(`${type} は色として扱います。既定値は =#rrggbb で書きます`);
      return { type: 'color', default: d.toLowerCase(), ...(desc ? { desc } : {}) };
    }
    case 'sampler2D':
      return { type: 'asset', kind: 'image', default: def ?? '', ...(desc ? { desc } : {}) };
  }
  return null;
}

/** 調整できる値を、構造体の型にする（住所の解決・検証・エディタの欄に使う） */
export function paramsField(def: ShaderDef): StructField {
  return { type: 'struct', fields: def.uniforms, desc: def.desc };
}

/** 調整できる値の既定値 */
export function paramDefaults(def: ShaderDef): Record<string, unknown> {
  return Object.fromEntries(Object.entries(def.uniforms).map(([k, f]) => [k, structuredClone(f.default)]));
}

/** 描く側で使う、全部入りのフラグメントシェーダー。#line でエラーの行番号がファイルの行と合う */
export function wrapShader(def: ShaderDef): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_color;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_texel;
uniform vec4 u_rect;
uniform float u_time;
out vec4 o_color;
vec2 frameUV(vec2 uv) { return (uv - u_rect.xy) / (u_rect.zw - u_rect.xy); }
vec4 pick(vec2 uv) {
  vec2 lo = min(u_rect.xy, u_rect.zw), hi = max(u_rect.xy, u_rect.zw);
  if (uv.x < lo.x || uv.y < lo.y || uv.x > hi.x || uv.y > hi.y) return vec4(0.0);
  return texture(u_tex, uv) * v_color;
}
#line 1
${def.code}
void main() { o_color = effect(texture(u_tex, v_uv) * v_color, v_uv); }
`;
}

/** 標準のシェーダー（std:名前 で使う。ファイルを置かなくてよい） */
export const STD_SHADER_CODE: Record<string, string> = {
  'std:flash': `// 色を重ねて光らせる（被弾の点滅など。amount を 1→0 にトゥイーンする）
uniform float amount; // 0..1 =0 光る強さ
uniform vec3 color; // =#ffffff 光る色
vec4 effect(vec4 c, vec2 uv) {
  return vec4(mix(c.rgb, color, amount), c.a);
}
`,
  'std:outline': `// 縁取り（画像の透明な所との境目に色を付ける。コマの余白の内側に描く）
uniform float width; // 0..8 =1 太さ（px）
uniform vec3 color; // =#ffffff 縁の色
vec4 effect(vec4 c, vec2 uv) {
  if (c.a > 0.5 || width <= 0.0) return c;
  float a = 0.0;
  for (int i = 0; i < 8; i++) {
    float t = float(i) * 0.7853982;
    a = max(a, pick(uv + vec2(cos(t), sin(t)) * u_texel * width).a);
  }
  return a > 0.5 ? vec4(color, v_color.a) : c;
}
`,
  'std:dissolve': `// 溶けて消える（amount 0 で元のまま、1 で消える。溶ける縁が光る）
uniform float amount; // 0..1 =0 溶けた量
uniform float scale; // 1..64 =12 ムラの細かさ
uniform vec3 edge; // =#ffb02e 溶ける縁の色
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec4 effect(vec4 c, vec2 uv) {
  float n = noise(frameUV(uv) * scale);
  if (n < amount) return vec4(0.0);
  float e = smoothstep(amount + 0.08, amount, n) * step(0.001, amount);
  return vec4(mix(c.rgb, edge, e), c.a);
}
`,
  'std:desaturate': `// 色を抜く（白黒・セピア。画面全体にも使える）
uniform float amount; // 0..1 =1 色を抜く量
uniform vec3 tint; // =#ffffff 抜いた後に掛ける色（セピアなら #f0d9b0）
vec4 effect(vec4 c, vec2 uv) {
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  return vec4(mix(c.rgb, g * tint, amount), c.a);
}
`,
  'std:vignette': `// 画面の端を暗くする（画面全体用）
uniform float amount; // 0..1 =0.4 端の暗さ
uniform float size; // 0..1.5 =0.6 暗くし始める所（中心からの距離）
uniform vec3 color; // =#000000 端の色
vec4 effect(vec4 c, vec2 uv) {
  float d = length(frameUV(uv) - 0.5) * 1.4142;
  float k = smoothstep(size, size + 0.6, d) * amount;
  return vec4(mix(c.rgb, color, k), c.a);
}
`,
  'std:crt': `// ブラウン管ふう（走査線・色のずれ・ちらつき。画面全体用）
uniform float scanline; // 0..1 =0.25 走査線の濃さ
uniform float lines; // 60..1080 =320 走査線の数
uniform float aberration; // 0..4 =1 色のずれ（px）
uniform float flicker; // 0..0.2 =0.02 ちらつき
vec4 effect(vec4 c, vec2 uv) {
  vec2 off = vec2(u_texel.x * aberration, 0.0);
  vec3 col = vec3(pick(uv + off).r, c.g, pick(uv - off).b);
  col *= 1.0 - scanline * (0.5 + 0.5 * sin(frameUV(uv).y * lines * 6.2831853));
  col *= 1.0 - flicker * (0.5 + 0.5 * sin(u_time * 60.0));
  return vec4(col, c.a);
}
`,
};

export const STD_SHADERS: Map<string, ShaderDef> = new Map(Object.entries(STD_SHADER_CODE).map(([k, code]) => [k, parseShader(k, code)]));

/** 標準のものとプロジェクトのものを合わせる */
export function shaderMap(project: Iterable<ShaderDef> = []): Map<string, ShaderDef> {
  const m = new Map(STD_SHADERS);
  for (const d of project) m.set(d.path, d);
  return m;
}

/** 中身の指紋（エディタで確かめたコンパイルの結果を、今の中身と結びつける） */
export function codeHash(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
