// アセットの出どころの記録（自作・AI 生成・配布や購入の素材・人に頼んだ）。assets.origin.json に置く（Git で共有）。
// ストアへの申告（プレイヤーに届く物に生成 AI を使ったか）とクレジットのために、後から思い出さなくてよいように残す。自己申告の記録で、調べて見分けるものではない
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetInfo } from './assets.ts';

export const ORIGIN_FILE = 'assets.origin.json';
export { ORIGIN_BY, BY_JA, originOf, describeOrigin, type Origin, type OriginBy, type Origins, type OriginInput } from '../core/origin.ts';
import { ORIGIN_BY, BY_JA, originOf, describeOrigin, type Origin, type OriginBy, type Origins, type OriginInput } from '../core/origin.ts';

/** 出どころを記録するアセット（シェーダーはコードなので入れない） */
export const needsOrigin = (a: AssetInfo): boolean => a.kind !== 'shader';

export async function readOrigins(dir: string): Promise<Origins> {
  let text: string;
  try { text = await readFile(join(dir, ORIGIN_FILE), 'utf8'); } catch { return {}; }
  try {
    const v = JSON.parse(text) as Origins;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    throw new Error(`${ORIGIN_FILE} が読めません（JSON の形が崩れています）: ${(e as Error).message}`);
  }
}

export async function writeOrigins(dir: string, o: Origins): Promise<void> {
  const sorted = Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const path = join(dir, ORIGIN_FILE), tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(sorted, null, 2) + '\n');
  await rename(tmp, path);
}

/**
 * 出どころを書く。target はファイル・フォルダ（中のファイル全部）・`$text.言語`。by が none なら記録を消す。
 * 人が書いた記録を AI が変えるには force が要る
 */
export function setOrigin(o: Origins, assets: AssetInfo[], languages: string[], target: string, input: OriginInput, who: 'human' | 'ai', force = false): { key: string; text: string } {
  let key = target.replace(/\\/g, '/');
  if (key.startsWith('$text.')) {
    const lang = key.slice('$text.'.length);
    if (!languages.includes(lang)) throw new Error(`言語 ${lang} はありません（${languages.join(' ')}）`);
  } else if (!assets.some((a) => a.path === key)) {
    key = key.replace(/\/+$/, '') + '/';
    if (!assets.some((a) => a.path.startsWith(key))) throw new Error(`${target} というファイル・フォルダはありません（ages assets <dir> で一覧）`);
  }
  const old = o[key];
  if (old && old.who === 'human' && who === 'ai' && !force) throw new Error(`★ ${key} の出どころは人が書いたものです（${describeOrigin(old)}）。変えるなら人に確かめて --force`);
  if (input.by === 'none') {
    if (!old) throw new Error(`${key} の出どころの記録はありません`);
    delete o[key];
    return { key, text: `${key}: 出どころの記録を消しました` };
  }
  const by = input.by ?? old?.by;
  if (!by || !(ORIGIN_BY as readonly string[]).includes(by)) throw new Error(`--by は ${ORIGIN_BY.map((b) => `${b}（${BY_JA[b]}）`).join(' / ')} のどれかです（消すなら none）`);
  const pick = (k: 'tool' | 'license' | 'from' | 'note') => { const v = input[k] !== undefined ? input[k]!.trim() : old?.[k]; return v ? { [k]: v } : {}; };
  const next: Origin = { by: by as OriginBy, ...pick('tool'), ...pick('license'), ...pick('from'), ...pick('note'), who };
  o[key] = next;
  const inside = key.endsWith('/') ? `（中の ${assets.filter((a) => a.path.startsWith(key) && needsOrigin(a)).length} ファイル）` : '';
  const hint = next.by === 'ai' && !next.tool ? '。--tool で使った AI の名前も' : next.by === 'stock' && !next.license ? '。--license と --from（入手元）も' : '';
  return { key, text: `${key}${inside}: ${describeOrigin(next)}${hint}` };
}

/** ファイル・フォルダの場所が変わったら、記録の場所も変える（消したものの記録は残す: 元に戻したときのため） */
export function moveOrigins(o: Origins, moves: { from: string; to: string | null; dir?: boolean }[]): boolean {
  let changed = false;
  for (const m of moves) {
    if (m.to === null) continue;
    for (const key of Object.keys(o)) {
      const bare = key.replace(/\/$/, '');
      const hit = bare === m.from || (m.dir && bare.startsWith(m.from + '/'));
      if (!hit) continue;
      const to = m.to + bare.slice(m.from.length) + (key.endsWith('/') ? '/' : '');
      o[to] = o[key];
      delete o[key];
      changed = true;
    }
  }
  return changed;
}

/** 出どころが未記入のアセット */
export function unrecorded(o: Origins, assets: AssetInfo[]): AssetInfo[] {
  return assets.filter((a) => needsOrigin(a) && !originOf(o, a.path));
}

const KIND_JA: Record<string, string> = { image: '画像', sound: '音', font: 'フォント', model: 'モデル' };

/** 申告のための短いまとめ（書き出し・check に出す）。生成 AI を使った物の種類ごとの数と、未記入の数 */
export function originSummary(o: Origins, assets: AssetInfo[], languages: string[]): { ai: string; missing: number; total: number } {
  const need = assets.filter(needsOrigin);
  const ai = new Map<string, number>();
  for (const a of need) if (originOf(o, a.path)?.origin.by === 'ai') ai.set(KIND_JA[a.kind] ?? a.kind, (ai.get(KIND_JA[a.kind] ?? a.kind) ?? 0) + 1);
  const text = languages.filter((l) => o[`$text.${l}`]?.by === 'ai');
  const parts = [...[...ai].map(([k, n]) => `${k} ${n}`), ...(text.length ? [`言葉（${text.join(' ')}）`] : [])];
  return { ai: parts.join('・'), missing: unrecorded(o, assets).length, total: need.length };
}

/** 出どころの一覧（ages assets --origin）。出どころごとに、記録の単位（ファイル・フォルダ）で */
export function originReport(o: Origins, assets: AssetInfo[], languages: string[], textRows: number): string[] {
  const need = assets.filter(needsOrigin);
  const s = originSummary(o, assets, languages);
  const out = [`出どころ（アセット ${s.total}件のうち未記入 ${s.missing}）。書く: ages assets <dir> --origin <ファイル | フォルダ | $text.言語> --by ${ORIGIN_BY.join('|')} [--tool AIの名前] [--license CC0] [--from 入手元] [--note 一言]`];
  out.push(s.ai ? `生成 AI を使った物: ${s.ai}（ストアの申告: 事前に作った AI の内容あり）` : `生成 AI を使った物: ${s.missing ? '記録の中にはなし（未記入が残っている）' : 'なし'}`);
  for (const by of ORIGIN_BY) {
    const keys = Object.keys(o).filter((k) => o[k].by === by).sort();
    if (!keys.length) continue;
    out.push(`${BY_JA[by]}:`);
    for (const k of keys) {
      const x = o[k];
      const n = k.startsWith('$text.') ? '' : k.endsWith('/') ? ` ${need.filter((a) => originOf(o, a.path)?.key === k).length}件` : assets.some((a) => a.path === k) ? '' : ' （ファイルがない）';
      out.push(`  ${k}${n}${[x.tool, x.license, x.from, x.note].some(Boolean) ? ` — ${[x.tool, x.license, x.from, x.note].filter(Boolean).join('・')}` : ''}${x.who === 'human' ? ' ★' : ''}`);
    }
  }
  const miss = unrecorded(o, assets);
  if (miss.length) {
    // 未記入は、フォルダごとの数で（多いとき）
    const dirs = new Map<string, string[]>();
    for (const a of miss) { const d = a.path.slice(0, a.path.lastIndexOf('/') + 1); dirs.set(d, [...(dirs.get(d) ?? []), a.path.slice(d.length)]); }
    out.push('⚠ 未記入:');
    for (const [d, names] of [...dirs].sort()) out.push(`  ${d}${names.length > 4 ? ` ${names.length}件（${names.slice(0, 3).join(' ')} …）` : names.length > 1 ? `{${names.join(' ')}}` : names[0]}`);
  }
  if (textRows) {
    const langs = languages.map((l) => `${l} ${o[`$text.${l}`] ? describeOrigin(o[`$text.${l}`]) : '未記入'}`);
    out.push(`言葉（表 $text ${textRows}行。AI の翻訳も申告の対象）: ${langs.join(' ／ ')}`);
  }
  return out;
}
