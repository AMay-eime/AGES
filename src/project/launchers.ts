// ダブルクリックでエディタを開くファイル（PC に慣れていない人が、黒い画面に命令を打たずに使えるように）。
// Windows は「エディタを開く.cmd」、mac は「エディタを開く.command」。ages init と ages pin（ages.mjs upgrade）が作る。
// 中の印の行が残っていれば作り直す（本体の場所や起動の仕方が変わったとき）。印の行を消せば、手で直したものとして残す
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const LAUNCHER_MARK = 'AGES launcher';
export const LAUNCHER_WIN = 'エディタを開く.cmd';
export const LAUNCHER_MAC = 'エディタを開く.command';
const NODE_URL = 'https://nodejs.org/ja/download';
/** Node が 22.18 以上か（TypeScript をそのまま動かすため。package.json の engines と同じ）。cmd でも sh でも同じに読める書き方（" と $ を使わない） */
const NODE_OK = "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)";

/** 中身。run は node に渡すもの（例 `ages.mjs editor`・`"../AGES/src/editor/server.ts" .`） */
/**
 * needs: 起動の前に、あることを確かめるファイル（AGES 本体。プロジェクトから見た場所）。
 * 本体を別の場所に置く形（ages init --no-pin）は、プロジェクトを別のパソコン・別の場所へ移すと本体が見つからなくなるので、直し方を出す
 */
export function launcherFiles(run: string, needs?: string): Record<string, string> {
  // cmd の ( ) の中では半角の括弧が使えないので、文には全角だけを使う
  const lost = ['AGES 本体が見つかりません。このフォルダを別の場所へ移したか、AGES 本体のフォルダがなくなっています。', '直し方: AI に「このプロジェクトを ages pin で、版だけ同梱の形にして」と頼んでください。'];
  const winCheck = needs ? [`if not exist "${needs.replaceAll('/', '\\')}" (`, ...lost.map((l) => `  echo ${l}`), '  pause', '  exit /b 1', ')'] : [];
  const macCheck = needs ? [`if [ ! -f "${needs}" ]; then`, ...lost.map((l) => `  echo "${l}"`), '  read -r _', '  exit 1', 'fi'] : [];
  // cmd は1行ずつ今の文字コードで読むので、日本語の行より先に UTF-8 にする。行の終わりは CRLF（Windows のメモ帳でも崩れない）
  const win = [
    '@echo off',
    'chcp 65001 >nul',
    `rem ${LAUNCHER_MARK}: ages init / ages pin が作る。手で直したら、この行を消すと上書きされない`,
    'cd /d "%~dp0"',
    'title AGES エディタ',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Node.js が入っていません。開いたページから「LTS」を入れてから、もう一度ダブルクリックしてください。',
    `  start "" ${NODE_URL}`,
    '  pause',
    '  exit /b 1',
    ')',
    `node -e "${NODE_OK}"`,
    'if errorlevel 1 (',
    '  echo Node.js が古いです。開いたページから新しい「LTS」を入れてから、もう一度ダブルクリックしてください。',
    `  start "" ${NODE_URL}`,
    '  pause',
    '  exit /b 1',
    ')',
    ...winCheck,
    'echo AGES のエディタを起動します。この黒い窓は閉じないでください。閉じるとエディタが止まります。',
    `node ${run}`,
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
  const mac = [
    '#!/bin/sh',
    `# ${LAUNCHER_MARK}: ages init / ages pin が作る。手で直したら、この行を消すと上書きされない`,
    'cd "$(dirname "$0")" || exit 1',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "Node.js が入っていません。開いたページから「LTS」を入れてから、もう一度ダブルクリックしてください。"',
    `  open ${NODE_URL}`,
    '  read -r _',
    '  exit 1',
    'fi',
    `if ! node -e "${NODE_OK}"; then`,
    '  echo "Node.js が古いです。開いたページから新しい「LTS」を入れてから、もう一度ダブルクリックしてください。"',
    `  open ${NODE_URL}`,
    '  read -r _',
    '  exit 1',
    'fi',
    ...macCheck,
    'echo "AGES のエディタを起動します。このターミナルの窓は閉じないでください（閉じるとエディタが止まります）。"',
    `node ${run} || read -r _`,
    '',
  ].join('\n');
  return { [LAUNCHER_WIN]: win, [LAUNCHER_MAC]: mac };
}

/** 書く（ないか、印の行が残っていて中身が違うときだけ）。書いたファイルの名前を返す */
export async function writeLaunchers(dir: string, run: string, needs?: string): Promise<string[]> {
  const out: string[] = [];
  for (const [name, body] of Object.entries(launcherFiles(run, needs))) {
    const f = join(dir, name);
    if (existsSync(f)) {
      const cur = await readFile(f, 'utf8');
      if (!cur.includes(LAUNCHER_MARK) || cur === body) continue;
    }
    await writeFile(f, body);
    if (name.endsWith('.command')) await chmod(f, 0o755).catch(() => {});
    out.push(name);
  }
  return out;
}
