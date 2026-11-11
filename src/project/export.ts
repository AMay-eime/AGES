// 書き出し（段階3）: エディタを含まない、ゲームだけのファイル一式を作る。
// Web: そのままブラウザで遊べる静的なファイル（itch.io などに置ける）。デスクトップ: Web の書き出しを Tauri の窓で包む元（Steam 向け）。
// 依存ゼロ: 型は Node の stripTypeScriptTypes で消し、import の .ts を .js に直すだけ（まとめない・縮めない。エラーの行番号もそのまま）
import { checkPackageNames } from '../packages/index.ts';
import { stripTypeScriptTypes } from 'node:module';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from './project.ts';
import type { ExportBundle } from '../player/main.ts';

const ENGINE_SRC = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** 書き出した先の印（ここにだけ上書きする。違うフォルダを消さない） */
export const EXPORT_MARK = '.ages-export';

export interface ExportOptions {
  /** 書き出す先（既定 <プロジェクト>/dist） */
  out?: string;
  /** デスクトップ（Tauri）の元も作る */
  desktop?: boolean;
  /** デスクトップのアプリの ID（逆さのドメイン。例 com.mk3.mygame。セーブの置き場所が変わるので、出した後は変えない） */
  id?: string;
  /** デスクトップの窓を全画面で始める */
  fullscreen?: boolean;
}

export interface ExportResult {
  out: string;
  web: string;
  desktop?: string;
  files: number;
  bytes: number;
  notes: string[];
}

/** import の書き方（行の頭の import/export … from '…'、import '…'、import('…')） */
const STATIC = /^(\s*(?:import|export)\b[^'"`;]*?\bfrom\s*)(['"])([^'"]+)\2/gm;
const BARE = /^(\s*import\s*)(['"])([^'"]+)\2/gm;
const DYNAMIC = /(\bimport\(\s*)(['"`])([^'"`$]+)\2(\s*\))/g;

/** import の行き先を拾う（型を消した後のコードから。型だけの import は消えている） */
export function importsOf(code: string): string[] {
  const out: string[] = [];
  for (const re of [STATIC, BARE, DYNAMIC]) for (const m of code.matchAll(re)) out.push(m[3]);
  return out;
}

/** 手元の import の .ts を .js に（ブラウザ・静的なサーバーは .ts を JavaScript として渡さないため） */
export function rewriteImports(code: string): string {
  const fix = (spec: string) => (/^\.{1,2}\//.test(spec) && spec.endsWith('.ts') ? spec.slice(0, -3) + '.js' : spec);
  return code
    .replace(STATIC, (_m, head: string, q: string, spec: string) => `${head}${q}${fix(spec)}${q}`)
    .replace(BARE, (_m, head: string, q: string, spec: string) => `${head}${q}${fix(spec)}${q}`)
    .replace(DYNAMIC, (_m, head: string, q: string, spec: string, tail: string) => `${head}${q}${fix(spec)}${q}${tail}`);
}

/** 入り口から import をたどり、型を消して .js にして書く。root の外へ出る import と、npm の部品（bare）は notes に */
async function copyModules(entries: string[], root: string, outDir: string, notes: string[], allowBare: (spec: string) => boolean): Promise<string[]> {
  const done = new Set<string>();
  const queue = [...entries];
  const written: string[] = [];
  while (queue.length) {
    const file = queue.shift()!;
    if (done.has(file)) continue;
    done.add(file);
    const rel = relative(root, file);
    if (rel.startsWith('..')) { notes.push(`⚠ ${file} は書き出す範囲の外なので入れていません`); continue; }
    let code = await readFile(file, 'utf8');
    if (file.endsWith('.ts')) {
      try { code = stripTypeScriptTypes(code, { mode: 'strip' }); } catch (e) { throw new Error(`${rel} の型を消せません（型だけの書き方に直す）: ${(e as Error).message}`); }
    }
    for (const spec of importsOf(code)) {
      if (/^\.{1,2}\//.test(spec)) queue.push(resolve(dirname(file), spec));
      else if (!allowBare(spec)) notes.push(`⚠ ${rel} の import '${spec}' は書き出しでは使えません（npm の部品は入れない。AGES の機能か、プロジェクトの中のコードにする）`);
    }
    const dst = join(outDir, rel.replace(/\.ts$/, '.js'));
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, rewriteImports(code));
    written.push(dst);
  }
  return written;
}

/** 書き出す（Web。desktop なら Tauri の元も）。ages check にエラーがあれば書き出さない */
export async function exportProject(p: Project, opts: ExportOptions = {}): Promise<ExportResult> {
  const errors = [...p.validate(), ...(await p.checkCode())];
  if (errors.length) throw new Error(`ages check のエラーを直してから書き出してください（${errors.length}件。最初: ${errors[0]}）`);
  const out = resolve(opts.out ?? join(p.dir, 'dist'));
  const web = join(out, 'web');
  await clearExportDir(web);
  const notes: string[] = [];
  // 書き出したものは大きいので Git に入れない（プロジェクトの中に書き出すとき）
  const ignore = join(p.dir, '.gitignore');
  if (!relative(p.dir, out).startsWith('..')) {
    const gi = existsSync(ignore) ? await readFile(ignore, 'utf8') : '';
    if (!gi.split(/\r?\n/).some((l) => /^\/?dist\/?$/.test(l.trim()))) {
      await writeFile(ignore, gi + (gi === '' || gi.endsWith('\n') ? '' : '\n') + '# 書き出したもの（ages export。大きいので共有しない）\ndist/\n');
      notes.push('.gitignore に dist/ を足しました（書き出したものを Git に入れない）');
    }
  }

  // 本体（再生に使う所だけ。エディタ・CLI・MCP は入れない）
  // 追加パッケージは、入れているものだけ（読み込みは式で組み立てているので、import をたどっても拾われない）
  const pkgs = checkPackageNames(p.config.packages);
  const engineFiles = await copyModules([join(ENGINE_SRC, 'player', 'main.ts'), join(ENGINE_SRC, 'index.ts'), ...pkgs.map((n) => join(ENGINE_SRC, 'packages', n, 'index.ts'))], ENGINE_SRC, join(web, 'engine'), notes, () => false);
  // ゲームのコード（'ages' は本体へ。import map で向ける）
  const entry = resolve(p.dir, p.config.game);
  const gameFiles = await copyModules([entry], p.dir, web, notes, (s) => s === 'ages' || pkgs.some((n) => s === `ages/${n}`));

  // データ（シーン・プレハブ・表・切り方・設定）を1つに
  const codeRefs = [...(await p.codeRefs()).keys()];
  const bundle: ExportBundle = {
    entry: relative(p.dir, entry).split(sep).join('/').replace(/\.ts$/, '.js'),
    config: p.config,
    scenes: Object.fromEntries(p.docs.scenes),
    prefabs: Object.fromEntries(p.docs.prefabs),
    tables: Object.fromEntries(p.docs.tables),
    sheets: Object.fromEntries(p.registry.sheets),
    assets: p.assets.map((a) => ({ path: a.path, kind: a.kind, ...(a.w ? { w: a.w } : {}), ...(a.h ? { h: a.h } : {}), ...(a.shader ? { shader: a.shader } : {}) })),
    codeRefs,
  };
  await writeFile(join(web, 'project.json'), JSON.stringify(bundle));

  // アセット（画像・音・フォント・シェーダー）
  let assetBytes = 0;
  for (const a of p.assets) {
    const dst = join(web, a.path);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(join(p.dir, a.path), dst);
    assetBytes += (await stat(dst)).size;
  }
  await writeFile(join(web, 'index.html'), indexHtml(p.config.name, pkgs));
  await writeFile(join(web, EXPORT_MARK), JSON.stringify({ engine: 'AGES', at: new Date().toISOString() }) + '\n');

  const files = engineFiles.length + gameFiles.length + p.assets.length + 3;
  let bytes = assetBytes;
  for (const f of [...engineFiles, ...gameFiles, join(web, 'project.json'), join(web, 'index.html')]) bytes += (await stat(f)).size;

  const result: ExportResult = { out, web, files, bytes, notes };
  if (opts.desktop) result.desktop = await writeDesktop(p, out, opts, notes);
  return result;
}

/** 前の書き出しを消す（印のあるフォルダか、空のフォルダだけ。違うフォルダを消さない） */
async function clearExportDir(dir: string): Promise<void> {
  if (existsSync(dir)) {
    const names = await readdir(dir);
    if (names.length && !names.includes(EXPORT_MARK)) throw new Error(`${dir} に、書き出したものでないファイルがあります。消さないので、別の書き出し先（--out）を選んでください`);
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
}

function indexHtml(name: string, pkgs: string[] = []): string {
  const more = pkgs.map((n) => `, "ages/${n}": "./engine/packages/${n}/index.js"`).join('');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<script type="importmap">{ "imports": { "ages": "./engine/index.js"${more} } }</script>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; touch-action: none; user-select: none; }
  #game { position: absolute; display: block; outline: none; }
  #msg { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; color: #fff; font: 18px/1.6 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; text-align: center; padding: 24px; cursor: pointer; white-space: pre-wrap; }
</style>
</head>
<body>
<canvas id="game" tabindex="0"></canvas>
<div id="msg"></div>
<script type="module" src="./engine/player/main.js"></script>
</body>
</html>
`;
}

// ---------- デスクトップ（Tauri。Steam 向け） ----------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';

/**
 * Tauri（v2）の元を書く。作るのは初めの1回だけ（あとで Steam などのために直した所を消さない）。
 * Web の書き出しは毎回作り直し、Tauri はそれを読んで exe にする
 */
async function writeDesktop(p: Project, out: string, opts: ExportOptions, notes: string[]): Promise<string> {
  const dir = join(out, 'desktop');
  const tauri = join(dir, 'src-tauri');
  const name = slug(p.config.name);
  const id = opts.id ?? `com.example.${name.replace(/-/g, '')}`;
  if (!opts.id) notes.push(`⚠ アプリの ID は仮の ${id} です。出す前に --id com.自分の名前.${name.replace(/-/g, '')} のように決めてください（セーブの置き場所が ID で決まるので、出した後は変えない）`);
  const v = p.config.view;
  const files: Record<string, string | Buffer> = {
    'src-tauri/Cargo.toml': `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }

[profile.release]
# 小さく速く（Steam に置く exe）
codegen-units = 1
lto = true
opt-level = "s"
strip = true
`,
    'src-tauri/build.rs': `fn main() {
    tauri_build::build()
}
`,
    'src-tauri/src/main.rs': `// AGES で作ったゲームを、Tauri の窓で動かす（中身は ../web の書き出し）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("ゲームを起動できませんでした");
}
`,
    'src-tauri/tauri.conf.json': JSON.stringify({
      $schema: 'https://schema.tauri.app/config/2',
      productName: p.config.name,
      version: '0.1.0',
      identifier: id,
      build: { frontendDist: '../../web' },
      app: {
        withGlobalTauri: true,
        windows: [{ label: 'main', title: p.config.name, width: v.width, height: v.height, resizable: true, center: true, fullscreen: !!opts.fullscreen }],
        security: { csp: null },
      },
      bundle: { active: true, targets: 'all', icon: ['icons/icon.png', 'icons/icon.ico'] },
    }, null, 2) + '\n',
    'src-tauri/capabilities/default.json': JSON.stringify({
      $schema: '../gen/schemas/desktop-schema.json',
      identifier: 'default',
      description: 'ゲームの窓（全画面の切り替えだけを許す）',
      windows: ['main'],
      permissions: ['core:default', 'core:window:allow-set-fullscreen', 'core:window:allow-is-fullscreen'],
    }, null, 2) + '\n',
    'src-tauri/icons/icon.png': await readFile(join(ENGINE_SRC, 'editor', 'icon-512.png')),
    'src-tauri/icons/icon.ico': icoFromPng(await readFile(join(ENGINE_SRC, 'editor', 'icon-192.png')), 192),
    'src-tauri/.gitignore': '/target\n/gen/schemas\n',
    'README.md': desktopReadme(p.config.name, name),
  };
  let made = 0;
  for (const [rel, body] of Object.entries(files)) {
    const f = join(dir, rel);
    if (existsSync(f)) continue;
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, body);
    made++;
  }
  if (!made) notes.push('デスクトップの元（src-tauri）はもうあるので、そのままにしました（Web の書き出しだけを新しくした。作り直すなら dist/desktop を消してから）');
  return dir;
}

/** PNG を1枚入れた .ico（Windows の exe のアイコン。Vista 以降は PNG のままでよい） */
export function icoFromPng(png: Buffer, size: number): Buffer {
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0); // 予約
  head.writeUInt16LE(1, 2); // アイコン
  head.writeUInt16LE(1, 4); // 枚数
  head.writeUInt8(size >= 256 ? 0 : size, 6);
  head.writeUInt8(size >= 256 ? 0 : size, 7);
  head.writeUInt8(0, 8); // 色の数
  head.writeUInt8(0, 9);
  head.writeUInt16LE(1, 10); // 面
  head.writeUInt16LE(32, 12); // ビット
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // 中身の位置
  return Buffer.concat([head, png]);
}

function desktopReadme(title: string, name: string): string {
  return `# ${title} のデスクトップ版（Tauri）

\`ages export <プロジェクト> --desktop\` が作った、デスクトップのアプリ（Windows の exe など）の元です。
中身のゲームは \`../web\`（Web の書き出し）で、作り直すたびにそれが新しくなります。この \`src-tauri\` は初めの1回だけ作り、そのあとは上書きしません（Steam のために直した所を消さない）。

## exe を作る（Windows・初めの1回の準備）

1. Rust を入れる: \`winget install Rustlang.Rustup\`（または https://rustup.rs ）
2. C++ のビルドの道具を入れる: \`winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"\`
3. Tauri の道具を入れる: \`cargo install tauri-cli --version "^2" --locked\`
4. WebView2 は Windows 10・11 に入っているので、入れなくてよい

## exe を作る（毎回）

\`\`\`sh
ages export <プロジェクト> --desktop     # Web の書き出しを新しくする
cd <プロジェクト>/dist/desktop/src-tauri
cargo tauri build
\`\`\`

- 出来上がり: \`target/release/${name}.exe\`（これ1つで動く）と、\`target/release/bundle/\` の中のインストーラー（msi・exe）
- 試しに動かすだけなら \`cargo tauri dev\`（作るのが速い）

## 動き

- 窓の大きさは、プロジェクトの画面の大きさ（view）。大きさは変えられ、ゲームの画面は view.fit のとおりに合わせる
- 全画面: F11 か Alt+Enter で切り替える（Esc はゲームに渡る）。初めから全画面にするなら \`--fullscreen\` を付けて書き出す（\`tauri.conf.json\` の \`fullscreen\` でもよい）
- セーブ: アプリの中の保存場所（localStorage）に残る。置き場所はアプリの ID（\`tauri.conf.json\` の \`identifier\`）で決まるので、出した後は ID を変えない

## Steam に出すとき

- アプリの ID を自分のものに: \`ages export <プロジェクト> --desktop --id com.自分の名前.ゲーム\`（初めて作る前に。作った後なら \`tauri.conf.json\` の \`identifier\`）
- アイコン: \`cargo tauri icon 自分の画像.png\`（1024×1024 の PNG から、全部の大きさを作る）
- Steam の depot には \`target/release/${name}.exe\` を置く（インストーラーは要らない）
- 実績・クラウドセーブ（Steamworks）はまだつないでいない。要るときは、使う人の AI と \`src-tauri\` に足す（steamworks の Rust の部品）
`;
}

// ---------- 試しに見る（書き出したものを手元で開く） ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.frag': 'text/plain; charset=utf-8', '.glsl': 'text/plain; charset=utf-8',
};

/** 書き出した Web のフォルダを配る小さなサーバー（ages export --serve・--check） */
export function serveStatic(root: string, port: number, host = '127.0.0.1'): Promise<Server> {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(base, path));
      if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok, ng) => { server.once('error', ng); server.listen(port, host, () => ok(server)); });
}

export { ENGINE_ROOT };
