// AGES エディタの起動。
import { App } from './app.ts';
import { Layout, type LayoutData, type Panel } from './ui/layout.ts';
import { h, clear, toast, modal } from './ui/dom.ts';
import { inspectorPanel } from './ui/inspector.ts';
import { hierarchyPanel, projectPanel, gamePanel, textPanel, logPanel, gitPanel } from './ui/panels.ts';
import { matrixPanel } from './ui/matrix.ts';
import type { EditorApi, EditorWindow } from './window-api.ts';
import type { Op } from '../core/patch.ts';
import { parseAddress } from '../core/docs.ts';

const app = new App();
(window as unknown as { ages: App }).ages = app; // デバッグ・AIのブラウザ操作用

await app.refresh();

// 別ウインドウで1つのパネルだけを開く（例: /?solo=matrix&path=main%23spawner.Spawner.formation）
const params = new URLSearchParams(location.search);
if (params.get('solo') === 'matrix') {
  document.body.classList.add('solo');
  const m = matrixPanel(app);
  m.el.classList.add('panel', 'active');
  document.getElementById('work')!.replaceChildren(m.el);
  m.open(params.get('path') ?? '');
  document.title = `行列 ${params.get('path')} — AGES`;
  const top = document.getElementById('top')!;
  const user = h('input', { type: 'text', value: app.user, style: 'width:110px', title: '操作ログに残るあなたの名前' }) as HTMLInputElement;
  user.addEventListener('change', () => app.setUser(user.value));
  top.replaceChildren(h('span', { class: 'title' }, 'AGES', h('small', {}, '行列エディタ')), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, '名前'), user);
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
for (const p of [hierarchyPanel(app), projectPanel(app, (path) => text.open(path)), game, matrix, text, logPanel(app), gitPanel(app), inspectorPanel(app)]) layout.add(p);
app.on('openMatrix', (path) => { matrix.open(path as string); layout.show('matrix'); });

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
    h('button', { class: p && !p.paused ? 'on' : '', title: '再生', onclick: () => (p ? app.togglePause() : app.startPlay()) }, p && !p.paused ? '⏸ 一時停止' : '▶ 再生'),
    h('button', { title: '1フレーム進める', onclick: () => app.stepOnce() }, '⏭'),
    h('button', { title: '停止（実行中の変更を保存するか選べます）', onclick: () => app.stopPlay(), disabled: !p }, '⏹ 停止'),
    h('button', { title: '入力を記録しながら再生（停止時に recordings/ に保存）', onclick: () => app.startPlay(true), disabled: !!p }, '● 記録して再生'),
    h('span', { class: 'spacer' }),
    broken ? h('button', { style: 'border-color:var(--bad);color:var(--bad)', onclick: checkLocks, title: s.integrity.reason }, '🔒⚠ ロックの記録を確認') : null,
    h('span', { class: 'status' }, s?.error ? `⚠ ${s.error}` : `${s.issues.length ? `⚠${s.issues.length} ` : ''}🔒${locks}  v${s.version}`),
    h('span', { class: 'muted' }, '名前'), userInput);
};
app.on('change', renderTop);
app.on('play', renderTop);

/** ロックの記録が人の封印と一致しないときの確認画面 */
function checkLocks(): void {
  const g = app.state.integrity;
  modal((close) => {
    const list = (title: string, items: string[], color: string) => items.length
      ? h('div', { style: 'margin:8px 0' }, h('div', { style: `color:${color}` }, `${title}（${items.length}）`), items.map((i) => h('div', { style: 'font:var(--mono);padding-left:12px' }, i)))
      : null;
    const act = (path: string) => async () => {
      close();
      try { await app.api(path, { body: {} }); toast('ロックの記録を確認しました。AIからの編集を再開できます'); }
      catch (e) { toast((e as Error).message, 'bad'); }
      await app.refresh();
    };
    return h('div', {},
      h('h3', {}, '🔒⚠ ロックの記録を確認してください'),
      h('div', { style: 'margin-bottom:8px' }, g.reason ?? ''),
      h('div', { class: 'muted' }, 'AIからの編集はすべて止まっています。最後にあなたが封印したロックは、確認するまで引き続き有効です。'),
      list('消されたロック', g.diff.removed, 'var(--bad)'),
      list('増えたロック', g.diff.added, 'var(--warn)'),
      list('値が変わったロック', g.diff.changed, 'var(--warn)'),
      !g.diff.added.length && !g.diff.removed.length && !g.diff.changed.length ? h('div', { class: 'muted', style: 'margin:8px 0' }, '（中身の違いは見つかりません。チームの誰かがGitで送ったロックか、この端末で初めて開いたロックです）') : null,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
        h('button', { onclick: close }, '閉じる'),
        g.hasBackup ? h('button', { onclick: act('/api/locks/restore'), title: '最後にあなたが封印した状態に戻す' }, '前の状態に戻す') : null,
        h('button', { class: 'on', onclick: act('/api/locks/approve'), title: '今のロックの記録を正しいものとして封印する' }, 'この内容で承認する')));
  });
}

// ---------- キー入力（再生中だけゲームへ） ----------
const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
window.addEventListener('keydown', (e) => {
  if (!app.play || typing(e)) return;
  app.keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => { app.keys.delete(e.code); });
window.addEventListener('blur', () => app.keys.clear());

// ---------- プロジェクト独自のウインドウ ----------
const windows = new Map<string, { el: HTMLElement; cleanup?: () => void }>();
async function mountWindows(): Promise<void> {
  for (const w of windows.values()) w.cleanup?.();
  const paths = app.state.config?.editorWindows ?? [];
  for (const path of paths) {
    let def: EditorWindow;
    try {
      def = (await import(`/project@${app.state.version}/${path}`)).default;
    } catch (e) {
      toast(`ウインドウ ${path} を読み込めません: ${(e as Error).message}`, 'bad', 8000);
      continue;
    }
    const id = `win:${def.id}`;
    let slot = windows.get(id);
    if (!slot) {
      slot = { el: h('div', {}) };
      windows.set(id, slot);
      const panel: Panel = { id, title: def.title, el: slot.el };
      layout.add(panel);
    }
    slot.el.replaceChildren();
    try {
      slot.cleanup = def.mount(slot.el, makeApi(def.id)) ?? undefined;
    } catch (e) {
      slot.el.append(h('div', { class: 'pad', style: 'color:var(--bad)' }, `エラー: ${(e as Error).message}`));
    }
  }
}

function makeApi(id: string): EditorApi {
  return {
    get state() { return app.state; },
    get user() { return app.user; },
    get playing() { return !!app.play; },
    patch: (ops: Op[]) => app.patch(ops, `window:${id}`),
    get(path: string) {
      const a = parseAddress(path);
      const holder = a.kind === 'prefab' ? app.state.prefabs[a.doc] : app.state.scenes[a.doc]?.entities.find((e) => e.id === a.entity);
      const comp = a.component ? holder?.components[a.component] : undefined;
      if (!a.field) return comp ?? holder;
      return comp && a.field in comp ? comp[a.field] : app.registry.components.get(a.component!)?.fields[a.field]?.default;
    },
    select(address: string) {
      const a = parseAddress(address);
      app.select(a.kind === 'prefab' ? { kind: 'prefab', name: a.doc } : { kind: 'scene', scene: a.doc, id: a.entity! });
    },
    simulate: (frames, keys, seed) => app.simulate(frames, keys, seed),
    on: ((ev: string, fn: (d?: unknown) => void) => app.on(ev, fn)) as EditorApi['on'],
    h: h as unknown as EditorApi['h'],
  };
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
    toast('🔒⚠ ロックの記録がエディタ以外で書き換えられました。AIからの編集を止めています。上の「ロックの記録を確認」から確認してください', 'lock', 10000);
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
