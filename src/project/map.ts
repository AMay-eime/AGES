// プロジェクトの地図。AIが最初に読む1枚。全体を少ないトークンで把握できる形にする。
import { brief } from '../core/schema.ts';
import { frameCount, sheetPathOf } from '../core/sheet.ts';
import type { Project } from './project.ts';
import type { LockMark, TouchMark } from './oplog.ts';

export function renderMap(p: Project, touched: Record<string, TouchMark> = {}, locks: Record<string, LockMark> = {}): string {
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
    out.push(`${i + 1} ${s.name} ${s.desc}${rw ? ' ' + rw : ''}`);
  });

  out.push('## prefabs（@名前 で参照）');
  for (const pf of p.docs.prefabs.values()) {
    const tags = pf.tags?.length ? ` tags:${pf.tags.join(',')}` : '';
    out.push(`@${pf.name}${pf.desc ? ' ' + pf.desc : ''} [${Object.keys(pf.components).join(' ')}]${tags}${marks(touched, locks, `@${pf.name}`)}`);
  }

  out.push('## scenes（シーン#ID "名前" [コンポーネント]）');
  for (const s of p.docs.scenes.values()) {
    out.push(`${s.name}（${s.entities.length}体）`);
    for (const e of s.entities) {
      const tags = e.tags?.length ? ` tags:${e.tags.join(',')}` : '';
      out.push(`  ${s.name}#${e.id} "${e.name}" [${Object.keys(e.components).join(' ')}]${tags}${marks(touched, locks, `${s.name}#${e.id}`)}`);
    }
  }

  if (p.assets.length) {
    out.push('## assets（画像は 幅x高さ、シートは コマの大きさ×コマ数 と clips）');
    for (const a of p.assets) {
      if (a.kind !== 'image') { out.push(`${a.path} ${a.kind} ${Math.ceil(a.bytes / 1024)}KB`); continue; }
      const sheet = p.registry.sheets.get(sheetPathOf(a.path));
      let line = `${a.path} ${a.w ?? '?'}x${a.h ?? '?'}`;
      if (sheet) {
        const n = a.w && a.h ? frameCount(sheet, a.w, a.h) : '?';
        const clips = Object.entries(sheet.clips ?? {}).map(([k, v]) => `${k}(${v.frames.join(',')} ${v.fps}fps${v.loop === false ? ' 1回' : ''})`).join(' ');
        line += ` シート${sheet.frame[0]}x${sheet.frame[1]}×${n}${clips ? ' clips: ' + clips : ''}`;
      }
      out.push(line);
    }
  }
  if (c.editorWindows?.length) out.push(`## editor windows\n${c.editorWindows.join(' ')}`);
  out.push(`## 🔒ロック ${Object.keys(locks).length}件（AIは変更不可。理由があれば人に提案する） / ★人が調整 ${Object.keys(touched).length}件（変更前に人へ確認）`);
  return out.join('\n');
}

function marks(touched: Record<string, TouchMark>, locks: Record<string, LockMark>, prefix: string): string {
  const pick = (rec: Record<string, unknown>) => Object.keys(rec).filter((k) => k.startsWith(prefix + '.')).map((k) => k.slice(prefix.length + 1));
  const l = pick(locks);
  const t = pick(touched).filter((k) => !l.includes(k));
  return (l.length ? ' 🔒' + l.join(',') : '') + (t.length ? ' ★' + t.join(',') : '');
}
