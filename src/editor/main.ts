// AGES エディタの起動。
import { App } from './app.ts';
import { Layout, type LayoutData, type Panel } from './ui/layout.ts';
import { h, clear, toast, modal } from './ui/dom.ts';
import { inspectorPanel } from './ui/inspector.ts';
import { hierarchyPanel, projectPanel, textPanel, logPanel, gitPanel } from './ui/panels.ts';
import { gamePanel } from './ui/game.ts';
import { matrixPanel } from './ui/matrix.ts';
import { spritePanel } from './ui/sprite.ts';
import { tablePanel } from './ui/table.ts';
import { assetsPanel } from './ui/assets.ts';
import { builtinExtensions, projectExtension, type LoadedExtension } from './extensions.ts';
import { duplicateOps, nudgeOps, removeOps } from './edit-ops.ts';

const app = new App();
(window as unknown as { ages: App }).ages = app; // デバッグ・AIのブラウザ操作用

await app.refresh();

// 別ウインドウで1つのパネルだけを開く（例: /?solo=matrix&path=main%23spawner.Spawner.formation）
const params = new URLSearchParams(location.search);
const solo = params.get('solo');
if (solo === 'matrix' || solo === 'sprite' || solo === 'table') {
  document.body.classList.add('solo');
  const m = solo === 'matrix' ? matrixPanel(app) : solo === 'sprite' ? spritePanel(app) : tablePanel(app);
  m.el.classList.add('panel', 'active');
  document.getElementById('work')!.replaceChildren(m.el);
  const target = (solo === 'matrix' ? params.get('path') : solo === 'sprite' ? params.get('image') : params.get('name')) ?? '';
  m.open(target);
  document.title = `${solo === 'matrix' ? '行列' : solo === 'sprite' ? '切り方' : '表'} ${target} — AGES`;
  const top = document.getElementById('top')!;
  const user = h('input', { type: 'text', value: app.user, style: 'width:110px', title: '操作ログに残るあなたの名前' }) as HTMLInputElement;
  user.addEventListener('change', () => app.setUser(user.value));
  top.replaceChildren(h('span', { class: 'title' }, 'AGES', h('small', {}, solo === 'matrix' ? '行列エディタ' : solo === 'sprite' ? '切り方' : '表')), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, '名前'), user);
  new EventSource('/api/events').onmessage = (msg) => { if (JSON.parse(msg.data).type !== 'hello') app.refresh(); };
} else {
  await startEditor();
}

/** 通常のエディタ（全パネルとレイアウト） */
async function startEditor(): Promise<void> {
const savedLayout = await app.api<LayoutData | null>('/api/layout').catch(() => null);
let saveTimer: ReturnType<typeof setTimeout>;
const layout = new Layout(document.getElementById('work')!, savedLayout, (d) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => app.api('/api/layout', { method: 'PUT', raw: JSON.stringify(d, null, 2) + '\n' }).catch(() => {}), 300);
});

const text = textPanel(app, () => layout);
const game = gamePanel(app);
const matrix = matrixPanel(app);
const sprite = spritePanel(app);
const table = tablePanel(app);
const assets = assetsPanel(app);
for (const p of [hierarchyPanel(app), projectPanel(app, (path) => text.open(path)), game, matrix, sprite, table, text, assets, logPanel(app), gitPanel(app), inspectorPanel(app)]) layout.add(p);
app.on('openText', (path) => text.open(String(path)));
app.on('revealAsset', (path) => { layout.show('assets'); assets.reveal(path as string); });
app.on('openMatrix', (path) => { matrix.open(path as string); layout.show('matrix'); });
app.on('openSprite', (image) => { sprite.open(image as string); layout.show('sprite'); sprite.render?.(); });
app.on('openTable', (t) => { const { name, row } = t as { name: string; row?: string }; table.open(name, row); layout.show('table'); });
app.on('showPanel', (id) => layout.show(String(id)));

// ---------- 上のバー ----------
const top = document.getElementById('top')!;
const renderTop = () => {
  const s = app.state;
  const p = app.play;
  const userInput = h('input', { type: 'text', value: app.user, title: '操作ログに残るあなたの名前', style: 'width:110px' }) as HTMLInputElement;
  userInput.addEventListener('change', () => { app.setUser(userInput.value); toast(`名前: ${app.user}`); });
  const locks = s && !s.error ? Object.keys(s.locks).length : 0;
  const broken = s && !s.error && s.integrity && !s.integrity.ok;
  clear(top,
    h('span', { class: 'title' }, 'AGES', h('small', {}, s?.config?.name ?? '')),
    h('button', { class: p && !p.paused ? 'on' : '', title: playTitle(), onclick: () => (p ? app.togglePause() : app.startPlay()) }, p && !p.paused ? '⏸ 一時停止' : '▶ 再生'),
    h('button', { class: playSet() ? 'icon on' : 'icon', title: `再生の設定（始めのシーンに渡す params・日時）${playSet() ? `\n${playSet()}` : ''}`, onclick: openPlaySettings, disabled: !!p }, '…'),
    h('button', { title: '1フレーム進める', onclick: () => app.stepOnce() }, '⏭'),
    speedSelect(),
    h('button', { title: '停止（実行中の変更を保存するか選べます）', onclick: () => app.stopPlay(), disabled: !p }, '⏹ 停止'),
    h('button', { title: '入力を記録しながら再生（停止時に recordings/ に保存）', onclick: () => app.startPlay(true), disabled: !!p }, '● 記録して再生'),
    h('button', { class: 'icon', title: app.undoInfo.undo ? `元に戻す（Ctrl+Z）: ${app.undoInfo.undo.label}` : '元に戻せる編集はありません', disabled: !app.undoInfo.undo || !!p, onclick: () => app.undo() }, '↶'),
    h('button', { class: 'icon', title: app.undoInfo.redo ? `やり直す（Ctrl+Shift+Z）: ${app.undoInfo.redo.label}` : 'やり直せる編集はありません', disabled: !app.undoInfo.redo || !!p, onclick: () => app.undo(true) }, '↷'),
    h('span', { class: 'spacer' }),
    audioControls(),
    broken ? h('button', { style: 'border-color:var(--bad);color:var(--bad)', onclick: () => app.openLocks(), title: `${s.integrity.reason}\nロックマネージャーで確かめます` }, '🔒⚠ ロックの記録を確認') : null,
    h('span', { class: 'status' }, s?.error ? `⚠ ${s.error}` : `${s.issues.length ? `⚠${s.issues.length} ` : ''}`, s?.error ? null : h('a', { style: 'cursor:pointer', title: 'ロックマネージャーを開く（ロックの一覧・付ける・外す）', onclick: () => app.openLocks() }, `🔒${locks}`), s?.error ? '' : `  v${s.version}`),
    h('button', { class: 'icon', title: '設定', onclick: openSettings }, '⚙'),
    h('span', { class: 'muted' }, '名前'), userInput);
};
app.on('change', renderTop);
app.on('play', renderTop);
app.on('audio', renderTop);

/** 再生の速さ（拡張の api.speed と同じ） */
function speedSelect(): HTMLElement {
  const sel = h('select', { title: '再生の速さ', style: 'width:auto' }, [0.25, 0.5, 1, 2, 4].map((v) => h('option', { value: String(v), selected: v === app.playSpeed }, `×${v}`))) as HTMLSelectElement;
  if (![0.25, 0.5, 1, 2, 4].includes(app.playSpeed)) sel.prepend(h('option', { value: String(app.playSpeed), selected: true }, `×${app.playSpeed}`));
  sel.addEventListener('change', () => { app.playSpeed = Number(sel.value); });
  return sel;
}

/** 再生の設定の要約（何も決めていなければ ''） */
function playSet(): string {
  if (!app.state || app.state.error) return '';
  const s = app.playSettings;
  return [s.params.trim() ? `params: ${s.params.trim()}` : '', s.date.trim() ? `日時: ${s.date.trim()}` : ''].filter(Boolean).join(' / ');
}
function playTitle(): string {
  return `再生${playSet() ? `（${playSet()}）` : ''}`;
}

/** 再生の設定: 始めのシーンに渡す params（ages run --params と同じ書き方）と日時（ctx.date。空なら実際の時計） */
function openPlaySettings(): void {
  modal((close) => {
    const s = app.playSettings;
    const params = h('input', { type: 'text', value: s.params, placeholder: 'stage=stage_0001,mode=test か JSON', style: 'flex:1' }) as HTMLInputElement;
    const date = h('input', { type: 'text', value: s.date, placeholder: '空なら実際の時計（例 2026-12-25T09:00）', style: 'flex:1' }) as HTMLInputElement;
    const save = () => {
      try { app.playSettings = { params: params.value.trim(), date: date.value.trim() }; close(); renderTop(); } catch (e) { toast((e as Error).message, 'bad'); }
    };
    return h('div', { style: 'min-width:420px' },
      h('h3', {}, '再生の設定'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, '▶ で再生するときに、始めのシーンへ渡すもの（ctx.scene.params）と日時（ctx.date）。このブラウザに覚えます。記録して再生すると、記録にも残ります'),
      h('div', { class: 'row' }, h('span', { style: 'width:4em' }, 'params'), params),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { style: 'width:4em' }, '日時'), date),
      h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' },
        h('button', { onclick: () => { params.value = ''; date.value = ''; } }, '空にする'),
        h('button', { onclick: close }, 'やめる'),
        h('button', { class: 'primary', onclick: save }, 'OK')));
  });
}

/** 手元の音量とミュート（このブラウザだけ。ゲームの音量は音量の区分 AudioBus で決める） */
function audioControls(): HTMLElement {
  const l = app.localAudio;
  const range = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(l.volume), style: 'width:70px', title: `手元の音量 ${Math.round(l.volume * 100)}%（このブラウザだけ。ゲームの音量は音量の区分 AudioBus で決めます）` }) as HTMLInputElement;
  range.addEventListener('input', () => app.setLocalAudio(Number(range.value), false));
  return h('span', { class: 'row', style: 'gap:2px' },
    h('button', { class: 'icon', title: l.muted ? 'ミュート中（クリックで解除）' : '音を消す', onclick: () => app.setLocalAudio(l.volume, !l.muted) }, l.muted ? '🔇' : '🔊'),
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
    return h('div', {},
      h('h3', {}, '設定'),
      h('label', { class: 'row' }, show, 'ロックされた値を表示する（インスペクタ・表。表示しても、ここでは変えられません）'),
      h('div', { class: 'muted', style: 'margin:8px 0' }, 'ロックを付ける・外す・ロックされた値を変えるのは、ロックマネージャーで。'),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:12px' },
        h('button', { onclick: () => { close(); app.openLocks(); } }, '🔒 ロックマネージャーを開く'),
        h('button', { onclick: close }, '閉じる')));
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
// シーンの編集: 複製（Ctrl+D）・削除（Delete）・すべて選ぶ（Ctrl+A）・選ぶのをやめる（Esc）・矢印で1px（Shift で格子の目か 10px）ずらす
window.addEventListener('keydown', (e) => {
  if (typing(e) || inExtension(e) || (e.target as HTMLElement)?.isContentEditable || app.play || document.querySelector('.modal-bg')) return;
  const scene = app.state.scenes[app.scene];
  const ids = app.selectedIds();
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'a' && scene) { e.preventDefault(); app.selectMany(scene.entities.map((x) => x.id)); return; }
  if (e.key === 'Escape' && app.sel) { app.select(null); return; }
  if (!scene || !ids.length) return;
  if (mod && k === 'd') {
    e.preventDefault();
    const r = duplicateOps(scene, ids, 16, new Map(Object.entries(app.state.prefabs)));
    void app.patch(r.ops, 'hierarchy').then((ok) => { if (ok) app.selectMany(r.ids); });
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
    e.preventDefault();
    if (confirm(ids.length > 1 ? `${ids.length}体を削除しますか？（${ids.join(', ')}）` : `${app.scene}#${ids[0]} を削除しますか？`)) void app.patch(removeOps(app.scene, ids), 'hierarchy').then((ok) => { if (ok) app.select(null); });
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
  const loaded: LoadedExtension[] = builtinExtensions(app);
  for (const path of app.state.config?.editorWindows ?? []) {
    try {
      loaded.push(projectExtension(app, path, (await import(`/project@${app.state.version}/${path}`)).default));
    } catch (e) {
      toast(`拡張 ${path} を読み込めません: ${(e as Error).message}`, 'bad', 8000);
    }
  }
  app.extensions = loaded;
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
      slot.el.append(h('div', { class: 'pad', style: 'color:var(--bad)' }, `エラー: ${(e as Error).message}`));
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
    if (n) toast(`外部でファイルが編集されました（${n}件の変更）`);
    if (ev.lockReport?.length) toast(ev.lockReport.map((l: string) => '🔒 ' + l).join('\n'), 'lock', 8000);
  }
  if (ev.type === 'locks' && ev.integrity === false) {
    toast('🔒⚠ ロックの記録がエディタ以外で書き換えられました。AIからの編集を止めています。上の「🔒⚠ ロックの記録を確認」からロックマネージャーで確かめてください', 'lock', 10000);
  }
  if (ev.type === 'code' && app.state.version !== lastVersion) {
    lastVersion = app.state.version;
    toast(`コードを読み込み直しました: ${(ev.paths ?? []).join(', ')}${app.play ? '\n（再生中のゲームは古いコードのままです。停止して再生し直してください）' : ''}`);
    await mountWindows();
    layout.build();
  }
};
events.onerror = () => toast('サーバーとの接続が切れました。サーバーを起動し直してください', 'bad', 6000);

await mountWindows();
layout.build();
renderTop();
if (app.state.lockReport?.length) toast(app.state.lockReport.map((l) => '🔒 ' + l).join('\n'), 'lock', 8000);
}
