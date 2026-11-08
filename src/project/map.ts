// プロジェクトの地図。AIが最初に読む1枚。全体を少ないトークンで把握できる形にする。
import { brief } from '../core/schema.ts';
import { frameCount } from '../core/sheet.ts';
import { assetRefs, baseOf, dirOf, isUnder } from '../core/assets.ts';
import type { AssetKind } from '../core/schema.ts';
import type { Project } from './project.ts';
import type { WindowInfo } from './windows.ts';
import type { LockMark, TouchMark } from './oplog.ts';

export function renderMap(p: Project, touched: Record<string, TouchMark> = {}, locks: Record<string, LockMark> = {}, code = new Map<string, string[]>(), windows: WindowInfo[] = [], gotos = new Map<string, string[]>()): string {
  const c = p.config;
  const out: string[] = [];
  out.push(`# ${c.name}  fps${c.fps} seed${c.seed} view${c.view.width}x${c.view.height} start:${c.startScene} code:${c.game}`);

  out.push('## components（名前 説明 | フィールド:型 範囲=既定値）');
  for (const def of p.registry.components.values()) {
    if (p.registry.std.has(def.name)) continue;
    const fields = Object.entries(def.fields).map(([k, f]) => `${k}:${brief(f)}`).join(' ');
    out.push(`${def.name} ${def.desc} | ${fields || '（フィールドなし）'}`);
  }
  out.push(`標準（定義不要。詳細は ages schema）: ${[...p.registry.std].join(' ')}`);

  out.push('## systems（実行順。r=読む w=書く）');
  p.registry.systems.forEach((s, i) => {
    const rw = [s.reads?.length ? `r:${s.reads.join(',')}` : '', s.writes?.length ? `w:${s.writes.join(',')}` : ''].filter(Boolean).join(' ');
    out.push(`${i + 1} ${s.name} ${s.desc}${rw ? ' ' + rw : ''}${s.scenes ? ` シーン:${s.scenes.join(',')}だけ` : ''}`);
  });

  if (p.registry.tables.size) {
    out.push('## tables（$表.行.列 で参照。中身は ages table <dir> <表>）');
    for (const def of p.registry.tables.values()) {
      const rows = p.docs.tables.get(def.name)?.rows ?? [];
      const ids = rows.map((r) => r.id);
      const lk = Object.keys(locks).filter((k) => k.startsWith(`$${def.name}.`)).length;
      const tc = Object.keys(touched).filter((k) => k.startsWith(`$${def.name}.`)).length;
      const cols = Object.entries(def.columns).map(([k, f]) => `${k}:${brief(f)}`).join(' ');
      out.push(`$${def.name} ${rows.length}行${def.desc ? ' ' + def.desc : ''} | ${cols} | 行: ${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ' …' : ''}${lk ? ` 🔒${lk}` : ''}${tc ? ` ★${tc}` : ''}`);
    }
  }

  out.push('## prefabs（@名前 で参照）');
  for (const pf of p.docs.prefabs.values()) {
    const tags = pf.tags?.length ? ` tags:${pf.tags.join(',')}` : '';
    out.push(`@${pf.name}${pf.desc ? ' ' + pf.desc : ''} [${Object.keys(pf.components).join(' ')}]${tags}${marks(touched, locks, `@${pf.name}`)}`);
  }

  out.push(`## scenes（シーン#ID "名前" [コンポーネント]。切り替えは ctx.scene.goto。tag keep の物は切り替えても残る）${gotos.size ? `\ngoto の行き先（コード）: ${[...gotos.keys()].join(' ')}` : ''}`);
  for (const s of p.docs.scenes.values()) {
    out.push(`${s.name}（${s.entities.length}体）${s.name === c.startScene ? ' 開始' : ''}${s.desc ? ' ' + s.desc : ''}`);
    for (const e of s.entities) {
      const tags = e.tags?.length ? ` tags:${e.tags.join(',')}` : '';
      out.push(`  ${s.name}#${e.id} "${e.name}" [${Object.keys(e.components).join(' ')}]${tags}${marks(touched, locks, `${s.name}#${e.id}`)}`);
    }
  }

  if (p.assets.length) {
    out.push('## assets（画像は 幅x高さ、音は 秒。シートは 格子なら コマの大きさ×コマ数、自由なら コマ数と名前。使っている所は ages assets <dir> --refs <場所>）');
    out.push(...renderAssets(p, { touched, locks, code }));
  }
  if (c.editorWindows?.length) {
    out.push('## editor windows（プロジェクト独自のエディタ。作る前にここを見て、近いものがあれば直す。変える値は edits に書いたものだけ）');
    for (const w of windows.length ? windows : c.editorWindows.map((path) => ({ path }) as WindowInfo)) {
      if (w.error) { out.push(`${w.path} ⚠ ${w.error}`); continue; }
      const edits = w.edits ? (w.edits.length ? compactPaths(w.edits) : 'なし（見るだけ）') : '⚠ 宣言なし';
      out.push(`${w.id ?? '?'}「${w.title ?? ''}」${w.desc ? ' ' + w.desc : ''} | 変える: ${edits} | ${w.path}`);
    }
  }
  out.push(`## 🔒ロック ${Object.keys(locks).length}件（AIは変更不可。理由があれば人に提案する） / ★人が調整 ${Object.keys(touched).length}件（変更前に人へ確認）`);
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
