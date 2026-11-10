// 標準のパネル: 階層 / プロジェクト / ゲーム / テキスト / ログ / Git
import type { App } from '../app.ts';
import { h, clear, modal, toast, time, menu } from './dom.ts';
import type { Layout, Panel } from './layout.ts';
import { PREFAB_MIME, importFiles } from './assets.ts';
import { kindOf } from '../../core/assets.ts';
import { menuItemsFor } from '../extensions.ts';
import type { EntityData } from '../../core/docs.ts';
import { uiParents, groupNumbered, groupKey, NUMBERED } from '../tree.ts';

// ---------- 階層 ----------
const ENTITY_MIME = 'application/x-ages-entity';

export function hierarchyPanel(app: App): Panel {
  const el = h('div', {});
  // 開いている親（シーン#ID）。はじめは畳む。選んだ物の親は開く
  const open = new Set<string>();
  const revealSelected = () => {
    const sel = app.sel;
    if (!app.state || app.state.error || sel?.kind !== 'scene') return;
    const { parent } = uiParents(app.state.scenes[sel.scene]?.entities ?? [], app.state.prefabs);
    // 連番のまとめも開く（まとめになっていなければ使われない鍵）
    for (let id: string | undefined = sel.id, n = 0; id && n < 64; id = parent.get(id), n++) {
      const m = NUMBERED.exec(id);
      if (m) open.add(groupKey(sel.scene, parent.get(id) ?? '', m[1]));
      if (id !== sel.id) open.add(`${sel.scene}#${id}`);
    }
  };
  const render = () => {
    if (!app.state || app.state.error) return clear(el);
    const s = app.state;
    const scene = s.scenes[app.scene];
    const lockCount = (prefix: string) => Object.keys(s.locks).filter((k) => k.startsWith(prefix + '.')).length;
    const sel = app.sel;
    const sceneSel = h('select', {
      title: scene?.desc ?? '',
      disabled: !!app.play,
      onchange: (e: Event) => { app.scene = (e.target as HTMLSelectElement).value; app.rebuildPreview(); app.select(null); app.emit('change'); },
    }, Object.keys(s.scenes).map((n) => h('option', { value: n, selected: n === app.scene }, `シーン: ${n}${n === s.config.startScene ? '（開始）' : ''}`)));
    // シーンを作る・複製・名前・説明・開始・消す
    const ask = (title: string, value: string, done: (v: string) => void, placeholder = '') => modal((close) => {
      const input = h('input', { type: 'text', value, placeholder, style: 'width:100%' }) as HTMLInputElement;
      const ok = () => { const v = input.value.trim(); close(); done(v); };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
      setTimeout(() => { input.focus(); input.select(); });
      return h('div', {}, h('h3', {}, title), input, h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { onclick: close }, 'やめる'), h('button', { class: 'on', onclick: ok }, '決める')));
    });
    const go = (name: string) => { app.scene = name; app.rebuildPreview(); app.select(null); app.emit('change'); };
    const sceneMenu = (e: MouseEvent) => menu(e.clientX, e.clientY, [
      ['新しいシーン', () => ask('新しいシーン（英数字・_・-）', '', async (v) => { if (v && await app.patch([{ op: 'addScene', name: v }], 'hierarchy')) go(v); }, '例 title')],
      [`${app.scene} を複製`, () => ask(`${app.scene} の写しの名前`, `${app.scene}_copy`, async (v) => { if (v && await app.patch([{ op: 'addScene', name: v, copy: app.scene }], 'hierarchy')) go(v); })],
      ['名前を変える', () => ask(`${app.scene} の新しい名前`, app.scene, async (v) => { if (v && v !== app.scene && await app.patch([{ op: 'renameScene', name: app.scene, to: v }], 'hierarchy')) go(v); })],
      ['説明を書く', () => ask(`${app.scene} は何のシーンか（1行。地図に出ます）`, scene?.desc ?? '', (v) => app.patch([{ op: 'setScene', name: app.scene, desc: v }], 'hierarchy'))],
      ...(app.scene !== s.config.startScene ? [['開始シーンにする', () => app.patch([{ op: 'setScene', name: app.scene, start: true }], 'hierarchy')] as [string, () => void]] : []),
      ['消す', () => { if (confirm(`シーン ${app.scene} を消しますか？`)) app.patch([{ op: 'removeScene', name: app.scene }], 'hierarchy'); }],
    ]);
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
    // シーンの物を UI の親子（UI.parent）で木に並べる。兄弟はシーンの順。UI でない物と親のない UI は一番上
    const entityRows = () => {
      const ents = scene?.entities ?? [];
      const { parent, hasUI } = uiParents(ents, s.prefabs);
      const kids = new Map<string, EntityData[]>();
      const roots: EntityData[] = [];
      for (const e of ents) {
        const p = parent.get(e.id);
        if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p)!.push(e); } else roots.push(e);
      }
      const count = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + 1 + (seen.has(k.id) ? 0 : count(k.id)), 0);
      const seen = new Set<string>();
      const out: HTMLElement[] = [];
      const ancestorsOf = (id: string) => { const a = new Set<string>(); for (let p = parent.get(id); p && !a.has(p); p = parent.get(p)) a.add(p); return a; };
      const reparent = async (child: string, to: string | null) => {
        if (child === to) return;
        if (!hasUI.has(child) || (to && !hasUI.has(to))) { toast('親子にできるのは UI の物どうしだけ（UI.parent）', 'warn'); return; }
        if (to && ancestorsOf(to).has(child)) { toast(`${to} は ${child} の中にあるので、親にできない`, 'warn'); return; }
        if ((parent.get(child) ?? null) === to) return;
        if (to) open.add(`${app.scene}#${to}`);
        await app.patch([{ op: 'set', path: `${app.scene}#${child}.UI.parent`, value: to }], 'hierarchy');
      };
      const dropOn = (target: string | null) => ({
        ondragover: (ev: DragEvent) => { if (ev.dataTransfer?.types.includes(ENTITY_MIME)) { ev.preventDefault(); (ev.currentTarget as HTMLElement).classList.add('drop'); } },
        ondragleave: (ev: DragEvent) => (ev.currentTarget as HTMLElement).classList.remove('drop'),
        ondrop: (ev: DragEvent) => {
          (ev.currentTarget as HTMLElement).classList.remove('drop');
          const id = ev.dataTransfer?.getData(ENTITY_MIME);
          if (!id) return;
          ev.preventDefault(); ev.stopPropagation();
          void reparent(id, target);
        },
      });
      const row = (e: EntityData, depth: number) => {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        const key = `${app.scene}#${e.id}`;
        const children = kids.get(e.id) ?? [];
        const isOpen = open.has(key);
        const n = lockCount(key);
        const toggle = (ev: MouseEvent) => {
          ev.stopPropagation();
          // Alt+クリックで中も全部
          const all = ev.altKey ? [e.id, ...[...ents].filter((x) => ancestorsOf(x.id).has(e.id)).map((x) => x.id)] : [e.id];
          for (const id of all) { const k = `${app.scene}#${id}`; if (isOpen) open.delete(k); else open.add(k); }
          render();
        };
        out.push(h('div', {
          class: `item ${sel?.kind === 'scene' && sel.id === e.id ? 'sel' : app.extra.includes(e.id) ? 'sel2' : ''}`,
          style: `padding-left:${4 + depth * 14}px`,
          title: 'Shift・Ctrl+クリックで足す・外す。右クリックで複製・削除・プレハブにする。UI の物は、ほかの UI の上へ運ぶとその子に（一番上の行へ運ぶと親なし。位置は親の四角の中になる。Ctrl+Z で戻せる）',
          onclick: (ev: MouseEvent) => app.select({ kind: 'scene', scene: app.scene, id: e.id }, { add: ev.shiftKey || ev.ctrlKey || ev.metaKey }),
          oncontextmenu: (ev: MouseEvent) => {
            ev.preventDefault();
            if (app.play) return;
            if (!app.selectedIds().includes(e.id)) app.select({ kind: 'scene', scene: app.scene, id: e.id });
            const items = menuItemsFor(app, 'entity', app.selectedIds().map((id) => `${app.scene}#${id}`));
            if (items.length) menu(ev.clientX, ev.clientY, items);
          },
          draggable: !app.play && hasUI.has(e.id),
          ondragstart: (ev: DragEvent) => { ev.dataTransfer!.setData(ENTITY_MIME, e.id); ev.dataTransfer!.effectAllowed = 'move'; },
          ...(app.play || !hasUI.has(e.id) ? {} : dropOn(e.id)),
        },
        h('span', { class: 'tw', title: children.length ? '開く・畳む（Alt+クリックで中も全部）' : '', onclick: children.length ? toggle : null }, children.length ? (isOpen ? '▾' : '▸') : ''),
        e.name, h('span', { class: 'muted' }, e.id),
        children.length > 0 && !isOpen ? h('span', { class: 'muted', title: '中にある物の数' }, `(${count(e.id)})`) : null,
        e.prefab ? h('span', { class: 'muted', title: `プレハブ @${e.prefab} のインスタンス（つながっている）` }, '←@' + e.prefab) : null,
        n ? h('span', { style: 'color:var(--lock)', title: `ロック ${n}件` }, '🔒' + n) : null));
        if (isOpen) rows(children, depth + 1, e.id);
      };
      // 連番の名前（例 star0〜star39）で、子のない兄弟が5つ以上なら1行にまとめる（見せ方だけ）
      const rows = (list: EntityData[], depth: number, under: string) => {
        for (const item of groupNumbered(list, (id) => (kids.get(id)?.length ?? 0) > 0)) {
          if (!('members' in item)) { row(item, depth); continue; }
          const key = groupKey(app.scene, under, item.prefix);
          const isOpen = open.has(key);
          const ids = item.members.map((m) => m.id);
          const nums = item.members.map((m) => m.id.slice(item.prefix.length));
          const picked = sel?.kind === 'scene' && ids.includes(sel.id);
          out.push(h('div', {
            class: `item ${picked ? 'sel2' : ''}`,
            style: `padding-left:${4 + depth * 14}px`,
            title: `連番の ${ids.length}個をまとめた行（見せ方だけ）。クリックで全部を選ぶ。▸ で開く`,
            onclick: () => {
              app.selectMany(ids);
              // まとめを選んだだけでは開かない（選んだ物の親を開く働きを戻す）
              if (!isOpen && open.delete(key)) render();
            },
          },
          h('span', { class: 'tw', onclick: (ev: MouseEvent) => { ev.stopPropagation(); if (isOpen) open.delete(key); else open.add(key); render(); } }, isOpen ? '▾' : '▸'),
          `${item.prefix}${nums[0]}〜${nums[nums.length - 1]}`, h('span', { class: 'muted' }, `×${ids.length}`)));
          if (isOpen) for (const m of item.members) row(m, depth + 1);
        }
      };
      rows(roots, 0, '');
      // 親子が輪になっている物（一番上からたどれない）も出す。畳んで見えていない物とは分ける
      const reach = new Set<string>();
      const walk = (id: string) => { if (reach.has(id)) return; reach.add(id); for (const k of kids.get(id) ?? []) walk(k.id); };
      for (const e of roots) walk(e.id);
      for (const e of ents) if (!reach.has(e.id) && !seen.has(e.id)) { out.push(h('div', { class: 'muted', style: 'padding:2px 8px' }, `⚠ ${e.id} の UI.parent が輪になっている`)); walk(e.id); row(e, 0); }
      return { rows: out, drop: dropOn(null) };
    };
    const tree = entityRows();
    clear(el,
      s.issues.length ? h('div', { class: 'issues' }, s.issues.map((i) => h('div', {}, '⚠ ' + i))) : null,
      h('div', { class: 'toolbar' }, sceneSel, h('button', { class: 'icon', title: 'シーンを作る・複製・名前・説明・開始・消す', onclick: sceneMenu, disabled: !!app.play }, '⚙'), h('span', { style: 'flex:1' }),
        h('button', { title: 'エンティティを追加', onclick: addEntity, disabled: !!app.play }, '＋'),
        h('button', { title: '選択中のエンティティを削除', onclick: remove, disabled: !!app.play || sel?.kind !== 'scene' }, '−')),
      h('div', { class: 'list' },
        h('div', { class: 'folder', title: (scene?.desc ? scene.desc + '\n' : '') + 'UI の物をここへ運ぶと親なしに', ...(app.play ? {} : tree.drop) }, `${app.scene}（${scene?.entities.length ?? 0}）${app.play && app.play.game.sceneName === app.scene && app.play.from !== app.scene ? ' ▶実行中' : ''}`),
        tree.rows,
        h('div', { class: 'folder' }, `プレハブ（${Object.keys(s.prefabs).length}）`),
        Object.values(s.prefabs).map((p) => {
          const n = lockCount(`@${p.name}`);
          return h('div', {
            class: `item ${sel?.kind === 'prefab' && sel.name === p.name ? 'sel' : ''}`,
            onclick: () => app.select({ kind: 'prefab', name: p.name }),
            // 右クリック: 拡張の menus（where: 'prefab'。本体の写す・名前を変える・削除も）
            oncontextmenu: (ev: MouseEvent) => {
              ev.preventDefault();
              if (app.play) return;
              app.select({ kind: 'prefab', name: p.name });
              const items = menuItemsFor(app, 'prefab', [`@${p.name}`]);
              if (items.length) menu(ev.clientX, ev.clientY, items);
            },
            // ゲームの画面へ運ぶと、落とした所にインスタンス（プレハブとつながった物）を置く
            draggable: true, title: 'ゲームの画面へ運ぶと、その場所にこのプレハブのインスタンスを置く。右クリックで写す・名前を変える・削除',
            ondragstart: (e: DragEvent) => { e.dataTransfer!.setData(PREFAB_MIME, p.name); e.dataTransfer!.effectAllowed = 'copy'; },
          }, '@' + p.name, h('span', { class: 'muted' }, p.base ? `← @${p.base}${p.desc ? ' ' + p.desc : ''}` : p.desc ?? ''), n ? h('span', { style: 'color:var(--lock)' }, '🔒' + n) : null);
        }),
        app.registry?.tables.size ? h('div', { class: 'folder' }, `表（${app.registry.tables.size}）`) : null,
        [...(app.registry?.tables.values() ?? [])].map((t) => {
          const n = lockCount(`$${t.name}`);
          const rows = s.tables?.[t.name]?.rows.length ?? 0;
          // 説明は最初の文だけ（全体は名前にカーソルを乗せると出る）
          const first = (t.desc ?? '').split('。')[0];
          return h('div', { class: 'item', onclick: () => app.emit('openTable', { name: t.name }), title: `${t.desc ?? ''}\n表のエディタで開く` },
            '$' + t.name, h('span', { class: 'muted' }, `${rows}行 ${first}`), n ? h('span', { style: 'color:var(--lock)' }, '🔒' + n) : null);
        })),
    );
  };
  app.on('change', render);
  app.on('select', () => { revealSelected(); render(); });
  app.on('play', render);
  return { id: 'hierarchy', title: '階層', el, render };
}

// ---------- プロジェクト（ファイル） ----------
const TEXT_EXT = /\.(json|ts|js|md|txt|css|html|frag|glsl)$/;

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
      const done = await importFiles(app, [...(e.dataTransfer?.files ?? [])], 'assets');
      if (done.length) app.emit('revealAsset', done[done.length - 1]);
    });
    clear(el, drop, h('div', { class: 'list' }, [...groups.entries()].map(([dir, files]) => [
      h('div', { class: 'folder' }, dir),
      files.map((f) => h('div', {
        class: 'item',
        title: `${f.path}（${f.size} bytes）`,
        // 画像は「切り方」で開く（コマ・基準点・動きを決められる）
        onclick: () => /^data\/.+\.table\.json$/.test(f.path) ? app.emit('openTable', { name: f.path.slice(5, -'.table.json'.length) }) : TEXT_EXT.test(f.path) ? openText(f.path) : kindOf(f.path) ? app.emit('revealAsset', f.path) : window.open(`/project@${app.state.version}/${f.path}`),
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
      type E = { t: string; who: string; kind: string; win?: string; op: string; path: string; from?: unknown; to?: unknown; auto?: boolean; tx?: string };
      const raw = await app.api<E[]>('/api/log?limit=300');
      // 同じ操作での画像の切り方の変更（コマごとに記録される）は、1行にまとめて見せる
      const entries: E[] = [];
      for (const e of raw) {
        const root = e.path.startsWith('sheet:') && e.path.includes('|') ? e.path.split('|')[0] : null;
        const prev = entries[entries.length - 1] as E & { n?: number; root?: string };
        if (root && prev?.root === root && prev.t === e.t && prev.who === e.who) { prev.n = (prev.n ?? 1) + 1; prev.to = `切り方 ${prev.n}件変更`; continue; }
        entries.push(root ? { ...e, path: root, from: undefined, to: `切り方 ${e.path.split('|')[1]} ${typeof e.to === 'string' ? e.to : '変更'}`, root } as E : e);
      }
      // 1回の編集（tx）の最初の行に「戻す」を出す（AI の編集も、人が選んで戻せる）
      const firstOfTx = new Set<E>();
      const seen = new Set<string>();
      for (const e of entries) if (e.tx && !seen.has(e.tx)) { seen.add(e.tx); firstOfTx.add(e); }
      clear(el, entries.length ? entries.reverse().map((e) => h('div', { class: 'line' },
        h('span', { class: 'muted' }, time(e.t), ' '),
        h('span', { class: `who-${e.kind}` }, `${e.who}`), h('span', { class: 'muted' }, `(${e.win ?? e.kind}) `),
        e.op === 'undo' ? h('span', { class: 'muted' }, '↶元に戻す ') : e.op === 'redo' ? h('span', { class: 'muted' }, '↷やり直し ') : null,
        `${e.path} `, ...shownChange(e),
        firstOfTx.has(e) && e.op !== 'undo' && e.kind !== 'system' ? h('button', { class: 'icon tiny undo-tx', title: 'この編集を元に戻す（その後で変えられた所があれば止まります）', onclick: () => app.undo(false, e.tx) }, '↶') : null)) : h('div', { class: 'pad muted' }, 'まだ編集はありません'));
    } catch { /* 起動直後など */ }
  };
  /** 変更の見せ方（ID の変更・リストの並べ替えは言葉で） */
  const shownChange = (e: { path?: string; from?: unknown; to?: unknown; auto?: boolean }) => {
    const auto = e.auto ? h('span', { class: 'muted' }, '（自動）') : null;
    if (e.path?.startsWith('file:')) {
      const word: Record<string, string> = { added: '取り込み', replaced: '差し替え', removed: '削除' };
      return typeof e.to === 'string' && word[e.to] ? [h('span', { class: 'muted' }, word[e.to])] : [h('span', { class: 'muted' }, '場所を '), fmt(e.to), h('span', { class: 'muted' }, ' に変更')];
    }
    if (typeof e.to === 'string' && e.to.startsWith('renamed:')) return [h('span', { class: 'muted' }, 'ID を '), e.to.slice(8), h('span', { class: 'muted' }, ' に変更')];
    if (typeof e.to === 'string' && e.to.startsWith('moved:')) return [h('span', { class: 'muted' }, `${fmt(e.from)} → `), e.to.slice(6), h('span', { class: 'muted' }, ' へ移動')];
    return [h('span', { class: 'muted' }, e.from !== undefined && typeof e.from !== 'object' ? `${fmt(e.from)} → ` : ''), fmt(e.to), auto];
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
      toast(`チームのロックの変更を取り込みました（${n}）。ロックマネージャーで確かめて承認するまで、AI の編集は止まります`, 'lock', 10000);
      app.openLocks();
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
