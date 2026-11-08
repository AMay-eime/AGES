// 標準のパネル: 階層 / プロジェクト / ゲーム / テキスト / ログ / Git
import type { App } from '../app.ts';
import { h, clear, modal, toast, time } from './dom.ts';
import type { Layout, Panel } from './layout.ts';

// ---------- 階層 ----------
export function hierarchyPanel(app: App): Panel {
  const el = h('div', {});
  const render = () => {
    if (!app.state || app.state.error) return clear(el);
    const s = app.state;
    const scene = s.scenes[app.scene];
    const lockCount = (prefix: string) => Object.keys(s.locks).filter((k) => k.startsWith(prefix + '.')).length;
    const sel = app.sel;
    const sceneSel = h('select', {
      onchange: (e: Event) => { app.scene = (e.target as HTMLSelectElement).value; app.rebuildPreview(); app.select(null); app.emit('change'); },
    }, Object.keys(s.scenes).map((n) => h('option', { value: n, selected: n === app.scene }, `シーン: ${n}`)));
    const addEntity = () => modal((close) => {
      const id = h('input', { type: 'text', placeholder: 'id（英数字・_・-）', style: 'width:100%' }) as HTMLInputElement;
      const ok = async () => {
        close();
        await app.patch([{ op: 'addEntity', scene: app.scene, entity: { id: id.value.trim(), components: { Transform: { x: s.config.view.width / 2, y: s.config.view.height / 2 } } } }], 'hierarchy');
        app.select({ kind: 'scene', scene: app.scene, id: id.value.trim() });
      };
      id.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
      setTimeout(() => id.focus());
      return h('div', {}, h('h3', {}, 'エンティティを追加'), id, h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { onclick: close }, 'やめる'), h('button', { class: 'on', onclick: ok }, '追加')));
    });
    const remove = () => {
      if (sel?.kind !== 'scene') return;
      if (!confirm(`${sel.scene}#${sel.id} を削除しますか？`)) return;
      app.patch([{ op: 'removeEntity', scene: sel.scene, id: sel.id }], 'hierarchy');
      app.select(null);
    };
    clear(el,
      s.issues.length ? h('div', { class: 'issues' }, s.issues.map((i) => h('div', {}, '⚠ ' + i))) : null,
      h('div', { class: 'toolbar' }, sceneSel, h('span', { style: 'flex:1' }),
        h('button', { title: 'エンティティを追加', onclick: addEntity, disabled: !!app.play }, '＋'),
        h('button', { title: '選択中のエンティティを削除', onclick: remove, disabled: !!app.play || sel?.kind !== 'scene' }, '−')),
      h('div', { class: 'list' },
        h('div', { class: 'folder' }, `${app.scene}（${scene?.entities.length ?? 0}）`),
        (scene?.entities ?? []).map((e) => {
          const n = lockCount(`${app.scene}#${e.id}`);
          return h('div', {
            class: `item ${sel?.kind === 'scene' && sel.id === e.id ? 'sel' : ''}`,
            onclick: () => app.select({ kind: 'scene', scene: app.scene, id: e.id }),
          }, e.name, h('span', { class: 'muted' }, e.id), n ? h('span', { style: 'color:var(--lock)', title: `ロック ${n}件` }, '🔒' + n) : null);
        }),
        h('div', { class: 'folder' }, `プレハブ（${Object.keys(s.prefabs).length}）`),
        Object.values(s.prefabs).map((p) => {
          const n = lockCount(`@${p.name}`);
          return h('div', {
            class: `item ${sel?.kind === 'prefab' && sel.name === p.name ? 'sel' : ''}`,
            onclick: () => app.select({ kind: 'prefab', name: p.name }),
          }, '@' + p.name, h('span', { class: 'muted' }, p.desc ?? ''), n ? h('span', { style: 'color:var(--lock)' }, '🔒' + n) : null);
        })),
    );
  };
  app.on('change', render);
  app.on('select', render);
  app.on('play', render);
  return { id: 'hierarchy', title: '階層', el, render };
}

// ---------- プロジェクト（ファイル） ----------
const TEXT_EXT = /\.(json|ts|js|md|txt|css|html)$/;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export function projectPanel(app: App, openText: (path: string) => void): Panel {
  const el = h('div', {});
  const render = () => {
    if (!app.state) return;
    const groups = new Map<string, { path: string; size: number }[]>();
    for (const f of app.state.files) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
      groups.set(dir, [...(groups.get(dir) ?? []), f]);
    }
    const drop = h('div', { class: 'drop-hint' }, 'ここにファイルをドロップすると assets/ に追加します');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      for (const file of [...(e.dataTransfer?.files ?? [])]) {
        await app.api(`/api/upload?path=${encodeURIComponent('assets/' + file.name)}`, { raw: file });
        toast(`追加しました: assets/${file.name}`);
      }
      await app.refresh();
    });
    clear(el, drop, h('div', { class: 'list' }, [...groups.entries()].map(([dir, files]) => [
      h('div', { class: 'folder' }, dir),
      files.map((f) => h('div', {
        class: 'item',
        title: `${f.path}（${f.size} bytes）`,
        // 画像は「切り方」で開く（コマ・基準点・動きを決められる）
        onclick: () => TEXT_EXT.test(f.path) ? openText(f.path) : IMAGE_EXT.test(f.path) ? app.emit('openSprite', f.path) : window.open(`/project@${app.state.version}/${f.path}`),
      }, f.path.split('/').pop()!, h('span', { class: 'muted' }, kb(f.size)))),
    ])));
  };
  app.on('change', render);
  return { id: 'project', title: 'プロジェクト', el, render };
}

const kb = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

// ---------- ゲーム ---------- → game.ts

// ---------- テキスト ----------
export function textPanel(app: App, layout: () => Layout): Panel & { open(path: string): void } {
  const label = h('span', { class: 'muted', style: 'flex:1;font:var(--mono)' }, 'ファイルを選ぶと開きます');
  const area = h('textarea', { class: 'code', spellcheck: false }) as HTMLTextAreaElement;
  let path = '';
  let dirty = false;
  const save = async () => {
    if (!path) return;
    try {
      await app.api(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', raw: area.value });
      dirty = false;
      label.textContent = path;
      toast(`保存しました: ${path}`);
      await app.refresh();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const load = async (p: string) => {
    const r = await app.api<{ text: string }>(`/api/file?path=${encodeURIComponent(p)}`);
    path = p;
    area.value = r.text;
    dirty = false;
    label.textContent = p;
  };
  area.addEventListener('input', () => { dirty = true; label.textContent = `${path} ●`; });
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Tab') { e.preventDefault(); area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end'); }
  });
  // 外部で変わったら（未保存の変更がなければ）読み直す
  app.on('change', () => { if (path && !dirty) load(path).catch(() => {}); });
  const el = h('div', {}, h('div', { class: 'toolbar' }, label, h('button', { onclick: save, title: 'Ctrl+S' }, '保存')), area);
  return {
    id: 'text', title: 'テキスト', el, fill: true,
    open: async (p: string) => {
      if (dirty && !confirm(`${path} の未保存の変更を捨てて ${p} を開きますか？`)) return;
      await load(p);
      layout().show('text');
    },
  };
}

// ---------- ログ ----------
export function logPanel(app: App): Panel {
  const el = h('div', { class: 'log' });
  const fmt = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const render = async () => {
    try {
      type E = { t: string; who: string; kind: string; win?: string; op: string; path: string; from?: unknown; to?: unknown };
      const raw = await app.api<E[]>('/api/log?limit=300');
      // 同じ操作での画像の切り方の変更（コマごとに記録される）は、1行にまとめて見せる
      const entries: E[] = [];
      for (const e of raw) {
        const root = e.path.startsWith('sheet:') && e.path.includes('|') ? e.path.split('|')[0] : null;
        const prev = entries[entries.length - 1] as E & { n?: number; root?: string };
        if (root && prev?.root === root && prev.t === e.t && prev.who === e.who) { prev.n = (prev.n ?? 1) + 1; prev.to = `切り方 ${prev.n}件変更`; continue; }
        entries.push(root ? { ...e, path: root, from: undefined, to: `切り方 ${e.path.split('|')[1]} ${typeof e.to === 'string' ? e.to : '変更'}`, root } as E : e);
      }
      clear(el, entries.length ? entries.reverse().map((e) => h('div', { class: 'line' },
        h('span', { class: 'muted' }, time(e.t), ' '),
        h('span', { class: `who-${e.kind}` }, `${e.who}`), h('span', { class: 'muted' }, `(${e.win ?? e.kind}) `),
        `${e.path} `, h('span', { class: 'muted' }, e.from !== undefined && typeof e.from !== 'object' ? `${fmt(e.from)} → ` : ''), fmt(e.to))) : h('div', { class: 'pad muted' }, 'まだ編集はありません'));
    } catch { /* 起動直後など */ }
  };
  app.on('change', render);
  return { id: 'log', title: '操作ログ', el, render };
}

// ---------- Git ----------
export function gitPanel(app: App): Panel {
  const status = h('pre', { class: 'pad muted' });
  const msg = h('textarea', { style: 'width:100%;height:90px;font:var(--mono)', placeholder: 'コミットの説明（操作ログから下書きされます）' }) as HTMLTextAreaElement;
  const out = h('pre', { class: 'pad' });
  let edited = false;
  msg.addEventListener('input', () => { edited = true; });
  const render = async () => {
    try {
      const r = await app.api<{ branch: string; status: string; draft: string }>('/api/git/status');
      status.textContent = `ブランチ: ${r.branch || '（なし）'}\n${r.status || '変更なし'}`;
      if (!edited) msg.value = r.draft;
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  const run = (op: string) => async () => {
    out.textContent = `${op}…`;
    const r = await app.api<{ out: string; locks?: { approved: boolean; diff: { added: string[]; removed: string[]; changed: string[] } } | null }>(`/api/git/${op}`, { body: op === 'commit' ? { message: msg.value } : {} });
    out.textContent = r.out;
    if (r.locks) {
      const d = r.locks.diff;
      const n = `増えたロック ${d.added.length}件・消えたロック ${d.removed.length}件・値が変わったロック ${d.changed.length}件`;
      toast(r.locks.approved ? `チームのロックの変更を取り込み、自動で承認しました（${n}）` : `ロックの記録は、取り込む前から確認待ちでした。「🔒⚠ ロックの記録を確認」から確認してください（${n}）`, 'lock', 8000);
    }
    if (op === 'commit') edited = false;
    await app.refresh();
    render();
  };
  const el = h('div', {},
    h('div', { class: 'toolbar' }, h('button', { onclick: run('pull') }, 'プル'), h('button', { onclick: run('commit') }, 'コミット'), h('button', { onclick: run('push') }, 'プッシュ'), h('button', { class: 'icon', onclick: render, title: '更新' }, '↻')),
    status, h('div', { class: 'pad' }, msg), out);
  app.on('change', () => { if (el.classList.contains('active')) render(); });
  return { id: 'git', title: 'Git', el, render };
}
