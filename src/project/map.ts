// プロジェクトの地図。AIが最初に読む1枚。全体を少ないトークンで把握できる形にする。
import { brief, suggest } from '../core/schema.ts';
import { frameCount } from '../core/sheet.ts';
import { assetRefs, baseOf, dirOf, isUnder } from '../core/assets.ts';
import type { AssetKind } from '../core/schema.ts';
import type { Project } from './project.ts';
import { languagesOf } from '../core/i18n.ts';
import { instanceOverrides, overridesOf } from '../core/variant.ts';
import { tagCounts, type WindowInfo } from './windows.ts';
import type { LockMark, TouchMark } from './oplog.ts';
import { RECENT_WINDOW } from './recent.ts';


/** 地図の大きさの上限（文字）。超えるプロジェクトでは細かいところを省いた要約の地図、それでも超えるなら目次の地図にする（中身は節ごと・名前で引く） */
export const MAP_BUDGET = 12000;

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
  /** コードの中の宣言の場所（codeDefs。システムの行に出す） */
  defs?: Map<string, string>;
}

export function renderMap(p: Project, touched: Record<string, TouchMark> = {}, locks: Record<string, LockMark> = {}, code = new Map<string, string[]>(), windows: WindowInfo[] = [], gotos = new Map<string, string[]>(), budget = MAP_BUDGET, recent: MapInputs['recent'] = [], defs: MapInputs['defs'] = new Map()): string {
  const ins: MapInputs = { touched, locks, code, windows, gotos, recent, defs };
  const full = buildMap(p, ins, 'full');
  if (full.length <= budget) return full;
  const compact = buildMap(p, ins, 'compact');
  return compact.length <= budget ? compact : buildMap(p, ins, 'index');
}

/** 節を1つだけ（目次の地図から引く）。大きなプロジェクトでは要約の形、小さければ詳しい形 */
export function renderMapSection(p: Project, section: string, ins: MapInputs = {}, budget = MAP_BUDGET): string {
  const name = section.toLowerCase() as MapSection;
  if (!MAP_SECTIONS.includes(name)) throw new Error(`地図の節 ${section} はありません${suggest(section, [...MAP_SECTIONS])}（${MAP_SECTIONS.join(' ')}）`);
  const mode: MapMode = buildMap(p, ins, 'full').length <= budget ? 'full' : 'compact';
  const lines = sectionLines(p, withDefaults(ins), mode)[name];
  return lines.length ? lines.join('\n') : `（${name} はありません）`;
}

/** 説明の最初の一文（要約の地図で。長い説明は ages schema で引く） */
const firstSentence = (s: string | undefined, max = 40): string => {
  if (!s) return '';
  const cut = s.split('。')[0];
  return cut.length > max ? cut.slice(0, max) + '…' : cut;
};

type Ins = Required<MapInputs>;
const withDefaults = (i: MapInputs): Ins => ({ touched: i.touched ?? {}, locks: i.locks ?? {}, code: i.code ?? new Map(), windows: i.windows ?? [], gotos: i.gotos ?? new Map(), recent: i.recent ?? [], defs: i.defs ?? new Map() });

export function buildMap(p: Project, inputs: MapInputs, mode: MapMode): string {
  const ins = withDefaults(inputs);
  const c = p.config;
  const out: string[] = [];
  out.push(`# ${c.name}  fps${c.fps} seed${c.seed} view${c.view.width}x${c.view.height} start:${c.startScene} code:${c.game}`);
  if (mode === 'compact') out.push(`（大きなプロジェクトなので要約の地図。型・範囲・既定値・説明は ages schema <dir> 名前,名前、物・プレハブの中身は ages get <dir> 住所）`);
  if (mode === 'index') out.push(`（とても大きなプロジェクトなので目次の地図。節の中身は ages map <dir> 節（${MAP_SECTIONS.join(' ')}）、名前・説明から探すのは ages find <dir> 語、型・範囲・説明は ages schema <dir> 名前、値は ages get <dir> 住所）`);
  const sec = mode === 'index' ? indexLines(p, ins) : sectionLines(p, ins, mode);
  out.push(...sec.components, ...sec.shaders, ...notes(p), ...sec.systems, ...sec.tables, ...sec.prefabs, ...sec.scenes, ...sec.assets, ...sec.extensions);
  if (mode === 'index') out.push(...markRoots(ins));
  // 最近の作業の場所（目次の地図だけ。続けて同じ辺りを触るなら探さずに済む）
  if (mode === 'index' && ins.recent.length) out.push(`最近の作業の場所（直近${RECENT_WINDOW}回の探す・見る・変えるで使った所。多い順）: ${ins.recent.map((r) => (r.hits > 1 ? `${r.place}(${r.hits})` : r.place)).join('  ')}`);
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
    out.push(`多言語（表 $text・ctx.t('名前')・Text.key）: ${langs.join(' ')}（既定 ${langs[0]}）${miss.size ? '。未訳 ' + [...miss].map(([l, ks]) => `${l}:${ks.length}件(${ks.slice(0, 5).join(',')}${ks.length > 5 ? '…' : ''})`).join(' ') + '（ages table <dir> text --empty 言語）' : '。未訳なし'}`);
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
  if (own.length && compact) {
    r.components.push('## components（名前 説明の初め | フィールドの名前 | 自動:実行中に変わる値）');
    for (const def of own) {
      const all = Object.entries(def.fields);
      const auto = all.filter(([, f]) => isAutoField(f)).map(([k]) => k);
      const fields = all.filter(([, f]) => !isAutoField(f)).map(([k]) => k).join(' ');
      r.components.push(`${def.name} ${firstSentence(def.desc)} | ${fields || '（フィールドなし）'}${auto.length ? ` | 自動:${auto.join(',')}` : ''}`);
    }
  } else if (own.length) {
    r.components.push('## components（名前 説明 | フィールド:型 範囲=既定値 | 自動:実行中に変わる値）');
    for (const def of own) {
      // 実行中に変わる値（desc に「自動で変化」）は人もAIも書かないので、型と範囲を省いて名前だけ（ages schema で引ける）
      const all = Object.entries(def.fields);
      const auto = all.filter(([, f]) => isAutoField(f)).map(([k]) => k);
      const fields = all.filter(([, f]) => !isAutoField(f)).map(([k, f]) => `${k}:${brief(f)}`).join(' ');
      r.components.push(`${def.name} ${def.desc} | ${fields || '（フィールドなし）'}${auto.length ? ` | 自動:${auto.join(',')}` : ''}`);
    }
  }

  // シェーダー: 自分のシェーダーと、使っている標準のものだけ（調整できる値を1行で）
  const { own: ownShaders, std: stdUsed } = shadersOf(p);
  if (ownShaders.length || stdUsed.length) {
    r.shaders.push('## shaders（Effect・PostEffect の shader で選ぶ。値は params.名前）');
    for (const d of ownShaders) r.shaders.push(`${d.path} ${d.desc} | ${Object.entries(d.uniforms).map(([k, f]) => `${k}:${brief(f)}`).join(' ') || '（値なし）'}${d.errors.length ? ` ⚠ ${d.errors.length}件の問題（ages check）` : ''}`);
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
    const rw = [s.reads?.length ? `r:${s.reads.join(',')}` : '', s.writes?.length ? `w:${s.writes.join(',')}` : ''].filter(Boolean).join(' ');
    const at = ins.defs.get(`system:${s.name}`);
    const on = s.on ? Object.keys(s.on) : [];
    r.systems.push(`${i + 1} ${s.name}${at ? `（${at}）` : ''} ${compact ? firstSentence(s.desc, 30) : s.desc}${rw ? ' ' + rw : ''}${on.length ? ` 受ける:${on.join(',')}` : ''}${s.scenes ? ` シーン:${s.scenes.join(',')}だけ` : ''}`);
  }

  if (p.registry.tables.size) {
    r.tables.push('## tables（$表.行.列 で参照。中身は ages table <dir> <表>）');
    for (const def of p.registry.tables.values()) {
      const rows = p.docs.tables.get(def.name)?.rows ?? [];
      const std = p.registry.stdTables.has(def.name);
      if (std && !rows.length) continue;
      const ids = rows.map((r) => r.id);
      // 標準の表は列が決まっているので、説明と列を省く（ages schema <dir> $表 で引ける）
      const head = std ? '（標準）' : compact
        ? `${def.desc ? ' ' + firstSentence(def.desc) : ''} | ${Object.keys(def.columns).join(' ')}`
        : `${def.desc ? ' ' + def.desc : ''} | ${Object.entries(def.columns).map(([k, f]) => `${k}:${brief(f)}`).join(' ')}`;
      r.tables.push(`$${def.name} ${rows.length}行${head} | 行: ${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ' …' : ''}${tableMarks(ins, def.name)}`);
    }
  }

  if (p.docs.prefabs.size && compact) {
    // 同じ部品の組ごとに、名前だけを並べる（説明・タグ・変えた所は ages get <dir> @名前）
    r.prefabs.push(`## prefabs（${p.docs.prefabs.size}個。同じ部品の組ごとに名前だけ。←は派生の元）`);
    for (const [key, names] of prefabGroups(p, ins)) r.prefabs.push(`[${key || '部品なし'}] ${names.length}: ${names.join(' ')}`);
  }
  if (p.docs.prefabs.size && !compact) r.prefabs.push(`## prefabs（@名前 で参照${[...p.docs.prefabs.values()].some((x) => x.base) ? '。← は派生の元、変: は元から変えた所' : ''}）`);
  for (const raw of compact ? [] : p.docs.prefabs.values()) {
    const pf = p.registry.findPrefab(raw.name) ?? raw;
    const tags = pf.tags?.length ? ` tags:${pf.tags.join(',')}` : '';
    const ov = raw.base ? overridesOf(p.docs.prefabs, raw.name) : [];
    const variant = raw.base ? ` ← @${raw.base}` : '';
    r.prefabs.push(`@${pf.name}${variant}${raw.desc ? ' ' + raw.desc : ''} [${Object.keys(pf.components).join(' ')}]${tags}${ov.length ? ` 変:${ov.join(',')}` : ''}${marks(touched, locks, `@${pf.name}`)}`);
  }

  r.scenes.push(`## scenes（シーン#ID "名前" [コンポーネント]）${gotos.size ? `\ngoto の行き先（コード）: ${[...gotos.keys()].join(' ')}` : ''}`);
  // 要約の地図では、前のシーンと同じ物（同じ ID・同じ部品）を繰り返さない
  const seen = new Map<string, string>();
  for (const raw of p.docs.scenes.values()) {
    const s = p.resolvedScene(raw);
    r.scenes.push(`${s.name}（${s.entities.length}体）${s.name === c.startScene ? ' 開始' : ''}${s.desc ? ' ' + (compact ? firstSentence(s.desc) : s.desc) : ''}`);
    const same = new Map<string, number>();
    s.entities.forEach((e, i) => {
      const tags = e.tags?.length ? ` tags:${e.tags.join(',')}` : '';
      const mk = marks(touched, locks, `${s.name}#${e.id}`);
      // プレハブのインスタンスは ←@プレハブ と、プレハブから変えた所（変:）
      const ov = e.prefab ? instanceOverrides(p.docs.prefabs, raw.entities[i]) : [];
      const inst = e.prefab ? ` ←@${e.prefab}${!compact && ov.length ? ` 変:${ov.join(',')}` : ''}` : '';
      const sig = `${e.id}[${Object.keys(e.components).join(' ')}]${tags}${inst}`;
      if (compact && !mk && seen.has(sig)) { const from = seen.get(sig)!; same.set(from, (same.get(from) ?? 0) + 1); return; }
      if (!seen.has(sig)) seen.set(sig, s.name);
      r.scenes.push(compact ? `  #${e.id}${inst} [${Object.keys(e.components).join(' ')}]${tags}${mk}` : `  ${s.name}#${e.id} "${e.name}"${inst} [${Object.keys(e.components).join(' ')}]${tags}${mk}`);
    });
    for (const [from, n] of same) r.scenes.push(`  ほか${n}体は ${from} と同じ`);
  }

  if (p.assets.length > ASSET_LIST_MAX) {
    // 多いときは1つずつ並べず、フォルダごとの数だけ（毎回読む1枚なので。1つずつは ages assets で引く）
    r.assets.push(`## assets（${p.assets.length}個。フォルダごとの数。1つずつは ages assets <dir> [フォルダ] [--unused]）`);
    r.assets.push(...summarizeAssets(p, { touched, locks, code }));
  } else if (p.assets.length) {
    r.assets.push('## assets（画像 幅x高さ・音 秒・シート 格子のコマの大きさ×数か、自由なコマ数と名前。使っている所は ages assets --refs）');
    r.assets.push(...renderAssets(p, { touched, locks, code }));
  }
  r.extensions.push(...extensionLines(p, windows));
  return r;
}

/** エディタ拡張の行（目次の地図でも省かない。作る前に見るため） */
function extensionLines(p: Project, windows: WindowInfo[]): string[] {
  const c = p.config;
  if (!c.editorWindows?.length) return [];
  const out = ['## editor extensions（プロジェクト独自のエディタ拡張。作る前にここを見て、近いものがあれば直す。変える値は edits と、見せている欄・部品・行だけ）'];
  for (const w of windows.length ? windows : c.editorWindows.map((path) => ({ path }) as WindowInfo)) {
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

/** 目次の地図: 節ごとに数と名前だけ。中身は ages map <dir> 節・ages find で引く */
function indexLines(p: Project, ins: Ins): Record<MapSection, string[]> {
  const r: Record<MapSection, string[]> = { components: [], shaders: [], systems: [], tables: [], prefabs: [], scenes: [], assets: [], extensions: [] };
  const own = ownComponents(p);
  if (own.length) r.components.push(`## components ${own.length}個: ${own.map((d) => d.name).join(' ')}`);
  const { own: ownShaders, std: stdUsed } = shadersOf(p);
  if (ownShaders.length || stdUsed.length) r.shaders.push(`## shaders: ${[...ownShaders, ...stdUsed].map((d) => d.path).join(' ')}`);
  // システムは実行順の名前だけ（標準の続きは1つにまとめる）
  const names: string[] = [];
  const systems = p.registry.systems;
  for (let i = 0; i < systems.length; i++) {
    if (systems[i].name.startsWith('std.')) {
      let j = i;
      while (j + 1 < systems.length && systems[j + 1].name.startsWith('std.')) j++;
      names.push(`(標準${j - i + 1})`);
      i = j;
    } else names.push(systems[i].name);
  }
  if (systems.length) r.systems.push(`## systems 実行順: ${names.join(' ')}`);
  const tables = [...p.registry.tables.values()].filter((d) => (p.docs.tables.get(d.name)?.rows.length ?? 0) || !p.registry.stdTables.has(d.name));
  if (tables.length) r.tables.push(`## tables（$表.行.列）: ${tables.map((d) => `$${d.name} ${p.docs.tables.get(d.name)?.rows.length ?? 0}行${tableMarks(ins, d.name)}`).join('  ')}`);
  if (p.docs.prefabs.size) {
    // 部品の組ごとに、いちばん後ろの部品（ふつう、いちばん特有のもの）で数える。1つだけの組は名前も
    const kinds = new Map<string, string[]>();
    for (const [key, list] of prefabGroups(p, ins)) {
      const label = key.split(' ').filter(Boolean).pop() ?? '部品なし';
      kinds.set(label, [...(kinds.get(label) ?? []), ...list]);
    }
    r.prefabs.push(`## prefabs ${p.docs.prefabs.size}個（主な部品ごとの数）: ${[...kinds].map(([k, l]) => (l.length === 1 ? `${k}(${l[0]})` : `${k} ${l.length}`)).join('  ')}`);
  }
  if (p.docs.scenes.size) r.scenes.push(`## scenes: ${[...p.docs.scenes.values()].map((s) => `${s.name}(${s.entities.length}体${s.name === p.config.startScene ? '・開始' : ''})`).join(' ')}${ins.gotos.size ? `  goto の行き先（コード）: ${[...ins.gotos.keys()].join(' ')}` : ''}`);
  if (p.assets.length) {
    const n = { image: 0, sheet: 0, sound: 0, font: 0 };
    for (const a of p.assets) {
      if (a.kind === 'image') { n.image++; if (p.registry.sheets.get(a.path)) n.sheet++; } else if (a.kind === 'sound') n.sound++; else n.font++;
    }
    r.assets.push(`## assets ${p.assets.length}個: 画像${n.image}（シート${n.sheet}） 音${n.sound}${n.font ? ` フォント${n.font}` : ''}（1つずつは ages assets <dir> [フォルダ]）`);
  }
  r.extensions.push(...extensionLines(p, ins.windows));
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
  const groups = new Map<string, { image: number; sheet: number; sound: number; font: number; unused: number; lock: number; star: number }>();
  for (const a of p.assets) {
    const parts = dirOf(a.path).split('/').filter(Boolean);
    const key = parts.slice(0, 3).join('/') || '.';
    const g = groups.get(key) ?? { image: 0, sheet: 0, sound: 0, font: 0, unused: 0, lock: 0, star: 0 };
    if (a.kind === 'image') { g.image++; if (p.registry.sheets.get(a.path)) g.sheet++; }
    else if (a.kind === 'sound') g.sound++;
    else g.font++;
    if (!((refs.get(a.path)?.length ?? 0) + (code.get(a.path)?.length ?? 0))) g.unused++;
    if (locks[`sheet:${a.path}`] || locks[`file:${a.path}`]) g.lock++;
    else if (touched[`sheet:${a.path}`]) g.star++;
    groups.set(key, g);
  }
  return [...groups].map(([k, g]) => {
    const kinds = [g.image ? `画像${g.image}${g.sheet ? `（シート${g.sheet}）` : ''}` : '', g.sound ? `音${g.sound}` : '', g.font ? `フォント${g.font}` : ''].filter(Boolean).join(' ');
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
