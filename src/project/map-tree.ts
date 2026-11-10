// 入れ子の目次（とても大きなプロジェクトの地図）。名前をまとめ（ファイル・名前の頭・親子）の木にし、
// 地図には1段目だけ、中身は ages map <dir> 節/まとめ で1段ずつ引く。プロジェクトが大きくなるほど木が深くなる。
// 地図とは別のファイル（地図の部品に頼らない。テストのため）

/** 木の葉（地図の1行になるもの） */
export interface TreeItem {
  /** 名前（まとめと同じ名前なら、そのまとめの中の先頭に入る） */
  name: string;
  /** まとめの鍵の並び（浅い順） */
  keys: string[];
  /** 引いたときの1行 */
  line: string;
  /** まとめの中に並べるときの短い名前（なければ name） */
  label?: string;
}

/** 木のまとめ（ages map <dir> 節/鍵 で引ける） */
export interface TreeNode {
  key: string;
  /** 葉とまとめを、初めに出てきた順に */
  entries: Array<TreeItem | TreeNode>;
  /** 中の葉の数（下のまとめも含む） */
  n: number;
}

export const isNode = (e: TreeItem | TreeNode): e is TreeNode => 'entries' in e;
const labelOf = (it: TreeItem) => it.label ?? it.name;

/** 葉の並びから木を作る。1つだけのまとめは葉に戻し、中がまとめ1つだけのまとめは下の鍵にする */
export function buildTree(items: TreeItem[]): TreeNode {
  const root: TreeNode = { key: '', entries: [], n: 0 };
  for (const it of items) {
    let node = root;
    for (const k of it.keys) {
      let kid = node.entries.find((e): e is TreeNode => isNode(e) && e.key === k);
      if (!kid) { kid = { key: k, entries: [], n: 0 }; node.entries.push(kid); }
      node = kid;
    }
    node.entries.push(it);
  }
  const t = tidy(root);
  // 全体がまとめ1つだけなら、その中身を1段目に
  while (t.entries.length === 1 && isNode(t.entries[0])) t.entries = t.entries[0].entries;
  return t;
}

function tidy(node: TreeNode): TreeNode {
  // まとめと同じ名前の葉は、そのまとめの先頭に（例 bgm と bgm_battle…）
  for (const it of node.entries.filter((e): e is TreeItem => !isNode(e))) {
    const same = node.entries.find((e): e is TreeNode => isNode(e) && e.key === it.name);
    if (!same) continue;
    // まとめは、葉とまとめの前のほうの場所に
    const at = Math.min(node.entries.indexOf(it), node.entries.indexOf(same));
    node.entries = node.entries.filter((e) => e !== it && e !== same);
    node.entries.splice(at, 0, same);
    same.entries.unshift(it);
  }
  node.entries = node.entries.map((e) => {
    if (!isNode(e)) return e;
    let kid = tidy(e);
    // 中がまとめ1つだけなら、下の鍵にする
    while (kid.entries.length === 1 && isNode(kid.entries[0])) kid = kid.entries[0];
    // 葉が1つだけのまとめは葉に戻す
    return kid.n === 1 ? (leaves(kid)[0]) : kid;
  });
  node.n = node.entries.reduce((s, e) => s + (isNode(e) ? e.n : 1), 0);
  return node;
}

/** 中の葉を並べる順に */
export function leaves(node: TreeNode): TreeItem[] {
  return node.entries.flatMap((e) => (isNode(e) ? leaves(e) : [e]));
}

/**
 * 1段目だけを1行に: 葉は名前、まとめは 鍵/(数)。max 文字を超えるなら、まとめだけにして葉は数（ほか n個）。
 * それでも超えたら …ほか
 */
export function summarize(node: TreeNode, max: number): string {
  const parts = node.entries.map((e) => (isNode(e) ? `${e.key}/(${e.n})` : labelOf(e)));
  const all = parts.join('  ');
  if (all.length <= max) return all;
  const groups = node.entries.filter(isNode);
  const single = node.entries.length - groups.length;
  if (!groups.length || !single) return cut(parts, max);
  // まとめだけを並べ、まとめていない名前は数だけ。並びきらないまとめも数に
  const gs = groups.map((e) => `${e.key}/(${e.n})`);
  let shown = '';
  let k = 0;
  for (; k < gs.length; k++) {
    const next = shown ? `${shown}  ${gs[k]}` : gs[k];
    if (next.length + 20 > max && shown) break;
    shown = next;
  }
  return `${shown}  ほか${k < gs.length ? `まとめ${gs.length - k}・` : ''}名前${single}個`;
}

/** 名前を全部並べる。max 文字に収まるときだけ（収まらなければ null）。連番だけなら 最初〜最後 */
export function allLabels(node: TreeNode, max: number): string | null {
  const ls = leaves(node);
  const range = rangeOf(ls.map((it) => it.name));
  if (range) return range;
  const s = ls.map(labelOf).join(' ');
  return s.length <= max ? s : null;
}

/** 名前がみな同じ頭の、抜けのない連番（5つ以上）なら 最初〜最後（例 star0〜star39） */
export function rangeOf(names: string[]): string | null {
  if (names.length < 5) return null;
  const re = /^(.*?\D)(\d+)$/;
  const ms = names.map((n) => re.exec(n));
  if (ms.some((m) => !m || m[1] !== ms[0]![1])) return null;
  const nums = ms.map((m) => Number(m![2]));
  const lo = Math.min(...nums), hi = Math.max(...nums);
  if (hi - lo + 1 !== new Set(nums).size || nums.length !== new Set(nums).size) return null;
  return `${names[nums.indexOf(lo)]}〜${names[nums.indexOf(hi)]}`;
}

/** 地図の1行: 収まれば名前を全部、収まらなければ1段目（まとめと数） */
export function topLine(node: TreeNode, max: number): string {
  return allLabels(node, max) ?? summarize(node, max);
}

function cut(parts: string[], max: number): string {
  let s = '';
  for (let i = 0; i < parts.length; i++) {
    const next = s ? `${s}  ${parts[i]}` : parts[i];
    if (next.length > max && s) return `${s}  …ほか${parts.length - i}（まとめ・名前）`;
    s = next;
  }
  return s;
}

/**
 * まとめの中身（ages map <dir> 節/鍵）。収まるなら葉の行を全部（下のまとめは ### 鍵 の見出しの下に）、
 * 収まらなければ、このまとめの葉の行と、下のまとめを1行ずつ（名前か、さらに下のまとめと数）
 */
export function treePage(node: TreeNode, budget: number): string[] {
  const all = fullLines(node, '');
  if (all.join('\n').length <= budget) return all;
  return node.entries.map((e) => (isNode(e) ? `${e.key}/ ${e.n}個: ${topLine(e, 200)}` : e.line));
}

function fullLines(node: TreeNode, at: string): string[] {
  const out: string[] = [];
  for (const e of node.entries) {
    if (!isNode(e)) { out.push(e.line); continue; }
    const path = at ? `${at}/${e.key}` : e.key;
    out.push(`### ${path}（${e.n}）`, ...fullLines(e, path));
  }
  return out;
}

/** まとめを鍵の道で探す（途中を省いてもよい: 最後の鍵が木の中で1つだけなら、それ） */
export function findNode(root: TreeNode, path: string[]): TreeNode | TreeItem | undefined {
  let node: TreeNode | TreeItem = root;
  for (const seg of path) {
    if (!isNode(node)) return undefined;
    const kids: Array<TreeNode | TreeItem> = node.entries;
    const hit: TreeNode | TreeItem | undefined = kids.find((e) => isNode(e) && same(e.key, seg)) ?? kids.find((e) => !isNode(e) && e.name === seg) ?? deep(node, seg);
    if (!hit) return undefined;
    node = hit;
  }
  return node;
}

const same = (key: string, seg: string) => key === seg || key === seg + '*';

/** 下のどこかにある、その鍵のまとめ（1つだけのとき）か、その名前の葉 */
function deep(node: TreeNode, seg: string): TreeNode | TreeItem | undefined {
  const nodes: TreeNode[] = [];
  const items: TreeItem[] = [];
  const walk = (n: TreeNode) => {
    for (const e of n.entries) {
      if (isNode(e)) { if (same(e.key, seg)) nodes.push(e); walk(e); } else if (e.name === seg) items.push(e);
    }
  };
  walk(node);
  return nodes.length === 1 ? nodes[0] : !nodes.length && items.length === 1 ? items[0] : undefined;
}

/** 道の鍵の候補（見つからないときに見せる） */
export function keysOf(node: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => { for (const e of n.entries) if (isNode(e)) { out.push(e.key); walk(e); } };
  walk(node);
  return out;
}

/** コードのファイルの場所からまとめの鍵: 共通の頭を除いたフォルダ、ファイル名の頭（- _ . の前）、ファイル名 */
export function fileKeys(file: string, root: string, byPrefix = true): string[] {
  const rel = root && file.startsWith(root) ? file.slice(root.length) : file;
  const segs = rel.split('/').filter(Boolean);
  const name = segs.pop() ?? '';
  const stem = name.split('.')[0];
  if (!byPrefix) return segs;
  const head = stem.split(/[-_]/)[0] || stem;
  return [...segs, head, ...(stem !== head ? [stem] : [])];
}

/** ファイルの場所の共通のフォルダ（末尾に /。ないなら空） */
export function commonDir(files: string[]): string {
  if (!files.length) return '';
  const dirs = files.map((f) => f.split('/').slice(0, -1));
  const first = dirs[0];
  let i = 0;
  while (i < first.length && dirs.every((d) => d[i] === first[i])) i++;
  return i ? first.slice(0, i).join('/') + '/' : '';
}
