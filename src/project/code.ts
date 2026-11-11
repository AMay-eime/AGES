// ages code の答えを作る: 宣言（場所・範囲・中身）、名前や欄を使っている所（どの関数の中か・読むか書くか）、ファイルの目次、コメントからの検索
import { brief } from '../core/schema.ts';
import type { Project } from './project.ts';
import { blockAt, findUses, indexFile, lineOf, lineText, loose, pathName, type CodeBlock, type CodeFile, type CodeUse } from './codeindex.ts';

export interface CodeOptions {
  /** 宣言の中身（行番号つき）も出す */
  body?: boolean;
  /** 使っている所の前後の行数 */
  around?: number;
  /** 使っている所を出す数（既定 30） */
  max?: number;
  /** 名前だけ同じで、別の物らしい所も出す */
  all?: boolean;
}

/** 中身を出す行の上限（超えたら切って、続きの場所を知らせる） */
const BODY_MAX = 200;
const KIND: Record<CodeBlock['kind'], string> = { function: '関数', method: '関数', system: 'システム', component: '部品', table: '表', extension: 'エディタ拡張', class: 'クラス', type: '型', const: '定数' };

export function indexCode(files: [string, string][]): CodeFile[] {
  return files.map(([path, text]) => indexFile(path, text)).sort((a, b) => a.path.localeCompare(b.path));
}

const range = (b: CodeBlock) => (b.endLine > b.line ? `${b.line}-${b.endLine}` : `${b.line}`);

/** 使っている所を、ファイル → 関数 ごとにまとめて書く */
function useLines(uses: { file: CodeFile; line: number; at?: number; how?: string; block?: CodeBlock }[], o: CodeOptions, max: number): string[] {
  const out: string[] = [];
  let file = '', block: CodeBlock | undefined | null = null, n = 0;
  // 同じ行にいくつもあれば1行に（書く > 入れる > 呼ぶ > 読む の順で1つ）
  const order = ['書', '値', '呼', '読', '型'];
  const hows = new Map<string, string>();
  for (const u of uses) {
    const key = `${u.file.path}:${u.line}`, had = hows.get(key);
    if (u.how && (had === undefined || order.indexOf(u.how) < order.indexOf(had))) hows.set(key, u.how);
  }
  const seen = new Set<string>();
  for (const u0 of uses) {
    const key = `${u0.file.path}:${u0.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = { ...u0, how: hows.get(key) ?? u0.how };
    if (n++ >= max) continue;
    if (u.file.path !== file) { file = u.file.path; block = null; out.push(file); }
    if (u.block !== block) { block = u.block; out.push(`  ${block ? `${pathName(block)}(${range(block)})` : '（一番外）'}`); }
    const a = o.around ?? 0;
    if (a > 0) {
      for (let l = Math.max(1, u.line - a); l <= Math.min(u.file.lines.length, u.line + a); l++) out.push(`    ${l}${l === u.line ? `${u.how ? ' ' + u.how : ''}>` : '|'} ${lineText(u.file, l, 140)}`);
    } else out.push(`    ${u.line}${u.how ? ' ' + u.how : ''}  ${lineText(u.file, u.line, 120, u.at)}`);
  }
  if (n > max) out.push(`ほか ${n - max} か所（--max ${Math.min(500, n)} で全部）`);
  return out;
}

/** 宣言の1行と、--body なら中身 */
function defLines(files: CodeFile[], b: CodeBlock, o: CodeOptions): string[] {
  const f = files.find((x) => x.path === b.file)!;
  const out = [`${pathName(b)} — ${KIND[b.kind]}（${b.file}:${range(b)}${b.endLine - b.line >= 3 ? `・${b.endLine - b.line + 1}行` : ''}）${b.doc ? ' ' + b.doc : ''}`];
  if (!o.body) { out.push(`  ${b.head}`); return out; }
  const last = Math.min(b.endLine, b.line + BODY_MAX - 1);
  for (let l = b.line; l <= last; l++) out.push(`${l}| ${f.text.slice(f.lines[l - 1], (f.lines[l] ?? f.text.length + 1) - 1).replace(/\s+$/, '')}`);
  if (last < b.endLine) out.push(`（${BODY_MAX}行で切った。続きは ${b.file} の ${last + 1}〜${b.endLine} 行）`);
  return out;
}

/** ファイルの目次（宣言と行の範囲。小さな入れ子は出さない） */
function outline(f: CodeFile): string[] {
  const out = [`${f.path}（${f.lines.length}行）`];
  const depth = (b: CodeBlock) => { let d = 0; for (let x = b.parent; x; x = x.parent) d++; return d; };
  for (const b of f.blocks) {
    const d = depth(b);
    if (d > 1 || (d === 1 && b.endLine - b.line < 4)) continue;
    out.push(`${'  '.repeat(d + 1)}${range(b)} ${d === 0 ? b.head : b.name}${b.doc ? ` — ${b.doc}` : ''}`);
  }
  return out;
}

/** 欄・列の宣言の行（部品・表の宣言の中の 名前:） */
function fieldLine(files: CodeFile[], kind: 'component' | 'table', owner: string, field: string): string {
  for (const f of files) for (const b of f.blocks) {
    if (b.kind !== kind || b.name !== owner) continue;
    // 行の頭の 名前:（欄の宣言）を先に。image: { kind: 'image' } のような、中の同じ名前を拾わないように
    const body = f.code.slice(b.start, b.end);
    const m = new RegExp(`^[ \\t]*${field}\\s*:`, 'm').exec(body) ?? new RegExp(`(?<![\\w$])${field}\\s*:`).exec(body);
    return `${f.path}:${m ? lineOf(f, b.start + m.index + m[0].length - 1) : b.line}`;
  }
  return '';
}

/**
 * 問い（いくつでも）に答える:
 * - `game/shot.ts`（ファイル）→ 目次
 * - `$表.列`・`部品.欄` → 宣言と、コードで使っている所（その表・部品の名前が近くにある所を先に）
 * - 名前（関数・システム・クラス・型・定数）→ 宣言と、使っている所。`--body` で中身
 * - 日本語の語 → コメントから探す
 */
export function codeQuery(p: Project, files: CodeFile[], queries: string[], o: CodeOptions = {}): string {
  const max = o.max ?? 30;
  const out: string[] = [];
  const allBlocks = files.flatMap((f) => f.blocks);
  // 日本語の語は、まとめて1つの問い（全部を含む行）
  const words = queries.filter((q) => /[^\x00-\x7f]/.test(q) && !/[\\/]|\.(?:ts|js|mjs)$/.test(q));
  queries = [...queries.filter((q) => !words.includes(q)), ...(words.length ? [words.join(' ')] : [])];
  for (const raw of queries) {
    const q = raw.trim();
    if (!q) continue;
    if (out.length) out.push('');
    // ファイルの目次
    if (/[\\/]|\.(?:ts|js|mjs)$/.test(q)) {
      const want = q.replace(/\\/g, '/').replace(/^\.?\/+/, '');
      const hit = files.filter((f) => f.path === want || f.path.endsWith('/' + want));
      if (!hit.length) out.push(`「${q}」というファイルはコード（game/・editor/）にありません${near(files.map((f) => f.path), want)}`);
      for (const f of hit) out.push(...outline(f));
      continue;
    }
    // コメントから探す（日本語の語。空白で区切ると全部を含む行）。宣言の説明（直前のコメント）に含むものを先に
    if (/[^\x00-\x7f]/.test(q)) {
      const ws = q.split(/\s+/).filter(Boolean);
      const has = (text: string) => ws.every((w) => text.includes(w));
      const decls = allBlocks.filter((b) => has(docText(files.find((f) => f.path === b.file)!, b)));
      const hits: { file: CodeFile; line: number; block?: CodeBlock }[] = [];
      for (const f of files) f.lines.forEach((at, i) => {
        const text = f.text.slice(at, f.lines[i + 1] ?? f.text.length);
        if (has(text)) hits.push({ file: f, line: i + 1, block: blockAt(f, at + (/^\s*/.exec(text)?.[0].length ?? 0)) });
      });
      if (!decls.length && !hits.length) { out.push(`「${q}」を含む行はコードにありません（語を減らすか、データの名前・説明から探す ages find）`); continue; }
      if (decls.length) {
        out.push(`「${q}」が説明にある宣言 ${decls.length}`);
        for (const b of decls.slice(0, max)) out.push(`  ${b.file}:${range(b)} ${pathName(b)}${b.doc ? ` — ${b.doc}` : ''}`);
      }
      // 宣言の説明の行は、上に出したので除く
      const rest = hits.filter((h) => !decls.some((b) => b.file === h.file.path && h.line < b.line && h.line >= b.line - 12));
      if (rest.length) {
        out.push(`「${q}」を含む行 ${rest.length}（コメント・文字列）`);
        out.push(...useLines(rest, o, decls.length ? Math.min(max, 12) : max));
      }
      continue;
    }
    // 欄・列
    const tm = /^\$([\w-]+)(?:\.([\w$]+))?$/.exec(q), cm = /^([A-Z][\w$]*)\.([\w$]+)$/.exec(q);
    const table = tm ? p.registry.tables.get(tm[1]) : undefined;
    const comp = cm ? p.registry.components.get(cm[1]) : undefined;
    if (tm && !table) { out.push(`表 $${tm[1]} はありません${near([...p.registry.tables.keys()].map((k) => '$' + k), q)}`); continue; }
    if ((table && tm![2]) || (comp && comp.fields[cm![2]])) {
      const owner = table ? table.name : comp!.name, field = table ? tm![2] : cm![2];
      const def = table ? table.columns[field] : comp!.fields[field];
      if (!def) { out.push(`表 $${owner} に列 ${field} はありません（あるのは ${Object.keys(table!.columns).join(' ')}）`); continue; }
      const at = fieldLine(files, table ? 'table' : 'component', owner, field);
      const rows = table ? p.docs.tables.get(owner)?.rows.length : undefined;
      out.push(`${q} — ${table ? `表 $${owner} の列` : `部品 ${owner} の欄`} ${brief(def)}${at ? `（${at}）` : ''}${def.desc ? ' ' + def.desc : ''}${rows !== undefined ? `。値は data/${owner}.table.json（${rows}行）` : ''}`);
      const others = new Set(Object.keys(table ? table.columns : comp!.fields).filter((k) => k !== field));
      // 選ぶ値（enum）のうち、ほかの表・部品の同じ名前の欄にない値。その値と比べている行は、この欄のもの（e.kind === 'boss'）
      const opts = (d: unknown): string[] => ((d as { type?: string; options?: unknown[] })?.type === 'enum' ? ((d as { options?: unknown[] }).options ?? []).map(String) : []);
      const elsewhere = new Set([
        ...[...p.registry.tables.values()].filter((t) => !(table && t.name === owner)).flatMap((t) => opts(t.columns[field])),
        ...[...p.registry.components.values()].filter((c) => !(comp && c.name === owner)).flatMap((c) => opts(c.fields[field])),
      ]);
      const distinct = opts(def).filter((v) => !elsewhere.has(v) && v.length >= 3);
      const uses = findUses(files, field, true).filter((u) => !inOtherDecl(u, owner));
      // 宣言そのもの（表・部品の宣言の中の 名前:）は除く
      const real = uses.filter((u) => !isDeclOf(u, owner, table ? 'table' : 'component'));
      const rank = new Map(real.map((u) => [u, sureness(u, owner, others, distinct)]));
      const strong = real.filter((u) => rank.get(u) === 2), nearby = real.filter((u) => rank.get(u) === 1), far = real.filter((u) => rank.get(u) === 0);
      const shown = o.all ? [...strong, ...nearby, ...far] : strong.length ? strong : nearby.length ? nearby : far;
      const count = (us: CodeUse[]) => new Set(us.map((u) => `${u.file.path}:${u.line}`)).size;
      const rest = count(real) - count(shown);
      const note = o.all ? '' : strong.length
        ? (rest ? `（${owner} のものと分かる所だけ。名前だけ同じ所がほかに ${rest}: --all で出す）` : '')
        : real.length ? `（${owner} のものと分かる所はなし。${nearby.length ? `同じ関数に ${owner} の名前がある所` : '名前だけ同じ所'}${rest ? `。ほかに ${rest}: --all` : ''}）` : '';
      out.push(`使っている所 ${count(shown)}${note}`);
      out.push(...useLines(shown, o, max));
      continue;
    }
    // 名前（親.名前 も）
    const dot = /^([\w$-]+(?:\.[\w$-]+)*)\.([\w$]+)$/.exec(q);
    let defs = allBlocks.filter((b) => b.name === q || b.alias === q || pathName(b) === q);
    if (!defs.length && dot) defs = allBlocks.filter((b) => b.name === dot[2] && b.parent && (b.parent.name === dot[1] || b.parent.alias === dot[1] || pathName(b.parent) === dot[1]));
    // 親.名前 が見つからなければ、親だけでも（1行に書いたシステムの update など）
    let fallback = false;
    if (!defs.length && dot) { defs = allBlocks.filter((b) => b.name === dot[1] || b.alias === dot[1]); fallback = defs.length > 0; }
    const ident = fallback ? dot![1] : defs.length && dot && !allBlocks.some((b) => b.name === q) ? dot[2] : q;
    if (defs.length > 6) {
      out.push(`${q} という宣言は ${defs.length} か所（親.名前 で絞る。例 ${pathName(defs[0])}）`);
      for (const b of defs.slice(0, 40)) out.push(`  ${b.file}:${range(b)} ${pathName(b)}${b.doc ? ` — ${b.doc}` : ''}`);
      continue;
    }
    for (const b of defs) out.push(...defLines(files, b, o));
    if (!/^[\w$.-]+$/.test(ident)) { if (!defs.length) out.push(`「${q}」はコードにありません`); continue; }
    // 使っている所（親.名前 で絞ったメソッドは、名前が同じ別のものと区別できないので出さない）
    const uses = dot && defs.length && ident !== q ? [] : findUses(files, ident);
    if (uses.length) {
      out.push(`使っている所 ${new Set(uses.map((u) => `${u.file.path}:${u.line}`)).size}`);
      out.push(...useLines(uses, o, max));
    } else if (!defs.length) {
      const like = allBlocks.filter((b) => loose(b.name).includes(loose(q)) || (b.alias && loose(b.alias).includes(loose(q))));
      if (like.length) {
        out.push(`「${q}」という名前はありません。名前に含むもの ${like.length}:`);
        for (const b of like.slice(0, 20)) out.push(`  ${b.file}:${range(b)} ${pathName(b)}${b.doc ? ` — ${b.doc}` : ''}`);
      } else out.push(`「${q}」はコード（game/・editor/）にありません（データの名前・説明から探すのは ages find。欄・列は 部品.欄・$表.列 で）`);
    } else if (defs.length && !(dot && ident !== q)) out.push('使っている所 0（ほかから名前で使われていない）');
  }
  return out.join('\n');
}

/** 表・部品の宣言の中の「名前:」が、その表・部品のものか */
function isDeclOf(u: CodeUse, owner: string, kind: 'table' | 'component'): boolean {
  for (let b = u.block; b; b = b.parent) if (b.kind === kind && b.name === owner) return u.how === '値' || u.how === '型';
  return false;
}
/** 別の表・部品の宣言の中の、同じ名前の欄（使っている所ではない） */
function inOtherDecl(u: CodeUse, owner: string): boolean {
  if (u.how !== '値') return false;
  for (let b = u.block; b; b = b.parent) if (b.kind === 'table' || b.kind === 'component') return b.name !== owner;
  return false;
}

/**
 * その欄が owner（表・部品）のものだと、どれだけ言えるか。型がなくても（Record<string, any> でも）分かるように、形から見る:
 * 2 = 分かる（e.c.部品.欄 のように手前に名前がある・元の変数の宣言に名前がある・同じ変数から読んでいる欄の半分以上（2つ以上）が owner の欄・この欄だけの値と比べている）
 * 1 = 同じ関数の中に owner の名前がある ／ 0 = 名前だけ同じ
 */
function sureness(u: CodeUse, owner: string, others: Set<string>, distinct: string[] = []): 0 | 1 | 2 {
  const f = u.file, key = loose(owner);
  let top = u.block;
  while (top?.parent) top = top.parent;
  const from = top ? top.start : f.lines[Math.max(0, u.line - 9)], to = top ? top.end : f.lines[Math.min(f.lines.length - 1, u.line + 8)];
  const lineAt = f.lines[u.line - 1];
  const before = f.bare.slice(lineAt, u.at);
  // この欄だけの値と比べている（.kind === 'boss'）
  const tail = f.bare.slice(u.at, Math.min(f.lines[u.line] ?? f.bare.length, u.at + 60));
  if (distinct.some((v) => new RegExp(`^[\\w$]+\\s*[!=]==?\\s*['"\`]${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(tail))) return 2;
  // 手前のつながり（e.c.Health. / ctx.table('bullets').get(id). / def.）
  const chain = /((?:[\w$]+|\([^()]*\)|\[[^[\]]*\]|\?\.|\.|!)+?)\s*\??\.\s*$/.exec(before)?.[1] ?? '';
  if (!chain) {
    // { 部品: { 欄: … } }・{ 部品: { 欄 } } の形か、型の名前
    const parent = /([\w$]+)\s*:\s*\{[^{}]*$/.exec(f.bare.slice(Math.max(from, u.at - 200), u.at))?.[1];
    if (parent && loose(parent) === key) return 2;
    if (u.how === '型' && u.block && loose(pathName(u.block)).includes(key)) return 2;
  } else {
    const comp = /\.c\??\.([A-Z][\w$]*)$/.exec(chain)?.[1];
    if (comp) return comp === owner ? 2 : 0;
    if (loose(chain).includes(key)) return 2;
    const root = /^[\w$]+/.exec(chain)?.[0];
    if (root && root !== 'this') {
      const scope = f.bare.slice(from, to), code = f.code.slice(from, to);
      // 元の変数の宣言（const def = bulletOf(…)・引数の p: ShotPattern・for (const p of patterns)）
      const esc = root.replace(/[$]/g, '\\$');
      const decl = [...scope.matchAll(new RegExp(`(?:(?:const|let|var)\\s+${esc}\\b[^;\\n]*|[(,]\\s*${esc}\\s*\\??\\s*:\\s*[^,)=]+)`, 'g'))].map((m) => m[0]).join(' ');
      if (decl && loose(decl.replace(new RegExp(`\\b${esc}\\b`, 'g'), '')).includes(key)) return 2;
      // 同じ変数から読んでいる欄の半分以上（2つ以上）が、owner の欄
      const props = new Set([...code.matchAll(new RegExp(`(?<![\\w$.])${esc}\\s*\\??\\.\\s*([\\w$]+)`, 'g'))].map((m) => m[1]));
      props.delete(u.file.bare.slice(u.at).match(/^[\w$]+/)?.[0] ?? '');
      const hits = [...props].filter((k) => others.has(k)).length;
      if (hits >= 2 && hits * 2 >= props.size) return 2;
    }
  }
  return loose(f.bare.slice(from, to)).includes(key) ? 1 : 0;
}

/** 宣言の直前のコメントの全体（説明から探すとき） */
function docText(f: CodeFile, b: CodeBlock): string {
  let from = b.line - 1;
  while (from >= 1 && b.line - from <= 12) {
    const row = f.text.slice(f.lines[from - 1], f.lines[from]).trim();
    if (!(row.startsWith('//') || row.startsWith('*') || row.startsWith('/*'))) break;
    from--;
  }
  return f.text.slice(f.lines[from], f.lines[b.line - 1]);
}

/** 近い名前を1〜3つ */
function near(names: string[], q: string): string {
  const k = loose(q.replace(/^.*\//, '').replace(/\.\w+$/, ''));
  const like = names.filter((n) => k && loose(n).includes(k)).slice(0, 3);
  return like.length ? `（近いもの: ${like.join(' ')}）` : '';
}
