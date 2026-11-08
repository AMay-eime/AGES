// 表のエディタ。同じ形の行がたくさん並ぶデータ（武器・敵・アイテム・カードなど）を、表計算ソフトのように編集する。
// - セルを直接書き換える（数値・文字・選択・チェック）。入れ子の値（リストなど）は行を選ぶと右に開く
// - 表計算ソフトからコピーした範囲を、選んだセルから貼り付けられる。CSV の書き出し・読み込み
// - 行の追加・複製・削除・並べ替え・ID の変更（その行を指している値も書き換わる）
// - セル・行ごとの 🔒（AIが変えられない）と ★（人が調整した）
import type { App } from '../app.ts';
import type { Op } from '../../core/patch.ts';
import { defaultOf, typeOf, type Field } from '../../core/schema.ts';
import { cellText, cellsToRows, formatDelimited, importOps, parseCell, parseDelimited, tableToCells } from '../../core/csv.ts';
import type { Row } from '../../core/table.ts';
import { h, clear, toast, modal, time } from './dom.ts';
import { isNested, nestedWidget, toOp, valueSummary, widget, type NestedOp } from './inspector.ts';
import type { Panel } from './layout.ts';

const SIMPLE = new Set(['number', 'int', 'string', 'enum', 'bool', 'color', 'row', 'prefab', 'asset', 'frame', 'ref', 'input', 'scene', 'ease']);

export function tablePanel(app: App): Panel & { open(name: string, row?: string): void } {
  const el = h('div', { class: 'table-ed' });
  let name = '';
  let selRow = '';
  let filter = '';
  let sortCol = '';
  let sortDir = 1;

  const def = () => app.registry?.tables.get(name);
  const rows = (): Row[] => app.registry?.tableData.get(name)?.rows ?? [];
  const addr = (id: string, col?: string) => `$${name}${id ? '.' + id : ''}${col ? '.' + col : ''}`;
  const patch = (ops: Op[]) => app.patch(ops, 'table');

  const open = (n: string, row?: string) => { name = n; if (row) selRow = row; render(); };

  // ---------- 上の帯 ----------
  const bar = () => {
    const names = [...(app.registry?.tables.keys() ?? [])];
    const d = def();
    const pick = h('select', { onchange: (e: Event) => open((e.target as HTMLSelectElement).value) },
      h('option', { value: '' }, names.length ? '表を選ぶ…' : '表がありません（ゲームのコードで defineTable）'), names.map((n) => h('option', { value: n, selected: n === name }, `$${n}`))) as HTMLSelectElement;
    const search = h('input', { type: 'search', placeholder: '絞り込み（id や値）', value: filter, style: 'width:140px', oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value; renderGrid(); } });
    const fileIn = h('input', { type: 'file', accept: '.csv,.tsv,.txt', style: 'display:none' }) as HTMLInputElement;
    fileIn.addEventListener('change', async () => { const f = fileIn.files?.[0]; if (f) importText(await f.text(), f.name); fileIn.value = ''; });
    return h('div', { class: 'table-bar' }, pick,
      d ? h('span', { class: 'muted' }, `${rows().length}行${d.desc ? ' — ' + d.desc : ''}`) : null,
      d ? search : null, h('span', { class: 'spacer' }),
      d ? h('button', { onclick: addRow, title: '最後に行を足す' }, '＋ 行') : null,
      d ? h('button', { onclick: exportCsv, title: '表計算ソフトで開ける CSV に書き出す' }, 'CSV書き出し') : null,
      d ? h('button', { onclick: () => fileIn.click(), title: 'CSV・TSV から表をまるごと置き換える（1行目は列の名前）' }, 'CSV読み込み') : null, fileIn);
  };

  // ---------- 表 ----------
  const grid = h('div', { class: 'table-grid' });
  const side = h('div', { class: 'table-side' });
  const visibleRows = (): Row[] => {
    const d = def()!;
    let list = rows();
    if (filter) { const q = filter.toLowerCase(); list = list.filter((r) => r.id.toLowerCase().includes(q) || Object.values(r).some((v) => cellText(v).toLowerCase().includes(q))); }
    if (sortCol) {
      const val = (r: Row) => (sortCol === 'id' ? r.id : sortCol in r ? r[sortCol] : defaultOf(d.columns[sortCol]));
      list = [...list].sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : cellText(x).localeCompare(cellText(y))) * sortDir; });
    }
    return list;
  };
  const renderGrid = () => {
    const d = def();
    if (!d) return clear(grid);
    const cols = Object.entries(d.columns);
    const locks = app.state.locks, touched = app.state.touched;
    const th = (k: string, f?: Field) => h('th', {
      title: f ? `${k}: ${typeOf(f)}${f.desc ? '\n' + f.desc : ''}\nクリックで並べて見る（データの並びは変わりません）` : '行の名前（並べ替えても変わらない）',
      onclick: () => { if (sortCol === k) sortDir = -sortDir; else { sortCol = k; sortDir = 1; } renderGrid(); },
    }, k, sortCol === k ? (sortDir > 0 ? ' ▲' : ' ▼') : '');
    const body = visibleRows().map((r) => h('tr', { class: r.id === selRow ? 'sel' : '', onclick: (e: Event) => { if ((e.target as HTMLElement).tagName === 'TD' || (e.target as HTMLElement).tagName === 'TR') { selRow = r.id; renderSide(); markSel(); } } },
      h('td', { class: 'rowno muted' }, String(rows().indexOf(r))),
      h('td', { class: `idcell ${touched[addr(r.id)] ? 'touched' : ''}`, 'data-row': r.id, 'data-col': '__id' }, idInput(r)),
      cols.map(([k, f]) => cell(r, k, f, locks[addr(r.id, k)], touched[addr(r.id, k)]))));
    clear(grid, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '#'), th('id'), cols.map(([k, f]) => th(k, f)))), h('tbody', {}, body)));
  };
  const markSel = () => grid.querySelectorAll('tbody tr').forEach((tr, i) => tr.classList.toggle('sel', visibleRows()[i]?.id === selRow));

  const idInput = (r: Row) => {
    const t = h('input', { type: 'text', value: r.id, class: 'cell-in', title: 'ID を変えると、この行を指している値も書き換わります' }) as HTMLInputElement;
    t.addEventListener('focus', () => { selRow = r.id; renderSide(); markSel(); });
    t.addEventListener('change', () => { const to = t.value.trim(); if (to && to !== r.id) { selRow = to; patch([{ op: 'renameRow', table: name, id: r.id, to }]); } else t.value = r.id; });
    return t;
  };

  /** セル。単純な型はその場で書き換える。入れ子は要約だけ出し、行を選ぶと右で編集する */
  const cell = (r: Row, k: string, f: Field, lock: unknown, touched: unknown) => {
    const v = k in r ? r[k] : defaultOf(f);
    const cls = `${k in r ? '' : 'default'} ${touched ? 'touched' : ''} ${lock ? 'locked' : ''}`;
    // ロックされたセルは見るだけ（設定で隠すこともできる）。変えるのはロックマネージャーで
    if (lock && !app.showLocked) return h('td', { class: `cplx ${cls}`, title: '🔒 ロック中（設定で隠しています）', 'data-row': r.id, 'data-col': k }, '🔒');
    if (!SIMPLE.has(f.type)) return h('td', { class: `cplx ${cls}`, title: '行を選ぶと右で編集できます' }, valueSummary(f, v), lock ? ' 🔒' : '');
    const commit = (nv: unknown, final: boolean) => { if (final && JSON.stringify(nv) !== JSON.stringify(v)) patch([{ op: 'set', path: addr(r.id, k), value: nv }]); };
    const w = widget(app, f, v, commit, { comp: '', field: k, holder: {} });
    if (lock) w.el.setAttribute('inert', '');
    const td = h('td', { class: cls, 'data-row': r.id, 'data-col': k }, w.el, lock ? h('span', { class: 'lockmark', title: '🔒 ロック中（AI もエディタも変えられません）。変えるならロックマネージャーで' }, '🔒') : null);
    td.addEventListener('focusin', () => { if (selRow !== r.id) { selRow = r.id; renderSide(); markSel(); } });
    // 表計算ソフトからの貼り付け（複数のセル）
    td.addEventListener('paste', (e) => {
      const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      if (!/[\t\n]/.test(text.trim())) return;
      e.preventDefault();
      pasteAt(r.id, k, text);
    });
    return td;
  };

  const pasteAt = (rowId: string, col: string, text: string) => {
    const d = def()!;
    const list = visibleRows();
    const colNames = Object.keys(d.columns);
    const r0 = list.findIndex((r) => r.id === rowId), c0 = colNames.indexOf(col);
    const cells = parseDelimited(text, '\t');
    const ops: Op[] = [];
    try {
      cells.forEach((line, i) => line.forEach((t, j) => {
        const r = list[r0 + i], c = colNames[c0 + j];
        if (!r || !c || !SIMPLE.has(d.columns[c].type)) return;
        const v = parseCell(d.columns[c], t, addr(r.id, c));
        if (v !== undefined) ops.push({ op: 'set', path: addr(r.id, c), value: v });
      }));
    } catch (e) { return toast((e as Error).message, 'bad', 8000); }
    if (ops.length) { patch(ops); toast(`${ops.length}セルを貼り付けました`); }
  };

  // ---------- 右: 選んだ行 ----------
  const renderSide = () => {
    const d = def();
    const r = rows().find((x) => x.id === selRow);
    if (!d || !r) return clear(side, h('div', { class: 'pad muted' }, '行を選ぶと、ここで全部の列（リストなど入れ子の値も）を編集できます'));
    const i = rows().indexOf(r);
    const locks = app.state.locks;
    const allPaths = Object.keys(d.columns).map((k) => addr(r.id, k));
    const allLocked = allPaths.every((p) => locks[p]);
    const fields = Object.entries(d.columns).map(([k, f]) => {
      const path = addr(r.id, k);
      const v = k in r ? r[k] : defaultOf(f);
      const lock = locks[path];
      const touched = app.state.touched[path];
      const emit = (op: NestedOp) => patch([toOp(path, op)]);
      const w = isNested(f) ? nestedWidget(app, f, v, path, [], emit, { comp: '', field: k, holder: {} })
        : f.type === 'matrix' ? h('span', { class: 'muted' }, '行列（ages set で編集）')
        : widget(app, f, v, (nv, final) => { if (final) patch([{ op: 'set', path, value: nv }]); }, { comp: '', field: k, holder: {} }).el;
      if (lock) { w.setAttribute('inert', ''); w.classList.add('locked-value'); }
      return h('div', { class: `field ${isNested(f) ? 'wide' : ''} ${k in r ? '' : 'default'} ${touched ? 'touched' : ''} ${lock ? 'locked' : ''}` },
        h('label', { title: `${k}: ${typeOf(f)}${f.desc ? '\n' + f.desc : ''}${touched ? `\n★ ${touched.who} が ${time(touched.t)} に調整` : ''}` }, k), w,
        h('button', { class: `icon lockbtn ${lock ? 'on' : ''}`, title: lock ? `🔒 ロック中（${lock.who}）。クリックでロックマネージャーを開く（外す・値を変える）` : 'ロックする（外すのはロックマネージャーで）', onclick: () => (lock ? app.openLocks(path) : app.lock([path], 'table')) }, lock ? '🔒' : '🔓'));
    });
    clear(side,
      h('div', { class: 'pad', style: 'border-bottom:1px solid var(--line)' },
        h('div', { style: 'font-weight:600' }, `$${name}.${r.id}`),
        h('div', { class: 'row', style: 'gap:4px;margin-top:6px;flex-wrap:wrap' },
          h('button', { class: 'icon', title: '上へ', disabled: i === 0, onclick: () => patch([{ op: 'moveRow', table: name, id: r.id, to: i - 1 }]) }, '↑'),
          h('button', { class: 'icon', title: '下へ', disabled: i === rows().length - 1, onclick: () => patch([{ op: 'moveRow', table: name, id: r.id, to: i + 1 }]) }, '↓'),
          h('button', { onclick: () => duplicate(r), title: 'この行を複製して、すぐ下に置く' }, '複製'),
          h('button', { onclick: () => (allLocked ? app.openLocks(`$${name}.${r.id}`) : app.lock(allPaths.filter((p) => !locks[p]), 'table')), title: allLocked ? 'この行のロックを見る・外す（ロックマネージャーで）' : 'この行の値をまとめてロックする（外すのはロックマネージャーで）' }, allLocked ? '🔒 行のロック' : '🔒 行をロック'),
          h('button', { style: 'color:var(--bad)', onclick: () => { if (confirm(`$${name}.${r.id} を消しますか？`)) { selRow = ''; patch([{ op: 'removeRow', table: name, id: r.id }]); } } }, '消す'))),
      fields);
  };

  // ---------- 行の操作・CSV ----------
  const freshId = (base: string) => {
    const ids = new Set(rows().map((r) => r.id));
    let n = 1;
    while (ids.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  };
  const addRow = () => { const id = freshId(name.replace(/s$/, '') + '_'); selRow = id; patch([{ op: 'addRow', table: name, row: { id } }]); };
  const duplicate = (r: Row) => {
    const id = freshId(r.id.replace(/_?\d+$/, '') + '_');
    selRow = id;
    patch([{ op: 'addRow', table: name, row: { ...structuredClone(r), id }, index: rows().indexOf(r) + 1 }]);
  };
  const exportCsv = () => {
    const text = formatDelimited(tableToCells(def()!, rows()));
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })), download: `${name}.csv` }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importText = (text: string, file: string) => {
    let ops: Op[];
    try { ops = importOps(def()!, rows(), cellsToRows(def()!, parseDelimited(text))); } catch (e) { return toast((e as Error).message, 'bad', 8000); }
    if (!ops.length) return toast('読み込んだ内容は今の表と同じです');
    const count = (t: string) => ops.filter((o) => o.op === t).length;
    modal((close) => h('div', {},
      h('h3', {}, `${file} を $${name} に読み込みますか？`),
      h('div', {}, `行の追加 ${count('addRow')}・削除 ${count('removeRow')}・値の変更 ${count('set')}・並べ替え ${count('moveRow')}`),
      h('div', { class: 'muted', style: 'margin-top:6px' }, '表をまるごとファイルの内容にします（ファイルにない行は消えます）。操作ログに残り、あとから見直せます'),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, h('button', { onclick: close }, 'やめる'), h('button', { class: 'on', onclick: () => { close(); patch(ops); } }, '読み込む'))));
  };

  // ---------- 全体 ----------
  const body = h('div', { class: 'table-body' }, grid, side);
  let barEl = bar();
  const render = () => {
    barEl = bar();
    if (!def()) { clear(el, barEl, h('div', { class: 'pad muted' }, '表を選んでください。表はゲームのコードの defineTable で形を決め、中身は data/<名前>.table.json に入ります')); return; }
    clear(el, barEl, body);
    renderGrid();
    renderSide();
  };
  // 描き直しても、書いている途中のセルから入力の場所が飛ばないようにする
  app.on('change', () => {
    const td = (document.activeElement as HTMLElement | null)?.closest?.('.table-grid td[data-col]') as HTMLElement | null;
    const key = td ? [td.dataset.row, td.dataset.col] : null;
    render();
    if (key) (grid.querySelector(`td[data-row="${CSS.escape(key[0] ?? '')}"][data-col="${CSS.escape(key[1] ?? '')}"]`)?.querySelector('input,select') as HTMLElement | null)?.focus();
  });
  // リストを開く・閉じる（右の編集欄だけ描き直す）
  app.on('nestToggle', () => { if (el.isConnected) renderSide(); });
  app.on('settings', () => render());
  render();
  return { id: 'table', title: '表', el, fill: true, area: 'center', open, render };
}
