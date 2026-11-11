// AGES エディタの起動。
import { App } from './app.ts';
import { Layout, type LayoutData, type Panel } from './ui/layout.ts';
import { h, clear, toast, modal } from './ui/dom.ts';
import { inspectorPanel } from './ui/inspector.ts';
import { hierarchyPanel, projectPanel, textPanel, logPanel, gitPanel, exportPanel } from './ui/panels.ts';
import { gamePanel } from './ui/game.ts';
import { matrixPanel } from './ui/matrix.ts';
import { spritePanel } from './ui/sprite.ts';
import { tablePanel } from './ui/table.ts';
import { assetsPanel } from './ui/assets.ts';
import { builtinExtensions, projectExtension, type LoadedExtension } from './extensions.ts';
import { duplicateOps, nudgeOps, removeOps } from './edit-ops.ts';
import { EDITOR_LANGS, LANG_NAMES, T, lang, setLang, type EditorLang } from './i18n.ts';

const app = new App();
(window as unknown as { ages: App }).ages = app; // デバッグ・AIのブラウザ操作用

await app.refresh();

// 別ウインドウで1つのパネルだけを開く（例: /?solo=matrix&path=main%23spawner.Spawner.formation）
const params = new URLSearchParams(location.search);
const solo = params.get('solo');
if (solo === 'win') {
  // 拡張のパネルだけを別ウインドウで（/?solo=win&id=<拡張の id>）
  document.body.classList.add('solo');
  const id = params.get('id') ?? '';
  const loaded = await loadExtensions();
  const x = loaded.find((e) => e.ext.id === id && e.ext.panel);
  const el = h('div', { class: 'panel active ext-panel', style: 'overflow:auto' });
  document.getElementById('work')!.replaceChildren(el);
  const title = x?.ext.panel?.title ?? x?.ext.title ?? id;
  document.title = `${title} — AGES`;
  const top = document.getElementById('top')!;
  top.replaceChildren(h('span', { class: 'title' }, 'AGES', h('small', {}, title)));
  if (!x) el.append(h('div', { class: 'pad', style: 'color:var(--bad)' }, T('拡張 {0} のパネルがありません', id)));
  else {
    try { x.ext.panel!.mount(el, x.api); } catch (e) { el.append(h('div', { class: 'pad', style: 'color:var(--bad)' }, T('エラー: {0}', (e as Error).message))); }
  }
  new EventSource('/api/events').onmessage = (msg) => { if (JSON.parse(msg.data).type !== 'hello') app.refresh(); };
} else if (solo === 'matrix' || solo === 'sprite' || solo === 'table') {
  document.body.classList.add('solo');
  // 表の行・欄の見せ方（拡張）も効くように、拡張を読む
  if (solo === 'table') await loadExtensions();
  const m = solo === 'matrix' ? matrixPanel(app) : solo === 'sprite' ? spritePanel(app) : tablePanel(app);
  m.el.classList.add('panel', 'active');
  document.getElementById('work')!.replaceChildren(m.el);
  const target = (solo === 'matrix' ? params.get('path') : solo === 'sprite' ? params.get('image') : params.get('name')) ?? '';
  m.open(target);
  document.title = T('{0} {1} — AGES', solo === 'matrix' ? T('行列') : solo === 'sprite' ? T('切り方') : T('表'), target);
  const top = document.getElementById('top')!;
  const user = h('input', { type: 'text', value: app.user, style: 'width:110px', title: T('操作ログに残るあなたの名前') }) as HTMLInputElement;
  user.addEventListener('change', () => app.setUser(user.value));
  top.replaceChildren(h('span', { class: 'title' }, 'AGES', h('small', {}, solo === 'matrix' ? T('行列エディタ') : solo === 'sprite' ? T('切り方') : T('表'))), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, T('名前')), user);
  new EventSource('/api/events').onmessage = (msg) => { if (JSON.parse(msg.data).type !== 'hello') app.refresh(); };
} else {
  await startEditor();
}

/** 通常のエディタ（全パネルとレイアウト） */
async function startEditor(): Promise<void> {
/** エディタで人が見ている所を知らせる間合い（sendFocus） */
let focusTimer: ReturnType<typeof setTimeout> | undefined;
const savedLayout = await app.api<LayoutData | null>('/api/layout').catch(() => null);
let saveTimer: ReturnType<typeof setTimeout>;
const layout = new Layout(document.getElementById('work')!, savedLayout, (d) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => app.api('/api/layout', { method: 'PUT', raw: JSON.stringify(d, null, 2) + '\n' }).catch(() => {}), 300);
  // 見えている窓が変わった（エディタで人が見ている所）
  sendFocus();
});

const text = textPanel(app, () => layout);
const game = gamePanel(app);
const matrix = matrixPanel(app);
const sprite = spritePanel(app);
const table = tablePanel(app);
const assets = assetsPanel(app);
for (const p of [hierarchyPanel(app), projectPanel(app, (path) => text.open(path)), game, matrix, sprite, table, text, assets, logPanel(app), gitPanel(app), exportPanel(app), inspectorPanel(app)]) layout.add(p);
app.on('openText', (path) => text.open(String(path)));

// エディタで人が見ている所を、AI の地図に出すために知らせる（選びが変わったら少し待って、開いている間は1分ごと。閉じたら消す）
const focusNow = () => ({
  scene: app.scene,
  selected: app.sel?.kind === 'prefab' ? [`@${app.sel.name}`] : app.selectedIds().map((id) => `${app.scene}#${id}`),
  ...(app.row ? { row: `$${app.row.table}.${app.row.id}` } : {}),
  ...(layout.isVisible('table') && table.current() ? { table: table.current() } : {}),
  windows: [...layout.panels.values()].filter((p) => p.id.startsWith('win:') && layout.isVisible(p.id)).map((p) => ({ id: p.id.slice(4), title: p.title })),
});
function sendFocus(): void {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { app.api('/api/focus', { body: focusNow() }).catch(() => {}); }, 400);
}
app.on('select', sendFocus);
app.on('change', sendFocus);
app.on('openTable', sendFocus);
setInterval(() => { if (document.visibilityState === 'visible') sendFocus(); }, 60_000);
window.addEventListener('pagehide', () => { navigator.sendBeacon('/api/focus', new Blob([JSON.stringify({ closed: true })], { type: 'application/json' })); });
app.on('revealAsset', (path) => { layout.show('assets'); assets.reveal(path as string); });
app.on('openMatrix', (path) => { matrix.open(path as string); layout.show('matrix'); });
app.on('openSprite', (image) => { sprite.open(image as string); layout.show('sprite'); sprite.render?.(); });
app.on('openTable', (t) => { const { name, row } = t as { name: string; row?: string }; table.open(name, row); layout.show('table'); });
app.on('showPanel', (id) => layout.show(String(id)));
(window as unknown as { agesLayout: Layout }).agesLayout = layout; // デバッグ・確かめ用（タブの開け閉め・別のウインドウ）

// ---------- 上のバー ----------
const top = document.getElementById('top')!;
const renderTop = () => {
  const s = app.state;
  const p = app.play;
  const userInput = h('input', { type: 'text', value: app.user, title: T('操作ログに残るあなたの名前'), style: 'width:110px' }) as HTMLInputElement;
  userInput.addEventListener('change', () => { app.setUser(userInput.value); toast(T('名前: {0}', app.user)); });
  const locks = s && !s.error ? Object.keys(s.locks).length : 0;
  const broken = s && !s.error && s.integrity && !s.integrity.ok;
  clear(top,
    h('span', { class: 'title' }, 'AGES', h('small', {}, s?.config?.name ?? '')),
    h('button', { class: p && !p.paused ? 'on' : '', title: playTitle(), onclick: () => (p ? app.togglePause() : app.startPlay()) }, p && !p.paused ? T('⏸ 一時停止') : T('▶ 再生')),
    h('button', { class: playSet() ? 'icon on' : 'icon', title: T('再生の設定（始めのシーンに渡す params・日時）{0}', playSet() ? `\n${playSet()}` : ''), onclick: openPlaySettings, disabled: !!p }, '…'),
    h('button', { title: T('1フレーム進める'), onclick: () => app.stepOnce() }, '⏭'),
    speedSelect(),
    h('button', { title: T('停止（実行中の変更を保存するか選べます）'), onclick: () => app.stopPlay(), disabled: !p }, T('⏹ 停止')),
    h('button', { title: T('入力を記録しながら再生（停止時に recordings/ に保存）'), onclick: () => app.startPlay(true), disabled: !!p }, T('● 記録して再生')),
    h('button', { class: 'icon', title: app.undoInfo.undo ? T('元に戻す（Ctrl+Z）: {0}', app.undoInfo.undo.label) : T('元に戻せる編集はありません'), disabled: !app.undoInfo.undo || !!p, onclick: () => app.undo() }, '↶'),
    h('button', { class: 'icon', title: app.undoInfo.redo ? T('やり直す（Ctrl+Shift+Z）: {0}', app.undoInfo.redo.label) : T('やり直せる編集はありません'), disabled: !app.undoInfo.redo || !!p, onclick: () => app.undo(true) }, '↷'),
    h('span', { class: 'spacer' }),
    audioControls(),
    broken ? h('button', { style: 'border-color:var(--bad);color:var(--bad)', onclick: () => app.openLocks(), title: T('{0}\nロックマネージャーで確かめます', s.integrity.reason) }, T('🔒⚠ ロックの記録を確認')) : null,
    h('span', { class: 'status' }, s?.error ? `⚠ ${s.error}` : `${s.issues.length ? `⚠${s.issues.length} ` : ''}`, s?.error ? null : h('a', { style: 'cursor:pointer', title: T('ロックマネージャーを開く（ロックの一覧・付ける・外す）'), onclick: () => app.openLocks() }, `🔒${locks}`), s?.error ? '' : `  v${s.version}`),
    h('button', { class: 'icon', title: T('設定'), onclick: openSettings }, '⚙'),
    h('span', { class: 'muted' }, T('名前')), userInput);
};
app.on('change', renderTop);
app.on('play', renderTop);
app.on('audio', renderTop);

/** 再生の速さ（拡張の api.speed と同じ） */
function speedSelect(): HTMLElement {
  const sel = h('select', { title: T('再生の速さ'), style: 'width:auto' }, [0.25, 0.5, 1, 2, 4].map((v) => h('option', { value: String(v), selected: v === app.playSpeed }, `×${v}`))) as HTMLSelectElement;
  if (![0.25, 0.5, 1, 2, 4].includes(app.playSpeed)) sel.prepend(h('option', { value: String(app.playSpeed), selected: true }, `×${app.playSpeed}`));
  sel.addEventListener('change', () => { app.playSpeed = Number(sel.value); });
  return sel;
}

/** 再生の設定の要約（何も決めていなければ ''） */
function playSet(): string {
  if (!app.state || app.state.error) return '';
  const s = app.playSettings;
  return [s.params.trim() ? `params: ${s.params.trim()}` : '', s.date.trim() ? T('日時: {0}', s.date.trim()) : ''].filter(Boolean).join(' / ');
}
function playTitle(): string {
  return T('再生{0}', playSet() ? T('（{0}）', playSet()) : '');
}

/** 再生の設定: 始めのシーンに渡す params（ages run --params と同じ書き方）と日時（ctx.date。空なら実際の時計） */
function openPlaySettings(): void {
  modal((close) => {
    const s = app.playSettings;
    const params = h('input', { type: 'text', value: s.params, placeholder: T('stage=stage_0001,mode=test か JSON'), style: 'flex:1' }) as HTMLInputElement;
    const date = h('input', { type: 'text', value: s.date, placeholder: T('空なら実際の時計（例 2026-12-25T09:00）'), style: 'flex:1' }) as HTMLInputElement;
    const save = () => {
      try { app.playSettings = { params: params.value.trim(), date: date.value.trim() }; close(); renderTop(); } catch (e) { toast((e as Error).message, 'bad'); }
    };
    return h('div', { style: 'min-width:420px' },
      h('h3', {}, T('再生の設定')),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, T('▶ で再生するときに、始めのシーンへ渡すもの（ctx.scene.params）と日時（ctx.date）。このブラウザに覚えます。記録して再生すると、記録にも残ります')),
      h('div', { class: 'row' }, h('span', { style: 'width:4em' }, 'params'), params),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { style: 'width:4em' }, T('日時')), date),
      h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' },
        h('button', { onclick: () => { params.value = ''; date.value = ''; } }, T('空にする')),
        h('button', { onclick: close }, T('やめる')),
        h('button', { class: 'primary', onclick: save }, 'OK')));
  });
}

/** 手元の音量とミュート（このブラウザだけ。ゲームの音量は音量の区分 AudioBus で決める） */
function audioControls(): HTMLElement {
  const l = app.localAudio;
  const range = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(l.volume), style: 'width:70px', title: T('手元の音量 {0}%（このブラウザだけ。ゲームの音量は音量の区分 AudioBus で決めます）', Math.round(l.volume * 100)) }) as HTMLInputElement;
  range.addEventListener('input', () => app.setLocalAudio(Number(range.value), false));
  return h('span', { class: 'row', style: 'gap:2px' },
    h('button', { class: 'icon', title: l.muted ? T('ミュート中（クリックで解除）') : T('音を消す'), onclick: () => app.setLocalAudio(l.volume, !l.muted) }, l.muted ? '🔇' : '🔊'),
    range);
}

// 音のファイルが書き換わったら読み直す
let soundTimes = new Map<string, number>();
app.on('change', () => {
  const next = new Map((app.state?.files ?? []).filter((f) => /\.(wav|mp3|ogg|m4a)$/i.test(f.path)).map((f) => [f.path, f.mtime]));
  for (const [p, m] of next) if (soundTimes.has(p) && soundTimes.get(p) !== m) app.audio.invalidate(p);
  soundTimes = next;
});

/** 設定（人ごとにブラウザに記憶する） */
function openSettings(): void {
  modal((close) => {
    const show = h('input', { type: 'checkbox', checked: app.showLocked, onchange: (e: Event) => { app.showLocked = (e.target as HTMLInputElement).checked; } });
    // エディタの言葉（変えると読み込み直す）。作るゲームの言語は、ゲームの画面の「言語」で
    const langSel = h('select', { onchange: (e: Event) => setLang((e.target as HTMLSelectElement).value as EditorLang) },
      ...EDITOR_LANGS.map((l) => h('option', { value: l, selected: l === lang }, LANG_NAMES[l]))) as HTMLSelectElement;
    return h('div', {},
      h('h3', {}, T('設定')),
      h('label', { class: 'row' }, T('エディタの言葉'), ' ', langSel),
      h('label', { class: 'row' }, show, T('ロックされた値を表示する（インスペクタ・表。表示しても、ここでは変えられません）')),
      h('div', { class: 'muted', style: 'margin:8px 0' }, T('ロックを付ける・外す・ロックされた値を変えるのは、ロックマネージャーで。')),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:12px' },
        h('button', { onclick: () => { close(); app.openLocks(); } }, T('🔒 ロックマネージャーを開く')),
        h('button', { onclick: close }, T('閉じる'))));
  });
}

// ---------- キー入力（再生中だけゲームへ。マウス・タッチはゲームの画面がつなぐ） ----------
const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
/** 拡張のパネルの中のキー（パネルが自分で使う。本体のシーンの編集のキーは動かさない） */
const inExtension = (e: KeyboardEvent) => !!(e.target as HTMLElement)?.closest?.('.ext-panel');
app.devices.enabled = () => !!app.play;
app.devices.bindKeyboard(window, typing);
// 元に戻す・やり直す（文字を入力している欄では、その欄の中の取り消しを優先する）
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || typing(e) || (e.target as HTMLElement)?.isContentEditable || app.play) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); app.undo(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); app.undo(true); }
});
// シーンの編集: 複製（Ctrl+D）・削除（Delete）・すべて選ぶ（Ctrl+A）・選ぶのをやめる（Esc）・矢印で1px（Shift で格子の目か 10px）ずらす・取っ手の切り替え（W・E・R）
window.addEventListener('keydown', (e) => {
  if (typing(e) || inExtension(e) || (e.target as HTMLElement)?.isContentEditable || app.play || document.querySelector('.modal-bg')) return;
  const scene = app.state.scenes[app.scene];
  const ids = app.selectedIds();
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'a' && scene) { e.preventDefault(); app.selectMany(scene.entities.map((x) => x.id)); return; }
  if (e.key === 'Escape' && app.sel) { app.select(null); return; }
  // 取っ手の切り替え（Unity と同じ W・E・R）
  if (!mod && !e.altKey && !e.shiftKey && (k === 'w' || k === 'e' || k === 'r')) { app.setTool(k === 'w' ? 'move' : k === 'e' ? 'rotate' : 'scale'); return; }
  if (!scene || !ids.length) return;
  if (mod && k === 'd') {
    e.preventDefault();
    const r = duplicateOps(scene, ids, 16, new Map(Object.entries(app.state.prefabs)));
    void app.patch(r.ops, 'hierarchy').then((ok) => { if (ok) app.selectMany(r.ids); });
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
    e.preventDefault();
    if (confirm(ids.length > 1 ? T('{0}体を削除しますか？（{1}）', ids.length, ids.join(', ')) : T('{0}#{1} を削除しますか？', app.scene, ids[0]))) void app.patch(removeOps(app.scene, ids), 'hierarchy').then((ok) => { if (ok) app.select(null); });
  } else if (e.key.startsWith('Arrow') && !mod) {
    e.preventDefault();
    const step = e.shiftKey ? app.snap() || 10 : 1;
    const [dx, dy] = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, -step] : [0, step];
    const ops = nudgeOps(app.sceneView(app.scene) ?? scene, ids, dx, dy);
    if (ops.length) void app.patch(ops, 'game');
  }
});

// ---------- エディタ拡張（本体の拡張と、プロジェクトの editor/*.window.ts・*.ext.ts） ----------
const panels = new Map<string, { el: HTMLElement; cleanup?: () => void }>();
async function mountWindows(): Promise<void> {
  for (const w of panels.values()) { try { w.cleanup?.(); } catch (e) { console.error(e); } w.cleanup = undefined; }
  const loaded = await loadExtensions();
  // パネル（Unity の EditorWindow）
  for (const x of loaded) {
    const p = x.ext.panel;
    if (!p) continue;
    const id = `win:${x.ext.id}`;
    let slot = panels.get(id);
    if (!slot) {
      slot = { el: h('div', { class: 'ext-panel' }) };
      panels.set(id, slot);
      const panel: Panel = { id, title: p.title ?? x.ext.title ?? x.ext.id, el: slot.el, ...(p.area ? { area: p.area } : {}) };
      layout.add(panel);
    }
    slot.el.replaceChildren();
    try {
      slot.cleanup = p.mount(slot.el, x.api) ?? undefined;
    } catch (e) {
      slot.el.append(h('div', { class: 'pad', style: 'color:var(--bad)' }, T('エラー: {0}', (e as Error).message)));
    }
  }
  // 欄・部品の見せ方は、インスペクタが描き直すときに使う
  app.emit('extensions');
}

// ---------- サーバーからの通知 ----------
let lastVersion = app.state.version;
const events = new EventSource('/api/events');
events.onmessage = async (msg) => {
  const ev = JSON.parse(msg.data);
  if (ev.type === 'hello') return;
  await app.refresh();
  if (ev.type === 'docs' && ev.by === 'external') {
    const n = ev.changes?.length ?? 0;
    if (n) toast(T('外部でファイルが編集されました（{0}件の変更）', n));
    if (ev.lockReport?.length) toast(ev.lockReport.map((l: string) => '🔒 ' + l).join('\n'), 'lock', 8000);
  }
  if (ev.type === 'locks' && ev.integrity === false) {
    toast(T('🔒⚠ ロックの記録がエディタ以外で書き換えられました。AIからの編集を止めています。上の「🔒⚠ ロックの記録を確認」からロックマネージャーで確かめてください'), 'lock', 10000);
  }
  if (ev.type === 'code' && app.state.version !== lastVersion) {
    lastVersion = app.state.version;
    toast(T('コードを読み込み直しました: {0}{1}', (ev.paths ?? []).join(', '), app.play ? T('\n（再生中のゲームは古いコードのままです。停止して再生し直してください）') : ''));
    await mountWindows();
    layout.build();
  }
};
events.onerror = () => toast(T('サーバーとの接続が切れました。サーバーを起動し直してください'), 'bad', 6000);

await mountWindows();
layout.build();
renderTop();
if (app.state.lockReport?.length) toast(app.state.lockReport.map((l) => '🔒 ' + l).join('\n'), 'lock', 8000);
}


/** 拡張を読む（本体の拡張と、プロジェクトの editorWindows）。見た目（css）も入れる */
async function loadExtensions(): Promise<LoadedExtension[]> {
  const loaded: LoadedExtension[] = builtinExtensions(app);
  for (const path of app.state.config?.editorWindows ?? []) {
    try {
      loaded.push(projectExtension(app, path, (await import(`/project@${app.state.version}/${path}`)).default));
    } catch (e) {
      toast(T('拡張 {0} を読み込めません: {1}', path, (e as Error).message), 'bad', 8000);
    }
  }
  for (const x of loaded) {
    if (!x.ext.css) continue;
    let st = document.querySelector(`style[data-ext="${x.ext.id}"]`);
    if (!st) { st = h('style', { 'data-ext': x.ext.id }); document.head.append(st); }
    st.textContent = x.ext.css;
  }
  app.extensions = loaded;
  return loaded;
}
