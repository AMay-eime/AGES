// プロジェクトの地図。AIが最初に読む1枚。全体を少ないトークンで把握できる形にする。
import { brief } from '../core/schema.ts';
import { frameCount } from '../core/sheet.ts';
import { assetRefs, baseOf, dirOf, isUnder } from '../core/assets.ts';
import type { AssetKind } from '../core/schema.ts';
import type { Project } from './project.ts';
import { languagesOf } from '../core/i18n.ts';
import { overridesOf } from '../core/variant.ts';
import type { WindowInfo } from './windows.ts';
import type { LockMark, TouchMark } from './oplog.ts';

/** 地図の大きさの上限（文字）。超えるプロジェクトでは、細かいところを省いた要約の地図にする（詳しくは ages schema・ages get で引く） */
export const MAP_BUDGET = 12000;

export function renderMap(p: Project, touched: Record<string, TouchMark> = {}, locks: Record<string, LockMark> = {}, code = new Map<string, string[]>(), windows: WindowInfo[] = [], gotos = new Map<string, string[]>(), budget = MAP_BUDGET): string {
  const full = buildMap(p, touched, locks, code, windows, gotos, false);
  return full.length <= budget ? full : buildMap(p, touched, locks, code, windows, gotos, true);
}

/** 説明の最初の一文（要約の地図で。長い説明は ages schema で引く） */
const firstSentence = (s: string | undefined, max = 40): string => {
  if (!s) return '';
  const cut = s.split('。')[0];
  return cut.length > max ? cut.slice(0, max) + '…' : cut;
};

function buildMap(p: Project, touched: Record<string, TouchMark>, locks: Record<string, LockMark>, code: Map<string, string[]>, windows: WindowInfo[], gotos: Map<string, string[]>, compact: boolean): string {
  const c = p.config;
  const out: string[] = [];
  out.push(`# ${c.name}  fps${c.fps} seed${c.seed} view${c.view.width}x${c.view.height} start:${c.startScene} code:${c.game}`);
  if (compact) out.push(`（大きなプロジェクトなので要約の地図。型・範囲・既定値・説明は ages schema <dir> 名前,名前、物・プレハブの中身は ages get <dir> 住所）`);

  // 毎回読む1枚なので、使っていないものの行は出さない（標準の部品・シェーダー・表の説明は ages schema で引く）
  const own = [...p.registry.components.values()].filter((def) => !p.registry.std.has(def.name));
  if (own.length && compact) {
    out.push('## components（名前 説明の初め | フィールドの名前 | 自動:実行中に変わる値）');
    for (const def of own) {
      const all = Object.entries(def.fields);
      const auto = all.filter(([, f]) => isAutoField(f)).map(([k]) => k);
      const fields = all.filter(([, f]) => !isAutoField(f)).map(([k]) => k).join(' ');
      out.push(`${def.name} ${firstSentence(def.desc)} | ${fields || '（フィールドなし）'}${auto.length ? ` | 自動:${auto.join(',')}` : ''}`);
    }
  } else if (own.length) {
    out.push('## components（名前 説明 | フィールド:型 範囲=既定値 | 自動:実行中に変わる値）');
    for (const def of own) {
      // 実行中に変わる値（desc に「自動で変化」）は人もAIも書かないので、型と範囲を省いて名前だけ（ages schema で引ける）
      const all = Object.entries(def.fields);
      const auto = all.filter(([, f]) => isAutoField(f)).map(([k]) => k);
      const fields = all.filter(([, f]) => !isAutoField(f)).map(([k, f]) => `${k}:${brief(f)}`).join(' ');
      out.push(`${def.name} ${def.desc} | ${fields || '（フィールドなし）'}${auto.length ? ` | 自動:${auto.join(',')}` : ''}`);
    }
  }

  // シェーダー: 自分のシェーダーと、使っている標準のものだけ（調整できる値を1行で）
  const shaders = [...p.registry.shaders.values()];
  const ownShaders = shaders.filter((d) => !d.path.startsWith('std:'));
  const used = usedShaders(p);
  const stdUsed = shaders.filter((d) => d.path.startsWith('std:') && used.has(d.path));
  if (ownShaders.length || stdUsed.length) {
    out.push('## shaders（Effect・PostEffect の shader で選ぶ。値は params.名前）');
    for (const d of ownShaders) out.push(`${d.path} ${d.desc} | ${Object.entries(d.uniforms).map(([k, f]) => `${k}:${brief(f)}`).join(' ') || '（値なし）'}${d.errors.length ? ` ⚠ ${d.errors.length}件の問題（ages check）` : ''}`);
    if (stdUsed.length) out.push(`標準: ${stdUsed.map((d) => `${d.path}(${Object.keys(d.uniforms).join(',')})`).join(' ')}`);
  }

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

  out.push('## systems（実行順。r=読む w=書く）');
  // 標準のシステムは、続いている所を1行にまとめる（中身は ages schema guide で引く）
  const systems = p.registry.systems;
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i];
    if (s.name.startsWith('std.')) {
      let j = i;
      while (j + 1 < systems.length && systems[j + 1].name.startsWith('std.')) j++;
      out.push(`${i + 1}${j > i ? `-${j + 1}` : ''} 標準: ${systems.slice(i, j + 1).map((x) => x.name).join(' ')}`);
      i = j;
      continue;
    }
    const rw = [s.reads?.length ? `r:${s.reads.join(',')}` : '', s.writes?.length ? `w:${s.writes.join(',')}` : ''].filter(Boolean).join(' ');
    out.push(`${i + 1} ${s.name} ${compact ? firstSentence(s.desc, 30) : s.desc}${rw ? ' ' + rw : ''}${s.scenes ? ` シーン:${s.scenes.join(',')}だけ` : ''}`);
  }

  if (p.registry.tables.size) {
    out.push('## tables（$表.行.列 で参照。中身は ages table <dir> <表>）');
    for (const def of p.registry.tables.values()) {
      const rows = p.docs.tables.get(def.name)?.rows ?? [];
      const std = p.registry.stdTables.has(def.name);
      if (std && !rows.length) continue;
      const ids = rows.map((r) => r.id);
      const lk = Object.keys(locks).filter((k) => k.startsWith(`$${def.name}.`)).length;
      const tc = Object.keys(touched).filter((k) => k.startsWith(`$${def.name}.`)).length;
      // 標準の表は列が決まっているので、説明と列を省く（ages schema <dir> $表 で引ける）
      const head = std ? '（標準）' : compact
        ? `${def.desc ? ' ' + firstSentence(def.desc) : ''} | ${Object.keys(def.columns).join(' ')}`
        : `${def.desc ? ' ' + def.desc : ''} | ${Object.entries(def.columns).map(([k, f]) => `${k}:${brief(f)}`).join(' ')}`;
      out.push(`$${def.name} ${rows.length}行${head} | 行: ${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ' …' : ''}${lk ? ` 🔒${lk}` : ''}${tc ? ` ★${tc}` : ''}`);
    }
  }

  if (p.docs.prefabs.size && compact) {
    // 同じ部品の組ごとに、名前だけを並べる（説明・タグ・変えた所は ages get <dir> @名前）
    out.push(`## prefabs（${p.docs.prefabs.size}個。同じ部品の組ごとに名前だけ。←は派生の元）`);
    const groups = new Map<string, string[]>();
    for (const raw of p.docs.prefabs.values()) {
      const pf = p.registry.findPrefab(raw.name) ?? raw;
      const key = Object.keys(pf.components).join(' ');
      const name = `${pf.name}${raw.base ? '←' + raw.base : ''}${marks(touched, locks, `@${pf.name}`)}`;
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }
    for (const [key, names] of groups) out.push(`[${key || '部品なし'}] ${names.length}: ${names.join(' ')}`);
  }
  if (p.docs.prefabs.size && !compact) out.push(`## prefabs（@名前 で参照${[...p.docs.prefabs.values()].some((x) => x.base) ? '。← は派生の元、変: は元から変えた所' : ''}）`);
  for (const raw of compact ? [] : p.docs.prefabs.values()) {
    const pf = p.registry.findPrefab(raw.name) ?? raw;
    const tags = pf.tags?.length ? ` tags:${pf.tags.join(',')}` : '';
    const own = raw.base ? overridesOf(p.docs.prefabs, raw.name) : [];
    const variant = raw.base ? ` ← @${raw.base}` : '';
    out.push(`@${pf.name}${variant}${raw.desc ? ' ' + raw.desc : ''} [${Object.keys(pf.components).join(' ')}]${tags}${own.length ? ` 変:${own.join(',')}` : ''}${marks(touched, locks, `@${pf.name}`)}`);
  }

  out.push(`## scenes（シーン#ID "名前" [コンポーネント]）${gotos.size ? `\ngoto の行き先（コード）: ${[...gotos.keys()].join(' ')}` : ''}`);
  // 要約の地図では、前のシーンと同じ物（同じ ID・同じ部品）を繰り返さない
  const seen = new Map<string, string>();
  for (const s of p.docs.scenes.values()) {
    out.push(`${s.name}（${s.entities.length}体）${s.name === c.startScene ? ' 開始' : ''}${s.desc ? ' ' + (compact ? firstSentence(s.desc) : s.desc) : ''}`);
    const same = new Map<string, number>();
    for (const e of s.entities) {
      const tags = e.tags?.length ? ` tags:${e.tags.join(',')}` : '';
      const mk = marks(touched, locks, `${s.name}#${e.id}`);
      const sig = `${e.id}[${Object.keys(e.components).join(' ')}]${tags}`;
      if (compact && !mk && seen.has(sig)) { const from = seen.get(sig)!; same.set(from, (same.get(from) ?? 0) + 1); continue; }
      if (!seen.has(sig)) seen.set(sig, s.name);
      out.push(compact ? `  #${e.id} [${Object.keys(e.components).join(' ')}]${tags}${mk}` : `  ${s.name}#${e.id} "${e.name}" [${Object.keys(e.components).join(' ')}]${tags}${mk}`);
    }
    for (const [from, n] of same) out.push(`  ほか${n}体は ${from} と同じ`);
  }

  if (p.assets.length > ASSET_LIST_MAX) {
    // 多いときは1つずつ並べず、フォルダごとの数だけ（毎回読む1枚なので。1つずつは ages assets で引く）
    out.push(`## assets（${p.assets.length}個。フォルダごとの数。1つずつは ages assets <dir> [フォルダ] [--unused]）`);
    out.push(...summarizeAssets(p, { touched, locks, code }));
  } else if (p.assets.length) {
    out.push('## assets（画像 幅x高さ・音 秒・シート 格子のコマの大きさ×数か、自由なコマ数と名前。使っている所は ages assets --refs）');
    out.push(...renderAssets(p, { touched, locks, code }));
  }
  if (c.editorWindows?.length) {
    out.push('## editor extensions（プロジェクト独自のエディタ拡張。作る前にここを見て、近いものがあれば直す。変える値は edits と、見せている欄・部品だけ）');
    for (const w of windows.length ? windows : c.editorWindows.map((path) => ({ path }) as WindowInfo)) {
      if (w.error) { out.push(`${w.path} ⚠ ${w.error}`); continue; }
      const edits = w.edits ? (w.edits.length ? compactPaths(w.edits) : 'なし（見るだけ）') : w.panel ? '⚠ 宣言なし' : '';
      const parts = [w.panel ? 'パネル' : '', w.fields?.length ? `欄:${w.fields.join(',')}` : '', w.components?.length ? `部品:${w.components.join(',')}` : '', w.menus?.length ? `メニュー:${w.menus.join(',')}` : ''].filter(Boolean).join(' ');
      out.push(`${w.id ?? '?'}${w.title ? `「${w.title}」` : ''}${w.desc ? ' ' + w.desc : ''}${edits ? ` | 変える: ${edits}` : ''}${parts && parts !== 'パネル' ? ` | ${parts}` : ''} | ${w.path}`);
    }
  }
  const nl = Object.keys(locks).length, nt = Object.keys(touched).length;
  if (nl || nt) out.push(`## 🔒ロック ${nl}件（AIは変更不可。理由があれば人に提案する） / ★人が調整 ${nt}件（変更前に人へ確認）`);
  return out.join('\n');
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
  for (const s of p.docs.scenes.values()) for (const e of s.entities) add(e.components);
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
  for (const s of p.docs.scenes.values()) for (const e of s.entities) add(e.components.Collider);
  return out;
}
