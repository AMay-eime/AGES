// 機能ごとのモジュール（game/名前/）。入口は game/名前/index.ts、仕様は game/名前/SPEC.md。
// 機能どうしは、部品・出来事・表と、相手の入口からだけやりとりする（中身を直接 import しない）。
// 境目がはっきりしていれば、ロックした機能は中を読まずに仕様と入口だけ読めばよく、変えても他を壊しにくい
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

export interface GameModule {
  name: string;
  /** プロジェクトの中の場所（game/名前/…） */
  files: string[];
  /** 入口（game/名前/index.ts など） */
  entry?: string;
  /** 仕様（SPEC.md）の最初の行（見出しの # は除く） */
  spec?: string;
}

const ENTRY = /^index\.(ts|js|mjs)$/;

/** 場所（/game/a/b.ts や game/a/b.ts）を game/… の形に */
const rel = (f: string) => f.replace(/^\/+/, '');

/** game/ の下のフォルダごとの機能（直下のファイルは共有の場所なので機能に数えない） */
export async function gameModules(dir: string, files: [string, string][]): Promise<GameModule[]> {
  const by = new Map<string, string[]>();
  for (const [f] of files) {
    const m = /^game\/([^/]+)\/(.+)$/.exec(rel(f));
    if (m) by.set(m[1], [...(by.get(m[1]) ?? []), rel(f)]);
  }
  const out: GameModule[] = [];
  for (const [name, fs] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = fs.find((f) => ENTRY.test(f.slice(`game/${name}/`.length)));
    const text = await readFile(join(dir, 'game', name, 'SPEC.md'), 'utf8').catch(() => null);
    const spec = text === null ? undefined : (text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '');
    out.push({ name, files: fs.sort(), ...(entry ? { entry } : {}), ...(spec !== undefined ? { spec } : {}) });
  }
  return out;
}

/** 書いてある import の行き先（相対の場所だけ。パッケージは除く） */
function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** 行き先の場所（.js 書きも .ts に寄せる） */
function resolveImport(from: string, spec: string): string {
  return normalize(join(dirname(from), spec)).split('\\').join('/').replace(/\.(js|mjs)$/, '.ts');
}

/** 機能の境目を越えた import（ほかの機能の中身を直接使っている）と、仕様のない機能 */
export function moduleProblems(files: [string, string][], mods: GameModule[]): string[] {
  const out: string[] = [];
  const names = new Set(mods.map((m) => m.name));
  for (const [f, text] of files) {
    const from = rel(f);
    const own = /^game\/([^/]+)\//.exec(from)?.[1];
    for (const spec of importsOf(text)) {
      const to = resolveImport(from, spec);
      const m = /^game\/([^/]+)\/(.+)$/.exec(to);
      if (!m || !names.has(m[1]) || m[1] === own) continue;
      if (m[2].replace(/\.ts$/, '') === 'index') continue;
      out.push(`${from}: 機能 ${m[1]} の中身（${to.endsWith('.ts') ? to : to + '.ts'}）を直接 import しています。入口 game/${m[1]}/index.ts から使うか、部品・出来事・表でやりとりする（guide:modules）`);
    }
  }
  for (const m of mods) {
    if (m.spec === undefined) out.push(`機能 ${m.name} に仕様 game/${m.name}/SPEC.md がありません（何をするか・読む部品と書く部品・出す出来事と受ける出来事・確かめるふるまい。guide:modules）`);
    if (!m.entry) out.push(`機能 ${m.name} に入口 game/${m.name}/index.ts がありません（ほかの機能・game/index.ts が使うものを、ここから出す。guide:modules）`);
  }
  return out;
}

/** 地図の行（機能ごと）。🔒 はファイルが全部ロックされた機能 */
export function moduleLines(mods: GameModule[], locks: Record<string, unknown>): string[] {
  if (!mods.length) return [];
  const lines = mods.map((m) => {
    const n = m.files.filter((f) => locks[`file:${f}`]).length;
    const mark = locks[`dir:game/${m.name}`] || n === m.files.length ? ' 🔒' : n ? ` 🔒${n}/${m.files.length}` : '';
    return `${m.name}${mark} ${m.files.length}ファイル${m.spec ? `: ${m.spec.length > 50 ? m.spec.slice(0, 50) + '…' : m.spec}` : m.spec === undefined ? ' 仕様なし' : ''}`;
  });
  return [`## 機能（game/名前/。入口 index.ts・仕様 SPEC.md。🔒 の機能は中を読まず SPEC.md と入口だけ読む。guide:modules）`, ...lines];
}
