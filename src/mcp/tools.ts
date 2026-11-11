// AGES の MCP の道具（tools）と、使い方の説明（instructions）。
// server.ts から使う。テスト（毎回読む量の上限）からも読めるよう、標準入出力を開かないこのファイルに分けてある。
import { cmdAssets, cmdUndo, cmdCheck, cmdUi, cmdGet, cmdInitPinned, cmdLog, cmdMap, cmdFind, cmdPatch, cmdRun, cmdSchema, cmdSheet, cmdSlice, cmdTable, cmdTalk } from '../cli/ages.ts';
import { parseLiteral, splitCell, type Op } from '../core/patch.ts';

/** 使い方の説明（MCP の initialize で毎回渡る）。短く保つ: 機能ごとの手順は ages_schema の guide で要るときに引く */
export function makeInstructions(defaultProject: string): string {
  return `AGES は、AIと人が一緒に速くゲームを作るためのゲームエンジン兼エディタ。道具の dir を省くと ${defaultProject}。
- ゲームの企画を受けたら、いきなりコードを書かない。まず ages_init でプロジェクトを作り、EDITOR-PLAN.md で「どんなエディタが必要か」を使用者と決める（「一緒に決めるか、AIにおまかせか」を最初に聞く。おまかせを自分から選ばない）。合意するまでゲームのコードは書かない
- 作業の始めに ages_talk の task で、人のエディタに何をするかを見せ、終わりに done。人が決めることは ask。出力の先頭に 📌 が出たら ages_talk で読む
- 作業のたびに最初に ages_map（全体の地図）と ages_log（前回から人が変えたこと）を読む。大きなプロジェクトの地図は目次なので、中身は ages_find（名前・説明から探す）か ages_map の section で引く
- 値は ages_set / ages_patch で変える。JSONやアセットのファイルを直接書き換えない・動かさない。行列はセル単位（住所[行,列]）、リストの中は 住所[番号]、構造体の中は 住所.名前
- 同じ形の行が並ぶデータ（武器・敵・カードなど）は表にする（住所は $表.行.列、中身は ages_table）
- 🔒ロックされた値は絶対に変えない（変えられない）。変えるべき理由があれば人に提案する。★人が調整した値は、人に確認してから force
- 間違えた編集は ages_undo で戻す（逆の操作を考えなくてよい）
- 確かめは作業の重さに合わせて最小で（調べるだけ→なし、値・データ→ages_check、部分をつなぐコード→ages_run を短く1回。詳しくは AGENTS.md）。画面・画像・音を開かずに、要約の行（sounds: hits: ui: など）と ⚠ で確かめる
- 機能を使う前に ages_schema で guide（機能ごとの手順の目次）を見て、guide:項目 で手順を引く。標準の部品と表（Sprite・Camera・Sound・UI・Collider・Particles・$actions・$tweens・$text など）を作り直さない
- ゲームのコードは、乱数を ctx.rng、入力を操作の名前（ctx.input.isDown('fire')）、画面の言葉を ctx.t('名前') で扱う。手触りの数字はコードに書かずデータに置く
- 面白さの核・手触り・個性は人が決める。AIが出すものは「案」と明記する
詳しくはプロジェクトの AGENTS.md。`;
}


export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(a: Record<string, any>, dir: string): Promise<string>;
}

/** 道具の一覧。defaultProject は dir を省いたときのフォルダ（説明に出る） */
export function makeTools(defaultProject: string): Tool[] {
  const dirProp = { dir: { type: 'string', description: 'プロジェクトのフォルダ' } };
  const strs = { type: 'array', items: { type: 'string' } };
  return [
    {
      name: 'ages_map',
      description: 'プロジェクトの地図。コンポーネント、システム（実行順・読み書き）、表、プレハブ、シーン、🔒★の印。作業のたびに最初に読む。大きなプロジェクトでは目次になり、section（components systems tables prefabs scenes など。まとめ 名前/(数) は 節/名前 で、例 prefabs/se）で中身を引く',
      inputSchema: { type: 'object', properties: { ...dirProp, section: { type: 'string' } } },
      run: (a, dir) => cmdMap(dir, a.section),
    },
    {
      name: 'ages_find',
      description: '部品・フィールド・表の列と行・システム・プレハブ・シーンの物を名前と説明から探す（例 "移動速度"）',
      inputSchema: { type: 'object', properties: { ...dirProp, words: { type: 'string' } }, required: ['words'] },
      run: (a, dir) => cmdFind(dir, a.words),
    },
    {
      name: 'ages_log',
      description: '前回からの編集の要約（人が何を変えたか）。peek=true なら既読にしない。all=true なら全件',
      inputSchema: { type: 'object', properties: { ...dirProp, peek: { type: 'boolean' }, all: { type: 'boolean' } } },
      run: (a, dir) => cmdLog(dir, { ...(a.peek ? { peek: true } : {}), ...(a.all ? { all: true } : {}) }),
    },
    {
      name: 'ages_schema',
      description: '詳しい説明を引く。names に: コンポーネント（例 UI。型・範囲・既定値）/ $表 / シェーダー（例 std:flash）/ ops（ages_patch の操作の一覧）/ guide（機能ごとの手順の目次）/ guide:項目（例 guide:ui）',
      inputSchema: { type: 'object', properties: { ...dirProp, names: { type: 'array', items: { type: 'string' }, description: '省くとコンポーネントと表をすべて' } } },
      run: (a, dir) => cmdSchema(dir, a.names ?? a.components ?? []),
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
      description: '複数の操作をまとめて行う（すべて成功するか、何も変えないか）。例 [{"op":"set","path":"main#player.Player.speed","value":5}]。op の一覧と書き方は ages_schema の ops（足す・消す・動かす・名前を変える・コマ・シーン・プレハブと派生・アセットの移動・UI の配置 dockUI / attachUI など）',
      inputSchema: { type: 'object', properties: { ...dirProp, ops: { type: 'array', items: { type: 'object' } }, force: { type: 'boolean' } }, required: ['ops'] },
      run: (a, dir) => cmdPatch(dir, a.ops as Op[], !!a.force),
    },
    {
      name: 'ages_run',
      description: '画面なしで実行し、要約だけを返す。keys の例 "0-300:@fire;0-120:@move_x=-1;300:click=retry"（開始-終了:入力+入力。title+30:… はシーンに入ってから。@操作 は表 $actions の名前。書き方の全部は guide:input）。watch の例 ["player.Health.hp"]。until はその出来事（scene:名前 でそのシーンに入ったら）で止める。twice=true で再現性を確かめる',
      inputSchema: {
        type: 'object',
        properties: {
          ...dirProp,
          frames: { type: 'number' }, scene: { type: 'string' }, seed: { type: 'number' }, keys: { type: 'string' },
          spawn: { type: 'string', description: 'プレハブだけを空のシーンの真ん中に出して試す（例 "enemy,explosion@40,0"。消えたら止まる）' },
          input: { type: 'string', description: '入力の記録のファイル（recordings/xxx.input.json）' },
          watch: { type: 'array', items: { type: 'string' } }, every: { type: 'number' }, until: { type: 'string' }, twice: { type: 'boolean' },
          save: { type: 'string', description: 'この保存データ（saves/x.save.json）から始める。省くと空' },
          saveOut: { type: 'string', description: '終わりの保存データを書き出す' },
          lang: { type: 'string', description: '言語' }, date: { type: 'string', description: 'ctx.date の始め' },
          params: { type: 'object', description: '始めのシーンの scene.params' },
          shot: { type: 'string', description: 'その画面を撮る（例 "0,600"）' }, shotScale: { type: 'number' },
          perf: { type: 'boolean', description: '重い所を探す（guide:perf）' },
        },
      },
      run: (a, dir) => {
        const f: Record<string, string | true> = {};
        for (const k of ['frames', 'scene', 'spawn', 'seed', 'keys', 'input', 'every', 'until', 'lang', 'date']) if (a[k] !== undefined) f[k] = String(a[k]);
        if (a.watch?.length) f.watch = a.watch.join(',');
        if (a.twice) f.twice = true;
        if (a.save) f.save = String(a.save);
        if (a.saveOut) f['save-out'] = String(a.saveOut);
        if (a.params) f.params = JSON.stringify(a.params);
        if (a.shot !== undefined) f.shot = String(a.shot);
        if (a.shotScale !== undefined) f['shot-scale'] = String(a.shotScale);
        if (a.perf) f.perf = true;
        return cmdRun(dir, f);
      },
    },
    {
      name: 'ages_ui',
      description: 'UI の配置を文字で（四角・置き方・重なり・はみ出しの ⚠）。直すのは ages_patch の dockUI / attachUI（座標を計算しない）',
      inputSchema: { type: 'object', properties: { ...dirProp, scene: { type: 'string', description: 'シーン（省くと開始のシーン）' } } },
      run: (a, dir) => cmdUi(dir, a.scene),
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
      inputSchema: { type: 'object', properties: { ...dirProp, table: { type: 'string', description: '表の名前（例 enemies）' }, cols: { type: 'string', description: '列（, 区切り）' }, rows: { type: 'string', description: '行の id（, 区切り）' }, empty: { type: 'string', description: 'この列が空の行だけ（未訳の言葉: table=text, empty=en）' }, export: { type: 'string' }, import: { type: 'string' }, force: { type: 'boolean' } }, required: ['table'] },
      run: (a, dir) => {
        const flags: Record<string, string | true> = {};
        for (const k of ['cols', 'rows', 'empty', 'export', 'import']) if (a[k] !== undefined) flags[k] = String(a[k]);
        if (a.force) flags.force = true;
        return cmdTable(dir, String(a.table).replace(/^\$/, ''), flags);
      },
    },
    {
      name: 'ages_undo',
      description: '自分（AI）の直前の編集を元に戻す（redo=true でやり直す）。その後で同じ所が変えられていれば止まる。間違えた編集は、逆の操作を考えずにこれで戻す',
      inputSchema: { type: 'object', properties: { ...dirProp, redo: { type: 'boolean' }, tx: { type: 'string', description: '戻す編集の ID（省くと直前）' }, force: { type: 'boolean' } } },
      run: (a, dir) => cmdUndo(dir, { ...(a.redo ? { redo: true } : {}), ...(a.tx ? { tx: a.tx } : {}), ...(a.force ? { force: true } : {}) }),
    },
    {
      name: 'ages_assets',
      description: 'アセット（画像・音・フォント）の一覧。フォルダごと、大きさ・長さ・使っている所の数。refs で、そのファイル（かフォルダ）を使っている所。unused で使っていないものだけ',
      inputSchema: {
        type: 'object',
        properties: {
          ...dirProp,
          folder: { type: 'string', description: 'このフォルダの中だけ（例 assets/ships）' },
          kind: { type: 'string', description: 'image sound font shader model' },
          unused: { type: 'boolean' },
          refs: { type: 'string', description: '使っている所を見るファイルかフォルダ' },
        },
      },
      run: (a, dir) => cmdAssets(dir, a.folder, { ...(a.kind ? { kind: a.kind } : {}), ...(a.unused ? { unused: true } : {}), ...(a.refs ? { refs: a.refs } : {}) }),
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
          skipEmpty: { type: 'boolean' }, gap: { type: 'number' }, min: { type: 'number' }, pad: { type: 'number' },
          pivot: { type: 'string', description: '新しいコマの基準点（例 0.5,1）' },
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
      name: 'ages_talk',
      description: 'エディタの人とのやり取り。作業の始めに task（steps・touch=触る住所）、区切りで step、終わりに done。人が決めることは ask（choices・about）。付箋を片付けたら reply=ID と text。引数なしで人の書き込みを読む',
      inputSchema: {
        type: 'object',
        properties: {
          ...dirProp, task: { type: 'string' }, steps: strs, step: { type: 'number' }, touch: strs, done: { type: 'string' },
          ask: { type: 'string' }, choices: strs, about: { type: 'string' }, reply: { type: 'string' }, text: { type: 'string' },
        },
      },
      run: (a, dir) => cmdTalk(dir, { ...a, ...(a.done !== undefined ? { done: a.done || true } : {}) }),
    },
    {
      name: 'ages_init',
      description: '新しいプロジェクトを作る（AGENTS.md・EDITOR-PLAN.md 付き）。ゲームの企画を受けたら最初にこれ',
      inputSchema: { type: 'object', properties: { dir: { type: 'string', description: '作る場所' }, name: { type: 'string' } }, required: ['dir'] },
      run: (a) => cmdInitPinned(a.dir, a.name),
    },
  ];
}
