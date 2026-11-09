// 多言語。言葉は標準の表 $text に置く（行 = 言葉の名前、列 = 言語。列は config.languages から作る）。
// ゲームのコードは ctx.t('名前', { 値 }) で今の言語の言葉を得る。Text.key に名前を書けば、エンジンが Text.text に入れる。
// 訳がない言語は、最初の言語（既定の言語）で出して ⚠ で知らせる。
import type { ProjectConfig } from './docs.ts';
import type { TableView } from './table.ts';

/** 言語の名前（列の名前になる）: ja・en・zh_Hans・pt_BR など */
export const LANG_RE = /^[a-z]{2,3}(_[A-Za-z0-9]+)?$/;

/** プロジェクトの言語（最初が既定）。書いていなければ日本語だけ */
export function languagesOf(config: Pick<ProjectConfig, 'languages'>): string[] {
  return config.languages?.length ? [...config.languages] : ['ja'];
}

/** {名前} を値で置きかえる（ない値はそのまま残す） */
export function format(template: string, params: Record<string, unknown> = {}): string {
  return template.replace(/\{([A-Za-z_][\w]*)\}/g, (all, k: string) => (k in params ? String(params[k]) : all));
}

/** 言葉を引く。missing: 'key' = 行がない、'lang' = その言語の訳がない（既定の言語で出す） */
export function lookup(view: TableView | null, languages: string[], lang: string, key: string): { text: string; missing?: 'key' | 'lang' } {
  if (!view?.has(key)) return { text: key, missing: 'key' };
  const row = view.get(key) as Record<string, unknown>;
  const t = row[lang];
  if (typeof t === 'string' && t !== '') return { text: t };
  for (const l of languages) {
    const f = row[l];
    if (typeof f === 'string' && f !== '') return { text: f, missing: 'lang' };
  }
  return { text: key, missing: 'lang' };
}

/** 言語ごとの未訳（訳が空の行の名前） */
export function missingText(rows: readonly Record<string, unknown>[], languages: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of languages) {
    const miss = rows.filter((r) => typeof r[l] !== 'string' || r[l] === '').map((r) => String(r.id));
    if (miss.length) out.set(l, miss);
  }
  return out;
}

/** コードの中の t('名前') / ctx.t("名前")（場所 → 中身から、名前 → 書いてある所） */
export function codeTextRefs(files: Iterable<[string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bt\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g)) out.set(m[2], [...(out.get(m[2]) ?? []), `${file}:${i + 1}`]);
    });
  }
  return out;
}
