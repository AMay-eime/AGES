// 行列エディタ。インスペクタの「開く」から開く。タブとして好きな場所に置けるほか、別のブラウザウインドウにも出せる。
// 表計算ソフトからのコピー＆ペースト（タブ区切り）に対応。数値セルは値に応じて色が付く。
import type { App } from '../app.ts';
import type { MatrixField, CellValue } from '../../core/schema.ts';
import { checkValue, matrixSize } from '../../core/schema.ts';
import { parseAddress } from '../../core/docs.ts';
import type { Op } from '../../core/patch.ts';
import { h, clear, toast, time } from './dom.ts';
import type { Panel } from './layout.ts';
import { T } from '../i18n.ts';

export function matrixPanel(app: App): Panel & { open(path: string): void } {
  const el = h('div', {});
  let path = '';
  let original: CellValue[][] = [];
  let draft: CellValue[][] = [];
  let dirty = false;
  // 全体を描き直さずに更新する部分
  let saveBtn: HTMLButtonElement | null = null;
  let revertBtn: HTMLButtonElement | null = null;
  let errBox: HTMLElement | null = null;
  const status = () => {
    const f = fieldOf();
    if (saveBtn) { saveBtn.disabled = !dirty || !!app.play; saveBtn.className = dirty ? 'on' : ''; saveBtn.textContent = dirty ? T('保存 ●') : T('保存'); }
    if (revertBtn) revertBtn.disabled = !dirty;
    if (errBox && f) {
      const a = parseAddress(path);
      const err = checkValue(a.component!, a.field!, f, draft);
      errBox.textContent = err ? '⚠ ' + err : '';
      errBox.style.display = err ? '' : 'none';
    }
  };

  const fieldOf = (): MatrixField | null => {
    if (!path || !app.registry) return null;
    const a = parseAddress(path);
    const f = app.registry.components.get(a.component!)?.fields[a.field!];
    return f?.type === 'matrix' ? f : null;
  };

  const current = (): CellValue[][] | null => {
    const a = parseAddress(path);
    const holder = a.kind === 'prefab' ? app.state.prefabs[a.doc] : app.sceneView(a.doc)?.entities.find((e) => e.id === a.entity);
    const comp = holder?.components[a.component!];
    if (!comp) return null;
    const f = fieldOf();
    return structuredClone((a.field! in comp ? comp[a.field!] : f?.default ?? []) as CellValue[][]);
  };

  const load = () => {
    const v = current();
    original = v ?? [];
    draft = structuredClone(original);
    dirty = false;
  };

  const save = async () => {
    const f = fieldOf();
    if (!f || !dirty) return;
    const err = checkValue(parseAddress(path).component!, parseAddress(path).field!, f, draft);
    if (err) return toast(err, 'bad', 6000);
    const sameSize = draft.length === original.length && draft.every((row, r) => row.length === original[r]?.length);
    let ops: Op[];
    if (sameSize) {
      const cells: [number, number, CellValue][] = [];
      draft.forEach((row, r) => row.forEach((v, c) => { if (v !== original[r][c]) cells.push([r, c, v]); }));
      ops = cells.length ? [{ op: 'setCells', path, cells }] : [];
    } else {
      ops = [{ op: 'set', path, value: draft }];
    }
    if (!ops.length) { dirty = false; return render(); }
    const r = await app.patch(ops, 'matrix');
    if (r) { load(); render(); toast(T('保存しました（{0}か所）', r.length)); }
  };

  const render = () => {
    if (!path) return clear(el, h('div', { class: 'pad muted' }, T('インスペクタで行列のパラメータの「開く」を押すと、ここで確認・編集できます。')));
    const f = fieldOf();
    if (!f) return clear(el, h('div', { class: 'pad muted' }, T('{0} は行列ではありません', path)));
    const lock = app.state.locks[path];
    const readonly = !!app.play;
    const fixedRows = f.rows !== undefined;
    const fixedCols = f.cols !== undefined;
    const cell = f.cell ?? 'number';
    const blank = (): CellValue => (cell === 'bool' ? false : cell === 'string' ? '' : Math.max(0, f.min ?? 0));
    const cols = draft[0]?.length ?? 0;

    const resize = (dr: number, dc: number) => {
      if (dr > 0) draft.push(Array.from({ length: f.cols ?? Math.max(cols, 1) }, blank));
      if (dr < 0 && draft.length) draft.pop();
      if (dc > 0) { if (!draft.length) draft.push([]); draft.forEach((row) => row.push(blank())); }
      if (dc < 0) draft.forEach((row) => row.pop());
      if (draft.length && draft.every((row) => row.length === 0)) draft = [];
      dirty = true;
      render();
    };

    const heat = (v: CellValue) => {
      if (typeof v !== 'number' || f.min === undefined || f.max === undefined || f.max === f.min) return '';
      const t = Math.max(0, Math.min(1, (v - f.min) / (f.max - f.min)));
      return `background:hsla(${210 - t * 200},70%,${18 + t * 22}%,1)`;
    };

    const inputs: HTMLElement[][] = [];
    const move = (r: number, c: number) => {
      const target = inputs[r]?.[c];
      if (target) { target.focus(); if (target instanceof HTMLInputElement && target.type !== 'checkbox') target.select(); }
    };

    const table = h('table', { class: 'matrix' },
      h('tr', {}, h('th', {}), Array.from({ length: cols }, (_, c) => h('th', {}, c))),
      draft.map((row, r) => {
        inputs[r] = [];
        return h('tr', {}, h('th', {}, r), row.map((v, c) => {
          const changed = original[r]?.[c] !== v;
          let input: HTMLInputElement;
          const td = h('td', { class: changed ? 'changed' : '' });
          const touch = () => {
            dirty = true;
            td.classList.toggle('changed', original[r]?.[c] !== draft[r][c]);
            status();
          };
          if (cell === 'bool') {
            input = h('input', { type: 'checkbox', checked: !!v, disabled: readonly }) as HTMLInputElement;
            input.addEventListener('change', () => { draft[r][c] = input.checked; touch(); });
          } else {
            input = h('input', { type: 'text', value: String(v), disabled: readonly, style: heat(v) }) as HTMLInputElement;
            input.addEventListener('change', () => {
              const t = input.value.trim();
              draft[r][c] = cell === 'string' ? input.value : t === '' || Number.isNaN(Number(t)) ? t : Number(t);
              input.setAttribute('style', heat(draft[r][c]));
              touch();
            });
          }
          input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); input.dispatchEvent(new Event('change')); move(r + 1, c); }
            if (e.key === 'ArrowUp') { e.preventDefault(); input.dispatchEvent(new Event('change')); move(r - 1, c); }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); input.dispatchEvent(new Event('change')); save(); }
          });
          // 表計算ソフトからの貼り付け（タブ区切り・カンマ区切り）
          input.addEventListener('paste', (e) => {
            const text = e.clipboardData?.getData('text') ?? '';
            if (!/[\t\n,]/.test(text.trim())) return;
            e.preventDefault();
            const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split(line.includes('\t') ? '\t' : ','));
            rows.forEach((vals, i) => vals.forEach((s, j) => {
              const rr = r + i, cc = c + j;
              if (!fixedRows) while (draft.length <= rr) draft.push(Array.from({ length: f.cols ?? draft[0]?.length ?? cc + 1 }, blank));
              if (!fixedCols && cc >= (draft[0]?.length ?? 0)) draft.forEach((row2) => { while (row2.length <= cc) row2.push(blank()); });
              if (!draft[rr] || cc >= draft[rr].length) return;
              const t = s.trim();
              draft[rr][cc] = cell === 'bool' ? t === 'true' || t === '1' : cell === 'string' ? t : Number(t);
            }));
            dirty = true;
            render();
            toast(T('{0}行を貼り付けました', rows.length));
          });
          inputs[r][c] = input;
          td.append(input);
          return td;
        }));
      }));

    const popout = () => window.open(`/?solo=matrix&path=${encodeURIComponent(path)}`, `ages-matrix-${path}`, 'width=900,height=640');
    revertBtn = h('button', { onclick: () => { load(); render(); } }, T('元に戻す')) as HTMLButtonElement;
    saveBtn = h('button', { onclick: save, title: 'Ctrl+S' }, T('保存')) as HTMLButtonElement;
    errBox = h('div', { class: 'issues' });
    clear(el,
      h('div', { class: 'toolbar' },
        h('span', { style: 'font:var(--mono)' }, path),
        h('span', { class: 'muted' }, T('{0} {1}{2}{3}', matrixSize(draft), cell, f.min !== undefined || f.max !== undefined ? ` ${f.min ?? ''}..${f.max ?? ''}` : '', fixedRows && fixedCols ? T('（大きさ固定）') : fixedRows ? T('（行数固定）') : fixedCols ? T('（列数固定）') : '')),
        lock ? h('span', { style: 'color:var(--lock)', title: `${lock.who} ${time(lock.t)}` }, T('🔒 ロック中（AIは変更不可）')) : null,
        h('span', { style: 'flex:1' }),
        !readonly && !fixedRows ? [h('button', { onclick: () => resize(1, 0), title: T('行を追加') }, T('＋行')), h('button', { onclick: () => resize(-1, 0), title: T('最後の行を削除') }, T('−行'))] : null,
        !readonly && !fixedCols ? [h('button', { onclick: () => resize(0, 1), title: T('列を追加') }, T('＋列')), h('button', { onclick: () => resize(0, -1), title: T('最後の列を削除') }, T('−列'))] : null,
        revertBtn,
        saveBtn,
        new URLSearchParams(location.search).get('solo') ? null : h('button', { class: 'icon', title: T('別のウインドウで開く'), onclick: popout }, '↗')),
      readonly ? h('div', { class: 'pad muted' }, T('再生中は表示のみです。停止すると編集できます。')) : null,
      errBox,
      h('div', { class: 'pad', style: 'overflow:auto' }, draft.length ? table : h('div', { class: 'muted' }, T('空の行列です。＋行・＋列で作るか、表計算ソフトから貼り付けてください。'))),
      h('div', { class: 'pad muted', style: 'font-size:12px' }, T('↑↓・Enterで上下に移動、Tabで右へ。表計算ソフトからコピーしたセル範囲は、そのまま貼り付けられます。')));
    status();
  };

  app.on('change', () => {
    if (!path) return;
    if (!dirty) { load(); render(); } else status();
  });
  app.on('play', render);

  return {
    id: 'matrix', title: T('行列'), el, render,
    open(p: string) {
      if (dirty && path !== p && !confirm(T('{0} の未保存の変更を捨てて {1} を開きますか？', path, p))) return;
      path = p;
      load();
      render();
    },
  };
}
