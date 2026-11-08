// ロックマネージャー（人だけが使う専用の画面）。エディタとは別のオリジンで開くので、エディタや拡張のコードからは操作できない。
// ロックを付ける・外す・ロックされた値を変える・ロックの記録を確かめるのは、ここからだけ。
// このファイルは単独で動く（エディタのコードを読み込まない）。

type Lock = { who: string; t: string; value: unknown; note?: string };
type Item = { path: string; kind: 'value' | 'sheet' | 'file'; value?: unknown; type?: string; problem?: string; lock?: Lock; asset?: { path: string; kind: string; bytes: number; w?: number; h?: number; sec?: number } };
type State = { items: Item[]; integrity: { ok: boolean; reason?: string; diff: { added: string[]; removed: string[]; changed: string[] }; hasBackup: boolean }; lockReport: string[]; project: string; version: number };

const params = new URLSearchParams(location.search);
let focus = params.get('focus') ?? '';
const userBox = document.getElementById('user') as HTMLInputElement;
userBox.value = params.get('user') || localStorage.getItem('ages.user') || 'human';
userBox.addEventListener('change', () => localStorage.setItem('ages.user', userBox.value.trim() || 'human'));
if (params.get('user')) localStorage.setItem('ages.user', userBox.value);

type Child = Node | string | null | undefined | false | Child[];
function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c: Child) => { if (Array.isArray(c)) c.forEach(add); else if (c !== null && c !== undefined && c !== false) el.append(c); };
  children.forEach(add);
  return el;
}
function toast(text: string, kind = ''): void {
  const t = h('div', { class: `toast ${kind}` }, text);
  document.getElementById('toasts')!.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 8000 : 4000);
}
async function api<T = unknown>(path: string, init: { body?: unknown; raw?: BodyInit } = {}): Promise<T> {
  const post = init.body !== undefined || init.raw !== undefined;
  const res = await fetch(path, {
    method: post ? 'POST' : 'GET',
    headers: { 'x-ages-user': encodeURIComponent(userBox.value.trim() || 'human'), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
  return data as T;
}
const act = async (fn: () => Promise<unknown>, ok: string) => {
  try { await fn(); toast(ok); await load(); } catch (e) { toast((e as Error).message, 'bad'); }
};

const time = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));
const groupOf = (p: string) => (p.startsWith('file:') ? 'ファイル' : p.startsWith('sheet:') ? '画像の切り方' : p.startsWith('$') ? '表' : p.startsWith('@') ? 'プレハブ' : 'シーン');

let state: State | null = null;
let filter = '';
const main = document.getElementById('main')!;

/** 値を変える欄（数・文字・真偽はその場で、ほかは JSON で） */
function editor(it: Item): HTMLElement {
  if (it.kind === 'file') {
    const a = it.asset;
    const pick = h('input', { type: 'file', style: 'display:none' }) as HTMLInputElement;
    pick.addEventListener('change', () => {
      const f = pick.files?.[0];
      if (f) act(() => api(`/api/replace?path=${encodeURIComponent(it.path.slice(5))}`, { raw: f }), `差し替えました: ${it.path.slice(5)}`);
    });
    return h('div', {},
      a?.kind === 'image' ? h('img', { src: `/project@${state?.version ?? 0}/${it.path.slice(5)}?t=${Date.now()}`, alt: '' }) : null,
      h('div', { class: 'muted' }, a ? [a.kind === 'image' ? `${a.w}×${a.h}` : a.sec !== undefined ? `${a.sec}秒` : '', `${(a.bytes / 1024).toFixed(1)}KB`].filter(Boolean).join('・') : ''),
      h('button', { onclick: () => pick.click(), title: '中身を別のファイルに差し替える（ロックはそのまま）' }, '差し替える'), pick);
  }
  const v = it.value;
  const save = (value: unknown) => act(() => api('/api/set', { body: { path: it.path, value } }), `変えました: ${it.path}`);
  if (typeof v === 'number' || typeof v === 'string') {
    const box = h('input', { type: 'text', value: String(v), style: 'width:100%' }) as HTMLInputElement;
    box.addEventListener('change', () => save(typeof v === 'number' ? Number(box.value) : box.value));
    return h('div', {}, box, it.type ? h('div', { class: 'meta' }, it.type) : null);
  }
  if (typeof v === 'boolean') {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = v;
    box.addEventListener('change', () => save(box.checked));
    return h('div', {}, box, it.type ? h('span', { class: 'meta' }, ' ' + it.type) : null);
  }
  const area = h('textarea', {}) as HTMLTextAreaElement;
  area.value = JSON.stringify(v, null, 1);
  const apply = h('button', { onclick: () => { try { save(JSON.parse(area.value)); } catch { toast('JSON として読めません', 'bad'); } } }, '変える');
  return h('div', {}, area, h('div', { class: 'row' }, apply, it.type ? h('span', { class: 'meta' }, it.type) : null));
}

function render(): void {
  if (!state) return;
  const s = state;
  document.getElementById('project')!.textContent = s.project;
  const items = s.items.filter((i) => !filter || i.path.toLowerCase().includes(filter.toLowerCase()) || (i.lock?.note ?? '').includes(filter));
  const g = s.integrity;
  const list = (title: string, xs: string[]) => (xs.length ? h('div', {}, h('div', { class: 'muted' }, `${title}（${xs.length}）`), xs.map((x) => h('div', { class: 'mono', style: 'padding-left:12px' }, x))) : null);
  const integrity = g.ok ? null : h('div', { class: 'card warn' },
    h('h2', {}, '🔒⚠ ロックの記録を確認してください'),
    h('div', {}, g.reason ?? ''),
    h('div', { class: 'muted' }, 'AI からの編集はすべて止まっています。最後にあなたが封印したロックは、確認するまで引き続き有効です。'),
    list('消されたロック', g.diff.removed), list('増えたロック', g.diff.added), list('値が変わったロック', g.diff.changed),
    h('div', { class: 'row', style: 'margin-top:10px;justify-content:flex-end' },
      g.hasBackup ? h('button', { onclick: () => act(() => api('/api/restore', { body: {} }), '前の状態に戻しました') }, '前の状態に戻す') : null,
      h('button', { class: 'primary', onclick: () => act(() => api('/api/approve', { body: {} }), '今の記録を承認しました') }, 'この内容で承認する')));
  const report = s.lockReport.filter((l) => !l.startsWith('⚠'));
  // 付ける
  const pathBox = h('input', { type: 'text', placeholder: '住所（例 main#player.Player.speed / $enemies.basic.hp / sheet:assets/x.png / file:assets/x.png）', style: 'flex:1', list: 'cands' }) as HTMLInputElement;
  const note = h('input', { type: 'text', placeholder: '理由（任意。AI にも見えます）', style: 'width:220px' }) as HTMLInputElement;
  const cands = h('datalist', { id: 'cands' });
  const preview = h('div', { class: 'muted mono', style: 'margin-top:6px;min-height:1.4em' });
  const bulk = h('div', { style: 'margin-top:4px' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const look = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = pathBox.value.trim();
      const list = await api<string[]>(`/api/candidates?q=${encodeURIComponent(q)}`).catch(() => [] as string[]);
      cands.replaceChildren(...list.map((c) => h('option', { value: c })));
      if (!q) return void (preview.textContent = '');
      const d = await api<Item>(`/api/describe?path=${encodeURIComponent(q)}`).catch(() => null);
      // 値でなく、物・行などのまとまりなら、中の値をまとめてロックできる
      const inside = list.filter((c) => c.startsWith(q + '.') && !s.items.some((i) => i.path === c));
      bulk.replaceChildren(d?.problem && inside.length ? h('button', { onclick: () => act(() => api('/api/lock', { body: { paths: inside, note: note.value.trim() || undefined } }), `🔒 ${inside.length}件ロックしました`) }, `この中の値をまとめてロック（${inside.length}件: ${inside.slice(0, 3).map((c) => c.slice(q.length + 1)).join(', ')}${inside.length > 3 ? ' …' : ''}）`) : '');
      preview.textContent = !d ? '' : d.problem ? (inside.length ? '' : `⚠ ${d.problem}`) : d.lock ? '🔒 すでにロックされています（下の一覧）' : d.kind === 'file' ? `ファイル ${d.asset?.bytes ?? 0} bytes（中身の控えをこの端末に取ります）` : `今の値: ${show(d.value)}${d.type ? `  （${d.type}）` : ''}`;
    }, 120);
  };
  pathBox.addEventListener('input', look);
  const lockIt = () => {
    const path = pathBox.value.trim();
    if (!path) return;
    act(() => api('/api/lock', { body: { paths: [path], note: note.value.trim() || undefined } }), `🔒 ロックしました: ${path}`).then(() => { focus = path; });
  };
  pathBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') lockIt(); });
  const focused = focus && s.items.some((i) => i.path === focus);
  if (focus && !focused) { pathBox.value = focus; look(); }
  const add = h('div', { class: 'card' },
    h('h2', {}, 'ロックを付ける'),
    h('div', { class: 'row' }, pathBox, note, h('button', { class: 'primary', onclick: lockIt }, '🔒 付ける')), cands, preview, bulk,
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'ロックした値は、AI・独自のウインドウ・エディタのどこからも変えられません（この画面からだけ）。ファイルのロックは、差し替え・移動・削除を止め、書き換えられたらこの端末の控えから戻します。'));
  // 一覧
  const groups = new Map<string, Item[]>();
  for (const it of items) groups.set(groupOf(it.path), [...(groups.get(groupOf(it.path)) ?? []), it]);
  const filterBox = h('input', { type: 'search', placeholder: '🔍 住所・理由で絞る', value: filter, style: 'width:240px' }) as HTMLInputElement;
  filterBox.addEventListener('input', () => { filter = filterBox.value; render(); filterBox.focus(); });
  const rows = [...groups].map(([g2, its]) => [
    h('div', { class: 'group' }, `${g2}（${its.length}）`),
    its.map((it) => h('div', { class: `item${it.path === focus ? ' focus' : ''}`, id: `item-${it.path}` },
      h('div', {}, h('div', { class: 'path' }, it.path),
        h('div', { class: 'meta' }, `${it.lock?.who ?? ''} ${it.lock ? time(it.lock.t) : ''}${it.lock?.note ? `  理由: ${it.lock.note}` : ''}`),
        it.problem ? h('div', { class: 'problem' }, `⚠ ${it.problem}`) : null),
      editor(it),
      h('div', {}, h('button', { class: 'danger', onclick: () => { if (confirm(`${it.path} のロックを外しますか？\n外すと AI も変えられるようになります。`)) act(() => api('/api/unlock', { body: { paths: [it.path] } }), `ロックを外しました: ${it.path}`); } }, '外す')))),
  ]);
  main.replaceChildren(
    integrity ?? h('span'),
    report.length ? h('div', { class: 'card' }, h('h2', {}, '直したこと'), report.map((r) => h('div', { class: 'muted' }, r))) : h('span'),
    add,
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0;flex:1' }, `ロック ${s.items.length}件`), filterBox), rows.length ? rows : h('div', { class: 'muted', style: 'padding:8px' }, filter ? '見つかりません' : 'まだロックはありません')));
  if (focused) document.getElementById(`item-${focus}`)?.scrollIntoView({ block: 'center' });
}

async function load(): Promise<void> {
  try {
    state = await api<State>('/api/state');
    render();
  } catch (e) {
    main.replaceChildren(h('div', { class: 'card warn' }, `読み込めません: ${(e as Error).message}`));
  }
}

// エディタの 🔒 から開き直されたとき（同じ名前のウインドウ）は、場所が変わる
window.addEventListener('focus', () => {
  const f = new URLSearchParams(location.search).get('focus') ?? '';
  if (f && f !== focus) { focus = f; render(); }
});
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
new EventSource('/api/events').onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.type === 'hello') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 150);
};
await load();
