// 機能ごとの手順（docs/GUIDE.md）。AIが毎回読む AGENTS.md には目次だけを置き、詳しい手順は要るときにここから引く。
import { readFile } from 'node:fs/promises';

export interface GuideTopic {
  name: string;
  title: string;
  /** その項目で使う標準のコンポーネント（`部品:` の行） */
  parts: string[];
  body: string;
}

const GUIDE_FILE = new URL('../../docs/GUIDE.md', import.meta.url);

/** `## 項目: 題` ごとに分ける */
export function parseGuide(text: string): Map<string, GuideTopic> {
  const out = new Map<string, GuideTopic>();
  for (const sec of text.split(/^## /m).slice(1)) {
    const nl = sec.indexOf('\n');
    const head = (nl < 0 ? sec : sec.slice(0, nl)).trim();
    const m = head.match(/^([a-z0-9-]+):\s*(.*)$/);
    if (!m) continue;
    const lines = (nl < 0 ? '' : sec.slice(nl + 1)).trim().split('\n');
    const partsLine = lines.find((l) => l.startsWith('部品:'));
    out.set(m[1], {
      name: m[1],
      title: m[2],
      parts: partsLine ? partsLine.slice(3).trim().split(/\s+/) : [],
      body: lines.filter((l) => l !== partsLine).join('\n').trim(),
    });
  }
  return out;
}

let cache: Map<string, GuideTopic> | undefined;

const pkgCache = new Map<string, Map<string, GuideTopic>>();

/** 追加パッケージの手順（src/packages/<名前>/GUIDE.md。なければ空） */
export async function readPackageGuide(name: string): Promise<Map<string, GuideTopic>> {
  if (!pkgCache.has(name)) {
    const text = await readFile(new URL(`../packages/${name}/GUIDE.md`, import.meta.url), 'utf8').catch(() => '');
    pkgCache.set(name, parseGuide(text));
  }
  return pkgCache.get(name)!;
}

/** 本体の手順と、入れている追加パッケージ（packages）の手順 */
export async function readGuide(packages: string[] = []): Promise<Map<string, GuideTopic>> {
  const base = (cache ??= parseGuide(await readFile(GUIDE_FILE, 'utf8')));
  if (!packages.length) return base;
  const out = new Map(base);
  for (const n of packages) for (const [k, t] of await readPackageGuide(n)) out.set(k, t);
  return out;
}
