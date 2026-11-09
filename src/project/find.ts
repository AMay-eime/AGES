// 名前・説明から探す（ages find）。大きなプロジェクトの地図は目次だけなので、中身はここで引く。
import { brief } from '../core/schema.ts';
import type { Project } from './project.ts';
import type { GuideTopic } from './guide.ts';

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
export function findInProject(p: Project, query: string, guide: Map<string, GuideTopic> = new Map()): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('探す語を書いてください（例 ages find <dir> 移動速度 / ages find <dir> shot_gordon）');
  const hit = (...texts: (string | undefined)[]) => { const h = texts.filter(Boolean).join(' ').toLowerCase(); return words.every((w) => h.includes(w)); };
  const out: string[] = [];

  // 部品とフィールド（自分のものを先に。標準のものは後ろ）
  const comps = [...p.registry.components.values()];
  const own = comps.filter((d) => !p.registry.std.has(d.name));
  const std = comps.filter((d) => p.registry.std.has(d.name));
  for (const [defs, label] of [[own, '部品'], [std, '標準の部品']] as const) {
    for (const d of defs) {
      if (hit(d.name, d.desc)) out.push(`${label} ${d.name} — ${cut(d.desc)}`);
      for (const [k, f] of Object.entries(d.fields)) if (hit(`${d.name}.${k}`, f.desc)) out.push(`${d.name}.${k} ${type(f)} — ${cut(f.desc)}`);
    }
  }

  // 表・列・行（行は id と、文字の値）
  for (const t of p.registry.tables.values()) {
    if (hit(`$${t.name}`, t.desc)) out.push(`表 $${t.name} — ${cut(t.desc)}`);
    for (const [k, f] of Object.entries(t.columns)) if (hit(`$${t.name} ${k}`, f.desc)) out.push(`$${t.name} の列 ${k} ${type(f)} — ${cut(f.desc)}`);
    for (const row of p.docs.tables.get(t.name)?.rows ?? []) {
      if (hit(`$${t.name}.${row.id}`)) { out.push(`$${t.name}.${row.id}（行）`); continue; }
      for (const [k, v] of Object.entries(row)) if (k !== 'id' && typeof v === 'string' && hit(v)) out.push(`$${t.name}.${row.id}.${k} = ${JSON.stringify(cut(v, 60))}`);
    }
  }

  // システム（実行順）
  p.registry.systems.forEach((s, i) => {
    if (hit(s.name, s.desc)) {
      const rw = [s.reads?.length ? `r:${s.reads.join(',')}` : '', s.writes?.length ? `w:${s.writes.join(',')}` : ''].filter(Boolean).join(' ');
      out.push(`システム ${i + 1} ${s.name} — ${cut(s.desc)}${rw ? ' ' + rw : ''}`);
    }
  });

  // プレハブ（名前・説明・タグ・部品の名前）
  for (const raw of p.docs.prefabs.values()) {
    const pf = p.registry.findPrefab(raw.name) ?? raw;
    const comps = Object.keys(pf.components).join(' ');
    if (hit(`@${pf.name}`, raw.desc, pf.tags?.join(' '), raw.base ? `@${raw.base}` : '')) out.push(`@${pf.name}${raw.base ? ` ← @${raw.base}` : ''} [${comps}]${raw.desc ? ' — ' + cut(raw.desc) : ''}`);
  }

  // シーンと物（同じ ID・同じ部品の物がいくつものシーンにあれば1行にまとめる）
  const ents = new Map<string, { line: string; scenes: string[] }>();
  for (const s of p.docs.scenes.values()) {
    if (hit(s.name, s.desc)) out.push(`シーン ${s.name}（${s.entities.length}体）${s.desc ? ' — ' + cut(s.desc) : ''}`);
    for (const e of s.entities) {
      if (!hit(`#${e.id}`, e.name, e.tags?.join(' '))) continue;
      const key = `${e.id}[${Object.keys(e.components).join(' ')}]`;
      const prev = ents.get(key);
      if (prev) prev.scenes.push(s.name);
      else ents.set(key, { line: `#${e.id} "${e.name}" [${Object.keys(e.components).join(' ')}]${e.tags?.length ? ` tags:${e.tags.join(',')}` : ''}`, scenes: [s.name] });
    }
  }
  for (const { line, scenes } of ents.values()) out.push(`${scenes[0]}${line}${scenes.length > 1 ? `（ほか${scenes.length - 1}シーンにも: ${scenes.slice(1).join(',')}）` : ''}`);

  for (const d of p.registry.shaders.values()) if (hit(d.path, d.desc)) out.push(`シェーダー ${d.path} — ${cut(d.desc)}`);
  for (const a of p.assets) if (hit(a.path)) out.push(`アセット ${a.path}`);
  for (const t of guide.values()) if (hit(`guide:${t.name}`, t.title, t.parts.join(' '))) out.push(`手順 guide:${t.name} — ${t.title}`);

  if (!out.length) return `「${query}」は見つかりませんでした（名前の一部か、説明の言葉で探す。コードの中は grep）`;
  const head = `「${query}」${out.length}件`;
  if (out.length <= FIND_MAX) return [head, ...out].join('\n');
  return [head, ...out.slice(0, FIND_MAX), `ほか${out.length - FIND_MAX}件（語を足して絞る。節ごとの一覧は ages map <dir> 節）`].join('\n');
}
