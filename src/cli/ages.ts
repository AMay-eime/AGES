// AGES の AI 向け CLI。出力はすべて短いテキスト（トークン節約）。
// 後で MCP サーバーから同じ関数を呼べるよう、各コマンドは文字列を返す関数にしてある。
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from '../project/project.ts';
import { renderAssets, renderMap } from '../project/map.ts';
import { readCursor, readLog, readTouched, summarize, writeCursor, type Actor } from '../project/oplog.ts';
import { getValue, parseLiteral, splitCell, type Op } from '../core/patch.ts';
import { brief, defaultOf, matrixSize, suggest, typeOf, type AssetKind } from '../core/schema.ts';
import { assetRefs, codeSceneRefs, isUnder } from '../core/assets.ts';
import { parseAddress } from '../core/docs.ts';
import { cellsToRows, formatDelimited, importOps, parseDelimited, tableToCells } from '../core/csv.ts';
import type { Row, TableDoc } from '../core/table.ts';
import { InputPlayback, actionsFromRows, keysToEvents, type ActionDef, type InputEvent } from '../core/input.ts';
import { GameError, type Game } from '../core/game.ts';
import { baseNameOf, frameCount, listFrames, type SheetDef } from '../core/sheet.ts';
import { autoRects, carryClips, gridRects, nameFrames, type Pixels, type Rect } from '../core/slice.ts';
import { decodePng } from '../project/png.ts';
import { shaderReport } from '../project/shader-status.ts';
import { layoutUI } from '../core/ui.ts';

const HELP = `AGES CLI — 使い方: ages <コマンド> <プロジェクト> [引数]

  init   <dir> [--name 名前]          新しいプロジェクトを作る（EDITOR-PLAN.md 付き。ゲームの企画を受けたら最初にこれ）
  map    <dir>                       プロジェクトの地図（作業のたびに最初に読む）
  schema <dir> [Component ...]       コンポーネントの詳細（型・範囲・説明）
  get    <dir> <addr> [addr ...]     値を見る（例: main#player / main#player.Player.speed / @enemy / $enemies.basic）
  set    <dir> <addr> <value> [--force]  行列のセルは addr[行,列]（例 main#spawner.Spawner.formation[2,3] 1）
  patch  <dir> <ops.json | -> [--force]   操作の配列（set/setCells/insert/removeItem/moveItem/addEntity/removeEntity/addComponent/removeComponent/rename/
               addRow/removeRow/moveRow/renameRow/setSheet/setFrame/setClip/moveAsset/removeAsset/addScene/removeScene/renameScene/setScene）
               例 {"op":"moveAsset","from":"assets/a.png","to":"assets/ships/a.png"}（フォルダも可。使っている値と切り方も一緒に動く）
               シーン: addScene{name,copy?,desc?} / removeScene{name} / renameScene{name,to} / setScene{name,desc?,start?}
  table  <dir> <表> [--cols a,b] [--rows id1,id2]   表を見る（1行1行）
               [--export x.csv] [--import x.csv [--force]]   表計算ソフトとの行き来（読み込みは表をまるごと置き換える）
  run    <dir> [--frames 600] [--scene main] [--seed 1] [--keys "0-120:ArrowLeft+KeyZ;120-200:@move_x=1;30:Mouse0+ptr=240,100"]
               [--input recordings/x.input.json] [--watch player.Health.hp,...] [--every 60] [--until gameOver | scene:result | click:ボタンのID] [--twice] [--dump]
  log    <dir> [--all] [--peek]      前回からの編集の要約（--peek は既読にしない）
  undo   <dir> [--tx id] [--force]   自分（AI）の直前の編集を元に戻す（その後で変えられた所があれば止まる）。redo <dir> でやり直す
  check  <dir>                       全データの検証とロックの検査
  assets <dir> [フォルダ] [--kind image|sound|font] [--unused] [--refs 場所]   アセットの一覧（使っている所の数）・使っている所
  sheet  <dir> <画像>                 画像の切り方（コマの名前・位置・基準点・動き）を見る
  slice  <dir> <画像> --grid 32x32 | --count 4x6 | --auto  画像を切る（前と同じ場所のコマは名前を引き継ぐ）
               [--spacing n] [--margin n] [--skip-empty] [--alpha 1] [--min 2] [--gap 0] [--pad 0] [--pivot 0.5,1] [--dry] [--force]
  コマ1つ・動き1つの変更は patch の setFrame / setClip（例 {"op":"setFrame","image":"assets/x.png","frame":"x_3","name":"hero_idle","pivot":[0.5,1]}）

アドレス: シーン#ID.コンポーネント.フィールド（例 main#player.Player.speed）、プレハブは @名前.コンポーネント.フィールド、表は $表.行.列
          リストの中は [番号]、構造体・どれか1つの中は .名前（例 main#spawner.Spawner.waves[2].count）
印: 🔒=ロック（AIは変更不可）  ★=人が調整した値（変更前に人へ確認し、--force）`;

export const AI_ACTOR: Actor = { who: process.env.AGES_AGENT ?? 'ai', kind: 'ai', win: 'cli' };

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const isMatrix = (v: unknown): v is unknown[][] => Array.isArray(v) && v.length > 0 && v.every(Array.isArray);

/** 行列は1行1行で表示する（JSONより短く、AIにも人にも読みやすい） */
function grid(v: unknown[][]): string {
  return v.map((row) => '  ' + row.map((c) => (typeof c === 'string' ? JSON.stringify(c) : String(c))).join(' ')).join('\n');
}

function compact(obj: Record<string, unknown>): string {
  return Object.entries(obj).map(([k, v]) => `${k}:${fmt(v)}`).join(' ');
}

export async function cmdMap(dir: string): Promise<string> {
  const p = await Project.load(dir);
  const plan = await planWarning(p.dir);
  return withLockReport(p, (plan ? plan + '\n' : '') + renderMap(p, await readTouched(p.dir), await p.effectiveLocks(), await p.codeRefs(), await p.windows(), codeSceneRefs(await p.codeFiles())));
}

/** エディタ計画書が未合意なら警告文を返す */
export async function planWarning(dir: string): Promise<string> {
  const text = await readFile(join(dir, 'EDITOR-PLAN.md'), 'utf8').catch(() => null);
  if (text === null) return '⚠ EDITOR-PLAN.md がありません。ゲームを作る前に、必要なエディタを使用者と決めてください（AGENTS.md「ゲームの企画を受けたら」）';
  if (!/-\s*\[x\]\s*使用者が(この計画を確認した|AIにおまかせした)/i.test(text)) {
    return '⚠ EDITOR-PLAN.md がまだ合意されていません。使用者に「一緒に決めるか、AIにおまかせか」を聞き、合意するまでゲームのコードは書かないでください';
  }
  return '';
}

const ENGINE_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** 新しいプロジェクトを作る。AIへの手順書とエディタ計画書のひな形も入れる。 */
export async function cmdInit(dir: string, name?: string): Promise<string> {
  const target = resolve(dir);
  if (existsSync(join(target, 'ages.project.json'))) throw new Error(`${dir} にはすでに AGES のプロジェクトがあります`);
  const projectName = name ?? basename(target);
  if (!/^[\w.-]+$/.test(projectName)) throw new Error(`プロジェクト名 "${projectName}" には英数字・_・-・. だけが使えます（--name で指定できます）`);
  // 共通の親フォルダがあれば相対パス、ドライブ直下まで離れていれば絶対パス（読みやすさのため）
  const rel = (relative(target, ENGINE_DIR) || '.').split(sep).join('/');
  const ups = rel.match(/\.\.\//g)?.length ?? 0;
  const engine = ups >= target.split(sep).filter(Boolean).length ? ENGINE_DIR.replace(/[\\/]$/, '').split(sep).join('/') : rel;
  const tpl = join(ENGINE_DIR, 'templates', 'new-project');
  const created: string[] = [];
  const copy = async (from: string, to: string) => {
    for (const entry of await readdir(from)) {
      const src = join(from, entry);
      const outName = entry === 'gitignore' ? '.gitignore' : entry === 'gitattributes' ? '.gitattributes' : entry;
      const dst = join(to, outName);
      if ((await stat(src)).isDirectory()) {
        await mkdir(dst, { recursive: true });
        await copy(src, dst);
      } else if (entry !== '.gitkeep') {
        await mkdir(to, { recursive: true });
        const text = (await readFile(src, 'utf8')).replaceAll('{{name}}', projectName);
        await writeFile(dst, text);
        created.push(relative(target, dst).split(sep).join('/'));
      }
    }
  };
  await copy(tpl, target);
  // AIの手順書は AGES 本体の AGENTS.md をそのまま写す（プロジェクトだけを開いたAIも手順にたどり着けるように）
  const agents = (await readFile(join(ENGINE_DIR, 'AGENTS.md'), 'utf8'))
    .replace('`ages` は `node bin/ages.js`（`npm link` で `ages` コマンドになる）。', `\`ages\` は \`node ${engine}/bin/ages.js\`（AGES本体の場所: ${engine}。本体で \`npm link\` すれば \`ages\` だけで動く）。`)
    .replaceAll('docs/PLAN.md', `${engine}/docs/PLAN.md`)
    .replaceAll('`examples/', `\`${engine}/examples/`);
  await writeFile(join(target, 'AGENTS.md'), agents);
  created.push('AGENTS.md');
  // MCP の設定（Claude Code などがこのフォルダを開くと、AGES の道具と使い方の説明が自動で渡る）
  const mcp = { mcpServers: { ages: { command: 'node', args: [`${engine}/src/mcp/server.ts`] } } };
  await writeFile(join(target, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  created.push('.mcp.json');
  return [
    `プロジェクト ${projectName} を作りました: ${dir}`,
    ...created.sort().map((f) => `  ${f}`),
    '次: EDITOR-PLAN.md の質問を使用者に確認し、必要なエディタを決める。合意するまでゲームのコードは書かない',
  ].join('\n');
}

export async function cmdSchema(dir: string, names: string[]): Promise<string> {
  const p = await Project.load(dir);
  const field = (k: string, f: import('../core/schema.ts').Field) => `  ${k} ${brief(f)}${f.desc ? ' — ' + f.desc : ''}${nested(f, '    ')}`;
  const out: string[] = [];
  const isShader = (n: string) => n.startsWith('std:') || /\.(frag|glsl)$/i.test(n);
  const comps = names.length ? names.filter((n) => !n.startsWith('$') && !isShader(n)) : [...p.registry.components.keys()];
  const tables = names.length ? names.filter((n) => n.startsWith('$')).map((n) => n.slice(1)) : [...p.registry.tables.keys()];
  for (const n of comps) { const d = p.registry.component(n); out.push(`${d.name}: ${d.desc}`, ...Object.entries(d.fields).map(([k, f]) => field(k, f))); }
  for (const n of tables) { const t = p.registry.table(n); out.push(`$${t.name}: ${t.desc ?? ''}（表。列 id は行の名前）`, ...Object.entries(t.columns).map(([k, f]) => field(k, f))); }
  for (const n of names.filter(isShader)) {
    const d = p.registry.shaders.get(n);
    if (!d) throw new Error(`シェーダー ${n} はありません${suggest(n, [...p.registry.shaders.keys()])}`);
    out.push(`${d.path}: ${d.desc}（シェーダー。Effect / PostEffect の shader で選び、値は params.名前。トゥイーンは 'Effect.params.名前'）`, ...Object.entries(d.uniforms).map(([k, f]) => field(k, f)));
    out.push(SHADER_HOWTO);
    if (d.path.startsWith('std:')) out.push(`--- ${d.path} の中身（新しく書くときの手本）`, d.code.trimEnd());
    for (const e of d.errors) out.push(`⚠ ${e}`);
  }
  return out.join('\n');
}

const SHADER_HOWTO = `書き方（assets/ の下に .frag を置く）: 先頭のコメントが説明。uniform は1行に1つ「uniform float amount; // 0..1 =0 説明」（float・int・bool・vec2・vec3/vec4 は色 =#rrggbb・sampler2D は画像 =assets/x.png）。
関数 vec4 effect(vec4 c, vec2 uv) だけを書く（c はその点の色、uv はテクスチャの座標）。使えるもの: frameUV(uv)（コマの中の 0〜1、左上が 0）・pick(uv)（その座標の色。コマの外は透明）・u_texel（1px）・u_res（描く先の px）・u_time（秒）・v_color（tint と alpha）。#version・precision・main は書かない。
コンパイルできるかはエディタが確かめ、エラーは ages check に「ファイル:行」で出る`;

/** 構造体・どれか1つの中の項目の説明（あるものだけ） */
function nested(f: import('../core/schema.ts').Field, pad: string): string {
  const inner = f.type === 'list' ? f.of : f;
  const lines: string[] = [];
  if (inner.type === 'struct') for (const [k, sf] of Object.entries(inner.fields)) if (sf.desc) lines.push(`${pad}${k} ${typeOf(sf)} — ${sf.desc}`);
  if (inner.type === 'oneOf') for (const [k, v] of Object.entries(inner.variants)) lines.push(`${pad}${k}: ${v.desc ?? ''}${Object.entries(v.fields).map(([fk, sf]) => ` ${fk}:${typeOf(sf)}${sf.desc ? `（${sf.desc}）` : ''}`).join('')}`);
  return lines.length ? '\n' + lines.join('\n') : '';
}

export async function cmdGet(dir: string, addrs: string[]): Promise<string> {
  const p = await Project.load(dir);
  const touched = await readTouched(p.dir);
  const locks = await p.effectiveLocks();
  const mark = (path: string) => (locks[path] ? '🔒' : touched[path] ? '★' : '');
  const show = (v: unknown) => (isMatrix(v) ? `行列${matrixSize(v)}` : fmt(v));
  const out: string[] = [];
  for (const addr of addrs) {
    const a = parseAddress(addr);
    const { value, isDefault } = getValue(p.docs, p.registry, addr);
    if (a.kind === 'table' && !a.entity) { out.push(renderTable(p, a.doc, (value as TableDoc).rows, undefined, locks, touched)); continue; }
    if (a.kind === 'table' && !a.field) {
      const def = p.registry.table(a.doc);
      const row = value as Row;
      out.push(`${addr} { ${Object.keys(def.columns).map((k) => (k in row ? `${k}:${show(row[k])}${mark(`${addr}.${k}`)}` : `${k}:${show(defaultOf(def.columns[k]))}°`)).join(' ')} }`);
      continue;
    }
    if (a.field) {
      if (isMatrix(value)) out.push(`${addr} = 行列 ${matrixSize(value)}${isDefault ? '（既定値）' : ''}${mark(addr)}\n${grid(value)}`);
      else out.push(`${addr} = ${fmt(value)}${isDefault ? '（既定値）' : ''}${mark(addr)}`);
    } else if (a.component) {
      const comp = value as Record<string, unknown>;
      const def = p.registry.component(a.component);
      const fields = Object.entries(def.fields).map(([k, f]) => (k in comp ? `${k}:${show(comp[k])}${mark(`${addr}.${k}`)}` : `${k}:${show(defaultOf(f))}°`));
      out.push(`${addr} { ${fields.join(' ')} }`);
    } else {
      const h = value as { name?: string; tags?: string[]; components: Record<string, Record<string, unknown>> };
      out.push(`${addr}${h.name ? ` "${h.name}"` : ''}${h.tags?.length ? ' tags:' + h.tags.join(',') : ''}`);
      for (const [cn, cv] of Object.entries(h.components)) {
        const fields = Object.entries(cv).map(([k, v]) => `${k}:${show(v)}${mark(`${addr}.${cn}.${k}`)}`).join(' ');
        out.push(`  ${cn} { ${fields} }`);
      }
    }
  }
  if (out.some((l) => l.includes('°'))) out.push('（°=省略されていて既定値）');
  return withLockReport(p, out.join('\n'));
}

/** 表を1行1行で（タブ区切り。入れ子の値は JSON）。🔒★ は最後にまとめる */
function renderTable(p: Project, name: string, rows: Row[], cols: string[] | undefined, locks: Record<string, unknown>, touched: Record<string, unknown>): string {
  const def = p.registry.table(name);
  const cells = tableToCells(def, rows, cols);
  const lk = Object.keys(locks).filter((k) => k.startsWith(`$${name}.`));
  const tc = Object.keys(touched).filter((k) => k.startsWith(`$${name}.`) && !locks[k]);
  return [`$${name} ${rows.length}行${def.desc ? ' — ' + def.desc : ''}`, ...cells.map((r) => r.join('\t')),
    lk.length ? `🔒 ${lk.map((k) => k.slice(name.length + 2)).join(' ')}` : '', tc.length ? `★ ${tc.map((k) => k.slice(name.length + 2)).join(' ')}` : ''].filter(Boolean).join('\n');
}

export async function cmdTable(dir: string, name: string, flags: Record<string, string | true>): Promise<string> {
  const p = await Project.load(dir);
  const def = p.registry.table(name);
  const doc = p.docs.tables.get(name) ?? { name, rows: [] };
  const list = (v: string | true | undefined) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  if (typeof flags.import === 'string') {
    const cells = parseDelimited(await readFile(resolve(flags.import), 'utf8'));
    const ops = importOps(def, doc.rows, cellsToRows(def, cells));
    if (!ops.length) return '変更なし（読み込んだ内容と同じです）';
    const r = await p.apply(ops, AI_ACTOR, { force: flags.force === true });
    const n = (k: string) => r.changes.filter((c) => (k === 'add' ? c.to === 'added' : k === 'rm' ? c.to === 'removed' : c.to !== 'added' && c.to !== 'removed')).length;
    return `ok $${name} を読み込みました（行の追加 ${n('add')}・削除 ${n('rm')}・値の変更 ${n('set')}）`;
  }
  const cols = list(flags.cols);
  for (const c of cols ?? []) if (!def.columns[c]) throw new Error(`表 ${name} に列 ${c} はありません${suggest(c, Object.keys(def.columns))}`);
  const only = list(flags.rows);
  const rows = only ? doc.rows.filter((r) => only.includes(r.id)) : doc.rows;
  if (typeof flags.export === 'string') {
    const path = resolve(flags.export);
    await writeFile(path, formatDelimited(tableToCells(def, rows, cols), path.endsWith('.tsv') ? '\t' : ','));
    return `ok $${name} を ${flags.export} に書き出しました（${rows.length}行）`;
  }
  return withLockReport(p, renderTable(p, name, rows, cols, await p.effectiveLocks(), await readTouched(p.dir)));
}

export async function cmdPatch(dir: string, ops: Op[], force: boolean): Promise<string> {
  const p = await Project.load(dir);
  const r = await p.apply(ops, AI_ACTOR, { force });
  if (!r.changes.length) return '変更なし（すでに同じ値です）';
  const show = (v: unknown) => (isMatrix(v) ? `行列${matrixSize(v)}` : fmt(v));
  return [...r.changes.map((c) => (c.to === 'added' || c.to === 'removed' ? `ok ${c.path} ${c.to === 'added' ? '追加' : '削除'}`
    : typeof c.to === 'string' && c.to.startsWith('renamed:') && c.path.startsWith('scene:') ? `ok ${c.path} → scene:${c.to.slice('renamed:'.length)}（名前の変更）`
    : typeof c.to === 'string' && c.to.startsWith('renamed:') ? `ok ${c.path} → ${c.path.replace(/[^.]+$/, c.to.slice('renamed:'.length))}（ID の変更）`
    : c.path.startsWith('file:') ? `ok ${c.path} → ${c.to}（場所の変更）`
    : `ok ${c.path} ${show(c.from)} → ${show(c.to)}${c.auto ? '（自動）' : ''}`)), ...(r.warnings ?? []).map((w) => `⚠ ${w}`)].join('\n');
}

/** 元に戻す（--redo でやり直す）。省くと AI 自身の直前の編集 */
export async function cmdUndo(dir: string, f: Args['flags']): Promise<string> {
  const p = await Project.load(dir);
  const r = await p.undo(AI_ACTOR, { tx: typeof f.tx === 'string' ? f.tx : undefined, redo: !!f.redo, force: !!f.force });
  const lines = r.changes.map((c) => `ok ${c.path} ${fmt(c.from)} → ${fmt(c.to)}${c.auto ? '（自動）' : ''}`);
  const next = await p.undoState(AI_ACTOR);
  return withLockReport(p, [`${f.redo ? 'やり直した' : '元に戻した'}: ${r.label}`, ...lines, ...(r.warnings ?? []).map((w) => `⚠ ${w}`), `次に戻せる: ${next.undo?.label ?? 'なし'}${next.redo ? ` ／ やり直せる: ${next.redo.label}` : ''}`].join('\n'));
}

/** アセットの一覧（フォルダごと・使っている所の数）。refs を渡すと、そのアセットを使っている所 */
export async function cmdAssets(dir: string, folder: string | undefined, f: Args['flags']): Promise<string> {
  const p = await Project.load(dir);
  const code = await p.codeRefs();
  if (typeof f.refs === 'string') {
    const path = f.refs;
    const a = p.assets.find((x) => x.path === path);
    if (!a) {
      const inside = p.assets.filter((x) => isUnder(x.path, path.replace(/\/+$/, '')));
      if (!inside.length) throw new Error(`ファイル ${path} はありません${suggest(path, p.assets.map((x) => x.path))}`);
    }
    const refs = assetRefs(p.docs, p.registry);
    const targets = a ? [a.path] : p.assets.filter((x) => isUnder(x.path, path.replace(/\/+$/, ''))).map((x) => x.path);
    const lines: string[] = [];
    for (const t of targets) {
      const at = [...(refs.get(t) ?? []), ...(code.get(t) ?? []).map((c) => `${c}（コード）`)];
      lines.push(`${t}: ${at.length ? at.join(' ') : '未使用'}`);
    }
    return lines.join('\n');
  }
  const kind = typeof f.kind === 'string' ? f.kind : undefined;
  if (kind && !['image', 'sound', 'font'].includes(kind)) throw new Error(`--kind は image / sound / font のどれかです${suggest(kind, ['image', 'sound', 'font'])}`);
  const lines = renderAssets(p, { touched: await readTouched(p.dir), locks: await p.effectiveLocks(), code, folder: folder?.replace(/\/+$/, ''), kind: kind as AssetKind | undefined, unused: !!f.unused, counts: true });
  const n = lines.filter((l) => l.startsWith('  ')).length;
  if (!n) return folder || kind || f.unused ? '該当するアセットはありません' : 'アセットはまだありません（assets/ にファイルを置く）';
  return [`アセット ${n}件${f.unused ? '（未使用）' : ''}。場所を変える: patch の moveAsset（使っている値も直る）／消す: removeAsset（使っていないものだけ）`, ...lines].join('\n');
}

/** プロジェクトの操作の名前と割り当て（$actions） */
export function actionsOf(p: Project): Map<string, ActionDef> {
  return actionsFromRows(p.registry.tableView('actions').rows);
}

function readWatch(game: Game, addr: string): unknown {
  const s = addr.includes('#') ? addr.slice(addr.indexOf('#') + 1) : addr;
  const [id, comp, field] = s.split('.');
  const e = game.world.get(id);
  if (!e) return '—';
  if (!comp) return 'alive';
  const c = e.c[comp];
  if (!c) return '—';
  return field ? c[field] : c;
}

export async function cmdRun(dir: string, f: Args['flags']): Promise<string> {
  const p = await Project.load(dir);
  const frames = Number(f.frames ?? 600);
  const scene = typeof f.scene === 'string' ? f.scene : p.config.startScene;
  const seed = f.seed !== undefined ? Number(f.seed) : p.config.seed;
  let events: InputEvent[] = [];
  if (typeof f.input === 'string') events = JSON.parse(await readFile(`${p.dir}/${f.input}`, 'utf8')).events;
  // click=ボタンのID は、そのフレームのボタンの真ん中を押す（位置を数えなくてよい）
  const clicks = new Map<number, string>();
  if (typeof f.keys === 'string') {
    const spec = f.keys.split(';').map((seg) => {
      const m = seg.trim().match(/^(\d+):(.+)$/);
      if (!m) return seg;
      const rest = m[2].split('+').filter((tok) => {
        const c = tok.trim().match(/^click=([A-Za-z_][\w~-]*)$/);
        if (c) clicks.set(Number(m[1]), c[1]);
        return !c;
      });
      return rest.length ? `${m[1]}:${rest.join('+')}` : '';
    }).filter(Boolean).join(';');
    events = keysToEvents(spec, actionsOf(p));
  }
  const watch = typeof f.watch === 'string' ? f.watch.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const every = f.every !== undefined ? Number(f.every) : 0;
  const until = typeof f.until === 'string' ? f.until : '';

  const once = () => {
    const game = p.newGame(scene, seed);
    const play = new InputPlayback(events);
    const lines: string[] = [];
    const first = watch.map((w) => readWatch(game, w));
    let stopped = '';
    if (until.startsWith('scene:')) game.sceneListeners.push((_from, to) => { if (to === until.slice(6) && !stopped) stopped = `${until} @f${game.frame}`; });
    else if (until.startsWith('click:')) game.listeners.push((ev) => { if (ev.name === 'ui.click' && (ev.data as { id?: string })?.id === until.slice(6) && !stopped) stopped = `${until} @f${ev.frame}`; });
    else if (until) game.listeners.push((ev) => { if (ev.name === until && !stopped) stopped = `${until} @f${ev.frame}`; });
    const t0 = performance.now();
    try {
      for (let i = 0; i < frames && !stopped; i++) {
        const inp = play.at(game.frame);
        const target = clicks.get(game.frame) ?? clicks.get(game.frame - 1);
        if (target) {
          const r = layoutUI(game.world, p.config.view.width, p.config.view.height).get(target);
          if (!r) {
            if (clicks.get(game.frame)) lines.push(`⚠ f${game.frame} click=${target}: UI の付いた物 ${target} がありません${suggest(target, [...game.world.entities.values()].filter((e) => e.c.UI).map((e) => e.id))}`);
          } else {
            inp.pointer = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
            if (clicks.get(game.frame) === target) inp.buttons = [...inp.buttons, 'Mouse0'];
            else inp.buttons = [...inp.buttons].filter((b) => b !== 'Mouse0');
          }
        }
        game.step(inp);
        if (every && game.frame % every === 0) {
          lines.push(`f${game.frame} ` + watch.map((w) => `${w.split('.').pop()}=${fmt(readWatch(game, w))}`).join(' '));
        }
      }
    } catch (err) {
      if (err instanceof GameError) {
        lines.push(`error: ${err.message}`);
        const stack = (err.cause as Error)?.stack?.split('\n').find((l) => l.includes('/game/'));
        if (stack) lines.push(`  at ${stack.trim().replace(/^at /, '').replace('file://' + p.dir + '/', '')}`);
      } else throw err;
    }
    return { game, lines, first, ms: performance.now() - t0, stopped };
  };

  const r = once();
  const g = r.game;
  const out: string[] = [];
  out.push(`run ${scene} seed${seed} ${g.frame}f (${(g.frame / p.config.fps).toFixed(1)}s) ${r.ms.toFixed(0)}ms hash=${g.hash()}${r.stopped ? ' 停止:' + r.stopped : ''}`);
  out.push(...r.lines);
  const counts = [...g.counts.entries()].map(([k, v]) => `${k}×${v}`).join(' ');
  out.push(`events: ${counts || 'なし'}`);
  if (g.sceneLog.length > 1) out.push(`scenes: ${g.sceneLog.map((x) => `${x.name}@${x.frame}`).join(' → ')}${g.transition ? `（${g.transition.phase === 'out' ? '消えていく途中' : '出てくる途中'}）` : ''}`);
  if (g.soundCounts.size) out.push(`sounds: ${[...g.soundCounts.entries()].map(([k, v]) => `♪${k}×${v}`).join(' ')}`);
  if (g.uiCounts.size) out.push(`ui: 押されたボタン ${[...g.uiCounts.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}`);
  if (g.particleCounts.size) out.push(`particles: ${[...g.particleCounts.entries()].map(([k, v]) => `✦${k}×${v}`).join(' ')}`);
  if (g.tweens.length) out.push(`tweens: 動いている ${g.tweens.length}（${[...new Set(g.tweens.map((t) => `${t.comp}.${t.field}${t.sub ? "." + t.sub : ""}`))].join(' ')}）`);
  for (const w of g.warnings) out.push(`⚠ ${w}`);
  const byName = new Map<string, number>();
  for (const e of g.world.entities.values()) byName.set(e.prefab ? '@' + e.prefab : e.id, (byName.get(e.prefab ? '@' + e.prefab : e.id) ?? 0) + 1);
  out.push(`entities: ${g.world.entities.size} (${[...byName.entries()].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(' ')})`);
  watch.forEach((w, i) => out.push(`watch ${w}: ${fmt(r.first[i])} → ${fmt(readWatch(g, w))}`));
  if (f.twice) {
    const r2 = once();
    out.push(r2.game.hash() === g.hash() ? '再現性: OK（2回とも同じ結果）' : `再現性: NG（hash ${g.hash()} と ${r2.game.hash()}）。Math.random や実時間を使っていないか確認してください`);
  }
  if (f.dump) out.push(JSON.stringify(g.snapshot()));
  return withLockReport(p, out.join('\n'));
}

export async function cmdLog(dir: string, f: Args['flags']): Promise<string> {
  const p = new Project(dir);
  const all = await readLog(p.dir);
  const cursor = f.all ? 0 : await readCursor(p.dir);
  const entries = all.slice(cursor);
  if (!f.peek) await writeCursor(p.dir, all.length);
  const humans = entries.filter((e) => e.kind !== 'ai');
  const head = f.all ? `全${all.length}件` : `前回から${entries.length}件（うち人・AGES ${humans.length}件）`;
  return `${head}\n${summarize(f.all ? entries : humans.length ? humans : entries)}`;
}

export async function cmdCheck(dir: string): Promise<string> {
  const p = await Project.load(dir);
  const sh = await shaderReport(p.dir, p.assets);
  const errs = [...p.validate(), ...(await p.checkCode()), ...(await p.checkWindows()), ...sh.errors];
  // シェーダーがコンパイルできるかはブラウザでしか分からない。エディタが開いていれば、変わるたびに確かめる
  const note = sh.unchecked.length ? `\nシェーダー ${sh.unchecked.join(' ')} はまだコンパイルを確かめていません（エディタを開いていると、変えるたびに確かめて ages check に出ます）` : '';
  return withLockReport(p, (errs.length ? errs.map((e) => `error: ${e}`).join('\n') : `ok（シーン${p.docs.scenes.size} プレハブ${p.docs.prefabs.size} コンポーネント${p.registry.components.size} システム${p.registry.systems.length}）`) + note);
}

function imageOf(p: Project, image: string): { w: number; h: number } {
  const size = p.registry.images.get(image);
  if (!size) throw new Error(`画像 ${image} がありません${suggest(image, [...p.registry.images.keys()])}`);
  return size;
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000).replace(/^0\./, '.'));

/** 切り方を短いテキストで（格子はコマを並べない。位置は計算で決まるので） */
export function describeSheet(image: string, sheet: SheetDef | undefined, w: number, h: number, marks = ''): string {
  if (!sheet) return `${image} ${w}x${h} シートなし（画像全体を1コマとして描く）。切るには ages slice${marks}`;
  const out: string[] = [];
  const n = frameCount(sheet, w, h);
  if (sheet.frames) {
    out.push(`${image} ${w}x${h} 自由 ${n}コマ（#番号 名前 x,y 幅x高さ 基準点）${marks}`);
    for (const f of listFrames(sheet, w, h)) out.push(`#${f.index} ${f.name} ${f.x},${f.y} ${f.w}x${f.h}${f.pivot ? ` pivot ${f.pivot.map(num).join(',')}` : ''}`);
  } else {
    out.push(`${image} ${w}x${h} 格子 ${sheet.frame!.join('x')}${sheet.spacing ? ` 隙間${sheet.spacing}` : ''}${sheet.margin ? ` 余白${sheet.margin}` : ''} → ${n}コマ（番号で指定。左上から右へ0から）${marks}`);
  }
  const clips = Object.entries(sheet.clips ?? {});
  if (clips.length) out.push('動き:', ...clips.map(([k, c]) => `  ${k} ${c.frames.join(',')} ${c.fps}fps${c.loop === false ? ' 1回' : ''}`));
  return out.join('\n');
}

export async function cmdSheet(dir: string, image: string): Promise<string> {
  const p = await Project.load(dir);
  const size = imageOf(p, image);
  const locks = await p.effectiveLocks();
  const touched = await readTouched(dir);
  const root = `sheet:${image}`;
  const marks = locks[root] ? ' 🔒（AIは変更不可）' : touched[root] ? ` ★人が調整（${touched[root].who}。変更前に人へ確認し --force）` : '';
  return withLockReport(p, describeSheet(image, p.docs.sheets.get(image), size.w, size.h, marks));
}

const pair = (v: string | true | undefined, what: string): [number, number] => {
  const m = typeof v === 'string' ? v.match(/^(\d+)[x,](\d+)$/) : null;
  if (!m) throw new Error(`${what} は 幅x高さ の形で指定します（例 32x32）`);
  return [Number(m[1]), Number(m[2])];
};
const numFlag = (v: string | true | undefined, d: number) => (typeof v === 'string' ? Number(v) : d);

export async function cmdSlice(dir: string, image: string, flags: Record<string, string | true>): Promise<string> {
  const p = await Project.load(dir);
  const { w, h } = imageOf(p, image);
  const before = p.docs.sheets.get(image);
  const spacing = numFlag(flags.spacing, 0), margin = numFlag(flags.margin, 0);
  const pivot = typeof flags.pivot === 'string' ? (flags.pivot.split(',').map(Number) as [number, number]) : undefined;
  if (pivot && (pivot.length !== 2 || pivot.some((n) => !Number.isFinite(n)))) throw new Error('--pivot は 横,縦 の数で指定します（例 0.5,1 = 下の中央）');
  let pixels: Pixels | undefined;
  const needPixels = flags.auto === true || flags['skip-empty'] === true;
  if (needPixels) {
    if (!/\.png$/i.test(image)) throw new Error('自動で切る・空のコマを除くのは PNG だけです。ほかの形式はエディタの「切り方」画面を使ってください');
    pixels = decodePng(await readFile(join(dir, image)));
  }
  let next: SheetDef;
  if (flags.grid && !flags['skip-empty'] && !pivot && (!before || !before.frames)) {
    // 格子のまま（ファイルが短く、番号での指定もそのまま）
    next = { frame: pair(flags.grid, '--grid') };
    if (spacing) next.spacing = spacing;
    if (margin) next.margin = margin;
  } else {
    let rects: Rect[];
    if (flags.auto) rects = autoRects(pixels!, { alpha: numFlag(flags.alpha, 1), minSize: numFlag(flags.min, 2), gap: numFlag(flags.gap, 0), pad: numFlag(flags.pad, 0) });
    else if (flags.grid || flags.count) rects = gridRects(w, h, { cell: flags.grid ? pair(flags.grid, '--grid') : undefined, count: flags.count ? pair(flags.count, '--count') : undefined, spacing, margin, skipEmpty: flags['skip-empty'] === true }, pixels);
    else throw new Error('切り方を --grid 32x32 / --count 4x6 / --auto のどれかで指定してください');
    if (!rects.length) throw new Error('コマが1つも見つかりませんでした（透明な画像か、--alpha・--min が大きすぎます）');
    // 前が自由な矩形なら、同じ場所のコマの名前と基準点を引き継ぐ（前が格子なら名前はないので、新しく付ける）
    next = { frames: nameFrames(rects, baseNameOf(image), before?.frames ?? [], pivot) };
  }
  const carried = carryClips(before, next, w, h);
  if (carried.missing.length) throw new Error(`この切り方では、動きが使っているコマが無くなります: ${carried.missing.join(', ')}。先に動きを直すか（setClip）、切り方を変えてください`);
  if (carried.clips) next.clips = carried.clips;
  const summary = describeSheet(image, next, w, h);
  if (flags.dry) return `（試しに切っただけで、保存していません）\n${summary}`;
  const r = await p.apply([{ op: 'setSheet', image, sheet: next }], AI_ACTOR, { force: flags.force === true });
  const refs = r.changes.filter((c) => !c.path.startsWith('sheet:'));
  return [summary, refs.length ? `番号のずれに合わせて直した指定: ${refs.map((c) => `${c.path} ${fmt(c.from)}→${fmt(c.to)}`).join(', ')}` : ''].filter(Boolean).join('\n');
}

function withLockReport(p: Project, text: string): string {
  return p.lockReport.length ? `${p.lockReport.map((l) => '🔒 ' + l).join('\n')}\n${text}` : text;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  const dir = a.pos[0];
  if (!cmd || cmd === 'help' || !dir) { console.log(HELP); return; }
  const force = a.flags.force === true;
  let out: string;
  switch (cmd) {
    case 'init': out = await cmdInit(dir, typeof a.flags.name === 'string' ? a.flags.name : undefined); break;
    case 'map': out = await cmdMap(dir); break;
    case 'schema': out = await cmdSchema(dir, a.pos.slice(1)); break;
    case 'get': out = await cmdGet(dir, a.pos.slice(1)); break;
    case 'set': {
      const [, addr, value] = a.pos;
      if (!addr || value === undefined) throw new Error('使い方: ages set <dir> <アドレス> <値>');
      const { path, cell } = splitCell(addr);
      const op: Op = cell
        ? { op: 'setCells', path, cells: [[cell[0], cell[1], parseLiteral(value) as number]] }
        : { op: 'set', path, value: parseLiteral(value) };
      out = await cmdPatch(dir, [op], force);
      break;
    }
    case 'patch': {
      const src = a.pos[1];
      const text = !src || src === '-' ? await readStdin() : src.trim().startsWith('[') ? src : await readFile(src, 'utf8');
      out = await cmdPatch(dir, JSON.parse(text), force);
      break;
    }
    case 'run': out = await cmdRun(dir, a.flags); break;
    case 'log': out = await cmdLog(dir, a.flags); break;
    case 'check': out = await cmdCheck(dir); break;
    case 'assets': out = await cmdAssets(dir, a.pos[1], a.flags); break;
    case 'undo': out = await cmdUndo(dir, a.flags); break;
    case 'redo': out = await cmdUndo(dir, { ...a.flags, redo: true }); break;
    case 'sheet': out = await cmdSheet(dir, need(a.pos[1], '画像の場所（例 assets/hero.png）')); break;
    case 'slice': out = await cmdSlice(dir, need(a.pos[1], '画像の場所（例 assets/hero.png）'), a.flags); break;
    case 'table': out = await cmdTable(dir, need(a.pos[1], '表の名前（例 enemies）').replace(/^\$/, ''), a.flags); break;
    default: throw new Error(`未知のコマンド ${cmd}。ages help で一覧を表示します`);
  }
  console.log(out);
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`${what} が必要です`);
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bin/ages.js')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
