// コードを引く（ages code）。ゲームのコード（game/・editor/）から、宣言（関数・システム・クラス・型・定数）の場所と範囲、
// 名前を使っている所（どの関数の中か・読むか書くか）を出す。AI がファイルを丸ごと読まずに、要る所だけを開けるようにする。
// TypeScript のパーサーは使わない（本体は依存ゼロ）。文字列・コメントを伏せてから、かっこの対応と決まった形で見つける。
// 形が珍しい書き方は拾えないことがある（そのときは普通に検索する）。

export type BlockKind = 'function' | 'method' | 'system' | 'component' | 'table' | 'extension' | 'class' | 'type' | 'const';

export interface CodeBlock {
  file: string;
  /** 呼び名（システム・部品・表は name: に書いた名前） */
  name: string;
  /** 変数の名前（const enemyAI = defineSystem({ name: 'enemy.ai' }) の enemyAI） */
  alias?: string;
  kind: BlockKind;
  /** 文字の位置（始まり・終わりの次） */
  start: number;
  end: number;
  /** 行（1から。始まり・終わり） */
  line: number;
  endLine: number;
  /** 宣言の1行（短く） */
  head: string;
  /** 直前のコメントの1行 */
  doc: string;
  parent?: CodeBlock;
}

export interface CodeFile {
  path: string;
  text: string;
  /** 文字列・コメント・正規表現の中身を空白にしたもの（かっこの対応・形を見る） */
  code: string;
  /** コメントだけを空白にしたもの（名前を探す。文字列の中の名前は見たい） */
  bare: string;
  /** 各行の始まりの位置 */
  lines: number[];
  blocks: CodeBlock[];
}

const ID = '[A-Za-z_$][\\w$]*';
const isId = (c: string | undefined) => !!c && /[\w$]/.test(c);
/** この語の後ろの / は、割り算ではなく正規表現の始まり */
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'await', 'yield', 'else', 'do', 'try', 'throw', 'delete', 'void', 'super', 'import', 'export', 'const', 'let', 'var', 'with']);

/** 文字列・コメント・正規表現の中身を空白にする（長さと改行はそのまま） */
export function maskCode(text: string): { code: string; bare: string } {
  const code = text.split(''), bare = text.split('');
  const n = text.length;
  const blank = (arr: string[], a: number, b: number) => { for (let i = a; i < b && i < n; i++) if (arr[i] !== '\n') arr[i] = ' '; };
  // テンプレート文字列の ${ } の中はコードなので、入れ子を覚えておく
  const tmpl: number[] = [];
  let depth = 0;
  let i = 0;
  /** テンプレート文字列の文字の部分を、i から伏せる（` か ${ まで）。戻り値は次に見る位置 */
  const template = (from: number): number => {
    let j = from;
    while (j < n) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '`') { blank(code, from, j); return j + 1; }
      if (text[j] === '$' && text[j + 1] === '{') { blank(code, from, j); tmpl.push(depth); depth++; return j + 2; }
      j++;
    }
    blank(code, from, n);
    return n;
  };
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      blank(code, i, j); blank(bare, i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(code, i, j); blank(bare, i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(code, i + 1, j);
      i = j + 1;
    } else if (c === '`') {
      i = template(i + 1);
    } else if (c === '/') {
      // 正規表現か割り算か: 前の意味のある文字で決める
      let k = i - 1;
      while (k >= 0 && (code[k] === ' ' || code[k] === '\t' || code[k] === '\n' || code[k] === '\r')) k--;
      let regex = k < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(code[k]);
      if (!regex && isId(code[k])) {
        let s = k;
        while (s > 0 && isId(code[s - 1])) s--;
        regex = REGEX_AFTER.has(code.slice(s, k + 1).join(''));
      }
      if (!regex) { i++; continue; }
      let j = i + 1, cls = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') cls = true;
        else if (text[j] === ']') cls = false;
        else if (text[j] === '/' && !cls) break;
        j++;
      }
      blank(code, i + 1, j);
      i = j + 1;
    } else if (c === '{') {
      depth++; i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (tmpl.length && depth === tmpl[tmpl.length - 1]) { tmpl.pop(); i = template(i); }
    } else i++;
  }
  return { code: code.join(''), bare: bare.join('') };
}

const OPEN = '([{', CLOSE = ')]}';
/** 開きかっこ（i の位置）に対応する閉じかっこの位置（なければ -1） */
function matchClose(code: string, i: number): number {
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && --depth === 0) return j;
  }
  return -1;
}

/** 文の終わり（i から。; か、外側の閉じかっこか、次の文の始まりの前）。戻り値は終わりの次の位置 */
function statementEnd(code: string, i: number): number {
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) { if (--depth < 0) return j; }
    else if (c === ';' && depth === 0) return j + 1;
    else if (c === '\n' && depth === 0 && /^\s*(?:const|let|var|function|export|class|interface|type|import|if|for|while|return|async|enum)\b/.test(code.slice(j + 1, j + 40))) return j;
  }
  return code.length;
}

/** 引数の閉じかっこ（close）の後ろから、本体の { を探す（戻り値の型は飛ばす）。なければ -1 */
function bodyAfter(code: string, close: number): number {
  let j = close + 1;
  for (let guard = 0; guard < 4; guard++) {
    const open = code.indexOf('{', j);
    if (open < 0) return -1;
    const between = code.slice(j, open);
    // 戻り値の型が { } で始まる（): { x: number } {）ときは、その型を飛ばす
    if (/^\s*:\s*$/.test(between) || /[|&]\s*$/.test(between)) { const e = matchClose(code, open); if (e < 0) return -1; j = e + 1; continue; }
    return /^\s*(?::[^;={}]*)?\s*$/.test(between) ? open : -1;
  }
  return -1;
}

/** = や : の後ろ（i）が関数なら、その範囲の終わりの次の位置（関数でなければ -1） */
function functionValueEnd(code: string, i: number): number {
  const rest = code.slice(i, i + 400);
  let m = /^\s*(?:async\s+)?/.exec(rest)!;
  let j = i + m[0].length;
  if ((m = /^function\b\s*\*?\s*[\w$]*\s*(?:<[^>(]*>)?\s*\(/.exec(code.slice(j, j + 200))!)) {
    const close = matchClose(code, j + m[0].length - 1);
    const body = close < 0 ? -1 : bodyAfter(code, close);
    const end = body < 0 ? -1 : matchClose(code, body);
    return end < 0 ? -1 : end + 1;
  }
  // 矢印の関数: (a, b) => … / a => … / <T>(a) => …
  const g = /^<[^>(]*>\s*/.exec(code.slice(j, j + 120));
  if (g) j += g[0].length;
  let after: number;
  if (code[j] === '(') {
    const close = matchClose(code, j);
    if (close < 0) return -1;
    const arrow = /^\s*(?::[^=;{]*?)?\s*=>/.exec(code.slice(close + 1, close + 200));
    if (!arrow) return -1;
    after = close + 1 + arrow[0].length;
  } else {
    const one = new RegExp(`^${ID}\\s*=>`).exec(code.slice(j, j + 80));
    if (!one) return -1;
    after = j + one[0].length;
  }
  const sp = /^\s*/.exec(code.slice(after, after + 200))![0].length;
  if (code[after + sp] === '{') { const end = matchClose(code, after + sp); return end < 0 ? -1 : end + 1; }
  return statementEnd(code, after);
}

/** 1つのファイルを読む（宣言の場所と範囲） */
export function indexFile(path: string, text: string): CodeFile {
  const { code, bare } = maskCode(text);
  const lines = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
  const file: CodeFile = { path: path.replace(/^\/+/, ''), text, code, bare, lines, blocks: [] };
  const seen = new Set<string>();
  const lineStart = (i: number) => lines[lineOf(file, i) - 1];
  const add = (name: string, kind: BlockKind, start: number, end: number, alias?: string) => {
    if (end <= start || !name) return;
    // 文の頭（export・async・const など）から
    const ls = lineStart(start);
    if (/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*)?(?:async\s+)?$/.test(code.slice(ls, start))) start = ls + /^\s*/.exec(code.slice(ls, start))![0].length;
    const key = `${start}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const line = lineOf(file, start), endLine = lineOf(file, Math.max(start, end - 1));
    file.blocks.push({ file: file.path, name, kind, start, end, line, endLine, head: headOf(text, start, end), doc: docAbove(file, line), ...(alias && alias !== name ? { alias } : {}) });
  };

  // defineSystem({ name: '…' }) など（名前は name: の値）
  for (const m of code.matchAll(/\bdefine(System|Component|Table|Extension)\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1, close = matchClose(code, open);
    if (close < 0) continue;
    const named = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(text.slice(open, Math.min(close, open + 400)));
    const before = new RegExp(`(?:const|let|var)\\s+(${ID})\\s*(?::[^=]*)?=\\s*$`).exec(code.slice(Math.max(0, m.index - 120), m.index));
    const name = named?.[1] ?? before?.[1] ?? '';
    const end = code[close + 1] === ')' ? close + 2 : close + 1;
    add(name, m[1].toLowerCase() as BlockKind, before ? m.index - before[0].length : m.index, end, before?.[1]);
  }
  // function 名前(…) { … }
  for (const m of code.matchAll(new RegExp(`\\bfunction\\s*\\*?\\s*(${ID})\\s*(?:<[^>(]*>)?\\s*\\(`, 'g'))) {
    const close = matchClose(code, m.index + m[0].length - 1);
    const body = close < 0 ? -1 : bodyAfter(code, close);
    const end = body < 0 ? -1 : matchClose(code, body);
    if (end >= 0) add(m[1], 'function', m.index, end + 1);
  }
  // const 名前 = (…) => … / function (…) { … }。関数でない一番外の const は定数
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=;]+?)?\\s*=(?!=|>)`, 'g'))) {
    const at = m.index + m[0].length;
    if (/^\s*define(?:System|Component|Table|Extension)\s*\(\s*\{/.test(code.slice(at, at + 60))) continue;
    const end = functionValueEnd(code, at);
    if (end >= 0) add(m[1], 'function', m.index, end);
    else if (depthAt(code, m.index) === 0) add(m[1], 'const', m.index, statementEnd(code, at));
  }
  // class 名前 { … }
  for (const m of code.matchAll(new RegExp(`\\bclass\\s+(${ID})[^{;]*\\{`, 'g'))) {
    const end = matchClose(code, m.index + m[0].length - 1);
    if (end >= 0) add(m[1], 'class', m.index, end + 1);
  }
  // 行の頭の 名前(…) { … }（クラスのメソッド・オブジェクトの中の関数。システムの update など）
  for (const m of code.matchAll(new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|readonly|async|override|get|set)\\s+)*\\*?\\s*(${ID})\\s*(?:<[^>(]*>)?\\(`, 'gm'))) {
    if (NOT_METHOD.has(m[1])) continue;
    const close = matchClose(code, m.index + m[0].length - 1);
    const body = close < 0 ? -1 : bodyAfter(code, close);
    const end = body < 0 ? -1 : matchClose(code, body);
    if (end >= 0) add(m[1], 'method', m.index + /^[ \t]*/.exec(m[0])![0].length, end + 1);
  }
  // 行の頭の 名前: (…) => … / 名前: function (…) { … }
  for (const m of code.matchAll(new RegExp(`^[ \\t]*(${ID})\\s*:(?=\\s*(?:async\\s+)?(?:function\\b|\\(|<|${ID}\\s*=>))`, 'gm'))) {
    const end = functionValueEnd(code, m.index + m[0].length);
    if (end >= 0) add(m[1], 'method', m.index + /^[ \t]*/.exec(m[0])![0].length, end);
  }
  // interface・type・enum
  for (const m of code.matchAll(new RegExp(`^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(interface|type|enum)\\s+(${ID})`, 'gm'))) {
    const at = m.index + m[0].length;
    let end: number;
    if (m[1] === 'type') end = statementEnd(code, at);
    else { const open = code.indexOf('{', at); end = open < 0 ? -1 : matchClose(code, open) + 1; }
    if (end > 0) add(m[2], 'type', m.index + /^[ \t]*/.exec(m[0])![0].length, end);
  }

  // 親（自分を含む、いちばん小さい宣言）
  file.blocks.sort((a, b) => a.start - b.start || b.end - a.end);
  const stack: CodeBlock[] = [];
  for (const b of file.blocks) {
    while (stack.length && stack[stack.length - 1].end <= b.start) stack.pop();
    if (stack.length) b.parent = stack[stack.length - 1];
    stack.push(b);
  }
  return file;
}

/** その位置までの { } の深さ（一番外なら 0） */
function depthAt(code: string, i: number): number {
  let depth = 0;
  for (let j = 0; j < i; j++) { const c = code[j]; if (c === '{') depth++; else if (c === '}') depth--; }
  return depth;
}

/** 位置 → 行（1から） */
export function lineOf(f: { lines: number[] }, i: number): number {
  let lo = 0, hi = f.lines.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f.lines[mid] <= i) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

const squeeze = (s: string, max: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max) + '…' : t; };

/** 宣言の1行（本体の { の前まで。長ければ切る） */
function headOf(text: string, start: number, end: number): string {
  const first = text.slice(start, Math.min(end, start + 300));
  const nl = first.indexOf('\n');
  return squeeze((nl < 0 ? first : first.slice(0, nl)).replace(/\s*\{\s*$/, ''), 110);
}

/** 直前のコメントの1行（/** … *\/ の最初の文か、// の行） */
function docAbove(f: CodeFile, line: number): string {
  if (line < 2) return '';
  const row = (n: number) => f.text.slice(f.lines[n - 1], f.lines[n] ?? f.text.length).trim();
  const prev = row(line - 1);
  if (prev.startsWith('//')) return squeeze(prev.replace(/^\/\/+\s*/, ''), 70);
  if (!prev.endsWith('*/')) return '';
  for (let n = line - 1; n >= 1 && n > line - 30; n--) {
    const r = row(n);
    if (r.startsWith('/*')) {
      for (let k = n; k < line; k++) { const t = row(k).replace(/^\/\*+\s*|\s*\*+\/$|^\*\s?/g, '').trim(); if (t) return squeeze(t, 70); }
      return '';
    }
  }
  return '';
}

/** 位置を含む、いちばん内側の宣言 */
export function blockAt(f: CodeFile, i: number): CodeBlock | undefined {
  let best: CodeBlock | undefined;
  for (const b of f.blocks) {
    if (b.start > i) break;
    if (i < b.end) best = b;
  }
  return best;
}

/** 宣言の呼び名（外側.内側。システムの update なら enemyAI.update） */
export function pathName(b: CodeBlock): string {
  let top = b;
  while (top.parent) top = top.parent;
  return top === b ? b.name : `${top.name}.${b.name}`;
}

export interface CodeUse {
  file: CodeFile;
  at: number;
  line: number;
  /** 読 = 読む / 書 = 代入 / 値 = { 名前: … } で入れる / 呼 = 呼ぶ / 型 = 型の宣言の中 */
  how: '読' | '書' | '値' | '呼' | '型';
  block?: CodeBlock;
}

/** 名前を使っている所。field は欄・列として（.名前・{ 名前 }・名前: …・'名前'）だけを拾う */
export function findUses(files: CodeFile[], ident: string, field = false): CodeUse[] {
  const out: CodeUse[] = [];
  const re = new RegExp(`(?<![\\w$])${ident.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
  for (const f of files) {
    for (const m of f.bare.matchAll(re)) {
      const at = m.index, endAt = at + ident.length;
      const inString = f.code[at] === ' ';
      const before = f.code.slice(Math.max(0, at - 40), at), after = f.code.slice(endAt, endAt + 40);
      const prev = /(\S)\s*$/.exec(before)?.[1] ?? '', next = /^\s*(\S)/.exec(after)?.[1] ?? '';
      const block = blockAt(f, at);
      if (!block && /^\s*(?:import|export)\b[^=]*$/.test(f.code.slice(f.lines[lineOf(f, at) - 1], at))) continue;
      const dotted = prev === '.' && !/\.\.\.\s*$/.test(before);
      const key = next === ':' && !/^\s*::/.test(after) && (prev === '{' || prev === ',' || prev === '' || prev === ';' || /(?:^|\n)\s*$/.test(before) || prev === '?');
      const shorthand = (prev === '{' || prev === ',') && (next === ',' || next === '}' || next === '=');
      // 文字列の中は、文字列がその名前だけのとき（row['speed']・cols: ['speed']）。説明の文の中の語は拾わない
      const quoted = inString && /['"`]/.test(f.bare[at - 1] ?? '') && f.bare[endAt] === f.bare[at - 1];
      if (field && (inString ? !quoted : !dotted && !key && !shorthand)) continue;
      // 自分の宣言そのもの（function 名前・const 名前 =・名前(…) {・name: '名前'）は使っている所ではない
      if (!field && block && (block.name === ident || block.alias === ident)) {
        const head = block.start + Math.max(0, f.code.slice(block.start, block.end).search(/[(={]/));
        if (at < head || (inString && /\bname\s*:\s*['"`]$/.test(f.bare.slice(Math.max(0, at - 30), at)))) continue;
      }
      let how: CodeUse['how'] = '読';
      if (inString) how = '読';
      else if (/^\s*(?:=(?![=>])|\+=|-=|\*=|\/=|%=|\?\?=|\|\|=|&&=|\+\+|--)/.test(after) && (dotted || !key)) how = '書';
      else if (key) how = typeBlock(block) ? '型' : '値';
      else if (next === '(' && !field) how = '呼';
      out.push({ file: f, at, line: lineOf(f, at), how, block });
    }
  }
  return out;
}

/** 型の宣言（interface・type）の中か */
function typeBlock(b: CodeBlock | undefined): boolean {
  for (let x = b; x; x = x.parent) if (x.kind === 'type') return true;
  return false;
}

/** 比べるための形（小文字・記号なし・終わりの s なし）。shot_patterns と ShotPattern を同じに見る */
export const loose = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

/** 行の中身（前後の空白なし・長ければ切る）。at（文字の位置）を渡すと、長い行はその前後を出す（使っている所が切れないように） */
export function lineText(f: CodeFile, line: number, max = 120, at?: number): string {
  const start = f.lines[line - 1], raw = f.text.slice(start, (f.lines[line] ?? f.text.length + 1) - 1);
  const lead = /^\s*/.exec(raw)![0].length, text = raw.slice(lead).replace(/\s+$/, '');
  if (text.length <= max || at === undefined) return squeeze(text, max);
  const col = Math.max(0, at - start - lead);
  if (col < max - 30) return squeeze(text, max);
  const from = Math.max(0, Math.min(text.length - max, col - Math.floor(max * 0.6)));
  return `${from > 0 ? '…' : ''}${text.slice(from, from + max).replace(/\s+/g, ' ')}${from + max < text.length ? '…' : ''}`;
}
