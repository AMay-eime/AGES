// 表計算ソフトとの行き来（CSV・TSV）。表の書き出し・読み込みと、エディタの貼り付けに使う。
import { checkAt, defaultOf, type Field } from './schema.ts';
import type { Row, TableDef } from './table.ts';

/** CSV か TSV を読む（区切りは中身から判断。"..." の中の区切り・改行・"" に対応） */
export function parseDelimited(text: string, sep?: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const d = sep ?? (t.split('\n')[0].includes('\t') ? '\t' : ',');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export function formatDelimited(rows: string[][], sep = ','): string {
  const esc = (s: string) => (s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(esc).join(sep)).join('\n') + '\n';
}

/** 値を表計算ソフトのセルの文字にする（入れ子の値は JSON） */
export function cellText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** セルの文字を、列の型の値にする。空のセルは undefined（既定値のまま）。読めなければ例外 */
export function parseCell(f: Field, text: string, at: string): unknown {
  const s = text.trim();
  if (s === '') return undefined;
  let v: unknown;
  switch (f.type) {
    case 'number': case 'int': v = Number(s); break;
    case 'bool': v = /^(true|1|yes|y|はい|○|◯)$/i.test(s) ? true : /^(false|0|no|n|いいえ|×|✕)$/i.test(s) ? false : s; break;
    case 'frame': v = /^\d+$/.test(s) ? Number(s) : s; break;
    case 'vec2': v = s.startsWith('[') ? safeJson(s) : s.split(/[,\s]+/).map(Number); break;
    case 'vec3': v = s.startsWith('[') ? safeJson(s) : s.split(/[,\s]+/).map(Number); break;
    case 'ref': v = s; break;
    case 'list': case 'struct': case 'oneOf': case 'matrix': v = safeJson(s); break;
    default: v = s;
  }
  const err = checkAt(at, f, v);
  if (err) throw new Error(err);
  return v;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** 表を CSV・TSV の行にする（1行目は列の名前） */
export function tableToCells(def: TableDef, rows: Row[], cols?: string[]): string[][] {
  const names = cols ?? Object.keys(def.columns);
  return [['id', ...names], ...rows.map((r) => [r.id, ...names.map((c) => cellText(c in r ? r[c] : defaultOf(def.columns[c])))])];
}

/** CSV・TSV の行から表の行を作る（1行目は列の名前。id の列が要る）。既定値と同じセルは省く */
export function cellsToRows(def: TableDef, cells: string[][]): Row[] {
  if (!cells.length) return [];
  const head = cells[0].map((h) => h.trim());
  const idCol = head.indexOf('id');
  if (idCol < 0) throw new Error(`1行目に id の列がありません（1行目は列の名前: id, ${Object.keys(def.columns).join(', ')}）`);
  for (const h of head) if (h !== 'id' && h !== '' && !def.columns[h]) throw new Error(`列 ${h} は表 ${def.name} にありません（ある列: id, ${Object.keys(def.columns).join(', ')}）`);
  return cells.slice(1).map((r, i) => {
    const id = (r[idCol] ?? '').trim();
    if (!id) throw new Error(`${i + 2} 行目の id が空です`);
    const row: Row = { id };
    head.forEach((h, j) => {
      if (h === 'id' || h === '') return;
      const v = parseCell(def.columns[h], r[j] ?? '', `$${def.name}.${id}.${h}`);
      if (v !== undefined && JSON.stringify(v) !== JSON.stringify(defaultOf(def.columns[h]))) row[h] = v;
    });
    return row;
  });
}

/**
 * 表をまるごと next にするための操作（読み込み用）。値が同じセルは触らない（ロック・★・操作ログが余計に動かないように）
 */
export function importOps(def: TableDef, current: Row[], next: Row[]): import('./patch.ts').Op[] {
  const ops: import('./patch.ts').Op[] = [];
  const t = def.name;
  const ids = new Set(next.map((r) => r.id));
  if (ids.size !== next.length) throw new Error('読み込むデータに、同じ id の行があります');
  const eff = (r: Row, c: string) => (c in r ? r[c] : defaultOf(def.columns[c]));
  for (const r of current) if (!ids.has(r.id)) ops.push({ op: 'removeRow', table: t, id: r.id });
  const cur = new Map(current.map((r) => [r.id, r]));
  for (const r of next) {
    const o = cur.get(r.id);
    if (!o) { ops.push({ op: 'addRow', table: t, row: r }); continue; }
    for (const c of Object.keys(def.columns)) {
      if (JSON.stringify(eff(o, c)) !== JSON.stringify(eff(r, c))) ops.push({ op: 'set', path: `$${t}.${r.id}.${c}`, value: eff(r, c) });
    }
  }
  // 並び順
  const order = [...current.filter((r) => ids.has(r.id)).map((r) => r.id), ...next.filter((r) => !cur.has(r.id)).map((r) => r.id)];
  next.forEach((r, i) => {
    if (order[i] === r.id) return;
    ops.push({ op: 'moveRow', table: t, id: r.id, to: i });
    order.splice(order.indexOf(r.id), 1);
    order.splice(i, 0, r.id);
  });
  return ops;
}
