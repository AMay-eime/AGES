// AGES の MCP サーバー（依存ゼロ）。
// 使用者のPC上で、AIのアプリ（Claude Code など）がこのプログラムを起動し、標準入出力でやりとりする。ネット上のサーバーは要らない。
//   node <AGES>/src/mcp/server.ts --project <プロジェクトのフォルダ>
// 道具（tools）は CLI と同じ関数を呼ぶだけ。使い方の説明（instructions）も一緒に渡すので、AIは最初から手順を知っている。
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cmdCheck, cmdGet, cmdInit, cmdLog, cmdMap, cmdPatch, cmdRun, cmdSchema, cmdSheet, cmdSlice, cmdTable } from '../cli/ages.ts';
import { parseLiteral, splitCell, type Op } from '../core/patch.ts';

process.removeAllListeners('warning');

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const defaultProject = resolve(flag('project') ?? process.env.AGES_PROJECT ?? process.cwd());
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;

const INSTRUCTIONS = `AGES は、AIと人が一緒に速くゲームを作るためのゲームエンジン兼エディタ。
- ゲームの企画を受けたら、いきなりコードを書かない。まず ages_init でプロジェクトを作り、EDITOR-PLAN.md で「どんなエディタが必要か」を使用者と決める（「一緒に決めるか、AIにおまかせか」を最初に聞く。おまかせを自分から選ばない）。合意するまでゲームのコードは書かない
- 作業のたびに最初に ages_map（全体の地図）と ages_log（前回から人が変えたこと）を読む
- 値は ages_set / ages_patch で変える。JSONを直接書き換えない。行列はセル単位（住所[行,列]）。リストの中は 住所[番号]、構造体の中は 住所.名前
- 同じ形の行がたくさん並ぶデータ（武器・敵・カードなど）は表にする（defineTable と data/<表>.table.json）。住所は $表.行.列、中身は ages_table で見る
- 🔒ロックされた値は絶対に変えない（変えられない）。変えるべき理由があれば人に提案する。★人が調整した値は、人に確認してから force
- 変更後は ages_run で確かめる（keys で入力を指定、twice で再現性）
- 音は Sound の付いたプレハブを作り ctx.sound.play('名前') で鳴らす。鳴ったかは ages_run の sounds: と ⚠ で確かめる（音を聞かなくてよい）
- 画像の切り方（スプライトシート）は ages_sheet で見て、ages_slice（格子・数・自動）か ages_patch の setFrame / setClip で変える。画像を開いて確かめない
- 面白さの核・手触り・個性は人が決める。AIが出すものは「案」と明記する
詳しくはプロジェクトの AGENTS.md。`;

const dirProp = { dir: { type: 'string', description: `プロジェクトのフォルダ（省略時: ${defaultProject}）` } };

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(a: Record<string, any>, dir: string): Promise<string>;
}

const TOOLS: Tool[] = [
  {
    name: 'ages_map',
    description: 'プロジェクトの地図。コンポーネント（型・範囲）、システム（実行順・読み書き）、プレハブ、シーン、🔒ロックと★人の調整の印。作業のたびに最初に読む',
    inputSchema: { type: 'object', properties: { ...dirProp } },
    run: (_a, dir) => cmdMap(dir),
  },
  {
    name: 'ages_log',
    description: '前回からの編集の要約（人が何を変えたか）。peek=true なら既読にしない。all=true なら全件',
    inputSchema: { type: 'object', properties: { ...dirProp, peek: { type: 'boolean' }, all: { type: 'boolean' } } },
    run: (a, dir) => cmdLog(dir, { ...(a.peek ? { peek: true } : {}), ...(a.all ? { all: true } : {}) }),
  },
  {
    name: 'ages_schema',
    description: 'コンポーネントの詳細（各フィールドの型・範囲・既定値・説明）',
    inputSchema: { type: 'object', properties: { ...dirProp, components: { type: 'array', items: { type: 'string' }, description: '省略時はすべて' } } },
    run: (a, dir) => cmdSchema(dir, a.components ?? []),
  },
  {
    name: 'ages_get',
    description: '値を見る。住所の例: main#player（エンティティ）, main#player.Player（コンポーネント）, main#player.Player.speed（値）, @enemy（プレハブ）',
    inputSchema: { type: 'object', properties: { ...dirProp, addresses: { type: 'array', items: { type: 'string' } } }, required: ['addresses'] },
    run: (a, dir) => cmdGet(dir, a.addresses),
  },
  {
    name: 'ages_set',
    description: '値を1つ変える。行列のセルは住所[行,列]（例 main#spawner.Spawner.formation[2,3]）。🔒は変えられない。★は人の確認を取ってから force=true',
    inputSchema: { type: 'object', properties: { ...dirProp, address: { type: 'string' }, value: { description: '新しい値（数値・真偽・文字列・配列）' }, force: { type: 'boolean' } }, required: ['address', 'value'] },
    run: (a, dir) => {
      const { path, cell } = splitCell(a.address);
      const value = typeof a.value === 'string' ? parseLiteral(a.value) : a.value;
      const op: Op = cell ? { op: 'setCells', path, cells: [[cell[0], cell[1], value as number]] } : { op: 'set', path, value };
      return cmdPatch(dir, [op], !!a.force);
    },
  },
  {
    name: 'ages_patch',
    description: '複数の操作をまとめて行う（すべて成功するか、何も変えないか）。op: set{path,value} / setCells{path,cells:[[行,列,値]]} / addEntity{scene,entity:{id,name?,tags?,components?}} / removeEntity{scene,id} / addComponent{target,component,values?} / removeComponent{target,component} / rename{target,name} / insert{path,value?,index?}（リストに足す） / removeItem{path:"…[2]"} / moveItem{path:"…[2]",to} / addRow{table,row:{id,...},index?} / removeRow{table,id} / moveRow{table,id,to} / renameRow{table,id,to}（参照も直る） / setFrame{image,frame(番号か名前),name?,rect?:[x,y,w,h],pivot?:[x,y]|null,remove?}（ない名前に rect で追加。名前を変えると参照も直る） / setClip{image,clip,frames?,fps?,loop?,remove?} / setSheet{image,sheet|null}',
    inputSchema: { type: 'object', properties: { ...dirProp, ops: { type: 'array', items: { type: 'object' } }, force: { type: 'boolean' } }, required: ['ops'] },
    run: (a, dir) => cmdPatch(dir, a.ops as Op[], !!a.force),
  },
  {
    name: 'ages_run',
    description: '画面なしで実行し、要約だけを返す。keys の例 "0-120:ArrowLeft+KeyZ;120-200:ArrowRight"。watch の例 ["player.Health.hp"]。until はその出来事で止める。twice=true で再現性を確かめる',
    inputSchema: {
      type: 'object',
      properties: {
        ...dirProp,
        frames: { type: 'number' }, scene: { type: 'string' }, seed: { type: 'number' }, keys: { type: 'string' },
        input: { type: 'string', description: '入力の記録のファイル（recordings/xxx.input.json）' },
        watch: { type: 'array', items: { type: 'string' } }, every: { type: 'number' }, until: { type: 'string' }, twice: { type: 'boolean' },
      },
    },
    run: (a, dir) => {
      const f: Record<string, string | true> = {};
      for (const k of ['frames', 'scene', 'seed', 'keys', 'input', 'every', 'until']) if (a[k] !== undefined) f[k] = String(a[k]);
      if (a.watch?.length) f.watch = a.watch.join(',');
      if (a.twice) f.twice = true;
      return cmdRun(dir, f);
    },
  },
  {
    name: 'ages_check',
    description: '全データの検証とロックの検査',
    inputSchema: { type: 'object', properties: { ...dirProp } },
    run: (_a, dir) => cmdCheck(dir),
  },
  {
    name: 'ages_table',
    description: '表を1行1行で見る（タブ区切り）。cols・rows で絞れる。export で CSV に書き出し、import で CSV・TSV から表をまるごと置き換える',
    inputSchema: { type: 'object', properties: { ...dirProp, table: { type: 'string', description: '表の名前（例 enemies）' }, cols: { type: 'string', description: '列（, 区切り）' }, rows: { type: 'string', description: '行の id（, 区切り）' }, export: { type: 'string' }, import: { type: 'string' }, force: { type: 'boolean' } }, required: ['table'] },
    run: (a, dir) => {
      const flags: Record<string, string | true> = {};
      for (const k of ['cols', 'rows', 'export', 'import']) if (a[k] !== undefined) flags[k] = String(a[k]);
      if (a.force) flags.force = true;
      return cmdTable(dir, String(a.table).replace(/^\$/, ''), flags);
    },
  },
  {
    name: 'ages_sheet',
    description: '画像の切り方（コマの名前・位置・基準点・動き）を見る',
    inputSchema: { type: 'object', properties: { ...dirProp, image: { type: 'string', description: '画像の場所（例 assets/hero.png）' } }, required: ['image'] },
    run: (a, dir) => cmdSheet(dir, a.image),
  },
  {
    name: 'ages_slice',
    description: '画像を切ってコマにする。grid（1コマの大きさ）か count（列x行）か auto（描かれた部分ごと）。前と同じ場所のコマは名前を引き継ぎ、番号の指定がずれたら直す。dry で保存せずに結果だけ見る',
    inputSchema: {
      type: 'object',
      properties: {
        ...dirProp,
        image: { type: 'string', description: '画像の場所' },
        grid: { type: 'string', description: '1コマの大きさ 幅x高さ（例 32x32）' },
        count: { type: 'string', description: 'コマの数 列x行（例 4x6）' },
        auto: { type: 'boolean', description: '描かれた部分のかたまりごとに切る（PNGのみ）' },
        spacing: { type: 'number' }, margin: { type: 'number' },
        skipEmpty: { type: 'boolean', description: '格子で、何も描かれていないコマを除く' },
        gap: { type: 'number', description: 'auto: この距離(px)以内の部分は1コマにまとめる' },
        min: { type: 'number', description: 'auto: これより小さいものは捨てる(px)' },
        pad: { type: 'number', description: 'auto: 矩形を外へ広げる(px)' },
        pivot: { type: 'string', description: '新しいコマの基準点 横,縦（例 0.5,1 = 下の中央）' },
        dry: { type: 'boolean' }, force: { type: 'boolean', description: '人が調整した切り方を、人に確認したうえで変える' },
      },
      required: ['image'],
    },
    run: (a, dir) => {
      const flags: Record<string, string | true> = {};
      for (const k of ['grid', 'count', 'spacing', 'margin', 'gap', 'min', 'pad', 'pivot']) if (a[k] !== undefined) flags[k] = String(a[k]);
      for (const [k, f] of [['auto', 'auto'], ['skipEmpty', 'skip-empty'], ['dry', 'dry'], ['force', 'force']]) if (a[k]) flags[f] = true;
      return cmdSlice(dir, a.image, flags);
    },
  },
  {
    name: 'ages_init',
    description: '新しいプロジェクトを作る（AGENTS.md・EDITOR-PLAN.md 付き）。ゲームの企画を受けたら最初にこれ',
    inputSchema: { type: 'object', properties: { dir: { type: 'string', description: '作る場所' }, name: { type: 'string' } }, required: ['dir'] },
    run: (a) => cmdInit(a.dir, a.name),
  },
];

// ---------- JSON-RPC（1行に1メッセージ） ----------
const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };

async function handle(msg: { id?: number | string; method: string; params?: any }): Promise<void> {
  const reply = (result: unknown): void => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); };
  const fail = (code: number, message: string): void => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code, message } }); };
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ages', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `道具 ${msg.params?.name} はありません。使えるのは ${TOOLS.map((t) => t.name).join(' / ')}`);
      const a = msg.params?.arguments ?? {};
      try {
        const text = await tool.run(a, resolve(a.dir ?? defaultProject));
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        // 道具のエラーは「失敗した結果」として返す（AIが読んで直せるように）
        return reply({ content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `未知のメソッド ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSONとして読めません' } }); return; }
  queue = queue.then(() => handle(msg)).catch((e) => console.error(e));
});
