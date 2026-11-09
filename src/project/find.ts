// 名前・説明から探す（ages find）。大きなプロジェクトの地図は目次だけなので、中身はここで引く。
import { brief } from '../core/schema.ts';
import type { Project } from './project.ts';
import type { GuideTopic } from './guide.ts';
import { recentScore, type RecentStore } from './recent.ts';

/** 1回に出す行の上限（多すぎるときは語を足して絞る） */
export const FIND_MAX = 40;

const cut = (s: string | undefined, max = 80): string => {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max) + '…' : t;
};

/** 型の短い書き方（入れ子の型は長いので切る。全部は ages schema） */
const type = (f: Parameters<typeof brief>[0]): string => cut(brief(f), 50);

/**
 * 語（空白で区切ると、すべてを含むものだけ）で、部品・フィールド・表・列・行・システム・プレハブ・シーンの物・シェーダー・アセット・手順の項目を探す。
 * 大文字・小文字は区別しない。名前だけでなく説明も見る（「移動速度」で列が見つかる）
 */
export interface FindResult {
  text: string;
  /** 上に出た場所 */
  top: string[];
}

export function findInProject(p: Project, query: string, guide: Map<string, GuideTopic> = new Map(), recent?: RecentStore, defs = new Map<string, string>()): FindResult {
  // コードの中の宣言の場所（あれば名前の後ろに）
  const at = (key: string) => { const d = defs.get(key); return d ? `（${d}）` : ''; };
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('探す語を書いてください（例 ages find <dir> 移動速度 / ages find <dir> shot_gordon）');
  const hit = (...texts: (string | undefined)[]) => { const h = texts.filter(Boolean).join(' ').toLowerCase(); return words.every((w) => h.includes(w)); };
  const found: { place: string; line: string }[] = [];
  const add = (place: string, line: string) => found.push({ place, line });

  // 部品とフィールド（自分のものを先に。標準のものは後ろ）
  const comps = [...p.registry.components.values()];
  const own = comps.filter((d) => !p.registry.std.has(d.name));
  const std = comps.filter((d) => p.registry.std.has(d.name));
  for (const [defs, label] of [[own, '部品'], [std, '標準の部品']] as const) {
    for (const d of defs) {
      if (hit(d.name, d.desc)) add(d.name, `${label} ${d.name}${at(`component:${d.name}`)} — ${cut(d.desc)}`);
      for (const [k, f] of Object.entries(d.fields)) if (hit(`${d.name}.${k}`, f.desc)) add(`${d.name}.${k}`, `${d.name}.${k} ${type(f)} — ${cut(f.desc)}`);
    }
  }

  // 表・列・行（行は id と、文字の値）
  for (const t of p.registry.tables.values()) {
    if (hit(`$${t.name}`, t.desc)) add(`$${t.name}`, `表 $${t.name}${at(`table:${t.name}`)} — ${cut(t.desc)}`);
    for (const [k, f] of Object.entries(t.columns)) if (hit(`$${t.name} ${k}`, f.desc)) add(`$${t.name}.${k}`, `$${t.name} の列 ${k} ${type(f)} — ${cut(f.desc)}`);
    for (const row of p.docs.tables.get(t.name)?.rows ?? []) {
      if (hit(`$${t.name}.${row.id}`)) { add(`$${t.name}`, `$${t.name}.${row.id}（行）`); continue; }
      for (const [k, v] of Object.entries(row)) if (k !== 'id' && typeof v === 'string' && hit(v)) add(`$${t.name}.${k}`, `$${t.name}.${row.id}.${k} = ${JSON.stringify(cut(v, 60))}`);
    }
  }

  // システム（実行順）
  p.registry.systems.forEach((s, i) => {
    if (hit(s.name, s.desc)) {
      const rw = [s.reads?.length ? `r:${s.reads.join(',')}` : '', s.writes?.length ? `w:${s.writes.join(',')}` : ''].filter(Boolean).join(' ');
      add(`システム:${s.name}`, `システム ${i + 1} ${s.name}${at(`system:${s.name}`)} — ${cut(s.desc)}${rw ? ' ' + rw : ''}`);
    }
  });

  // プレハブ（名前・説明・タグ・部品の名前）
  for (const raw of p.docs.prefabs.values()) {
    const pf = p.registry.findPrefab(raw.name) ?? raw;
    const comps = Object.keys(pf.components).join(' ');
    if (hit(`@${pf.name}`, raw.desc, pf.tags?.join(' '), raw.base ? `@${raw.base}` : '')) add(`@${pf.name}`, `@${pf.name}${raw.base ? ` ← @${raw.base}` : ''} [${comps}]${raw.desc ? ' — ' + cut(raw.desc) : ''}`);
  }

  // シーンと物（同じ ID・同じ部品の物がいくつものシーンにあれば1行にまとめる）
  const ents = new Map<string, { id: string; line: string; scenes: string[] }>();
  for (const raw of p.docs.scenes.values()) {
    const s = p.resolvedScene(raw);
    if (hit(s.name, s.desc)) add(`シーン:${s.name}`, `シーン ${s.name}（${s.entities.length}体）${s.desc ? ' — ' + cut(s.desc) : ''}`);
    for (const e of s.entities) {
      if (!hit(`#${e.id}`, e.name, e.tags?.join(' '), e.prefab ? `@${e.prefab}` : '')) continue;
      const inst = e.prefab ? ` ←@${e.prefab}` : '';
      const key = `${e.id}[${Object.keys(e.components).join(' ')}]${inst}`;
      const prev = ents.get(key);
      if (prev) prev.scenes.push(s.name);
      else ents.set(key, { id: e.id, line: `#${e.id} "${e.name}"${inst} [${Object.keys(e.components).join(' ')}]${e.tags?.length ? ` tags:${e.tags.join(',')}` : ''}`, scenes: [s.name] });
    }
  }
  for (const { id, line, scenes } of ents.values()) add(`${scenes[0]}#${id}`, `${scenes[0]}${line}${scenes.length > 1 ? `（ほか${scenes.length - 1}シーンにも: ${scenes.slice(1).join(',')}）` : ''}`);

  for (const d of p.registry.shaders.values()) if (hit(d.path, d.desc)) add(d.path, `シェーダー ${d.path} — ${cut(d.desc)}`);
  for (const a of p.assets) if (hit(a.path)) add(a.path, `アセット ${a.path}`);
  for (const t of guide.values()) if (hit(`guide:${t.name}`, t.title, t.parts.join(' '))) add(`guide:${t.name}`, `手順 guide:${t.name} — ${t.title}`);

  if (!found.length) return { text: `「${query}」は見つかりませんでした（名前の一部か、説明の言葉で探す。コードの中は grep）`, top: [] };
  // 最近の作業の場所（.ages/recent.json）に近いものを上へ。ほかは元の順（自分の部品 → 表 → … → 手順）
  const ranked = recent ? found.map((f, i) => ({ ...f, i, w: recentScore(f.place, recent) })).sort((a, b) => b.w - a.w || a.i - b.i) : found;
  const out = ranked.map((f) => f.line);
  const head = `「${query}」${out.length}件${recent && ranked.some((f) => 'w' in f && (f as { w: number }).w > 0) ? '（最近の作業の場所に近いものから）' : ''}`;
  const top = ranked.slice(0, 3).map((f) => f.place);
  if (out.length <= FIND_MAX) return { text: [head, ...out].join('\n'), top };
  return { text: [head, ...out.slice(0, FIND_MAX), `ほか${out.length - FIND_MAX}件（語を足して絞る。節ごとの一覧は ages map <dir> 節）`].join('\n'), top };
}
