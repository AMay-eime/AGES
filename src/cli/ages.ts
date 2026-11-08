// AGES の AI 向け CLI。出力はすべて短いテキスト（トークン節約）。
// 後で MCP サーバーから同じ関数を呼べるよう、各コマンドは文字列を返す関数にしてある。
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from '../project/project.ts';
import { renderMap } from '../project/map.ts';
import { readCursor, readLog, readTouched, summarize, writeCursor, type Actor } from '../project/oplog.ts';
import { getValue, parseLiteral, splitCell, type Op } from '../core/patch.ts';
import { brief, matrixSize } from '../core/schema.ts';
import { InputPlayback, type InputEvent } from '../core/input.ts';
import { GameError, type Game } from '../core/game.ts';

const HELP = `AGES CLI — 使い方: ages <コマンド> <プロジェクト> [引数]

  init   <dir> [--name 名前]          新しいプロジェクトを作る（EDITOR-PLAN.md 付き。ゲームの企画を受けたら最初にこれ）
  map    <dir>                       プロジェクトの地図（作業のたびに最初に読む）
  schema <dir> [Component ...]       コンポーネントの詳細（型・範囲・説明）
  get    <dir> <addr> [addr ...]     値を見る（例: main#player / main#player.Player.speed / @enemy）
  set    <dir> <addr> <value> [--force]  行列のセルは addr[行,列]（例 main#spawner.Spawner.formation[2,3] 1）
  patch  <dir> <ops.json | -> [--force]   操作の配列（set/setCells/addEntity/removeEntity/addComponent/removeComponent/rename）
  run    <dir> [--frames 600] [--scene main] [--seed 1] [--keys "0-120:ArrowLeft+KeyZ;120-200:ArrowRight"]
               [--input recordings/x.input.json] [--watch player.Health.hp,...] [--every 60] [--until gameOver] [--twice] [--dump]
  log    <dir> [--all] [--peek]      前回からの編集の要約（--peek は既読にしない）
  check  <dir>                       全データの検証とロックの検査

アドレス: シーン#ID.コンポーネント.フィールド（例 main#player.Player.speed）、プレハブは @名前.コンポーネント.フィールド
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
  return withLockReport(p, (plan ? plan + '\n' : '') + renderMap(p, await readTouched(p.dir), await p.effectiveLocks()));
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
  const defs = names.length ? names.map((n) => p.registry.component(n)) : [...p.registry.components.values()];
  return defs.map((d) => [`${d.name}: ${d.desc}`, ...Object.entries(d.fields).map(([k, f]) => `  ${k} ${brief(f)}${f.desc ? ' — ' + f.desc : ''}`)].join('\n')).join('\n');
}

export async function cmdGet(dir: string, addrs: string[]): Promise<string> {
  const p = await Project.load(dir);
  const touched = await readTouched(p.dir);
  const locks = await p.effectiveLocks();
  const mark = (path: string) => (locks[path] ? '🔒' : touched[path] ? '★' : '');
  const out: string[] = [];
  for (const addr of addrs) {
    const { value, isDefault } = getValue(p.docs, p.registry, addr);
    const parts = addr.split('.');
    if (parts.length === 3) {
      if (isMatrix(value)) out.push(`${addr} = 行列 ${matrixSize(value)}${isDefault ? '（既定値）' : ''}${mark(addr)}\n${grid(value)}`);
      else out.push(`${addr} = ${fmt(value)}${isDefault ? '（既定値）' : ''}${mark(addr)}`);
    } else if (parts.length === 2) {
      const comp = value as Record<string, unknown>;
      const fields = Object.keys(p.registry.component(parts[1]).fields).map((k) => {
        const path = `${addr}.${k}`;
        const v = k in comp ? comp[k] : p.registry.component(parts[1]).fields[k].default;
        const shown = isMatrix(v) || (Array.isArray(v) && p.registry.component(parts[1]).fields[k].type === 'matrix') ? `行列${matrixSize(v)}` : fmt(v);
        return k in comp ? `${k}:${shown}${mark(path)}` : `${k}:${shown}°`;
      });
      out.push(`${addr} { ${fields.join(' ')} }`);
    } else {
      const h = value as { name?: string; tags?: string[]; components: Record<string, Record<string, unknown>> };
      out.push(`${addr}${h.name ? ` "${h.name}"` : ''}${h.tags?.length ? ' tags:' + h.tags.join(',') : ''}`);
      for (const [cn, cv] of Object.entries(h.components)) {
        const fields = Object.entries(cv).map(([k, v]) => `${k}:${isMatrix(v) ? `行列${matrixSize(v)}` : fmt(v)}${mark(`${addr}.${cn}.${k}`)}`).join(' ');
        out.push(`  ${cn} { ${fields} }`);
      }
    }
  }
  if (out.some((l) => l.includes('°'))) out.push('（°=省略されていて既定値）');
  return withLockReport(p, out.join('\n'));
}

export async function cmdPatch(dir: string, ops: Op[], force: boolean): Promise<string> {
  const p = await Project.load(dir);
  const r = await p.apply(ops, AI_ACTOR, { force });
  if (!r.changes.length) return '変更なし（すでに同じ値です）';
  const show = (v: unknown) => (isMatrix(v) ? `行列${matrixSize(v)}` : fmt(v));
  return r.changes.map((c) => (c.to === 'added' || c.to === 'removed' ? `ok ${c.path} ${c.to === 'added' ? '追加' : '削除'}` : `ok ${c.path} ${show(c.from)} → ${show(c.to)}`)).join('\n');
}

/** "0-120:ArrowLeft+KeyZ;120-200:ArrowRight" を入力の記録に変換する */
export function keysToEvents(spec: string): InputEvent[] {
  const timeline = new Map<number, { d: string[]; u: string[] }>();
  const at = (f: number) => timeline.get(f) ?? (timeline.set(f, { d: [], u: [] }), timeline.get(f)!);
  for (const seg of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = seg.match(/^(\d+)-(\d+):(.+)$/);
    if (!m) throw new Error(`--keys の書き方が違います: "${seg}"。例: 0-120:ArrowLeft+KeyZ`);
    const [, a, b, keys] = m;
    for (const k of keys.split('+')) {
      at(Number(a)).d.push(k);
      at(Number(b)).u.push(k);
    }
  }
  return [...timeline.entries()].sort((x, y) => x[0] - y[0]).map(([f, v]) => {
    const ev: InputEvent = { f };
    if (v.d.length) ev.d = v.d;
    if (v.u.length) ev.u = v.u;
    return ev;
  });
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
  if (typeof f.keys === 'string') events = keysToEvents(f.keys);
  const watch = typeof f.watch === 'string' ? f.watch.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const every = f.every !== undefined ? Number(f.every) : 0;
  const until = typeof f.until === 'string' ? f.until : '';

  const once = () => {
    const game = p.newGame(scene, seed);
    const play = new InputPlayback(events);
    const lines: string[] = [];
    const first = watch.map((w) => readWatch(game, w));
    let stopped = '';
    if (until) game.listeners.push((ev) => { if (ev.name === until && !stopped) stopped = `${until} @f${ev.frame}`; });
    const t0 = performance.now();
    try {
      for (let i = 0; i < frames && !stopped; i++) {
        game.step(play.keysAt(game.frame));
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
  const errs = p.validate();
  return withLockReport(p, errs.length ? errs.map((e) => `error: ${e}`).join('\n') : `ok（シーン${p.docs.scenes.size} プレハブ${p.docs.prefabs.size} コンポーネント${p.registry.components.size} システム${p.registry.systems.length}）`);
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
    default: throw new Error(`未知のコマンド ${cmd}。ages help で一覧を表示します`);
  }
  console.log(out);
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
