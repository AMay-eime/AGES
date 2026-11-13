// プロジェクトの地図。AIが最初に読む1枚。全体を少ないトークンで把握できる形にする。
import { brief, suggest } from '../core/schema.ts';
import { frameCount } from '../core/sheet.ts';
import { assetRefs, baseOf, dirOf, isUnder } from '../core/assets.ts';
import type { AssetKind } from '../core/schema.ts';
import type { Project } from './project.ts';
import { languagesOf } from '../core/i18n.ts';
import { hasChildren, instanceOverrides, overridesOf, prefabChildren, prefabHolders, type ResolvedChild } from '../core/variant.ts';
import { tagCounts, type WindowInfo } from './windows.ts';
import type { LockMark, TouchMark } from './oplog.ts';
import { RECENT_WINDOW } from './recent.ts';
import type { ComponentDef } from '../core/schema.ts';
import type { ShaderDef } from '../core/shader.ts';
import type { SystemDef } from '../core/registry.ts';
import type { TableDef } from '../core/table.ts';
import type { PrefabDoc, SceneDoc } from '../core/docs.ts';
import { treeParents, NUMBERED } from '../editor/tree.ts';
import { buildTree, commonDir, fileKeys, findNode, isNode, keysOf, topLine, treePage, type TreeItem, type TreeNode } from './map-tree.ts';


/** 地図の大きさの上限（文字）。超えるプロジェクトでは細かいところを省いた要約の地図、それでも超えるなら目次の地図にする（中身は節ごと・名前で引く） */
export const MAP_BUDGET = 12000;
/**
 * 節の中身が、1つの作業で要る確率の仮の値（測らない。節を足す段階で置く。開発者の決定 2026-11-11）。
 * 節を目次の1行にするしきい値は、この確率で決まる: 大きさ s が T(p) = (S + p·h) / (1 − p) を超えたら、畳むほうが得
 * （S = 目次の1行の大きさ、h = 1回引く手間。畳んでも中身は ages map <dir> 節 で引ける）。
 * よく要る節（シーン・システム・部品）は 2,500字まで開いたまま、あまり要らない節（アセット・シェーダー）は 400字ほどで畳む。
 * エディタ拡張の節は、読み込めない拡張の ⚠ が出る所で、作る前に必ず見る所なので、高く置く
 */
export const SECTION_PRIOR: Record<MapSection, number> = { scenes: 0.87, systems: 0.87, components: 0.87, tables: 0.6, prefabs: 0.6, extensions: 0.87, shaders: 0.5, assets: 0.5 };
/** 目次の1行の大きさと、1回引く手間（文字に直した仮の値） */
const INDEX_LINE_COST = 60, LOOKUP_COST = 300;
/** 節の大きさの上限（文字）。超えた節だけ、目次の1行にする（全体が MAP_BUDGET に収まっていても） */
export function sectionMax(sec: MapSection): number {
  const p = SECTION_PRIOR[sec];
  return Math.round((INDEX_LINE_COST + p * LOOKUP_COST) / (1 - p));
}

/** 地図の節（ages map <dir> <節> で1つだけ引ける） */
export const MAP_SECTIONS = ['components', 'shaders', 'systems', 'tables', 'prefabs', 'scenes', 'assets', 'extensions'] as const;
export type MapSection = (typeof MAP_SECTIONS)[number];
/** full: 型・範囲・説明まで / compact: 名前と説明の初め / index: 節ごとの数と名前だけ（目次） */
export type MapMode = 'full' | 'compact' | 'index';

export interface MapInputs {
  touched?: Record<string, TouchMark>;
  locks?: Record<string, LockMark>;
  code?: Map<string, string[]>;
  windows?: WindowInfo[];
  gotos?: Map<string, string[]>;
  /** 最近の作業の場所（.ages/recent.json の上位。目次の地図に出す） */
  recent?: { place: string; hits: number }[];
  /** 最近の作業の場所を数えた長さ（操作の回数。既定 RECENT_WINDOW） */
  recentWindow?: number;
  /** コードの中の宣言の場所（codeDefs。システムの行に出す） */
  defs?: Map<string, string>;
}

export function renderMap(p: Project, touched: Record<string, TouchMark> = {}, locks: Record<string, LockMark> = {}, code = new Map<string, string[]>(), windows: WindowInfo[] = [], gotos = new Map<string, string[]>(), budget = MAP_BUDGET, recent: MapInputs['recent'] = [], defs: MapInputs['defs'] = new Map(), recentWindow?: number): string {
  const ins: MapInputs = { touched, locks, code, windows, gotos, recent, defs, recentWindow };
  // どの形にするかは、節を畳む前の大きさで決める（畳んだ後の大きさで決めると、とても大きなプロジェクトが
  // 「全部の節を畳んだ1枚」になり、目次の地図の見方の説明・最近の作業の場所が出なくなる）
  const mode = mapMode(p, ins, budget);
  return buildMap(p, ins, mode);
}

/** 節を1つだけ（目次の地図から引く）。大きなプロジェクトでは要約の形、小さければ詳しい形 */
export function renderMapSection(p: Project, section: string, ins: MapInputs = {}, budget = MAP_BUDGET): string {
  const [head, ...path] = section.split('/').filter(Boolean);
  const name = (head ?? '').toLowerCase() as MapSection;
  if (!MAP_SECTIONS.includes(name)) throw new Error(`地図の節 ${section} はありません${suggest(head ?? '', [...MAP_SECTIONS])}（${MAP_SECTIONS.join(' ')}）`);
  const mode = mapMode(p, ins, budget);
  // とても大きなプロジェクト（目次の地図）では、まとめの木から1枚（節/まとめ/…）
  // まとめの名前つき（節/まとめ/…）は、小さなプロジェクトでも木から1枚（節ごとの入れ子で目次になった節から引く）
  if ((mode === 'index' || path.length) && name !== 'assets') return treeSectionPage(p, withDefaults(ins), name, path);
  const lines = sectionLines(p, withDefaults(ins), mode === 'full' ? 'full' : 'compact')[name];
  return lines.length ? lines.join('\n') : `（${name} はありません）`;
}

/** 説明の最初の一文（要約の地図で。長い説明は ages schema で引く） */
const firstSentence = (s: string | undefined, max = 40): string => {
  if (!s) return '';
  const cut = s.split('。')[0];
  return cut.length > max ? cut.slice(0, max) + '…' : cut;
};

type Ins = Required<MapInputs>;
const withDefaults = (i: MapInputs): Ins => ({ touched: i.touched ?? {}, locks: i.locks ?? {}, code: i.code ?? new Map(), windows: i.windows ?? [], gotos: i.gotos ?? new Map(), recent: i.recent ?? [], recentWindow: i.recentWindow ?? RECENT_WINDOW, defs: i.defs ?? new Map() });

/** 地図の形（節を畳む前の大きさで決める）: 1枚に収まれば full、要約で収まれば compact、収まらなければ目次 */
function mapMode(p: Project, ins: MapInputs, budget: number): MapMode {
  return buildMap(p, ins, 'full', false).length <= budget ? 'full' : buildMap(p, ins, 'compact', false).length <= budget ? 'compact' : 'index';
}

export function buildMap(p: Project, inputs: MapInputs, mode: MapMode, collapse = true): string {
  const ins = withDefaults(inputs);
  const c = p.config;
  const out: string[] = [];
  out.push(`# ${c.name}  fps${c.fps} seed${c.seed} view${c.view.width}x${c.view.height} start:${c.startScene} code:${c.game}`);
  if (mode === 'compact') out.push(`（大きなプロジェクトなので要約の地図。型・範囲・既定値・説明は ages schema <dir> 名前,名前、物・プレハブの中身は ages get <dir> 住所）`);
  if (mode === 'index') out.push(`（とても大きなプロジェクトなので目次の地図。名前/(数) はまとめで、中身は ages map <dir> 節/名前（例 ${indexExample(p, ins)}）、節の全体は ages map <dir> 節。名前・説明から探すのは ages find <dir> 語、型・範囲・説明は ages schema <dir> 名前、値は ages get <dir> 住所、コードは ages code <dir> 名前）`);
  // 追加パッケージ（入れているときだけ）。機能の目次は AGENTS.md と同じ書き方（→ `項目` は ages schema <dir> guide:項目）
  for (const pk of p.registry.packages) out.push(`## package ${pk.name}: ${pk.desc}`, ...(pk.toc ?? []).map((l) => `- ${l}`));
  const sec = mode === 'index' ? indexLines(p, ins) : sectionLines(p, ins, mode);
  // 節ごとの入れ子: 全体は1枚に収まっても、1つの節だけが長いなら、その節だけ目次にする（置いた物の多いシーンなど）
  if (mode !== 'index' && collapse) {
    for (const k of TREE_SECTIONS) {
      if (sec[k].join('\n').length <= sectionMax(k)) continue;
      const line = indexTreeLine(p, ins, k);
      if (line) sec[k] = [`${line}（長いので目次。中身は ages map <dir> ${k}、まとめは ages map <dir> ${k}/名前）`];
    }
  }
  out.push(...sec.components, ...sec.shaders, ...notes(p), ...sec.systems, ...sec.tables, ...sec.prefabs, ...sec.scenes, ...sec.assets, ...sec.extensions);
  if (mode === 'index') out.push(...markRoots(ins));
  // 最近の作業の場所（目次の地図だけ。続けて同じ辺りを触るなら探さずに済む）
  if (mode === 'index' && ins.recent.length) out.push(`最近の作業の場所（直近${ins.recentWindow}回の探す・見る・変えるで使った所。多い順。map: は ages map <dir> で引いたまとめ）: ${ins.recent.map((r) => (r.hits > 1 ? `${r.place}(${r.hits})` : r.place)).join('  ')}`);
  const nl = Object.keys(ins.locks).length, nt = Object.keys(ins.touched).length;
  if (nl || nt) out.push(`## 🔒ロック ${nl}件（AIは変更不可。理由があれば人に提案する） / ★人が調整 ${nt}件（変更前に人へ確認）`);
  return out.join('\n');
}

/** 節に入らない短い行（当たり判定のグループ・多言語・保存データ） */
function notes(p: Project): string[] {
  const out: string[] = [];
  // 当たり判定のグループ（Collider.group と、重なり始めを記録する相手 with）
  const groups = collisionGroups(p);
  if (groups.size) out.push(`当たり判定のグループ（Collider.group → with。ctx.hit で調べる）: ${[...groups].map(([g, w]) => (w.size ? `${g || '（なし）'}→${[...w].join(',')}` : g || '（なし）')).join('  ')}`);
  // 多言語（言語が2つ以上のときだけ）
  const langs = languagesOf(p.config);
  if (langs.length > 1) {
    const miss = p.missingText();
    out.push(`多言語（表 $text・ctx.t('名前')・Text.key）: ${langs.join(' ')}（既定 ${langs[0]}）${miss.size ? '。未訳 ' + [...miss].map(([l, ks]) => (ks.length > 5 ? `${l}:${ks.length}件` : `${l}:${ks.length}件(${ks.join(',')})`)).join(' ') + '（ages table <dir> text --empty 言語）' : '。未訳なし'}`);
  }
  // 保存データのファイル（その状態から始めて確かめる）
  if (p.saves.size) out.push(`保存データ（ages run --save で、その状態から始める）: ${[...p.saves].map(([path, v]) => (v.error ? `${path} ⚠` : `${path}(${Object.keys(v.data ?? {}).join(',')})`)).join('  ')}`);
  return out;
}

/** 自分のコンポーネント（標準のものは ages schema で引く） */
const ownComponents = (p: Project) => [...p.registry.components.values()].filter((def) => !p.registry.std.has(def.name));

function sectionLines(p: Project, ins: Ins, mode: 'full' | 'compact'): Record<MapSection, string[]> {
  const compact = mode === 'compact';
  const { touched, locks, code, windows, gotos } = ins;
  const c = p.config;
  const r: Record<MapSection, string[]> = { components: [], shaders: [], systems: [], tables: [], prefabs: [], scenes: [], assets: [], extensions: [] };

  // 毎回読む1枚なので、使っていないものの行は出さない（標準の部品・シェーダー・表の説明は ages schema で引く）
  const own = ownComponents(p);
  if (own.length) r.components.push(compact ? '## components（名前 説明の初め | フィールドの名前 | 自動:実行中に変わる値）' : '## components（名前 説明 | フィールド:型 範囲=既定値 | 自動:実行中に変わる値）');
  for (const def of own) r.components.push(componentLine(def, compact));

  // シェーダー: 自分のシェーダーと、使っている標準のものだけ（調整できる値を1行で）
  const { own: ownShaders, std: stdUsed } = shadersOf(p);
  if (ownShaders.length || stdUsed.length) {
    r.shaders.push('## shaders（Effect・PostEffect の shader で選ぶ。値は params.名前）');
    for (const d of ownShaders) r.shaders.push(shaderLine(d));
    if (stdUsed.length) r.shaders.push(`標準: ${stdUsed.map((d) => `${d.path}(${Object.keys(d.uniforms).join(',')})`).join(' ')}`);
  }

  r.systems.push('## systems（実行順。（コードの場所） r=読む w=書く 受ける=on で受ける出来事）');
  // 標準のシステムは、続いている所を1行にまとめる（中身は ages schema guide で引く）
  const systems = p.registry.systems;
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i];
    if (s.name.startsWith('std.')) {
      let j = i;
      while (j + 1 < systems.length && systems[j + 1].name.startsWith('std.')) j++;
      r.systems.push(`${i + 1}${j > i ? `-${j + 1}` : ''} 標準: ${systems.slice(i, j + 1).map((x) => x.name).join(' ')}`);
      i = j;
      continue;
    }
    r.systems.push(systemLine(s, i, ins, compact));
  }

  if (p.registry.tables.size) {
    r.tables.push('## tables（$表.行.列 で参照。中身は ages table <dir> <表>）');
    for (const def of shownTables(p)) r.tables.push(tableLine(p, def, ins, compact));
  }

  if (p.docs.prefabs.size && compact) {
    // 同じ部品の組ごとに、名前だけを並べる（説明・タグ・変えた所は ages get <dir> @名前）
    r.prefabs.push(`## prefabs（${p.docs.prefabs.size}個。同じ部品の組ごとに名前だけ。←は派生の元）`);
    for (const [key, names] of prefabGroups(p, ins)) r.prefabs.push(`[${key || '部品なし'}] ${names.length}: ${names.join(' ')}`);
  }
  if (p.docs.prefabs.size && !compact) r.prefabs.push(`## prefabs（@名前 で参照${[...p.docs.prefabs.values()].some((x) => x.base) ? '。← は派生の元、変: は元から変えた所' : ''}）`);
  for (const raw of compact ? [] : p.docs.prefabs.values()) r.prefabs.push(prefabLine(p, raw, ins, false));

  r.scenes.push(`## scenes（シーン#ID "名前" ←@プレハブ 変:プレハブと違う値 [部品]。プレハブと同じ部品・タグと、位置の上書きは省く。連番は #coin1〜8 ×8 とまとめる）${gotos.size ? `\ngoto の行き先（コード）: ${[...gotos.keys()].join(' ')}` : ''}`);
  // 要約の地図では、前のシーンと同じ物（同じ ID・同じ部品）を繰り返さない
  const seen = new Map<string, string>();
  for (const raw of p.docs.scenes.values()) {
    const s = p.resolvedScene(raw);
    r.scenes.push(`${s.name}（${s.entities.length}体）${s.name === c.startScene ? ' 開始' : ''}${s.desc ? ' ' + (compact ? firstSentence(s.desc) : s.desc) : ''}`);
    const same = new Map<string, number>();
    // 1行ずつ作ってから、連番（同じ頭の名前・同じ中身）を1行にまとめる
    const rows: { id: string; rest: string; group: string | null }[] = [];
    s.entities.forEach((e, i) => {
      const mk = marks(touched, locks, `${s.name}#${e.id}`);
      const rest = entityRest(p, raw.entities[i], e, compact) + mk;
      const sig = `${e.id}${rest}`;
      if (compact && !mk && seen.has(sig)) { const from = seen.get(sig)!; same.set(from, (same.get(from) ?? 0) + 1); return; }
      if (!seen.has(sig)) seen.set(sig, s.name);
      const num = NUMBERED.exec(e.id);
      rows.push({ id: e.id, rest, group: num && !mk && (!e.name || e.name === e.id) ? `${num[1]}\n${rest}` : null });
    });
    const done = new Set<string>();
    for (const row of rows) {
      const members = row.group ? rows.filter((x) => x.group === row.group) : [row];
      if (members.length < 2) { r.scenes.push(`  ${compact ? '' : s.name}#${row.id}${row.rest}`); continue; }
      if (done.has(row.group!)) continue;
      done.add(row.group!);
      r.scenes.push(`  ${compact ? '' : s.name}#${NUMBERED.exec(row.id)![1]}${numberRuns(members.map((x) => NUMBERED.exec(x.id)![2]))}${row.rest} ×${members.length}`);
    }
    for (const [from, n] of same) r.scenes.push(`  ほか${n}体は ${from} と同じ`);
  }

  // 多い・長いときは1つずつ並べず、フォルダごとの数だけ（毎回読む1枚なので。1つずつは ages assets で引く）
  const assetList = p.assets.length && p.assets.length <= ASSET_LIST_MAX ? ['## assets（画像 幅x高さ・音 秒・シート 格子のコマの大きさ×数か、自由なコマ数と名前。使っている所は ages assets --refs）', ...renderAssets(p, { touched, locks, code })] : [];
  if (assetList.length && assetList.join('\n').length <= sectionMax('assets')) r.assets.push(...assetList);
  else if (p.assets.length) {
    r.assets.push(`## assets（${p.assets.length}個。フォルダごとの数。1つずつは ages assets <dir> [フォルダ] [--unused]）`);
    r.assets.push(...summarizeAssets(p, { touched, locks, code }));
  }
  r.extensions.push(...extensionLines(p, windows));
  return r;
}

/** 位置・向き・大きさの上書き（置いた物なら当たり前なので、地図には出さない） */
const PLACEMENT = /^Transform(3D)?\./;

/**
 * シーンの物の行の、ID の後ろ（"名前" ←@プレハブ 変:… [部品] tags:…）。
 * プレハブのインスタンスは、プレハブの行にあるもの（同じ部品・同じタグ）を繰り返さない
 */
function entityRest(p: Project, rawEntity: SceneDoc['entities'][number], e: SceneDoc['entities'][number], compact: boolean): string {
  const comps = Object.keys(e.components);
  let pf: { tags?: string[]; components: Record<string, unknown> } | undefined;
  try { pf = e.prefab ? p.registry.findPrefab(e.prefab) : undefined; } catch { pf = undefined; }
  const ov = e.prefab ? instanceOverrides(p.docs.prefabs, rawEntity).filter((o) => !PLACEMENT.test(o)) : [];
  const inst = e.prefab ? ` ←@${e.prefab}${!compact && ov.length ? ` 変:${ov.join(',')}` : ''}` : '';
  const sameParts = !!pf && Object.keys(pf.components).length === comps.length && comps.every((k) => k in pf!.components);
  const sameTags = !!pf && (pf.tags ?? []).join(',') === (e.tags ?? []).join(',');
  const tags = e.tags?.length && !sameTags ? ` tags:${e.tags.join(',')}` : '';
  const name = !compact && e.name && e.name !== e.id ? ` "${e.name}"` : '';
  return `${name}${inst}${sameParts ? '' : ` [${comps.join(' ')}]`}${tags}`;
}

/** 連番の番号の並びを短く（1,2,3,5 → 1〜3,5。桁をそろえた 01 などはそのまま） */
export function numberRuns(nums: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1].length === nums[j].length && Number(nums[j + 1]) === Number(nums[j]) + 1) j++;
    out.push(j > i + 1 ? `${nums[i]}〜${nums[j]}` : j === i + 1 ? `${nums[i]},${nums[j]}` : nums[i]);
    i = j + 1;
  }
  return out.join(',');
}

/** コンポーネントの1行。compact: 説明の初めとフィールドの名前だけ。at: コードの場所 */
function componentLine(def: ComponentDef, compact: boolean, at?: string): string {
  // 実行中に変わる値（desc に「自動で変化」）は人もAIも書かないので、型と範囲を省いて名前だけ（ages schema で引ける）
  const all = Object.entries(def.fields);
  const auto = all.filter(([, f]) => isAutoField(f)).map(([k]) => k);
  const fields = all.filter(([, f]) => !isAutoField(f)).map(([k, f]) => (compact ? k : `${k}:${brief(f)}`)).join(' ');
  return `${def.name}${at ? `（${at}）` : ''} ${compact ? firstSentence(def.desc) : def.desc} | ${fields || '（フィールドなし）'}${auto.length ? ` | 自動:${auto.join(',')}` : ''}`;
}

function shaderLine(d: ShaderDef): string {
  return `${d.path} ${d.desc} | ${Object.entries(d.uniforms).map(([k, f]) => `${k}:${brief(f)}`).join(' ') || '（値なし）'}${d.errors.length ? ` ⚠ ${d.errors.length}件の問題（ages check）` : ''}`;
}

function systemLine(s: SystemDef, i: number, ins: Ins, compact: boolean): string {
  const rw = [s.reads?.length ? `r:${s.reads.join(',')}` : '', s.writes?.length ? `w:${s.writes.join(',')}` : ''].filter(Boolean).join(' ');
  const at = ins.defs.get(`system:${s.name}`);
  const on = s.on ? Object.keys(s.on) : [];
  return `${i + 1} ${s.name}${at ? `（${at}）` : ''} ${compact ? firstSentence(s.desc, 30) : s.desc}${rw ? ' ' + rw : ''}${on.length ? ` 受ける:${on.join(',')}` : ''}${s.scenes ? ` シーン:${s.scenes.join(',')}だけ` : ''}`;
}

/** 地図に出す表（標準の表は行があるときだけ） */
const shownTables = (p: Project): TableDef[] => [...p.registry.tables.values()].filter((d) => (p.docs.tables.get(d.name)?.rows.length ?? 0) || !p.registry.stdTables.has(d.name));

function tableLine(p: Project, def: TableDef, ins: Ins, compact: boolean): string {
  const rows = p.docs.tables.get(def.name)?.rows ?? [];
  const ids = rows.map((r) => r.id);
  // 標準の表は列が決まっているので、説明と列を省く（ages schema <dir> $表 で引ける）
  const head = p.registry.stdTables.has(def.name) ? '（標準）' : compact
    ? `${def.desc ? ' ' + firstSentence(def.desc) : ''} | ${Object.keys(def.columns).join(' ')}`
    : `${def.desc ? ' ' + def.desc : ''} | ${Object.entries(def.columns).map(([k, f]) => `${k}:${brief(f)}`).join(' ')}`;
  return `$${def.name} ${rows.length}行${head} | 行: ${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ' …' : ''}${tableMarks(ins, def.name)}`;
}

/** プレハブの1行。short: 説明は最初の一文だけ */
function prefabLine(p: Project, raw: PrefabDoc, ins: Ins, short: boolean): string {
  const pf = p.registry.findPrefab(raw.name) ?? raw;
  const tags = pf.tags?.length ? ` tags:${pf.tags.join(',')}` : '';
  const ov = raw.base ? overridesOf(p.docs.prefabs, raw.name) : [];
  const variant = raw.base ? ` ← @${raw.base}` : '';
  const desc = short ? firstSentence(raw.desc) : raw.desc;
  // 子: 名前（←子にしたプレハブ・(孫の数)）。派生は元の子の値を変えた所を 変: に足す
  let kids = '';
  if (hasChildren(p.docs.prefabs, raw.name)) {
    try {
      const count = (k: ResolvedChild): number => k.children.reduce((n, c) => n + 1 + count(c), 0);
      kids = ` 子:${prefabChildren(p.docs.prefabs, raw.name).map((k) => `${k.name}${k.prefab ? '←@' + k.prefab : ''}${count(k) ? `(${count(k)})` : ''}`).join(',')}`;
    } catch { kids = ' 子:⚠'; }
    if (raw.base) for (const [at, comps] of prefabHolders(raw).slice(1)) for (const [c, v] of Object.entries(comps)) for (const f of Object.keys(v)) ov.push(`${at.slice(raw.name.length + 1)}.${c}.${f}`);
  }
  return `@${pf.name}${variant}${desc ? ' ' + desc : ''} [${Object.keys(pf.components).join(' ')}]${kids}${tags}${ov.length ? ` 変:${ov.join(',')}` : ''}${marks(ins.touched, ins.locks, `@${pf.name}`)}`;
}

// ---- 入れ子の目次（とても大きなプロジェクト） ----

/** 目次の地図の1行の長さの上限（これより長いと、名前を並べずにまとめと数にする） */
export const INDEX_LINE_MAX = 400;
/** 目次から引く1枚（節/まとめ）の大きさの上限（文字）。超えると下のまとめは1行ずつ */
export const MAP_PAGE_BUDGET = 4000;

/** 名前の頭の並び（weapon_gatling → weapon。se_ZzFX_Hit → se, se_ZzFX。区切りがなければ大文字の境目） */
export function nameKeys(name: string): string[] {
  const parts = /[_\-.]/.test(name) ? name.split(/[_\-.]/) : name.split(/(?<=[a-z0-9])(?=[A-Z])/);
  const sep = /[_\-.]/.exec(name)?.[0] ?? '';
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(sep));
  return out.filter(Boolean);
}

/** コードで宣言したもの（defs の 種類:名前 → ファイル:行）をファイルの木に */
function codeTree<T>(list: T[], kind: string, nameOf: (x: T) => string, item: (x: T, at: string | undefined) => Omit<TreeItem, 'keys'>, keysOverride: (x: T) => string[] | null, ins: Ins): TreeNode {
  const at = (x: T) => ins.defs.get(`${kind}:${nameOf(x)}`);
  const root = commonDir(list.map((x) => at(x)?.split(':')[0]).filter((f): f is string => !!f));
  return buildTree(list.map((x) => {
    const a = at(x);
    return { ...item(x, a), keys: keysOverride(x) ?? (a ? fileKeys(a.split(':')[0], root) : ['その他']) };
  }));
}

type TreeSection = Exclude<MapSection, 'assets'>;
const TREE_SECTIONS: TreeSection[] = ['components', 'shaders', 'systems', 'tables', 'prefabs', 'scenes', 'extensions'];

/** 節の木（目次の地図と ages map <dir> 節/まとめ） */
function sectionTree(p: Project, ins: Ins, sec: TreeSection): TreeNode {
  switch (sec) {
    case 'components':
      return codeTree(ownComponents(p), 'component', (d) => d.name, (d, at) => ({ name: d.name, line: componentLine(d, true, at) }), () => null, ins);
    case 'systems':
      return codeTree(p.registry.systems.map((s, i) => ({ s, i })), 'system', (x) => x.s.name,
        ({ s, i }) => ({ name: s.name, label: `${i + 1}.${s.name}`, line: s.name.startsWith('std.') ? `${i + 1} 標準 ${s.name}` : systemLine(s, i, ins, true) }),
        ({ s }) => (s.name.startsWith('std.') ? ['標準'] : null), ins);
    case 'tables':
      return codeTree(shownTables(p), 'table', (d) => d.name,
        (d) => ({ name: d.name, label: `$${d.name}(${p.docs.tables.get(d.name)?.rows.length ?? 0}行)${tableMarks(ins, d.name)}`, line: tableLine(p, d, ins, true) }),
        (d) => (p.registry.stdTables.has(d.name) ? ['標準'] : null), ins);
    case 'prefabs':
      return buildTree([...p.docs.prefabs.values()].map((raw) => ({ name: raw.name, label: `${raw.name}${marks(ins.touched, ins.locks, `@${raw.name}`)}`, keys: nameKeys(raw.name), line: prefabLine(p, raw, ins, true) })));
    case 'scenes':
      return buildTree([...p.docs.scenes.values()].map((s) => {
        const start = s.name === p.config.startScene;
        return { name: s.name, label: `${s.name}(${s.entities.length}体${start ? '・開始' : ''})`, keys: nameKeys(s.name), line: `${s.name}（${s.entities.length}体）${start ? ' 開始' : ''}${s.desc ? ' ' + firstSentence(s.desc) : ''}` };
      }));
    case 'shaders': {
      const { own, std } = shadersOf(p);
      const root = commonDir(own.map((d) => d.path));
      return buildTree([
        ...own.map((d) => ({ name: d.path, label: d.path.slice(root.length), keys: fileKeys(d.path, root, false), line: shaderLine(d) })),
        ...std.map((d) => ({ name: d.path, keys: ['標準'], line: `${d.path} ${d.desc} | ${Object.keys(d.uniforms).join(' ') || '（値なし）'}` })),
      ]);
    }
    case 'extensions': {
      const list = ins.windows.length ? ins.windows : (p.config.editorWindows ?? []).map((path) => ({ path }) as WindowInfo);
      const root = commonDir(list.map((w) => w.path));
      const full = extensionLines(p, list).slice(1);
      return buildTree(list.map((w, i) => ({ name: w.id ?? w.path, label: `${w.id ?? w.path}${w.title ? `「${w.title}」` : ''}`, keys: fileKeys(w.path, root, false), line: full[i] })));
    }
  }
}

/** シーンの物の木（UI.parent・Transform.parent の親子。連番の名前で子のない物が5つ以上ならまとめる） */
function entityTree(p: Project, raw: SceneDoc, ins: Ins): TreeNode {
  const s = p.resolvedScene(raw);
  const { parent } = treeParents(raw.entities, Object.fromEntries(p.docs.prefabs));
  const hasKids = new Set(parent.values());
  const chain = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set([id]);
    for (let q = parent.get(id); q && !seen.has(q); q = parent.get(q)) { out.unshift(q); seen.add(q); }
    return out;
  };
  // 兄弟の中の連番（子のない物が5つ以上）
  const sib = new Map<string, number>();
  const numKey = (id: string) => { const m = NUMBERED.exec(id); return m && !hasKids.has(id) ? `${parent.get(id) ?? ''}~${m[1]}` : null; };
  for (const e of s.entities) { const k = numKey(e.id); if (k) sib.set(k, (sib.get(k) ?? 0) + 1); }
  return buildTree(s.entities.map((e, i) => {
    const k = numKey(e.id);
    const keys = [...chain(e.id), ...(k && sib.get(k)! >= 5 ? [NUMBERED.exec(e.id)![1] + '*'] : [])];
    const ov = e.prefab ? instanceOverrides(p.docs.prefabs, raw.entities[i]) : [];
    const inst = e.prefab ? ` ←@${e.prefab}${ov.length ? ` 変:${ov.join(',')}` : ''}` : '';
    const tags = e.tags?.length ? ` tags:${e.tags.join(',')}` : '';
    const nm = e.name && e.name !== e.id ? ` "${e.name}"` : '';
    return { name: e.id, keys, line: `#${e.id}${nm}${inst} [${Object.keys(e.components).join(' ')}]${tags}${marks(ins.touched, ins.locks, `${s.name}#${e.id}`)}` };
  }));
}

/** 節ごとの列の見方（引いた1枚の見出しに） */
const PAGE_LEGEND: Record<TreeSection, string> = {
  components: '名前（コードの場所） 説明の初め | フィールドの名前 | 自動:実行中に変わる値。型・範囲・説明は ages schema <dir> 名前',
  systems: '番号=実行順 名前（コードの場所） 説明の初め r=読む w=書く 受ける=on で受ける出来事',
  tables: '$表.行.列 で参照。中身は ages table <dir> <表>',
  prefabs: '@名前 で参照。← は派生の元、変: は元から変えた所。中身は ages get <dir> @名前',
  scenes: 'シーン（物の数）。物は ages map <dir> scenes/シーン',
  shaders: 'Effect・PostEffect の shader で選ぶ。値は params.名前',
  extensions: 'プロジェクト独自のエディタ拡張。作る前にここを見て、近いものがあれば直す。変える値は edits と、見せている欄・部品・行だけ',
};

/** 目次の地図の節の行（1段目だけ。名前が短く収まるなら全部） */
function indexTreeLine(p: Project, ins: Ins, sec: TreeSection): string | null {
  const t = sectionTree(p, ins, sec);
  if (!t.n) return null;
  const head: Record<TreeSection, string> = {
    components: `## components ${t.n}個`,
    shaders: `## shaders ${t.n}個`,
    systems: `## systems ${t.n}個（番号.名前 の番号は実行順）`,
    tables: `## tables ${t.n}個（$表.行.列）`,
    prefabs: `## prefabs ${t.n}個（@名前）`,
    scenes: `## scenes ${t.n}個`,
    extensions: `## editor extensions ${t.n}個（作る前にここを見て、近いものがあれば直す）`,
  };
  return `${head[sec]}: ${topLine(t, INDEX_LINE_MAX)}`;
}

/** 目次の入れ子の深さ（節の木のまとめの段の数のいちばん深いもの。シーンの中の物の木は数えない）。目次でない地図は 0 */
export function indexDepth(p: Project, inputs: MapInputs = {}, budget = MAP_BUDGET): number {
  if (buildMap(p, inputs, 'compact', false).length <= budget) return 0;
  const ins = withDefaults(inputs);
  const depth = (n: TreeNode): number => Math.max(0, ...n.entries.filter(isNode).map((k) => 1 + depth(k)));
  return Math.max(0, ...MAP_SECTIONS.filter((s): s is TreeSection => s !== 'assets').map((s) => depth(sectionTree(p, ins, s))));
}

/** 目次の地図の見出しの例（いちばん大きなまとめ） */
function indexExample(p: Project, ins: Ins): string {
  // いちばん大きなまとめ
  let best: [string, number] = ['prefabs', 0];
  for (const sec of ['components', 'prefabs', 'systems', 'tables'] as const) {
    const t = sectionTree(p, ins, sec);
    if (!topLine(t, INDEX_LINE_MAX).includes('/(')) continue;
    for (const g of t.entries.filter(isNode)) if (g.n > best[1]) best = [`${sec}/${g.key}`, g.n];
  }
  return best[0];
}

/** 目次から1枚引く（ages map <dir> 節/まとめ/…） */
function treeSectionPage(p: Project, ins: Ins, sec: TreeSection, path: string[]): string {
  // シーンの中: scenes/シーン/物…
  if (sec === 'scenes' && path.length && p.docs.scenes.has(path[0])) {
    const raw = p.docs.scenes.get(path[0])!;
    return pageOf(entityTree(p, raw, ins), path.slice(1), `scenes/${path[0]}`, `${raw.name}#ID "名前" ←@プレハブ [コンポーネント]。### は親（UI.parent・Transform.parent）の下の物、名前* は連番のまとめ`);
  }
  const t = sectionTree(p, ins, sec);
  if (!t.n) return `（${sec} はありません）`;
  const pre = sec === 'scenes' && !path.length && ins.gotos.size ? [`goto の行き先（コード）: ${[...ins.gotos.keys()].join(' ')}`] : [];
  return [...pre, pageOf(t, path, sec, PAGE_LEGEND[sec])].join('\n');
}

function pageOf(t: TreeNode, path: string[], at: string, legend: string): string {
  const hit = path.length ? findNode(t, path) : t;
  const where = [at, ...path].join('/');
  if (!hit) throw new Error(`地図の ${where} はありません${suggest(path[path.length - 1], keysOf(t))}（${at} の中のまとめ: ${keysOf(t).slice(0, 30).join(' ')}）`);
  if (!isNode(hit)) return `## ${where}（${legend}）\n${hit.line}`;
  const lines = treePage(hit, MAP_PAGE_BUDGET);
  const more = lines.some((l) => /^\S+\/ \d+個: /.test(l)) ? `\n（名前/ はまとめ。中身は ages map <dir> ${where}/名前）` : '';
  return `## ${where} ${hit.n}個（${legend}）\n${lines.join('\n')}${more}`;
}

/** エディタ拡張の行（目次の地図では名前と見出しだけ。中身は ages map <dir> extensions） */
function extensionLines(p: Project, windows: WindowInfo[]): string[] {
  const c = p.config;
  if (!c.editorWindows?.length) return [];
  const list = windows.length ? windows : c.editorWindows.map((path) => ({ path }) as WindowInfo);
  const out = ['## editor extensions（プロジェクト独自のエディタ拡張。作る前にここを見て、近いものがあれば直す。変える値は edits と、見せている欄・部品・行だけ）'];
  for (const w of list) {
    if (w.error) { out.push(`${w.path} ⚠ ${w.error}`); continue; }
    const edits = w.edits ? (w.edits.length ? withTagCounts(compactPaths(w.edits), p) : 'なし（見るだけ）') : w.panel ? '⚠ 宣言なし' : '';
    const parts = [w.panel ? 'パネル' : '', w.fields?.length ? `欄:${w.fields.join(',')}` : '', w.components?.length ? `部品:${w.components.join(',')}` : '', w.rows?.length ? `行:${w.rows.map((t) => '$' + t).join(',')}` : '', w.menus?.length ? `メニュー:${w.menus.join(',')}` : ''].filter(Boolean).join(' ');
    out.push(`${w.id ?? '?'}${w.title ? `「${w.title}」` : ''}${w.desc ? ' ' + w.desc : ''}${edits ? ` | 変える: ${edits}` : ''}${parts && parts !== 'パネル' ? ` | ${parts}` : ''} | ${w.path}`);
  }
  return out;
}

/** edits の @[タグ] に、そのタグのプレハブの数を添える（ないときは ⚠） */
function withTagCounts(edits: string, p: Project): string {
  if (!edits.includes('@[')) return edits;
  const counts = tagCounts(p.docs.prefabs);
  return edits.replace(/@\[([^\]]*)\]/g, (m, tag: string) => `${m}（${counts.get(tag) ? `${counts.get(tag)}個` : '⚠ まだ0個'}）`);
}

function shadersOf(p: Project) {
  const shaders = [...p.registry.shaders.values()];
  const used = usedShaders(p);
  return { own: shaders.filter((d) => !d.path.startsWith('std:')), std: shaders.filter((d) => d.path.startsWith('std:') && used.has(d.path)) };
}

function tableMarks(ins: Ins, table: string): string {
  const lk = Object.keys(ins.locks).filter((k) => k.startsWith(`$${table}.`)).length;
  const tc = Object.keys(ins.touched).filter((k) => k.startsWith(`$${table}.`)).length;
  return `${lk ? ` 🔒${lk}` : ''}${tc ? ` ★${tc}` : ''}`;
}

/** プレハブを同じ部品の組ごとに（名前・←派生の元・🔒★） */
function prefabGroups(p: Project, ins: Ins): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const raw of p.docs.prefabs.values()) {
    const pf = p.registry.findPrefab(raw.name) ?? raw;
    const key = Object.keys(pf.components).join(' ');
    const name = `${pf.name}${raw.base ? '←' + raw.base : ''}${marks(ins.touched, ins.locks, `@${pf.name}`)}`;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return groups;
}

/** 目次の地図: 節ごとに1行（名前が短く収まるなら全部、収まらなければまとめと数）。中身は ages map <dir> 節/まとめ・ages find で引く */
function indexLines(p: Project, ins: Ins): Record<MapSection, string[]> {
  const r: Record<MapSection, string[]> = { components: [], shaders: [], systems: [], tables: [], prefabs: [], scenes: [], assets: [], extensions: [] };
  for (const sec of MAP_SECTIONS) {
    if (sec === 'assets') continue;
    const line = indexTreeLine(p, ins, sec);
    if (line) r[sec].push(line);
  }
  if (p.assets.length) {
    const n = { image: 0, sheet: 0, sound: 0, font: 0, shader: 0, model: 0 };
    for (const a of p.assets) {
      if (a.kind === 'image') { n.image++; if (p.registry.sheets.get(a.path)) n.sheet++; } else n[a.kind]++;
    }
    r.assets.push(`## assets ${p.assets.length}個: 画像${n.image}（シート${n.sheet}） 音${n.sound}${n.font ? ` フォント${n.font}` : ''}${n.shader ? ` シェーダー${n.shader}` : ''}${n.model ? ` モデル${n.model}` : ''}（1つずつは ages assets <dir> [フォルダ]）`);
  }
  return r;
}

/** 目次の地図で、🔒★のある所（住所の頭ごとの数） */
function markRoots(ins: Ins): string[] {
  const count = (rec: Record<string, unknown>) => {
    const m = new Map<string, number>();
    for (const k of Object.keys(rec)) { const root = k.split('.')[0]; m.set(root, (m.get(root) ?? 0) + 1); }
    return m;
  };
  const l = count(ins.locks), t = count(ins.touched);
  const roots = [...new Set([...l.keys(), ...t.keys()])];
  if (!roots.length) return [];
  const shown = roots.slice(0, 20).map((r) => `${r}${l.get(r) ? ` 🔒${l.get(r)}` : ''}${t.get(r) ? ` ★${t.get(r)}` : ''}`);
  return [`🔒★のある所: ${shown.join('  ')}${roots.length > 20 ? ` ほか${roots.length - 20}か所` : ''}`];
}

function marks(touched: Record<string, TouchMark>, locks: Record<string, LockMark>, prefix: string): string {
  const pick = (rec: Record<string, unknown>) => Object.keys(rec).filter((k) => k.startsWith(prefix + '.')).map((k) => k.slice(prefix.length + 1));
  const l = pick(locks);
  const t = pick(touched).filter((k) => !l.includes(k));
  return (l.length ? ' 🔒' + l.join(',') : '') + (t.length ? ' ★' + t.join(',') : '');
}

export interface AssetListOptions {
  touched?: Record<string, TouchMark>;
  locks?: Record<string, LockMark>;
  /** コードの中で場所を書いている所 */
  code?: Map<string, string[]>;
  /** このフォルダの中だけ */
  folder?: string;
  kind?: AssetKind;
  /** 使っていないものだけ */
  unused?: boolean;
  /** 使っている所の数を出す */
  counts?: boolean;
}

/** 実行中に変わる値（AGENTS.md の決まり: desc に「自動で変化」） */
export const isAutoField = (f: { desc?: string }): boolean => /自動で変化/.test(f.desc ?? '');

/** 地図にアセットを1つずつ並べる上限。これより多いとフォルダごとの数にする */
export const ASSET_LIST_MAX = 40;

/** アセットをフォルダ（assets の下の2段目まで）ごとに数える: 画像・シート・音・フォント・未使用・🔒★ */
export function summarizeAssets(p: Project, o: AssetListOptions = {}): string[] {
  const refs = assetRefs(p.docs, p.registry);
  const code = o.code ?? new Map<string, string[]>();
  const locks = o.locks ?? {}, touched = o.touched ?? {};
  const groups = new Map<string, { image: number; sheet: number; sound: number; font: number; shader: number; model: number; unused: number; lock: number; star: number }>();
  for (const a of p.assets) {
    const parts = dirOf(a.path).split('/').filter(Boolean);
    const key = parts.slice(0, 3).join('/') || '.';
    const g = groups.get(key) ?? { image: 0, sheet: 0, sound: 0, font: 0, shader: 0, model: 0, unused: 0, lock: 0, star: 0 };
    if (a.kind === 'image') { g.image++; if (p.registry.sheets.get(a.path)) g.sheet++; }
    else g[a.kind]++;
    if (!((refs.get(a.path)?.length ?? 0) + (code.get(a.path)?.length ?? 0))) g.unused++;
    if (locks[`sheet:${a.path}`] || locks[`file:${a.path}`]) g.lock++;
    else if (touched[`sheet:${a.path}`]) g.star++;
    groups.set(key, g);
  }
  return [...groups].map(([k, g]) => {
    const kinds = [g.image ? `画像${g.image}${g.sheet ? `（シート${g.sheet}）` : ''}` : '', g.sound ? `音${g.sound}` : '', g.font ? `フォント${g.font}` : '', g.shader ? `シェーダー${g.shader}` : '', g.model ? `モデル${g.model}` : ''].filter(Boolean).join(' ');
    const marks = [g.unused ? `未使用${g.unused}` : '', g.lock ? `🔒${g.lock}` : '', g.star ? `★${g.star}` : ''].filter(Boolean).join(' ');
    return `  ${k}/ ${kinds}${marks ? ' ' + marks : ''}`;
  });
}

/** アセットの一覧。フォルダごとにまとめ、名前だけを並べる（同じフォルダの場所を繰り返さない） */
export function renderAssets(p: Project, o: AssetListOptions = {}): string[] {
  const refs = assetRefs(p.docs, p.registry);
  const code = o.code ?? new Map<string, string[]>();
  const locks = o.locks ?? {}, touched = o.touched ?? {};
  const out: string[] = [];
  let folder: string | null = null;
  for (const a of p.assets) {
    if (o.folder && !(a.path === o.folder || isUnder(a.path, o.folder))) continue;
    if (o.kind && a.kind !== o.kind) continue;
    const n = (refs.get(a.path)?.length ?? 0) + (code.get(a.path)?.length ?? 0);
    if (o.unused && n) continue;
    const dir = dirOf(a.path);
    if (dir !== folder) { out.push(`${dir || '.'}/`); folder = dir; }
    let line = `  ${baseOf(a.path)}`;
    if (a.kind === 'image') {
      line += ` ${a.w ?? '?'}x${a.h ?? '?'}`;
      const sheet = p.registry.sheets.get(a.path);
      if (sheet) {
        const fc = a.w && a.h ? frameCount(sheet, a.w, a.h) : '?';
        const clips = Object.entries(sheet.clips ?? {}).map(([k, v]) => `${k}(${v.frames.join(',')} ${v.fps}fps${v.loop === false ? ' 1回' : ''})`).join(' ');
        if (sheet.frames) {
          const names = sheet.frames.map((f) => f.name);
          line += ` シート 自由${fc}コマ（${names.slice(0, 6).join(' ')}${names.length > 6 ? ' …' : ''}）`;
        } else if (sheet.frame) line += ` シート 格子${sheet.frame[0]}x${sheet.frame[1]}×${fc}`;
        if (clips) line += ` clips: ${clips}`;
        const root = `sheet:${a.path}`;
        if (locks[root]) line += ' 🔒切り方';
        else if (touched[root]) line += ' ★切り方';
      }
    } else if (a.kind === 'sound') line += a.sec !== undefined ? ` ${a.sec}s` : '';
    else if (a.kind === 'model' && a.model) line += ` ${a.model.size.join('x')}m 中心[${a.model.center.join(',')}] 三角形${a.model.tris}${a.model.clips.length ? ` 動き: ${a.model.clips.map((c, i) => `${c}${a.model!.clipSec?.[i] !== undefined ? `(${Math.round(a.model!.clipSec[i] * 100) / 100}s)` : ''}`).join(' ')}` : ''}`;
    else line += ' フォント';
    if (locks[`file:${a.path}`]) line += ' 🔒ファイル';
    if (o.counts) line += n ? ` ${n}か所` : ' 未使用';
    else if (!n) line += ' 未使用';
    out.push(line);
  }
  return out;
}

/** 住所の並びを短く（main#s.Spawner.a, main#s.Spawner.b → main#s.Spawner.{a,b}） */
export function compactPaths(paths: string[]): string {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const i = p.lastIndexOf('.');
    const [head, leaf] = i > 0 && !p.endsWith('.*') ? [p.slice(0, i), p.slice(i + 1)] : [p, ''];
    groups.set(head, [...(groups.get(head) ?? []), leaf]);
  }
  return [...groups].map(([head, leaves]) => leaves.length === 1 ? (leaves[0] ? `${head}.${leaves[0]}` : head) : `${head}.{${leaves.filter(Boolean).join(',')}}`).join(' ');
}

/** シーン・プレハブの Effect・PostEffect が選んでいるシェーダー */
function usedShaders(p: Project): Set<string> {
  const out = new Set<string>();
  const add = (comps: Record<string, Record<string, unknown>>) => {
    for (const c of ['Effect', 'PostEffect']) if (typeof comps[c]?.shader === 'string') out.add(comps[c].shader as string);
  };
  for (const pf of p.docs.prefabs.values()) add(pf.components);
  for (const s of p.docs.scenes.values()) for (const e of p.resolvedScene(s).entities) add(e.components);
  return out;
}

/** シーン・プレハブの Collider のグループと、それぞれの with */
export function collisionGroups(p: Project): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (c?: Record<string, unknown>) => {
    if (!c) return;
    const g = String(c.group ?? '');
    if (!out.has(g)) out.set(g, new Set());
    for (const w of (c.with as string[] | undefined) ?? []) out.get(g)!.add(w);
  };
  for (const pf of p.docs.prefabs.values()) add(pf.components.Collider);
  for (const s of p.docs.scenes.values()) for (const e of p.resolvedScene(s).entities) add(e.components.Collider);
  return out;
}
