// AGES エディタの起動。
import { App } from './app.ts';
import { Layout, type LayoutData, type Panel } from './ui/layout.ts';
import { h, clear, toast } from './ui/dom.ts';
import { inspectorPanel } from './ui/inspector.ts';
import { hierarchyPanel, projectPanel, gamePanel, textPanel, logPanel, gitPanel } from './ui/panels.ts';
import type { EditorApi, EditorWindow } from './window-api.ts';
import type { Op } from '../core/patch.ts';
import { parseAddress } from '../core/docs.ts';

const app = new App();
(window as unknown as { ages: App }).ages = app; // デバッグ・AIのブラウザ操作用

await app.refresh();
const savedLayout = await app.api<LayoutData | null>('/api/layout').catch(() => null);
let saveTimer: ReturnType<typeof setTimeout>;
const layout = new Layout(document.getElementById('work')!, savedLayout, (d) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => app.api('/api/layout', { method: 'PUT', raw: JSON.stringify(d, null, 2) + '\n' }).catch(() => {}), 300);
});

const text = textPanel(app, () => layout);
const game = gamePanel(app);
for (const p of [hierarchyPanel(app), projectPanel(app, (path) => text.open(path)), game, text, logPanel(app), gitPanel(app), inspectorPanel(app)]) layout.add(p);

// ---------- 上のバー ----------
const top = document.getElementById('top')!;
const renderTop = () => {
  const s = app.state;
  const p = app.play;
  const userInput = h('input', { type: 'text', value: app.user, title: '操作ログに残るあなたの名前', style: 'width:110px' }) as HTMLInputElement;
  userInput.addEventListener('change', () => { app.setUser(userInput.value); toast(`名前: ${app.user}`); });
  const locks = s && !s.error ? Object.keys(s.locks).length : 0;
  clear(top,
    h('span', { class: 'title' }, 'AGES', h('small', {}, s?.config?.name ?? '')),
    h('button', { class: p && !p.paused ? 'on' : '', title: '再生', onclick: () => (p ? app.togglePause() : app.startPlay()) }, p && !p.paused ? '⏸ 一時停止' : '▶ 再生'),
    h('button', { title: '1フレーム進める', onclick: () => app.stepOnce() }, '⏭'),
    h('button', { title: '停止（実行中の変更を保存するか選べます）', onclick: () => app.stopPlay(), disabled: !p }, '⏹ 停止'),
    h('button', { title: '入力を記録しながら再生（停止時に recordings/ に保存）', onclick: () => app.startPlay(true), disabled: !!p }, '● 記録して再生'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'status' }, s?.error ? `⚠ ${s.error}` : `${s.issues.length ? `⚠${s.issues.length} ` : ''}🔒${locks}  v${s.version}`),
    h('span', { class: 'muted' }, '名前'), userInput);
};
app.on('change', renderTop);
app.on('play', renderTop);

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
