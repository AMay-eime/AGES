#!/usr/bin/env node
// AGES の起動用（版だけ同梱）。このプロジェクトが使う AGES 本体の版（ages.project.json の engineSource）を
// .ages/engine（git の対象外）に GitHub から取ってきて、そこで動かす。リポジトリにはこのファイルと版だけを入れる。
//   node ages.mjs <命令> .       … ages の命令（例 node ages.mjs check .）
//   node ages.mjs editor          … エディタを起動（http://localhost:5170）
//   node ages.mjs mcp             … MCP サーバー（.mcp.json から）
//   node ages.mjs upgrade [ref]   … 本体を新しい版（既定 main）に上げる。直しが要れば手順が出る
// 本体（.ages/engine）は書き換えない。書き換えられていたら、動かす前に元に戻す（本体の直しは AGES のリポジトリで）
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, '.ages', 'engine');
const cfgFile = join(here, 'ages.project.json');
const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
const src = cfg.engineSource ?? {};
const repo = src.repo ?? 'https://github.com/AMay-eime/AGES.git';
// 取ってくる様子・直したことは stderr に（MCP では stdout がやりとりに使われるため）
const say = (s) => process.stderr.write(s + '\n');
const git = (...args) => execFileSync('git', ['-C', engine, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const fail = (what, e) => {
  say(`ages.mjs: ${what}: ${String(e?.stderr ?? e?.message ?? e).trim().split('\n')[0]}`);
  say('  git が要る（Windows: winget install Git.Git）。ネットにつながっているかも確かめる');
  process.exit(1);
};

/** 本体を ref の版で取ってくる（ref はコミットか main などの名前）。取れたコミットを返す */
function fetchEngine(ref) {
  try {
    if (!existsSync(join(engine, '.git'))) execFileSync('git', ['init', '-q', engine], { stdio: ['ignore', 'pipe', 'pipe'] });
    git('fetch', '-q', '--depth', '1', repo, ref);
    git('checkout', '-q', '--force', '--detach', 'FETCH_HEAD');
    return git('rev-parse', 'HEAD');
  } catch (e) { fail(`AGES 本体（${ref}）を取れませんでした`, e); }
}

/** 決めた版の本体があり、書き換えられていないようにする */
function ensureEngine() {
  if (!src.commit) { say('ages.mjs: ages.project.json に engineSource.commit がありません（ages pin で作る）'); process.exit(1); }
  let head = '';
  try { if (existsSync(join(engine, '.git'))) head = git('rev-parse', 'HEAD'); } catch { /* 取り直す */ }
  if (head !== src.commit) {
    say(`AGES 本体を取ってきます（${src.commit.slice(0, 7)}）`);
    fetchEngine(src.commit);
    return;
  }
  // 行頭の空白にも意味があるので trim しない
  const changed = execFileSync('git', ['-C', engine, 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().replace(/\n+$/, '');
  if (changed) {
    git('checkout', '-q', '--force', src.commit);
    git('clean', '-qfd');
    const files = changed.split('\n').map((l) => l.slice(3)).slice(0, 5).join(' ');
    say(`⚠ AGES 本体（.ages/engine）が書き換えられていたので戻しました: ${files}。本体は書き換えない（足りない所は書き出して、AGES のリポジトリで直す）`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'upgrade') {
  const sha = fetchEngine(rest[0] ?? 'main');
  if (sha === src.commit) { say(`AGES 本体はもう最新です（${sha.slice(0, 7)}）`); process.exit(0); }
  say(`AGES 本体を ${String(src.commit ?? '?').slice(0, 7)} → ${sha.slice(0, 7)} に上げます`);
  // 新しい本体で版だけ同梱の形を当て直す（engineSource・この起動用・AGENTS.md（手で直されていなければ）・.mcp.json）。直しが要れば手順を出す
  const ages = (...a) => spawnSync(process.execPath, [join(engine, 'bin', 'ages.js'), ...a], { stdio: 'inherit' }).status ?? 1;
  if (ages('pin', here, '--repo', repo, '--commit', sha)) {
    cfg.engineSource = { ...src, repo, commit: sha };
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  }
  process.exit(ages('version', here));
}
ensureEngine();
const args = cmd === 'editor' ? [join(engine, 'src', 'editor', 'server.ts'), here, ...rest]
  : cmd === 'mcp' ? [join(engine, 'src', 'mcp', 'server.ts'), '--project', here, ...rest]
  : [join(engine, 'bin', 'ages.js'), ...(cmd ? [cmd] : []), ...rest];
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
