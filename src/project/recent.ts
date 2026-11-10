// 最近の作業の場所（.ages/recent.json。Git で共有しない）。
// 作業の場所は偏るので、AI が最近 探した・見た・変えた所を覚えておき、目次の地図に上位だけを出し、ages find の並びに使う。
// 古さは日付ではなく操作の回数で決める（しばらく触らなかったプロジェクトに戻っても消えない。作業が進んだ分だけ古くなる）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** この回数の操作のあいだ一度も出てこなかった場所は、地図と ages find では使わない（入れ子の深い目次では長くする: recentFor） */
export const RECENT_WINDOW = 50;
/** 目次の地図に出す数（入れ子の深い目次では増やす: recentFor） */
export const RECENT_SHOW = 10;
/** 覚えておく長さ（操作の回数）。これより古いものは忘れる */
export const RECENT_KEEP = 200;

/**
 * 目次の入れ子の深さに合わせた、見せる数と長さ。深いほど1回引く手間が増えるので、最近の場所を多く・長く見せて引く回数を減らす。
 * 深さ1までは今までどおり（10か所・50回）、1段深いごとに +5か所・+50回（上限 30か所・RECENT_KEEP）
 */
export function recentFor(depth: number): { show: number; window: number } {
  const extra = Math.max(0, depth - 1);
  return { show: Math.min(30, RECENT_SHOW + 5 * extra), window: Math.min(RECENT_KEEP, RECENT_WINDOW * (1 + extra)) };
}

export interface RecentStore {
  /** これまでの操作の回数（探す・見る・変えるで1回ずつ） */
  n: number;
  /** 場所 → 使った回数と、最後に使った操作の番号 */
  places: Record<string, { hits: number; last: number }>;
}

const fileOf = (root: string) => join(root, '.ages', 'recent.json');

export async function readRecent(root: string): Promise<RecentStore> {
  try {
    const s = JSON.parse(await readFile(fileOf(root), 'utf8')) as RecentStore;
    return typeof s.n === 'number' && s.places && typeof s.places === 'object' ? s : { n: 0, places: {} };
  } catch {
    return { n: 0, places: {} };
  }
}

/**
 * 1回の操作（探す・見る・変える）を数え、そこで見た・変えた場所を覚える（同じ操作の中の重なりは1つに）。古いものは忘れる。
 * 探す（ages find）は、出た結果を使うとは限らないので場所は覚えず、回数だけ数える
 */
export async function noteRecent(root: string, places: string[]): Promise<void> {
  const uniq = [...new Set(places.filter(Boolean))];
  const s = await readRecent(root);
  s.n++;
  for (const p of uniq) {
    const e = s.places[p] ?? { hits: 0, last: 0 };
    e.hits++;
    e.last = s.n;
    s.places[p] = e;
  }
  for (const [k, e] of Object.entries(s.places)) if (s.n - e.last >= RECENT_KEEP) delete s.places[k];
  await mkdir(join(root, '.ages'), { recursive: true });
  // 書きかけを読まれないよう、別の名前に書いてから置きかえる
  const tmp = `${fileOf(root)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s) + '\n');
  await rename(tmp, fileOf(root));
}

/** よく使った順（同じ回数なら新しい順）。window 回より前に最後に使った所は除く */
export function topRecent(s: RecentStore, max = RECENT_SHOW, window = RECENT_WINDOW): { place: string; hits: number }[] {
  return Object.entries(s.places)
    .filter(([, e]) => s.n - e.last < window)
    .sort(([, a], [, b]) => b.hits - a.hits || b.last - a.last)
    .slice(0, max)
    .map(([place, e]) => ({ place, hits: e.hits }));
}

/**
 * 住所を「場所」にまとめる（細かい所は同じ場所として数える）。
 * $表.行.列 → $表.列（行はいろいろ変わるので）、シーン#ID.部品.値 → シーン#ID.部品、@プレハブ.部品.値 → @プレハブ.部品、
 * リストの中（[2] など）は外す。patch の変更の印（prefab: scene: file: sheet:）も場所に直す
 */
export function placeOf(path: string): string {
  if (path.startsWith('prefab:')) return '@' + path.slice('prefab:'.length);
  if (path.startsWith('scene:')) return `シーン:${path.slice('scene:'.length)}`;
  if (path.startsWith('file:')) return path.slice('file:'.length);
  if (path.startsWith('sheet:')) return path.slice('sheet:'.length).split('|')[0];
  const parts = path.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);
  if (!parts.length) return '';
  if (parts[0].startsWith('$')) return parts.length >= 3 ? `${parts[0]}.${parts[2]}` : parts[0];
  if (parts[0].includes('#') || parts[0].startsWith('@')) return parts.slice(0, 2).join('.');
  return parts.slice(0, 2).join('.');
}

/**
 * 並べるときの重み: 同じ場所なら回数の2倍、どちらかが他方の中（$表 と $表.列 など）なら回数。
 * プレハブ・シーンの物の部品（@enemy.Health）は、その部品（Health・Health.hp）にも回数で効く
 */
export function recentScore(place: string, s: RecentStore, window = RECENT_WINDOW): number {
  const near = (a: string, b: string) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
  let best = 0;
  for (const [p, e] of Object.entries(s.places)) {
    if (s.n - e.last >= window) continue;
    const head = p.split('.')[0];
    const comp = (head.startsWith('@') || head.includes('#')) ? p.split('.')[1] : undefined;
    const w = p === place ? e.hits * 2 : near(p, place) || (comp && near(comp, place)) ? e.hits : 0;
    if (w > best) best = w;
  }
  return best;
}
