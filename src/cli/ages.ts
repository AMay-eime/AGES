// AGES の AI 向け CLI。出力はすべて短いテキスト（トークン節約）。
// 後で MCP サーバーから同じ関数を呼べるよう、各コマンドは文字列を返す関数にしてある。
import { engineCommitFull, engineOnRemote, engineVersion, formatVersion, migrations, recordVersion, versionNote } from '../project/version.ts';
import { readFile, writeFile, readdir, mkdir, stat, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative, basename, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from '../project/project.ts';
import { indexDepth, renderAssets, renderMap, renderMapSection } from '../project/map.ts';
import { findInProject } from '../project/find.ts';
import { codeDefs } from '../project/codedefs.ts';
import { codeQuery, indexCode } from '../project/code.ts';
import { noteCodeEdits, noteRecent, placeOf, readRecent, recentFor, topRecent } from '../project/recent.ts';
import { eventWarnings } from '../project/events.ts';
import { focusLine, readFocus, withFocus } from '../project/focus.ts';
import { EXPORT_MARK, exportProject, serveStatic } from '../project/export.ts';
import { writeLaunchers } from '../project/launchers.ts';
import { checkExport } from './export-check.ts';
import { readCursor, readLog, readTouched, summarize, writeCursor, type Actor } from '../project/oplog.ts';
import { OP_DOCS, getValue, parseLiteral, splitCell, type Op } from '../core/patch.ts';
import { readGuide, readPackageGuide } from '../project/guide.ts';
import { PACKAGE_LIST, loadPackageCommands } from '../packages/index.ts';
import type { PackageCommand } from '../core/packages.ts';
import { activeTask, appendTalk, foldTalk, newId, readTalk, readTalkCursor, talkNotice, talkView, writeTalkCursor } from '../project/talk.ts';
import { ASSET_EXT, brief, defaultOf, matrixSize, suggest, typeOf, type AssetKind } from '../core/schema.ts';
import { assetRefs, codeSceneRefs, isUnder } from '../core/assets.ts';
import { parseAddress } from '../core/docs.ts';
import { cellsToRows, formatDelimited, importOps, parseDelimited, tableToCells } from '../core/csv.ts';
import type { Row, TableDoc } from '../core/table.ts';
import { actionsFromRows, type ActionDef } from '../core/input.ts';
import { GameError, type Game, type GameEvent } from '../core/game.ts';
import type { Entity } from '../core/world.ts';
import { baseNameOf, frameCount, listFrames, type SheetDef } from '../core/sheet.ts';
import { autoRects, carryClips, gridRects, nameFrames, type Pixels, type Rect } from '../core/slice.ts';
import { decodePng } from '../project/png.ts';
import { shaderReport } from '../project/shader-status.ts';
import { layoutUI } from '../core/ui.ts';
import { RunInput, parseParams, parseRunKeys, type RunKeys } from '../core/runinput.ts';
export { parseParams } from '../core/runinput.ts';
import { RUN_DATE, formatDate, parseDate } from '../core/clock.ts';
import { captureShots, findChrome } from './shot.ts';
import { Profile } from '../core/profile.ts';
import { originReport, originSummary, readOrigins, setOrigin, writeOrigins } from '../project/origin.ts';
import type { DrawStats } from '../editor/shot.ts';
import { MemoryStore } from '../core/save.ts';
import { languagesOf } from '../core/i18n.ts';
import { parseSpawns, spawnTryout, tryoutGone, tryoutScene } from '../core/tryout.ts';

const HELP = `AGES CLI — 使い方: ages <コマンド> <プロジェクト> [引数]

  init   <dir> --template none|shooter|collect3d [--name 名前] [--no-pin]  新しいプロジェクトを作る（--template を付けないと、作らずにテンプレートの一覧を出す: 使うかを使用者に聞く。EDITOR-PLAN.md 付き。ゲームの企画を受けたら最初にこれ）。版だけ同梱の形になる（どこへ移しても ages.mjs が本体を取ってきて動く。本体が GitHub にない版のとき・--no-pin のときは、本体を今の場所から指す形）
  map    <dir> [節[/まとめ]]          プロジェクトの地図（作業のたびに最初に読む）。大きなプロジェクトでは目次になり、節（components systems tables prefabs scenes など）で中身を引く。まとめ 名前/(数) は 節/名前（例 prefabs/se）
  find   <dir> <語 ...>              部品・フィールド・表の列と行・システム・プレハブ・シーンの物を、名前と説明から探す（語は全部を含むもの）
  code   <dir> <名前 | 部品.欄 | $表.列 | ファイル | 日本語の語 ...> [--body] [--around 2] [--all] [--max 30]
                                     コードを引く: 宣言の場所と範囲（--body で中身）・使っている所（どの関数の中か。読/書/値/呼）・ファイルの目次・コメントから探す
  schema <dir> [名前 ...]             詳しく引く: コンポーネント（型・範囲・説明）/ $表 / std:flash などのシェーダー
               / ops（patch の操作の一覧と書き方）/ guide（機能ごとの手順の目次）/ guide:項目（例 guide:ui）
  get    <dir> <addr> [addr ...]     値を見る（例: main#player / main#player.Player.speed / @enemy / $enemies.basic）
  set    <dir> <addr> <value> [--force]  行列のセルは addr[行,列]（例 main#spawner.Spawner.formation[2,3] 1）
  patch  <dir> <ops.json | -> [--force]   操作の配列（例 [{"op":"set","path":"main#player.Player.speed","value":5}]。一覧は schema <dir> ops）
  table  <dir> <表> [--cols a,b] [--rows id1,id2] [--empty 列]   表を見る（1行1行。--empty はその列が空の行だけ。例 未訳: text --empty en）
               [--export x.csv] [--import x.csv [--force]]   表計算ソフトとの行き来（読み込みは表をまるごと置き換える）
  run    <dir> [--frames 600] [--scene main | --spawn enemy,explosion@40,0（プレハブだけを空のシーンの真ん中に出して試す）] [--seed 1] [--keys "0-120:ArrowLeft+KeyZ;120-200:@move_x=1;30:Mouse0+ptr=240,100"]
               [--input recordings/x.input.json] [--watch player.Health.hp,@enemy.Health.hp,...（@プレハブ名 はいる最初の1つ。@enemy[*] は全部、@enemy[kind=boss] は合う最初の1つ、@enemy[*kind=boss] は合う物全部）] [--log 出来事の名前,…（中身をフレームつきで。* で全部）] [--every 60] [--until gameOver | scene:result | click:ボタンのID] [--twice] [--dump]
               [--save saves/x.save.json]（この保存データから始める。省くと空） [--save-out saves/y.save.json]（終わりの保存データを書き出す） [--lang en]（言語）
               [--params stage=s1,level=2]（始めのシーンに渡す ctx.scene.params。JSON でもよい） [--date 2026-12-25T09:00]（ctx.date の始め。省くと決まった日時）
               --keys の "title+30-32:@ui_confirm" は、シーン title に入るたびに、入ってから 30〜31 フレーム目に押す（click=ボタンのID も書ける）
               [--shot 0,600 [--shot-scale 0.5] [--shot-dir 場所]]（そのフレームの画面を PNG で撮る。既定 .ages/shots。要 Chrome）
               [--perf | --perf logic]（速さ: システムごとの1フレームの時間と、物がいちばん多いフレームを描いた量。logic は描いた量を省く）
  log    <dir> [--all] [--peek]      前回からの編集の要約（--peek は既読にしない）
  undo   <dir> [--tx id] [--force]   自分（AI）の直前の編集を元に戻す（その後で変えられた所があれば止まる）。redo <dir> でやり直す
  check  <dir>                       全データの検証とロックの検査
  talk   <dir> [--task 作業 [--steps "a|b|c"] [--touch 住所,住所]] [--step 2] [--done 結果] [--ask 質問 [--choices "A|B"] [--about 住所]] [--reply 付箋ID 一言]
               エディタの人とのやり取り（何をしているかを見せる・人が決めることを聞く・付箋を読む）。引数なしで読む
  version <dir> [--record]           AGES の版（記録が古ければ直し方を出す）。--record で今の版を残す
  export <dir> [--out 先] [--diff 前の.ages-export] [--check] [--serve [ポート]] [--desktop [--id com.名前.ゲーム] [--fullscreen]]  書き出す（ゲームだけ。dist/web は Web にそのまま置ける。--desktop は Tauri の元 dist/desktop。--check は headless の Chrome で動くか確かめる）
  pin    <dir> [--repo URL] [--commit SHA] [--force]  版だけ同梱の形に（ages.mjs が本体を .ages/engine に取ってくる。GitHub との連携用）。AGENTS.md は手で直されていなければ本体の版に合わせる（--force で直されていても）
  ui     <dir> [シーン]               UI の配置（四角・置き方）と、重なり・はみ出し。直すのは patch の dockUI / attachUI
  assets <dir> [フォルダ] [--kind image|sound|font|shader|model] [--unused] [--refs 場所]   アセットの一覧（使っている所の数）・使っている所
               [--origin [ファイル | フォルダ | $text.言語 --by own|ai|stock|commission [--tool AIの名前] [--license CC0] [--from 入手元] [--note 一言]]]   出どころ（自作・AI 生成・素材・人に頼んだ）の一覧と記録
  space  <dir> [シーン] [--near id [--radius 3]] [--only id,id] [--frames n] [--keys …]   （追加パッケージ 3d を入れたプロジェクト）3D の空間を文字で確かめる
  sheet  <dir> <画像>                 画像の切り方（コマの名前・位置・基準点・動き）を見る
  slice  <dir> <画像> --grid 32x32 | --count 4x6 | --auto  画像を切る（前と同じ場所のコマは名前を引き継ぐ）
               [--spacing n] [--margin n] [--skip-empty] [--alpha 1] [--min 2] [--gap 0] [--pad 0] [--pivot 0.5,1] [--dry] [--force]

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

export async function cmdMap(dir: string, section?: string): Promise<string> {
  const p = await Project.load(dir);
  const files = await p.codeFiles();
  const ins = { touched: await readTouched(p.dir), locks: await p.effectiveLocks(), code: await p.codeRefs(), windows: await p.windows(), gotos: codeSceneRefs(files), defs: codeDefs(files) };
  // 節を1つだけ引く（目次の地図から）。まとめ（節/まとめ）を引いたら、最近の作業の場所として覚える
  if (section) {
    const page = renderMapSection(p, section, ins);
    if (section.includes('/')) await noteRecent(p.dir, [`map:${section}`]);
    return withLockReport(p, page);
  }
  // 入れ子の深い目次ほど、最近の作業の場所を多く・長く見せる（引く回数を減らす）
  const { show, window } = recentFor(indexDepth(p, ins));
  const recent = topRecent(await readRecent(p.dir), show, window);
  const plan = await planWarning(p.dir);
  const map = renderMap(p, ins.touched, ins.locks, ins.code, ins.windows, ins.gotos, undefined, recent, ins.defs, window);
  // エディタで人が見ている所（開いているときだけ）を、見出しのすぐ下に
  const focus = await readFocus(p.dir);
  const fl = focus ? focusLine(p, focus) : null;
  const withFocusLine = fl ? map.replace('\n', `\n${fl}\n`) : map;
  return withLockReport(p, (plan ? plan + '\n' : '') + withFocusLine);
}

/** 名前・説明から探す（目次の地図の中身を引く） */
export async function cmdFind(dir: string, query: string): Promise<string> {
  const p = await Project.load(dir);
  // 最近の作業の場所と、エディタで人が見ている所に近いものを上に
  const focus = await readFocus(p.dir);
  const r = findInProject(p, query, await readGuide(), withFocus(await readRecent(p.dir), focus), codeDefs(await p.codeFiles()), focus ? '最近の作業の場所・エディタで見ている所' : undefined);
  await noteRecent(p.dir, []);
  return r.text;
}

/** コードを引く: 宣言の場所と中身・名前や欄を使っている所・ファイルの目次・コメントからの検索 */
export async function cmdCode(dir: string, queries: string[], f: Args['flags'] = {}): Promise<string> {
  if (!queries.length && typeof f.body !== 'string') throw new Error('引くものを書いてください（例 ages code <dir> combat --body / $enemies.hp / Player.speed / game/systems.ts / 速さ）');
  // --body 名前 と書いても、名前は引くものに数える
  for (const k of ['body', 'all']) if (typeof f[k] === 'string') queries = [...queries, f[k] as string];
  const p = await Project.load(dir);
  const num = (k: string) => (f[k] !== undefined && f[k] !== true ? Number(f[k]) : undefined);
  return codeQuery(p, indexCode(await p.codeFiles()), queries, { body: !!f.body, all: !!f.all, around: num('around'), max: num('max') });
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

/** プロジェクトから見た AGES 本体の場所。共通の親フォルダがあれば相対パス、ドライブ直下まで離れていれば絶対パス（読みやすさのため） */
function enginePathFrom(target: string): string {
  const rel = (relative(target, ENGINE_DIR) || '.').split(sep).join('/');
  const ups = rel.match(/\.\.\//g)?.length ?? 0;
  return ups >= target.split(sep).filter(Boolean).length ? ENGINE_DIR.replace(/[\\/]$/, '').split(sep).join('/') : rel;
}

/** 写した手順書の印（手で直されたかを見分ける。ages.project.json の engineSource.agents） */
const textMark = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);

/** プロジェクトに写す AGES の手順書（本体の場所と ages の呼び方を書きかえる） */
async function projectAgents(engine: string, howToRun: string): Promise<string> {
  return (await readFile(join(ENGINE_DIR, 'AGENTS.md'), 'utf8'))
    .replace('`ages` は `node bin/ages.js`（`npm link` で `ages` コマンドになる）。', howToRun)
    .replaceAll('docs/PLAN.md', `${engine}/docs/PLAN.md`)
    .replaceAll('docs/GUIDE.md', `${engine}/docs/GUIDE.md`)
    .replaceAll('`examples/', `\`${engine}/examples/`);
}

const PINNED_ENGINE = '.ages/engine';
const DEFAULT_REPO = 'https://github.com/AMay-eime/AGES.git';

/**
 * 版だけ同梱の形にする（GitHub との連携の土台）。リポジトリには起動用の ages.mjs と使う本体の版（ages.project.json の engineSource）だけを入れ、
 * 本体は ages.mjs が .ages/engine（git の対象外）に取ってくる。使用者側の AI が本体を書き換えても push されない。
 * 版は今動いている本体のコミット（GitHub にあること）。上げるのは ages.mjs upgrade
 */
export async function cmdPin(dir: string, repo = DEFAULT_REPO, commit?: string, force = false): Promise<string> {
  const p = await Project.load(dir);
  const sha = commit ?? engineCommitFull();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('本体のコミットが分かりません（git で取った AGES から動かすか、--commit に40文字のコミットを渡す）');
  const done: string[] = [];
  await writeFile(join(p.dir, 'ages.mjs'), await readFile(join(ENGINE_DIR, 'templates', 'launcher', 'ages.mjs'), 'utf8'));
  done.push('ages.mjs（起動用。本体を .ages/engine に取ってきて動かす）');
  const cfgFile = join(p.dir, 'ages.project.json');
  const cfg = JSON.parse(await readFile(cfgFile, 'utf8')) as Record<string, unknown>;
  // AGENTS.md は本体の手順の写し。手で直されていなければ（前に書いたときの印と同じなら）新しい版のものに合わせる
  const agentsFile = join(p.dir, 'AGENTS.md');
  const agents = await projectAgents(PINNED_ENGINE, `\`ages\` は \`node ages.mjs\`（例 \`node ages.mjs check .\`。AGES 本体は ${PINNED_ENGINE} に自動で取ってくる。**本体は書き換えない**。ages.mjs と .ages/ は起動の仕組みなので読まなくてよい。足りない所は書き出して使用者に伝える）。`);
  const before = existsSync(agentsFile) ? await readFile(agentsFile, 'utf8') : null;
  const mark = (cfg.engineSource as { agents?: string } | undefined)?.agents;
  const edited = before !== null && before !== agents && mark !== undefined && mark !== textMark(before);
  cfg.engineSource = { repo, commit: sha, agents: edited && !force ? mark : textMark(agents) };
  await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  done.push(`ages.project.json の engineSource（${sha.slice(0, 7)}）`);
  const ignore = join(p.dir, '.gitignore');
  const gi = existsSync(ignore) ? await readFile(ignore, 'utf8') : '';
  if (!gi.split(/\r?\n/).includes(`${PINNED_ENGINE}/`)) {
    await writeFile(ignore, gi + (gi && !gi.endsWith('\n') ? '\n' : '') + `# AGES 本体（ages.mjs が engineSource の版を取ってくる。共有しない）\n${PINNED_ENGINE}/\n`);
    done.push('.gitignore');
  }
  // 前の版で作ったプロジェクトにも: AI が人の書き込みを読んだ所は共有しない・やり取りは Git の統合で両方の行を残す（ages talk）
  for (const [file, line, note] of [['.gitignore', '.ages/talk-cursor', '# AI が人の書き込みを読んだ所（共有しない）'], ['.gitattributes', '.ages/talk.jsonl merge=union', '# エディタの人と AI のやり取り（ages talk）は追記だけ']] as const) {
    const f = join(p.dir, file);
    const t = existsSync(f) ? await readFile(f, 'utf8') : '';
    if (t.split(/\r?\n/).includes(line)) continue;
    await writeFile(f, t + (t && !t.endsWith('\n') ? '\n' : '') + `${note}\n${line}\n`);
    if (!done.includes(file)) done.push(file);
  }
  if (edited && !force) done.push(`AGENTS.md は手で直されているので、そのままにした（本体の新しい手順は ${PINNED_ENGINE}/AGENTS.md。直した所を移してから ages pin <dir> --force で合わせる）`);
  else if (before !== agents) { await writeFile(agentsFile, agents); done.push('AGENTS.md（本体のこの版の手順）'); }
  await writeFile(join(p.dir, '.mcp.json'), JSON.stringify({ mcpServers: { ages: { command: 'node', args: ['ages.mjs', 'mcp'] } } }, null, 2) + '\n');
  done.push('.mcp.json');
  // ダブルクリックでエディタを開くファイル（印の行が残っていれば、この起動の仕方に作り直す）
  for (const f of await writeLaunchers(p.dir, 'ages.mjs editor')) done.push(`${f}（ダブルクリックでエディタを開く）`);
  // 型の確かめ（tsconfig）の本体の場所も
  const ts = join(p.dir, 'tsconfig.json');
  if (existsSync(ts)) {
    const t = await readFile(ts, 'utf8');
    // 追加パッケージ（'ages/3d' など）の場所も（なければ足す）
    const u = t.replace(/"ages":\s*\["[^"]*\/src\/index\.ts"\](,\s*"ages\/\*":\s*\["[^"]*"\])?/, `"ages": ["./${PINNED_ENGINE}/src/index.ts"], "ages/*": ["./${PINNED_ENGINE}/src/packages/*/index.ts"]`);
    if (u !== t) { await writeFile(ts, u); done.push('tsconfig.json'); }
  } else {
    await writeFile(ts, tsconfigText(`./${PINNED_ENGINE}`));
    done.push('tsconfig.json（型チェック: tsc -p tsconfig.json。エディタの補完にも）');
  }
  return [`版だけ同梱の形にしました（AGES ${sha.slice(0, 7)}）:`, ...done.map((d) => `  ${d}`), '使い方: node ages.mjs <命令> . ・node ages.mjs editor（「エディタを開く」のダブルクリックでも）・本体を上げる: node ages.mjs upgrade'].join('\n');
}

/** 書き出す（段階3）。Web はそのまま置ける一式、--desktop は Tauri（Steam 向け）の元も。--check は headless の Chrome で動くか確かめる */
export async function cmdExport(dir: string, flags: Record<string, string | boolean>): Promise<string> {
  // 型を消す Node の機能（stripTypeScriptTypes）の「試しの機能です」の知らせを出さない（エディタのサーバーと同じ）
  process.removeAllListeners('warning');
  const p = await Project.load(dir);
  const r = await exportProject(p, {
    ...(typeof flags.out === 'string' ? { out: resolve(flags.out) } : {}),
    desktop: flags.desktop === true,
    ...(typeof flags.id === 'string' ? { id: flags.id } : {}),
    fullscreen: flags.fullscreen === true,
    ...(typeof flags.diff === 'string' ? { diff: flags.diff } : {}),
  });
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  const lines = [`書き出しました: ${relative(process.cwd(), r.web) || r.web}（${r.files}ファイル・${mb(r.bytes)}）`,
    '  Web: このフォルダを丸ごと置けば遊べる（itch.io なら zip にして HTML のゲームとして上げる）。手元で試すなら --serve'];
  if (r.desktop) lines.push(`  デスクトップ: ${relative(process.cwd(), r.desktop) || r.desktop}（exe の作り方は中の README.md。Rust と Tauri の道具が要る）`);
  lines.push(...r.notes.map((n) => `  ${n}`));
  // 前の書き出しとの違い（変わったファイルだけ送るため）。一覧は書き出しの中の .ages-export（場所・大きさ・sha1）
  if (r.changes) {
    const c = r.changes, n = c.added.length + c.changed.length + c.removed.length;
    lines.push(`  ${c.against}との違い: ${n ? `増えた ${c.added.length}・変わった ${c.changed.length}・消えた ${c.removed.length}（同じ ${c.same}）` : 'なし（すべて同じ）'}`);
    const list = [...c.added.map((x) => `+ ${x}`), ...c.changed.map((x) => `~ ${x}`), ...c.removed.map((x) => `- ${x}`)];
    lines.push(...list.slice(0, 40).map((x) => `    ${x}`));
    if (list.length > 40) {
      const file = join(r.out, 'changes.txt');
      await writeFile(file, list.join('\n') + '\n');
      lines.push(`    …ほか ${list.length - 40}（全部は ${relative(process.cwd(), file) || file}）`);
    }
  } else lines.push(`  ファイルの一覧（場所・大きさ・sha1）は ${EXPORT_MARK}。次からは前の書き出しとの違いが出る（ほかの書き出しと比べるなら --diff <その ${EXPORT_MARK}>）`);
  // ストアの申告（生成 AI を使ったか）のためのまとめ。未記入があっても止めない
  const og = originSummary(await readOrigins(p.dir), p.assets, languagesOf(p.config));
  if (og.total) lines.push(`  出どころ: 生成 AI を使った物は ${og.ai || 'なし'}${og.missing ? `（未記入 ${og.missing}件）` : ''}。一覧とクレジットは ages assets <dir> --origin`);
  if (og.missing) lines.push(`⚠ 出どころが未記入のアセットが ${og.missing}件あります（ストアの申告の前に埋める）`);
  if (flags.check) {
    const fps = p.config.fps;
    const c = await checkExport(r.web, fps * 3);
    lines.push(c.ok ? `確かめました: headless の Chrome で ${c.frame}フレーム（約${Math.round(c.frame / fps)}秒）進み、エラーなし（シーン ${c.scene}）` : `⚠ 書き出したものが動きません: ${c.error || `${c.frame}フレームで止まった`}（シーン ${c.scene || '?'}）`);
  }
  if (flags.serve !== undefined && flags.serve !== false) {
    const port = typeof flags.serve === 'string' ? Number(flags.serve) : 5180;
    await serveStatic(r.web, port, 'localhost');
    lines.push(`試しに開く: http://localhost:${port}/ （止めるには Ctrl+C）`);
    console.log(lines.join('\n'));
    await new Promise(() => {});
  }
  return lines.join('\n');
}

/** 新しいプロジェクトを作る。AIへの手順書とエディタ計画書のひな形も入れる。 */
/** 公式テンプレート（動く骨組み。本体の examples/ の見本をそのまま使う） */
export const TEMPLATES: { name: string; from: string; desc: string; has: string }[] = [
  { name: 'shooter', from: 'examples/shooter', desc: '2D の縦シューティング', has: '自機の移動と弾・敵の種類と出方の表・当たり判定と体力・得点と結果の画面・音・多言語・エディタ拡張の例' },
  { name: 'collect3d', from: 'examples/collect3d', desc: '3D の足場渡り（追加パッケージ 3d）', has: '3人称の移動とジャンプ・足場と壁の当たり判定・コイン集め・追いかけるカメラ・モデルの動き・音' },
];

/** ages init に --template がないとき: 作らずに、テンプレートから始めるかを聞く */
export function templateQuestion(dir: string): string {
  return [
    'テンプレートから始めますか？ 使用者に聞いて、--template を付けてもう一度（まだ何も作っていません）:',
    `  ages init ${dir} --template none   空から始める`,
    ...TEMPLATES.map((t) => `  ages init ${dir} --template ${t.name}   ${t.desc}: ${t.has}`),
    'テンプレートは動く骨組みで、面白さの核・手触り・個性は入っていない（使用者がこれから決める）。使用者に聞けないときは、企画に近いものがあれば選び、なければ none',
  ].join('\n');
}

export async function cmdInit(dir: string, name?: string, template?: string): Promise<string> {
  const target = resolve(dir);
  const from = template && template !== 'none' ? TEMPLATES.find((t) => t.name === template) : undefined;
  if (template && template !== 'none' && !from) throw new Error(`テンプレート ${template} はありません（none ${TEMPLATES.map((t) => t.name).join(' ')}）${suggest(template, TEMPLATES.map((t) => t.name))}`);
  if (existsSync(join(target, 'ages.project.json'))) throw new Error(`${dir} にはすでに AGES のプロジェクトがあります`);
  const projectName = name ?? basename(target);
  if (!/^[\w.-]+$/.test(projectName)) throw new Error(`プロジェクト名 "${projectName}" には英数字・_・-・. だけが使えます（--name で指定できます）`);
  const engine = enginePathFrom(target);
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
  if (from) created.push(...(await copyTemplate(join(ENGINE_DIR, from.from), target, projectName, from)));
  // AIの手順書は AGES 本体の AGENTS.md をそのまま写す（プロジェクトだけを開いたAIも手順にたどり着けるように）
  await writeFile(join(target, 'AGENTS.md'), await projectAgents(engine, `\`ages\` は \`node ${engine}/bin/ages.js\`（AGES本体の場所: ${engine}。本体で \`npm link\` すれば \`ages\` だけで動く）。`));
  created.push('AGENTS.md');
  // MCP の設定（Claude Code などがこのフォルダを開くと、AGES の道具と使い方の説明が自動で渡る）
  const mcp = { mcpServers: { ages: { command: 'node', args: [`${engine}/src/mcp/server.ts`] } } };
  await writeFile(join(target, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  created.push('.mcp.json');
  // 型チェックの設定（tsc -p tsconfig.json。コードのエディタの補完にも使われる）
  if (!existsSync(join(target, 'tsconfig.json'))) { await writeFile(join(target, 'tsconfig.json'), tsconfigText(engine.startsWith('.') || engine.startsWith('/') || /^[A-Za-z]:/.test(engine) ? engine : `./${engine}`)); created.push('tsconfig.json'); }
  // ダブルクリックでエディタを開くファイル（Windows・mac。命令を打たずに使えるように）
  created.push(...(await writeLaunchers(target, `"${engine}/src/editor/server.ts" .`, `${engine}/src/editor/server.ts`)));
  // 作ったときの AGES の版を残す（後で本体を上げたとき、どこから直せばよいか分かるように）
  const v = await recordVersion(target);
  return [
    `プロジェクト ${projectName} を作りました: ${dir}（AGES ${formatVersion(v)}）`,
    ...created.sort().map((f) => `  ${f}`),
    from
      ? `次: テンプレート ${from.name}（${from.desc}）の骨組みが入っています。ages map で中身を見て、EDITOR-PLAN.md の質問（何を残し・何を変えるか）を使用者に確認する。合意するまでゲームのコードは書かない`
      : '次: EDITOR-PLAN.md の質問を使用者に確認し、必要なエディタを決める。合意するまでゲームのコードは書かない',
  ].join('\n');
}

/** テンプレート（見本のプロジェクト）の中身を、作ったばかりのプロジェクトに重ねる。設定は名前だけ変え、エディタ計画書には始め方を書き足す */
async function copyTemplate(src: string, target: string, projectName: string, t: (typeof TEMPLATES)[number]): Promise<string[]> {
  const SKIP = new Set(['.ages', 'dist', 'recordings', 'EDITOR-PLAN.md', 'ages.project.json', 'node_modules']);
  let files = 0;
  const walk = async (from: string, to: string, top: boolean) => {
    for (const entry of await readdir(from)) {
      if (top && SKIP.has(entry)) continue;
      const a = join(from, entry), b = join(to, entry);
      if ((await stat(a)).isDirectory()) await walk(a, b, false);
      else { await mkdir(to, { recursive: true }); await copyFile(a, b); files++; }
    }
  };
  await walk(src, target, true);
  // 設定: 見本のもの（画面の大きさ・言語・追加パッケージ・エディタ拡張）に、名前だけ入れる。版は作った後で記録する
  const cfg = JSON.parse(await readFile(join(src, 'ages.project.json'), 'utf8')) as Record<string, unknown>;
  delete cfg.engine;
  await writeFile(join(target, 'ages.project.json'), JSON.stringify({ ...cfg, name: projectName }, null, 2) + '\n');
  const plan = join(target, 'EDITOR-PLAN.md');
  await writeFile(plan, (await readFile(plan, 'utf8')).trimEnd() + `

## テンプレート

このプロジェクトは、公式テンプレート \`${t.name}\`（${t.desc}）から始めた。入っているもの: ${t.has}。

- これは動く骨組みで、面白さの核・手触り・個性は入っていない。上の質問は、このゲームとして改めて使用者に聞く
- まず \`ages map\` で中身を見て、\`ages run\` で動くことを確かめる。その上で、何を残し・何を変え・何を消すかを使用者に聞く
- 素材（画像・音・モデル）は仮のもの。出どころは \`ages assets <dir> --origin\`（差し替えたら書き直す）
`);
  return [`（テンプレート ${t.name}: ${files} ファイル）`];
}

export async function cmdSchema(dir: string, names: string[]): Promise<string> {
  const p = await Project.load(dir);
  const field = (k: string, f: import('../core/schema.ts').Field) => `  ${k} ${brief(f)}${f.desc ? ' — ' + f.desc : ''}${nested(f, '    ')}`;
  const out: string[] = [];
  const guide = await readGuide(p.registry.packages.map((x) => x.name));
  // 名前の種類: コンポーネント / $表 / シェーダー（std:… か .frag）/ ops（patch の操作）/ guide・guide:項目（機能ごとの手順）
  const isShader = (n: string) => n.startsWith('std:') || /\.(frag|glsl)$/i.test(n);
  const isDoc = (n: string) => n === 'ops' || n === 'guide' || n.startsWith('guide:');
  const comps = names.length ? names.filter((n) => !n.startsWith('$') && !isShader(n) && !isDoc(n)) : [...p.registry.components.keys()];
  if (names.length) await noteRecent(p.dir, names.filter((n) => !isShader(n) && !isDoc(n)));
  const tables = names.length ? names.filter((n) => n.startsWith('$')).map((n) => n.slice(1)) : [...p.registry.tables.keys()];
  const topicOf = (comp: string) => [...guide.values()].find((t) => t.parts.includes(comp))?.name;
  for (const n of comps) {
    if (!p.registry.components.has(n) && guide.has(n.toLowerCase())) throw new Error(`コンポーネント ${n} はありません。機能の手順なら guide:${n.toLowerCase()}`);
    const d = p.registry.component(n);
    const topic = names.length ? topicOf(d.name) : undefined;
    out.push(`${d.name}: ${d.desc}${topic ? `（使い方: guide:${topic}）` : ''}`, ...Object.entries(d.fields).map(([k, f]) => field(k, f)));
  }
  for (const n of tables) { const t = p.registry.table(n); out.push(`$${t.name}: ${t.desc ?? ''}（表。列 id は行の名前）`, ...Object.entries(t.columns).map(([k, f]) => field(k, f))); }
  for (const n of names.filter(isShader)) {
    const d = p.registry.shaders.get(n);
    if (!d) throw new Error(`シェーダー ${n} はありません${suggest(n, [...p.registry.shaders.keys()])}`);
    out.push(`${d.path}: ${d.desc}（シェーダー。Effect / PostEffect の shader で選び、値は params.名前。トゥイーンは 'Effect.params.名前'）`, ...Object.entries(d.uniforms).map(([k, f]) => field(k, f)));
    out.push(SHADER_HOWTO);
    if (d.path.startsWith('std:')) out.push(`--- ${d.path} の中身（新しく書くときの手本）`, d.code.trimEnd());
    for (const e of d.errors) out.push(`⚠ ${e}`);
  }
  for (const n of names.filter(isDoc)) {
    if (n === 'ops') {
      out.push('patch の操作（ages patch <dir> \'[{"op":"set","path":"main#player.Player.speed","value":5}]\'。すべて成功するか、何も変えないか）');
      for (const [op, doc] of Object.entries(OP_DOCS)) out.push(`  ${op}${doc}`);
    } else if (n === 'guide') {
      out.push('機能ごとの手順（ages schema <dir> guide:項目）');
      for (const t of guide.values()) out.push(`  ${t.name}: ${t.title}${t.parts.length ? `（${t.parts.join(' ')}）` : ''}`);
    } else {
      const name = n.slice('guide:'.length);
      const t = guide.get(name);
      if (!t) {
        // 入れていない追加パッケージの項目
        for (const pk of Object.keys(PACKAGE_LIST)) if ((await readPackageGuide(pk)).has(name)) throw new Error(`手順の項目 ${name} は、追加パッケージ ${pk} を入れると引けます（ages.project.json の packages に "${pk}"。guide:packages）`);
        throw new Error(`手順の項目 ${name} はありません${suggest(name, [...guide.keys()])}。一覧は guide`);
      }
      const engine = enginePathFrom(p.dir);
      out.push(`## ${t.name}: ${t.title}${t.parts.length ? `（部品: ${t.parts.join(' ')}。中身は ages schema <dir> ${t.parts[0]}）` : ''}`, engine === '.' ? t.body : t.body.replaceAll('`examples/', `\`${engine}/examples/`));
    }
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
  await noteRecent(p.dir, addrs.map(placeOf));
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
  await noteRecent(p.dir, [`$${name}`]);
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
  let rows = only ? doc.rows.filter((r) => only.includes(r.id)) : doc.rows;
  // --empty 列: その列が空（省いた・"" ）の行だけ（未訳の言葉を探すなど）
  if (typeof flags.empty === 'string') {
    const col = flags.empty;
    if (!def.columns[col]) throw new Error(`表 ${name} に列 ${col} はありません${suggest(col, Object.keys(def.columns))}`);
    rows = rows.filter((r) => r[col] === undefined || r[col] === '' || r[col] === null);
    if (!rows.length) return `$${name}: 列 ${col} が空の行はありません`;
  }
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
  await noteRecent(p.dir, r.changes.map((c) => placeOf(c.path)));
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
  // 出どころ（自作・AI 生成・素材）: --origin だけなら一覧、場所と --by で書く
  if (f.origin !== undefined) {
    const o = await readOrigins(p.dir), langs = languagesOf(p.config);
    if (typeof f.origin === 'string') {
      const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
      if (str('by') === undefined && ['tool', 'license', 'from', 'note'].every((k) => str(k) === undefined)) throw new Error('書く中身がありません（--by own|ai|stock|commission と、--tool・--license・--from・--note）。一覧は場所を付けずに ages assets <dir> --origin');
      const r = setOrigin(o, p.assets, langs, f.origin, { by: str('by'), tool: str('tool'), license: str('license'), from: str('from'), note: str('note') }, AI_ACTOR.kind === 'ai' ? 'ai' : 'human', f.force === true);
      await writeOrigins(p.dir, o);
      return r.text;
    }
    return originReport(o, p.assets, langs, p.registry.tableView('text').rows.length).join('\n');
  }
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
  const kinds = Object.keys(ASSET_EXT);
  if (kind && !kinds.includes(kind)) throw new Error(`--kind は ${kinds.join(' / ')} のどれかです${suggest(kind, kinds)}`);
  const lines = renderAssets(p, { touched: await readTouched(p.dir), locks: await p.effectiveLocks(), code, folder: folder?.replace(/\/+$/, ''), kind: kind as AssetKind | undefined, unused: !!f.unused, counts: true });
  const n = lines.filter((l) => l.startsWith('  ')).length;
  if (!n) return folder || kind || f.unused ? '該当するアセットはありません' : 'アセットはまだありません（assets/ にファイルを置く）';
  return [`アセット ${n}件${f.unused ? '（未使用）' : ''}。場所を変える: patch の moveAsset（使っている値も直る）／消す: removeAsset（使っていないものだけ）`, ...lines].join('\n');
}

const ANCHOR_JA: Record<string, string> = { topLeft: '左上', top: '上', topRight: '右上', left: '左', center: '中央', right: '右', bottomLeft: '左下', bottom: '下', bottomRight: '右下' };
const SIDE_JA: Record<string, string> = { right: '右', left: '左', below: '下', above: '上' };

/** UI の配置を文字で（位置を数えずに直せるように、置き方と、重なり・はみ出しを出す） */
export async function cmdUi(dir: string, sceneName?: string): Promise<string> {
  const p = await Project.load(dir);
  const scene = sceneName ?? p.config.startScene;
  if (!p.docs.scenes.has(scene)) throw new Error(`シーン ${scene} はありません${suggest(scene, [...p.docs.scenes.keys()])}`);
  const g = p.newGame(scene);
  const { width: W, height: H } = p.config.view;
  const rects = layoutUI(g.world, W, H);
  if (!rects.size) return `シーン ${scene} に UI の物はありません（物に UI を付けると画面に固定されます）`;
  const touched = await readTouched(p.dir);
  const locks = await p.effectiveLocks();
  const n = (v: number) => String(Math.round(v * 10) / 10);
  const out = [`UI（シーン ${scene}・画面 ${W}x${H}。左,上 幅x高さ ← 置き方）`];
  const ents = [...g.world.entities.values()].filter((e) => rects.has(e.id));
  const kids = (id: string | null) => ents.filter((e) => (rects.get(e.id)!.parent ?? null) === id);
  const line = (e: (typeof ents)[number], depth: number) => {
    const r = rects.get(e.id)!, u = e.c.UI;
    const parent = u.parent ? g.world.get(u.parent) : undefined;
    const off = u.x || u.y ? ` ずれ(${n(u.x ?? 0)},${n(u.y ?? 0)})` : '';
    const how = parent?.c.Layout ? `${u.parent} の並び（order ${u.order ?? 0}）`
      : u.beside && rects.has(u.beside) ? `${u.beside} の${SIDE_JA[u.side] ?? u.side}に${u.gap ? `間 ${n(u.gap)}` : '接して'}${u.align && u.align !== 'start' ? `・${u.align === 'center' ? '中央' : '端'}揃え` : ''}`
      : `${u.parent ? u.parent + 'の' : '画面の'}${ANCHOR_JA[u.anchor] ?? u.anchor}`;
    const what = [e.c.Button ? 'Button' : '', e.c.Gauge ? `Gauge${e.c.Gauge.drag ? '(drag)' : ''}` : '', e.c.Layout ? `Layout(${e.c.Layout.dir === 'horizontal' ? '横' : '縦'})` : '', e.c.Text?.text ? `"${String(e.c.Text.text).slice(0, 16)}"` : ''].filter(Boolean).join(' ');
    const base = `${scene}#${e.id}.UI`;
    const mark = Object.keys(locks).some((k) => k.startsWith(base)) ? ' 🔒' : Object.keys(touched).some((k) => k.startsWith(base)) ? ' ★' : '';
    out.push(`${'  '.repeat(depth)}${e.id} ${n(r.x)},${n(r.y)} ${n(r.w)}x${n(r.h)} ← ${how}${off}${what ? ' ' + what : ''}${r.visible ? '' : ' （隠れている）'}${mark}`);
    for (const k of kids(e.id)) line(k, depth + 1);
  };
  for (const e of kids(null)) line(e, 0);
  // 重なり（親子でないもの）と、画面からのはみ出し
  const shown = ents.filter((e) => rects.get(e.id)!.visible);
  const up = (id: string): string[] => { const out2: string[] = []; for (let c = rects.get(id)?.parent ?? null; c && !out2.includes(c); c = rects.get(c)?.parent ?? null) out2.push(c); return out2; };
  const warn: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = rects.get(shown[i].id)!, b = rects.get(shown[j].id)!;
      if (up(shown[i].id).includes(shown[j].id) || up(shown[j].id).includes(shown[i].id)) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0.01 && oy > 0.01) warn.push(`⚠ 重なっている: ${shown[i].id} と ${shown[j].id}（${n(ox)}x${n(oy)}）。接して置くなら attachUI`);
    }
    const r = rects.get(shown[i].id)!;
    if (r.x < -0.01 || r.y < -0.01 || r.x + r.w > W + 0.01 || r.y + r.h > H + 0.01) warn.push(`⚠ 画面からはみ出している: ${shown[i].id}。端に付けるなら dockUI`);
  }
  out.push(...warn);
  return out.join('\n');
}

/** プロジェクトの操作の名前と割り当て（$actions） */
export function actionsOf(p: Project): Map<string, ActionDef> {
  return actionsFromRows(p.registry.tableView('actions').rows);
}

/** 物の、部品.欄 の値（ない物・ない部品は —）。リスト・構造体は写す（始めの値が後の値で書き変わらないように） */
function valueOf(e: Entity, comp?: string, field?: string): unknown {
  if (!comp) return 'alive';
  const c = e.c[comp];
  if (!c) return '—';
  const v = field ? c[field] : c;
  if (v === undefined) return '—';
  return v !== null && typeof v === 'object' ? structuredClone(v) : v;
}

/** [欄=値]・[部品.欄=値]・[欄!=値]: 物がその条件に合うか（部品を書かなければ、どれかの部品のその欄） */
function matchWhere(e: Entity, cond: string): boolean {
  const m = /^([^=!]+?)(!?=)(.*)$/.exec(cond);
  if (!m) throw new Error(`--watch の [${cond}] は 欄=値 か 部品.欄=値 です（!= も使えます）`);
  const [, key, op, want] = m;
  const [a, b] = key.split('.');
  const values = b ? [e.c[a]?.[b]] : Object.values(e.c).map((c) => (c as Record<string, unknown>)[a]).filter((v) => v !== undefined);
  const hit = values.some((v) => v !== undefined && (typeof v === 'string' ? v : JSON.stringify(v)) === want);
  return op === '=' ? hit : !hit;
}

/**
 * --watch の1つを読む。ID.部品.欄、@プレハブ名.部品.欄（いる最初の1つ）、
 * @プレハブ名[*]（いる物全部。ID ごとの値）、@プレハブ名[欄=値]（合う最初の1つ）、@プレハブ名[*欄=値]（合う物全部）
 */
function readWatch(game: Game, addr: string): unknown {
  const s = addr.includes('#') ? addr.slice(addr.indexOf('#') + 1) : addr;
  const sel = /^@([^.[\]]+)\[(\*?)([^\]]*)\](.*)$/.exec(s);
  if (sel) {
    const [, prefab, all, cond, rest] = sel;
    const [, comp, field] = rest.split('.');
    const list = [...game.world.entities.values()].filter((x) => game.world.isAlive(x.id) && (x.id === prefab || x.id.startsWith(prefab + '~')) && (!cond || matchWhere(x, cond)));
    if (!all) return list[0] ? valueOf(list[0], comp, field) : '—';
    if (!list.length) return '—';
    return list.map((x) => `${x.id}=${fmt(valueOf(x, comp, field))}`).join(' ');
  }
  const [id, comp, field] = s.split('.');
  // @プレハブ名 は、そのプレハブから出した物のうち、いまいる最初の1つ（ID を探さなくてよい）
  const e = id.startsWith('@')
    ? [...game.world.entities.values()].find((x) => game.world.isAlive(x.id) && (x.id === id.slice(1) || x.id.startsWith(id.slice(1) + '~')))
    : game.world.get(id);
  if (!e) return '—';
  return valueOf(e, comp, field);
}

/** --log: 出来事の中身を、出たフレームごとに1行（多すぎるときは、始めの分だけ） */
const LOG_MAX = 300;
function logLine(ev: GameEvent): string {
  const data = ev.data === undefined ? '' : ' ' + (typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data));
  return `f${ev.frame} ${ev.name}${data.length > 240 ? data.slice(0, 239) + '…' : data}`;
}

export async function cmdRun(dir: string, f: Args['flags']): Promise<string> {
  const p = await Project.load(dir);
  const frames = Number(f.frames ?? 600);
  let scene = typeof f.scene === 'string' ? f.scene : p.config.startScene;
  const seed = f.seed !== undefined ? Number(f.seed) : p.config.seed;
  let keys: RunKeys = { events: [], clicks: [], scene: [] };
  let recParams: Record<string, unknown> | undefined;
  // 始めるときの保存データ（--save のファイル、なければ記録に入っているもの、なければ空）
  let initialSave: Record<string, unknown> = {};
  // 日時（--date、なければ記録に入っているもの、なければ決まった日時）
  let date = parseDate(RUN_DATE);
  if (typeof f.input === 'string') {
    const rec = JSON.parse(await readFile(`${p.dir}/${f.input}`, 'utf8'));
    keys.events = rec.events;
    if (rec.save && typeof rec.save === 'object') initialSave = rec.save;
    if (typeof rec.date === 'string') date = parseDate(rec.date);
    // 記録したシーン・params から始める（--scene・--params を書けばそちら）
    if (typeof f.scene !== 'string' && typeof rec.scene === 'string' && p.docs.scenes.has(rec.scene)) scene = rec.scene;
    if (typeof f.params !== 'string' && rec.params && typeof rec.params === 'object') recParams = rec.params;
  }
  if (typeof f.save === 'string') initialSave = await readSaveFile(p.dir, f.save);
  if (typeof f.date === 'string') date = parseDate(f.date);
  // click=ボタンのID は、そのフレームのボタンの真ん中を押す。シーン名+30:… は、そのシーンに入るたびに入ってから数える
  if (typeof f.keys === 'string') {
    keys = parseRunKeys(f.keys, actionsOf(p));
    for (const k of keys.scene) if (!p.registry.scenes.has(k.scene) && !p.docs.scenes.has(k.scene)) throw new Error(`--keys の ${k.scene}+${k.a}: シーン ${k.scene} はありません${suggest(k.scene, [...p.docs.scenes.keys()])}`);
  }
  const watch = typeof f.watch === 'string' ? f.watch.split(',').map((s) => s.trim()).filter(Boolean) : [];
  // --log: 出来事（ctx.emit）の名前。* で全部
  const logNames = typeof f.log === 'string' ? f.log.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const every = f.every !== undefined ? Number(f.every) : 0;
  const until = typeof f.until === 'string' ? f.until : '';
  // --params: 始めのシーンに渡すもの（ctx.scene.params）。stage=s1,level=2 か JSON
  const params = typeof f.params === 'string' ? parseParams(f.params) : recParams;
  // --shot: そのフレームの画面を撮る（headless の Chrome。.ages/shots に PNG）
  const shotFrames = typeof f.shot === 'string' ? f.shot.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--shot の ${x} はフレームの番号ではありません（例 --shot 0,600,1200）`);
    return n;
  }) : [];
  const shotHashes = new Map<number, string>();
  /** 撮るフレームの状態（撮ったページの状態と比べて、違えばどこがどれだけ違うかを出す） */
  const shotSnaps = new Map<number, unknown>();

  // --spawn: 選んだプレハブだけを空のシーンの真ん中に出して試す（出した物がすべて消えたら止まる）
  const spawns = typeof f.spawn === 'string' ? parseSpawns(f.spawn) : [];
  if (f.spawn !== undefined && !spawns.length) throw new Error('--spawn にはプレハブの名前が要ります（例 --spawn enemy_fast,explosion@40,0。@ の後は画面の真ん中からのずれ）');
  const once = () => {
    const lang = typeof f.lang === 'string' ? f.lang : undefined;
    const game = spawns.length ? p.newGame(undefined, seed, new MemoryStore(initialSave), lang, tryoutScene(), undefined, date) : p.newGame(scene, seed, new MemoryStore(initialSave), lang, undefined, params, date);
    if (f.perf) game.profile = new Profile();
    const spawned = spawns.length ? spawnTryout(game, spawns, p.config.view.width, p.config.view.height) : [];
    const play = new RunInput(keys);
    const lines: string[] = [];
    const first = watch.map((w) => readWatch(game, w));
    if (shotFrames.includes(0) && !shotHashes.has(0)) { shotHashes.set(0, game.hash()); shotSnaps.set(0, game.snapshot()); }
    let stopped = '';
    if (until.startsWith('scene:')) game.sceneListeners.push((_from, to) => { if (to === until.slice(6) && !stopped) stopped = `${until} @f${game.frame}`; });
    else if (until.startsWith('click:')) game.listeners.push((ev) => { if (ev.name === 'ui.click' && (ev.data as { id?: string })?.id === until.slice(6) && !stopped) stopped = `${until} @f${ev.frame}`; });
    else if (until) game.listeners.push((ev) => { if (ev.name === until && !stopped) stopped = `${until} @f${ev.frame}`; });
    let logged = 0;
    if (logNames.length) game.listeners.push((ev) => {
      if (!logNames.includes('*') && !logNames.includes(ev.name)) return;
      if (logged++ < LOG_MAX) lines.push(logLine(ev));
    });
    const t0 = performance.now();
    try {
      for (let i = 0; i < frames && !stopped; i++) {
        const { input: inp, warning } = play.at(game, p.config.view.width, p.config.view.height);
        if (warning) lines.push(`⚠ f${game.frame} click=${warning}: UI の付いた物 ${warning} がありません${suggest(warning, [...game.world.entities.values()].filter((e) => e.c.UI).map((e) => e.id))}`);
        game.step(inp);
        if (shotFrames.includes(game.frame) && !shotHashes.has(game.frame)) { shotHashes.set(game.frame, game.hash()); shotSnaps.set(game.frame, game.snapshot()); }
        if (spawned.length && !stopped && tryoutGone(game, spawned)) stopped = `出した物がすべて消えた @f${game.frame}`;
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
    if (logged > LOG_MAX) lines.push(`…出来事はほか ${logged - LOG_MAX}（--log は始めの ${LOG_MAX} まで。--frames か名前で絞る）`);
    if (logNames.length && !logged) lines.push(`log: ${logNames.join(',')} は1回も出ませんでした`);
    return { game, lines, first, ms: performance.now() - t0, stopped };
  };

  const r = once();
  const g = r.game;
  const out: string[] = [];
  out.push(`run ${spawns.length ? `試し(${spawns.map((x) => '@' + x.prefab).join(' ')})` : scene} seed${seed} ${g.frame}f (${(g.frame / p.config.fps).toFixed(1)}s) ${r.ms.toFixed(0)}ms hash=${g.hash()}${r.stopped ? ' 停止:' + r.stopped : ''}`);
  out.push(...r.lines);
  const counts = [...g.counts.entries()].map(([k, v]) => `${k}×${v}`).join(' ');
  out.push(`events: ${counts || 'なし'}`);
  if (g.sceneLog.length > 1) out.push(`scenes: ${g.sceneLog.map((x) => `${x.name}@${x.frame}`).join(' → ')}${g.transition ? `（${g.transition.phase === 'out' ? '消えていく途中' : '出てくる途中'}）` : ''}`);
  if (g.dateUsed) out.push(`date: ${formatDate(date)} から（ctx.date を読んだ。--date 2026-12-25T09:00 で変えられる）`);
  const unused = keys.scene.filter((k) => !g.sceneLog.some((x) => x.name === k.scene));
  if (unused.length) out.push(`⚠ --keys の ${unused.map((k) => `${k.scene}+${k.a}`).join(' ')}: そのシーンに入りませんでした`);
  if (g.soundCounts.size) out.push(`sounds: ${[...g.soundCounts.entries()].map(([k, v]) => `♪${k}×${v}`).join(' ')}`);
  if (g.hits.counts.size) out.push(`hits: ${[...g.hits.counts.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}（重なり始めた回数。Collider.with のグループ）`);
  if (g.uiCounts.size) out.push(`ui: 押されたボタン ${[...g.uiCounts.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}`);
  if (g.particleCounts.size) out.push(`particles: ${[...g.particleCounts.entries()].map(([k, v]) => `✦${k}×${v}`).join(' ')}`);
  if (g.save.writes.size) out.push(`save: 書いた ${[...g.save.writes.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}（終わりの保存: ${g.save.keys().join(' ') || 'なし'}${typeof f['save-out'] === 'string' ? ` → ${f['save-out']}` : '。中身は --save-out ファイルで書き出せる'}）`);
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
  if (typeof f['save-out'] === 'string') {
    const to = resolve(p.dir, f['save-out']);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, JSON.stringify(g.save.all(), null, 2) + '\n');
  }
  // --perf: システムごとの時間（画面なしで測った目安）と、物がいちばん多いフレームを描いたときの数
  const prof = g.profile;
  // 同じ入力なら同じ処理なので、あと2回測って、フレームごとに短い方を取る（たまたまの遅れを消す。長い実行は1回だけ足す）
  if (prof && prof.frames.length) for (let i = 0; i < (r.ms < 4000 ? 2 : r.ms < 20000 ? 1 : 0); i++) { const again = once().game.profile; if (again) prof.merge(again); }
  const drawStats = new Map<number, DrawStats>();
  const drawAt = prof && prof.frames.length && f.perf !== 'logic' && findChrome() ? prof.peak().frame : undefined;
  const shotLines = shotFrames.length || drawAt !== undefined ? await shots(p, f, shotFrames, shotHashes, shotSnaps, { scene, seed, keys, params, save: initialSave, spawns, date: formatDate(date), statsAt: drawAt, stats: drawStats }) : [];
  if (prof) out.push(...perfLines(prof, p.config.fps, drawAt, drawAt !== undefined ? drawStats.get(drawAt) : undefined, f.perf === 'logic' ? '' : findChrome() ? '' : '描いたときの数は Chrome がないので出せません'));
  out.push(...shotLines);
  return withLockReport(p, out.join('\n'));
}

/** --perf の行。重い順に、1フレームあたりの時間と割合。1フレームの時間を超えたら ⚠ */
export function perfLines(prof: Profile, fps: number, drawAt: number | undefined, draw: DrawStats | undefined, note = ''): string[] {
  const n = prof.frames.length;
  if (!n) return ['perf: 1フレームも進んでいません'];
  const budget = 1000 / fps, s = prof.summary(budget), worst = prof.worst(), peak = prof.peak();
  const ms = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v >= 0.095 ? v.toFixed(2) : v.toFixed(3));
  const num = (v: number) => Math.round(v).toLocaleString('en-US');
  const out = [`perf: 1フレーム 平均 ${ms(s.mean)}ms・真ん中 ${ms(s.median)}ms・最大 ${ms(worst.ms)}ms @f${worst.frame}（${fps}fps の1フレームは ${ms(budget)}ms。物は最大 ${peak.count} @f${peak.frame}）`];
  const parts = prof.parts();
  const top = parts.filter((x) => x.ms / s.total >= 0.03).slice(0, 8), rest = s.total - top.reduce((a, x) => a + x.ms, 0);
  out.push(`  重い順: ${top.map((x) => `${x.name} ${ms(x.ms / n)}ms ${Math.round((x.ms / s.total) * 100)}%${x.max > budget / 4 ? `（最大 ${ms(x.max)} @f${x.maxFrame}）` : ''}`).join('・')}${rest > 0.005 * s.total ? `・ほか ${ms(rest / n)}ms` : ''}`);
  if (s.over) out.push(`⚠ 1フレームの時間（${ms(budget)}ms）を超えたフレームが ${s.over}（最初 f${s.firstOver}。いちばん長い f${worst.frame} は ${worst.parts.map(([k, v]) => `${k} ${ms(v)}ms`).join('・')}）`);
  if (draw) {
    const l3 = draw.layers['3d'];
    const d2 = `命令 ${draw.draws}回・2D の四角 ${num(draw.quads)}${draw.particles ? `・2D の粒 ${num(draw.particles)}` : ''}`;
    const d3 = l3 ? `／3D: 物 ${l3.things}（画面内 ${l3.shown}）・三角形 ${num(l3.tris)}${l3.particles ? `・粒 ${num(l3.particles)}` : ''}` : '';
    out.push(`  描画 @f${drawAt}（物がいちばん多いフレーム）: ${d2}${d3}`);
    if (draw.draws > 500 || (l3?.tris ?? 0) > 500_000 || draw.quads > 20_000) out.push(`⚠ 描く量が多い（目安: 命令 500回・三角形 50万・四角 2万まで）。同じ形・同じ材質にそろえる（まとめて描かれる）・画像を1枚のシートにまとめる・遠くの物を減らす`);
  } else if (note) out.push(`  ${note}`);
  return out;
}

/**
 * ages run と撮ったページの状態の違い。Node と Chrome では Math.sin などの計算の最後の桁が違うことがある（JavaScript の決まりで許されている）。
 * そのような小さな違いだけなら、画面はほぼ同じなので軽く知らせる。それより大きいときは、どこが違うかを出す
 */
export function snapshotDiff(a: unknown, b: unknown): string {
  const diffs: { path: string; tiny: boolean }[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (diffs.length > 200 || x === y) return;
    if (typeof x === 'number' && typeof y === 'number') {
      diffs.push({ path, tiny: Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)) });
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push({ path, tiny: false });
  };
  walk(JSON.parse(JSON.stringify(a ?? null)), b ?? null, '');
  const big = diffs.filter((d) => !d.tiny);
  if (!diffs.length) return '';
  if (!big.length) return `（ages run と数の最後の桁だけ違う所が ${diffs.length} か所。Node と Chrome の Math の計算の違いで、画面はほぼ同じ）`;
  return `⚠ 画面のページの状態が ages run と違います（${big.length}${diffs.length > 200 ? '+' : ''} か所。例 ${big.slice(0, 3).map((d) => d.path).join(' ')}。Math の計算の小さな違いが積もった可能性。撮った画面は ages run の状態と少し違う）`;
}

/** --shot: ages run と同じ入力で、そのフレームの画面を撮って .ages/shots（--shot-dir）に PNG で置く */
async function shots(p: Project, f: Args['flags'], frames: number[], hashes: Map<number, string>, snaps: Map<number, unknown>, o: { scene: string; seed: number; keys: RunKeys; params?: Record<string, unknown>; save: Record<string, unknown>; /** --perf: このフレームは、描いたときの数だけを取る（画像は置かない） */ statsAt?: number; stats?: Map<number, DrawStats>; spawns: import('../core/tryout.ts').TryoutSpawn[]; date: string }): Promise<string[]> {
  const scale = f['shot-scale'] !== undefined ? Number(f['shot-scale']) : 1;
  if (!(scale > 0 && scale <= 2)) throw new Error('--shot-scale は 0 より大きく 2 以下（例 0.5 で半分の大きさ。画像のトークンも減る）');
  const reach = frames.filter((n) => n === 0 || hashes.has(n));
  const out: string[] = [];
  for (const n of frames.filter((x) => !reach.includes(x))) out.push(`⚠ shot f${n}: そのフレームまで進んでいません（--frames を増やすか、--until で止まる前のフレームに）`);
  const all = [...new Set([...reach, ...(o.statsAt !== undefined ? [o.statsAt] : [])])];
  if (!all.length) return out;
  try {
    const r = await captureShots(p.dir, { scene: o.scene, seed: o.seed, frames: all, keys: o.keys, date: o.date, params: o.params, save: o.save, lang: typeof f.lang === 'string' ? f.lang : undefined, spawns: o.spawns, scale, dump: true });
    const dir = resolve(p.dir, typeof f['shot-dir'] === 'string' ? f['shot-dir'] : '.ages/shots');
    if (reach.length) await mkdir(dir, { recursive: true });
    const name = o.spawns.length ? 'tryout' : o.scene;
    const { width, height } = p.config.view;
    for (const s of r.shots) {
      o.stats?.set(s.frame, s.stats);
      if (!reach.includes(s.frame)) continue;
      const file = join(dir, `${name}-f${s.frame}.png`);
      await writeFile(file, Buffer.from(s.png, 'base64'));
      const same = hashes.get(s.frame) === s.hash;
      const rel = relative(p.dir, file).split(sep).join('/');
      out.push(`shot f${s.frame}: ${rel.startsWith('..') ? file : rel} ${Math.round(width * scale)}x${Math.round(height * scale)}${same ? '' : ' ' + snapshotDiff(snaps.get(s.frame), s.snapshot)}`);
    }
    if (r.error) out.push(`⚠ 画面のページでエラー（f${r.frame}）: ${r.error}`);
  } catch (e) {
    out.push(`⚠ ${reach.length ? '画面を撮れませんでした' : '描いたときの数を取れませんでした'}: ${(e as Error).message}`);
  }
  return out;
}

/** 保存データのファイル（キー → 値の JSON）を読む */
export async function readSaveFile(dir: string, path: string): Promise<Record<string, unknown>> {
  const text = await readFile(resolve(dir, path), 'utf8').catch(() => { throw new Error(`保存データのファイル ${path} がありません（saves/ に置いたファイルか、ages run --save-out で書き出したもの）`); });
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: 保存データは { キー: 値 } の形です`);
  return v;
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

/** AGES の版（プロジェクトの記録と今の本体）。記録が古ければ、直し方（docs/MIGRATIONS.md の要る項）を出す。--record で今の版を残す */
export async function cmdVersion(dir: string, record: boolean): Promise<string> {
  const p = await Project.load(dir);
  const cur = engineVersion();
  if (record) {
    const v = await recordVersion(p.dir);
    return `記録しました: AGES ${formatVersion(v)}（${v.recorded}）`;
  }
  const rec = p.config.engine;
  const lines = [`本体: AGES ${formatVersion(cur)}`, `プロジェクト: ${rec ? `AGES ${formatVersion(rec)}${rec.recorded ? `（${rec.recorded} に記録）` : ''}` : '記録なし（--record で今の版を残す）'}`];
  // 版だけ同梱で、起動用が前の版のもの（upgrade を前の起動用で行った）なら、当て直し方を出す（起動用と AGENTS.md を今の版に）
  const pinned = (JSON.parse(await readFile(join(p.dir, 'ages.project.json'), 'utf8')) as { engineSource?: { repo?: string; commit?: string } }).engineSource;
  const launcher = existsSync(join(p.dir, 'ages.mjs')) ? await readFile(join(p.dir, 'ages.mjs'), 'utf8') : null;
  if (pinned?.commit && launcher !== null && launcher !== await readFile(join(ENGINE_DIR, 'templates', 'launcher', 'ages.mjs'), 'utf8')) {
    lines.push(`起動用の ages.mjs がこの版のものと違う。合わせる（AGENTS.md も、手で直されていなければ合わせる）: node ${PINNED_ENGINE}/bin/ages.js pin . --repo ${pinned.repo ?? DEFAULT_REPO} --commit ${pinned.commit}`);
  }
  if (typeof rec?.compat === 'number' && rec.compat < cur.compat) {
    lines.push('', `直すこと（互換${rec.compat} → ${cur.compat}。上から順に。終わって確かめたら --record）:`);
    for (const m of migrations().filter((m) => m.n > rec.compat && m.n <= cur.compat)) lines.push('', `## ${m.n}. ${m.title}`, m.body);
  }
  return lines.join('\n');
}

export async function cmdCheck(dir: string): Promise<string> {
  const p = await Project.load(dir);
  const sh = await shaderReport(p.dir, p.assets);
  const warns: string[] = [];
  const errs = [...p.validate(), ...(await p.checkCode()), ...(await p.checkWindows(warns)), ...sh.errors];
  const miss = languagesOf(p.config).length > 1 ? p.missingText() : new Map<string, string[]>();
  const missNote = miss.size ? `\n未訳: ${[...miss].map(([l, ks]) => `${l} ${ks.length}件`).join('・')}（ages table <dir> text --empty 言語。訳がない間は既定の言語で出る）` : '';
  // シェーダーがコンパイルできるかはブラウザでしか分からない。エディタが開いていれば、変わるたびに確かめる
  const note = sh.unchecked.length ? `\nシェーダー ${sh.unchecked.join(' ')} はまだコンパイルを確かめていません（エディタを開いていると、変えるたびに確かめて ages check に出ます）` : '';
  // ゲーム独自の検証（defineCheck）は ⚠（編集は止めないもの）
  const own = p.projectChecks().map((m) => `\n⚠ ${m}`).join('');
  // 受けている出来事を、どこからも出していない（名前は文字なので型チェックで見えず、動かしても何も起きないだけ）
  const files = await p.codeFiles();
  const events = eventWarnings(p.registry.systems, files, codeDefs(files)).map((m) => `\n⚠ ${m}`).join('');
  const ver = versionNote(p.config.engine);
  const verNote = ver ? `\n${ver}` : '';
  const og = originSummary(await readOrigins(p.dir), p.assets, languagesOf(p.config));
  const ogNote = og.missing ? `\n⚠ 出どころが未記入のアセット ${og.missing}件（自作・AI 生成・素材のどれか。ages assets <dir> --origin）` : '';
  return withLockReport(p, (errs.length ? errs.map((e) => `error: ${e}`).join('\n') : `ok（シーン${p.docs.scenes.size} プレハブ${p.docs.prefabs.size} コンポーネント${p.registry.components.size} システム${p.registry.systems.length}）`) + warns.map((w) => `\n⚠ ${w}`).join('') + own + events + ogNote + note + missNote + verNote);
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

export interface TalkArgs {
  task?: string; steps?: string[]; step?: number; touch?: string[]; done?: string | true;
  ask?: string; choices?: string[]; about?: string; reply?: string; text?: string;
}

/** CLI の引数から（--steps は | で、--touch は , で区切る。行列のセル [2,3] の , では切らない） */
export function talkArgs(f: Args['flags'], text?: string): TalkArgs {
  const str = (k: string) => (typeof f[k] === 'string' ? f[k] as string : undefined);
  const list = (v: string | undefined, sep: RegExp) => v?.split(sep).map((x) => x.trim()).filter(Boolean);
  return {
    task: str('task'), steps: list(str('steps'), /\|/), step: str('step') !== undefined ? Number(str('step')) : undefined,
    touch: list(str('touch'), /,(?![^[]*\])/), done: f.done === true ? true : str('done'),
    ask: str('ask'), choices: list(str('choices'), /\|/), about: str('about'), reply: str('reply'), text,
  };
}

/** AI の編集に、いまの作業の ID を付ける（エディタで作業ごとにまとめる） */
export async function useActiveTask(dir: string): Promise<void> {
  // コードのファイルを直接直した場所も「最近の作業の場所」に（AI のコードの直しは AGES の命令を通らないので、命令のたびに見る）
  if (existsSync(join(dir, 'ages.project.json'))) await noteCodeEdits(resolve(dir)).catch(() => {});
  if (!existsSync(join(dir, '.ages', 'talk.jsonl'))) { delete AI_ACTOR.task; return; }
  const k = activeTask(foldTalk(await readTalk(resolve(dir))), AI_ACTOR.who);
  if (k) AI_ACTOR.task = k.id; else delete AI_ACTOR.task;
}

/** 人の書き込み（付箋・答え）を AI がまだ読んでいなければ、出力の先頭に1行 */
export async function withTalkNotice(dir: string, cmd: string, out: string): Promise<string> {
  if (cmd === 'talk' || cmd === 'init' || !existsSync(join(dir, '.ages', 'talk.jsonl'))) return out;
  const n = await talkNotice(resolve(dir)).catch(() => '');
  return n ? `${n}\n${out}` : out;
}

/** エディタの人とのやり取り。作業を始める・進める・終える、質問する、付箋に返事をする。最後に人からの書き込みを見せて既読にする */
export async function cmdTalk(dir: string, a: TalkArgs): Promise<string> {
  const root = resolve(dir);
  if (!existsSync(join(root, 'ages.project.json'))) throw new Error(`${dir} は AGES のプロジェクトではありません（ages.project.json がない）`);
  const me = { who: AI_ACTOR.who, kind: 'ai' as const };
  const done: string[] = [];
  let state = foldTalk(await readTalk(root));
  let cur = activeTask(state, me.who);
  const warn = await addressWarnings(root, [...(a.touch ?? []), ...(a.about ? [a.about] : [])]);
  if (a.task) {
    if (cur) await appendTalk(root, me, { ev: 'done', id: cur.id });
    const id = newId('t');
    await appendTalk(root, me, { ev: 'task', id, title: a.task, ...(a.steps?.length ? { steps: a.steps } : {}), ...(a.touch?.length ? { touch: a.touch } : {}) });
    done.push(`作業 ${id} を始めた: ${a.task}${a.steps?.length ? `（1/${a.steps.length} ${a.steps[0]}）` : ''}`);
  } else if (a.step !== undefined || a.touch?.length) {
    if (!cur) throw new Error('いまの作業がありません。--task "何をするか" で始める');
    if (a.step !== undefined && (!Number.isInteger(a.step) || a.step < 1 || (cur.steps.length && a.step > cur.steps.length))) throw new Error(`--step は 1〜${cur.steps.length || '段階の数'}（--steps で段階を書いた作業の何番目か）`);
    await appendTalk(root, me, { ev: 'step', id: cur.id, ...(a.step !== undefined ? { step: a.step } : {}), ...(a.touch?.length ? { touch: a.touch } : {}) });
    if (a.step !== undefined) done.push(`${a.step}/${cur.steps.length || '?'}${cur.steps[a.step - 1] ? ` ${cur.steps[a.step - 1]}` : ''}`);
    if (a.touch?.length) done.push(`触る予定: ${a.touch.join(' ')}`);
  }
  state = foldTalk(await readTalk(root));
  cur = activeTask(state, me.who);
  if (a.ask) {
    const id = newId('q');
    await appendTalk(root, me, { ev: 'ask', id, text: a.ask, ...(a.choices?.length ? { choices: a.choices } : {}), ...(a.about ? { about: a.about } : {}), ...(cur ? { task: cur.id } : {}) });
    done.push(`質問 ${id} を出した（答えを待たずに続けてよい。答えは次の ages の出力に 📌 で出る）`);
  }
  if (a.reply) {
    const n = state.notes.find((x) => x.id === a.reply);
    if (!n) throw new Error(`付箋 ${a.reply} はありません${suggest(a.reply, state.notes.map((x) => x.id))}`);
    await appendTalk(root, me, { ev: 'reply', id: n.id, ...(a.text ? { text: a.text } : {}) });
    done.push(`付箋 ${n.id} を済にした`);
  }
  if (a.done !== undefined) {
    if (!cur) throw new Error('いまの作業がありません（終わらせる作業がない）');
    await appendTalk(root, me, { ev: 'done', id: cur.id, ...(typeof a.done === 'string' ? { text: a.done } : {}) });
    done.push(`作業 ${cur.id} を終えた`);
  }
  const cursor = await readTalkCursor(root);
  const view = talkView(foldTalk(await readTalk(root)), me.who, cursor);
  await writeTalkCursor(root);
  return [...done, ...warn, view].join('\n');
}

/** 住所の形だけを確かめる（あるかどうか。ないものは ⚠。エディタで印が出ないため） */
async function addressWarnings(root: string, addrs: string[]): Promise<string[]> {
  if (!addrs.length) return [];
  const p = await Project.load(root);
  return addrs.filter((x) => !addressExists(p, x)).map((x) => `⚠ ${x} が見つかりません（エディタで印が出ません）`);
}

export function addressExists(p: Project, addr: string): boolean {
  const head = addr.split(/[.[|]/)[0];
  if (addr.startsWith('@')) return !!p.registry.findPrefab(head.slice(1));
  if (addr.startsWith('$')) return p.docs.tables.has(head.slice(1));
  if (addr.startsWith('file:') || addr.startsWith('sheet:')) return true;
  if (head.includes('#')) { const [sc, id] = head.split('#'); return !!p.docs.scenes.get(sc)?.entities.some((e) => e.id === id); }
  return p.docs.scenes.has(head) || existsSync(join(p.dir, addr));
}

/**
 * 新しいプロジェクトを作り、本体のこの版が GitHub にもあれば、版だけ同梱の形にする（命令と MCP の ages_init）。
 * 版だけ同梱なら、プロジェクトを別のパソコン・別の場所へ移しても ages.mjs が本体を取ってきて動く。
 * 本体を今の場所から指す形は、移す・本体のフォルダを消すと「エディタを開く」が本体を見つけられない。pin: true=必ず / false=しない / 省く=できるなら
 */
export async function cmdInitPinned(dir: string, name?: string, pin?: boolean, template?: string): Promise<string> {
  // テンプレートから始めるかは、作る前に決める（決めていなければ、作らずに聞く）
  if (template === undefined) return templateQuestion(dir);
  const out = await cmdInit(dir, name, template);
  if (pin === true || (pin !== false && engineOnRemote())) return `${out}\n${await cmdPin(dir)}`;
  return `${out}\n（AGES 本体を今の場所から指す形です。このプロジェクトを別のパソコン・別の場所で使うなら ages pin <dir>）`;
}

/** プロジェクトの tsconfig.json（型チェックと、コードのエディタの補完用。本体の場所は engine） */
export function tsconfigText(engine: string): string {
  return `{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true,
    "allowImportingTsExtensions": true, "erasableSyntaxOnly": true, "skipLibCheck": true, "lib": ["ES2022", "DOM"],
    "paths": { "ages": ["${engine}/src/index.ts"], "ages/*": ["${engine}/src/packages/*/index.ts"] }
  },
  "include": ["game/**/*.ts", "editor/**/*.ts"]
}
`;
}

/** プロジェクトが入れている追加パッケージの命令（設定を読めないフォルダなら、なし） */
export async function packageCommands(dir: string): Promise<PackageCommand[]> {
  try {
    const cfg = JSON.parse(await readFile(join(resolve(dir), 'ages.project.json'), 'utf8')) as { packages?: unknown };
    return cfg.packages ? await loadPackageCommands(cfg.packages) : [];
  } catch {
    return [];
  }
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
  await useActiveTask(dir);
  let out: string;
  switch (cmd) {
    case 'init': out = await cmdInitPinned(dir, typeof a.flags.name === 'string' ? a.flags.name : undefined, a.flags.pin === true ? true : a.flags['no-pin'] === true ? false : undefined, typeof a.flags.template === 'string' ? a.flags.template : undefined); break;
    case 'map': out = await cmdMap(dir, a.pos[1]); break;
    case 'find': out = await cmdFind(dir, need(a.pos.slice(1).join(' ') || undefined, '探す語（例 移動速度）')); break;
    case 'code': out = await cmdCode(dir, a.pos.slice(1), a.flags); break;
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
    case 'version': out = await cmdVersion(dir, a.flags.record === true); break;
    case 'export': out = await cmdExport(dir, a.flags); break;
    case 'pin': out = await cmdPin(dir, typeof a.flags.repo === 'string' ? a.flags.repo : undefined, typeof a.flags.commit === 'string' ? a.flags.commit : undefined, a.flags.force === true); break;
    case 'assets': out = await cmdAssets(dir, a.pos[1], a.flags); break;
    case 'ui': out = await cmdUi(dir, a.pos[1]); break;
    case 'undo': out = await cmdUndo(dir, a.flags); break;
    case 'redo': out = await cmdUndo(dir, { ...a.flags, redo: true }); break;
    case 'sheet': out = await cmdSheet(dir, need(a.pos[1], '画像の場所（例 assets/hero.png）')); break;
    case 'slice': out = await cmdSlice(dir, need(a.pos[1], '画像の場所（例 assets/hero.png）'), a.flags); break;
    case 'table': out = await cmdTable(dir, need(a.pos[1], '表の名前（例 enemies）').replace(/^\$/, ''), a.flags); break;
    case 'talk': out = await cmdTalk(dir, talkArgs(a.flags, a.pos[1])); break;
    default: {
      // 追加パッケージの命令（そのプロジェクトが入れているものだけ）
      const pc = (await packageCommands(dir)).find((c) => c.name === cmd);
      if (!pc) throw new Error(`未知のコマンド ${cmd}。ages help で一覧を表示します`);
      out = await pc.run(dir, { ...a.flags, ...(pc.pos && a.pos[1] !== undefined ? { [pc.pos]: a.pos[1] } : {}) });
    }
  }
  console.log(await withTalkNotice(dir, cmd, out));
}

/** --params の書き方: a=1,b=名前 か {"a":1} */
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
