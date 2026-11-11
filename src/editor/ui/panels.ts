// 標準のパネル: 階層 / プロジェクト / ゲーム / テキスト / ログ / Git
import type { App } from '../app.ts';
import { h, clear, modal, toast, time, menu } from './dom.ts';
import type { Layout, Panel } from './layout.ts';
import { PREFAB_MIME, importFiles } from './assets.ts';
import { kindOf } from '../../core/assets.ts';
import { menuItemsFor } from '../extensions.ts';
import type { EntityData } from '../../core/docs.ts';
import { treeParents, groupNumbered, groupKey, NUMBERED } from '../tree.ts';
import { docPose } from '../edit-ops.ts';
import { relativeTo } from '../../core/transform.ts';
import type { Op } from '../../core/patch.ts';
import type { GitFix, GitHelp } from '../git-help.ts';
import { T, TD } from '../i18n.ts';

// ---------- 階層 ----------
const ENTITY_MIME = 'application/x-ages-entity';

export function hierarchyPanel(app: App): Panel {
  const el = h('div', {});
  // 開いている親（シーン#ID）。はじめは畳む。選んだ物の親は開く
  const open = new Set<string>();
  const revealSelected = () => {
    const sel = app.sel;
    if (!app.state || app.state.error || sel?.kind !== 'scene') return;
    const { parent } = treeParents(app.state.scenes[sel.scene]?.entities ?? [], app.state.prefabs);
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
    }, Object.keys(s.scenes).map((n) => h('option', { value: n, selected: n === app.scene }, T('シーン: {0}{1}', n, n === s.config.startScene ? T('（開始）') : ''))));
    // シーンを作る・複製・名前・説明・開始・消す
    const ask = (title: string, value: string, done: (v: string) => void, placeholder = '') => modal((close) => {
      const input = h('input', { type: 'text', value, placeholder, style: 'width:100%' }) as HTMLInputElement;
      const ok = () => { const v = input.value.trim(); close(); done(v); };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
      setTimeout(() => { input.focus(); input.select(); });
      return h('div', {}, h('h3', {}, title), input, h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { onclick: close }, T('やめる')), h('button', { class: 'on', onclick: ok }, T('決める'))));
    });
    const go = (name: string) => { app.scene = name; app.rebuildPreview(); app.select(null); app.emit('change'); };
    const sceneMenu = (e: MouseEvent) => menu(e.clientX, e.clientY, [
      [T('新しいシーン'), () => ask(T('新しいシーン（英数字・_・-）'), '', async (v) => { if (v && await app.patch([{ op: 'addScene', name: v }], 'hierarchy')) go(v); }, T('例 title'))],
      [T('{0} を複製', app.scene), () => ask(T('{0} の写しの名前', app.scene), `${app.scene}_copy`, async (v) => { if (v && await app.patch([{ op: 'addScene', name: v, copy: app.scene }], 'hierarchy')) go(v); })],
      [T('名前を変える'), () => ask(T('{0} の新しい名前', app.scene), app.scene, async (v) => { if (v && v !== app.scene && await app.patch([{ op: 'renameScene', name: app.scene, to: v }], 'hierarchy')) go(v); })],
      [T('説明を書く'), () => ask(T('{0} は何のシーンか（1行。地図に出ます）', app.scene), scene?.desc ?? '', (v) => app.patch([{ op: 'setScene', name: app.scene, desc: v }], 'hierarchy'))],
      ...(app.scene !== s.config.startScene ? [[T('開始シーンにする'), () => app.patch([{ op: 'setScene', name: app.scene, start: true }], 'hierarchy')] as [string, () => void]] : []),
      [T('消す'), () => { if (confirm(T('シーン {0} を消しますか？', app.scene))) app.patch([{ op: 'removeScene', name: app.scene }], 'hierarchy'); }],
    ]);
    const addEntity = () => modal((close) => {
      const id = h('input', { type: 'text', placeholder: T('id（英数字・_・-）'), style: 'width:100%' }) as HTMLInputElement;
      const ok = async () => {
        close();
        await app.patch([{ op: 'addEntity', scene: app.scene, entity: { id: id.value.trim(), components: { Transform: { x: s.config.view.width / 2, y: s.config.view.height / 2 } } } }], 'hierarchy');
        app.select({ kind: 'scene', scene: app.scene, id: id.value.trim() });
      };
      id.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
      setTimeout(() => id.focus());
      return h('div', {}, h('h3', {}, T('エンティティを追加')), id, h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { onclick: close }, T('やめる')), h('button', { class: 'on', onclick: ok }, T('追加'))));
    });
    const remove = () => {
      if (sel?.kind !== 'scene') return;
      if (!confirm(T('{0}#{1} を削除しますか？', sel.scene, sel.id))) return;
      app.patch([{ op: 'removeEntity', scene: sel.scene, id: sel.id }], 'hierarchy');
      app.select(null);
    };
    // シーンの物を UI の親子（UI.parent）で木に並べる。兄弟はシーンの順。UI でない物と親のない UI は一番上
    const entityRows = () => {
      const ents = scene?.entities ?? [];
      const { parent, kind } = treeParents(ents, s.prefabs);
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
        const k = kind.get(child);
        if (!k || (to && kind.get(to) !== k)) { toast(T('親子にできるのは UI の物どうし（UI.parent）か、位置のある物どうし（Transform.parent）'), 'warn'); return; }
        if (to && ancestorsOf(to).has(child)) { toast(T('{0} は {1} の中にあるので、親にできない', to, child), 'warn'); return; }
        if ((parent.get(child) ?? null) === to) return;
        if (to) open.add(`${app.scene}#${to}`);
        const base = `${app.scene}#${child}.${k}`;
        const ops: Op[] = [{ op: 'set', path: `${base}.parent`, value: to }];
        // 位置の親は、画面の位置・向き・大きさを変えない（親から見た値に直す）
        const view = app.sceneView(app.scene);
        const w = k === 'Transform' && view ? docPose(view, child) : null;
        if (w && view) {
          const pp = to ? docPose(view, to) : null;
          const local = pp ? relativeTo(pp, w) : w;
          const cur = view.entities.find((e) => e.id === child)?.components.Transform ?? {};
          const r2 = (v: number) => Math.round(v * 100) / 100;
          for (const [f, d] of [['x', 0], ['y', 0], ['rot', 0], ['sx', 1], ['sy', 1]] as const) {
            const v = r2(local[f]);
            if (v !== Number(cur[f] ?? d)) ops.push({ op: 'set', path: `${base}.${f}`, value: v });
          }
        }
        await app.patch(ops, 'hierarchy');
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
          'data-ai': `${app.scene}#${e.id}`,
          title: T('Shift・Ctrl+クリックで足す・外す。右クリックで複製・削除・プレハブにする。ほかの物の上へ運ぶとその子に（UI どうしは UI.parent・位置のある物どうしは Transform.parent。シーン名の行へ運ぶと親なし。Ctrl+Z で戻せる）'),
          onclick: (ev: MouseEvent) => app.select({ kind: 'scene', scene: app.scene, id: e.id }, { add: ev.shiftKey || ev.ctrlKey || ev.metaKey }),
          oncontextmenu: (ev: MouseEvent) => {
            ev.preventDefault();
            if (app.play) return;
            if (!app.selectedIds().includes(e.id)) app.select({ kind: 'scene', scene: app.scene, id: e.id });
            const items = menuItemsFor(app, 'entity', app.selectedIds().map((id) => `${app.scene}#${id}`));
            if (items.length) menu(ev.clientX, ev.clientY, items);
          },
          draggable: !app.play && kind.has(e.id),
          ondragstart: (ev: DragEvent) => { ev.dataTransfer!.setData(ENTITY_MIME, e.id); ev.dataTransfer!.effectAllowed = 'move'; },
          ...(app.play || !kind.has(e.id) ? {} : dropOn(e.id)),
        },
        h('span', { class: 'tw', title: children.length ? T('開く・畳む（Alt+クリックで中も全部）') : '', onclick: children.length ? toggle : null }, children.length ? (isOpen ? '▾' : '▸') : ''),
        e.name, h('span', { class: 'muted' }, e.id),
        children.length > 0 && !isOpen ? h('span', { class: 'muted', title: T('中にある物の数') }, `(${count(e.id)})`) : null,
        e.prefab ? h('span', { class: 'muted', title: T('プレハブ @{0} のインスタンス（つながっている）', e.prefab) }, '←@' + e.prefab) : null,
        n ? h('span', { style: 'color:var(--lock)', title: T('ロック {0}件', n) }, '🔒' + n) : null));
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
            title: T('連番の {0}個をまとめた行（見せ方だけ）。クリックで全部を選ぶ。▸ で開く', ids.length),
            onclick: () => {
              app.selectMany(ids);
              // まとめを選んだだけでは開かない（選んだ物の親を開く働きを戻す）
              if (!isOpen && open.delete(key)) render();
            },
          },
          h('span', { class: 'tw', onclick: (ev: MouseEvent) => { ev.stopPropagation(); if (isOpen) open.delete(key); else open.add(key); render(); } }, isOpen ? '▾' : '▸'),
          T('{0}{1}〜{2}', item.prefix, nums[0], nums[nums.length - 1]), h('span', { class: 'muted' }, `×${ids.length}`)));
          if (isOpen) for (const m of item.members) row(m, depth + 1);
        }
      };
      rows(roots, 0, '');
      // 親子が輪になっている物（一番上からたどれない）も出す。畳んで見えていない物とは分ける
      const reach = new Set<string>();
      const walk = (id: string) => { if (reach.has(id)) return; reach.add(id); for (const k of kids.get(id) ?? []) walk(k.id); };
      for (const e of roots) walk(e.id);
      for (const e of ents) if (!reach.has(e.id) && !seen.has(e.id)) { out.push(h('div', { class: 'muted', style: 'padding:2px 8px' }, T('⚠ {0} の UI.parent が輪になっている', e.id))); walk(e.id); row(e, 0); }
      return { rows: out, drop: dropOn(null) };
    };
    const tree = entityRows();
    clear(el,
      s.issues.length ? h('div', { class: 'issues' }, s.issues.map((i) => h('div', {}, '⚠ ' + i))) : null,
      h('div', { class: 'toolbar' }, sceneSel, h('button', { class: 'icon', title: T('シーンを作る・複製・名前・説明・開始・消す'), onclick: sceneMenu, disabled: !!app.play }, '⚙'), h('span', { style: 'flex:1' }),
        h('button', { title: T('エンティティを追加'), onclick: addEntity, disabled: !!app.play }, T('＋')),
        h('button', { title: T('選択中のエンティティを削除'), onclick: remove, disabled: !!app.play || sel?.kind !== 'scene' }, '−')),
      h('div', { class: 'list' },
        h('div', { class: 'folder', title: (scene?.desc ? scene.desc + '\n' : '') + T('UI の物をここへ運ぶと親なしに'), ...(app.play ? {} : tree.drop) }, T('{0}（{1}）{2}', app.scene, scene?.entities.length ?? 0, app.play && app.play.game.sceneName === app.scene && app.play.from !== app.scene ? T(' ▶実行中') : '')),
        tree.rows,
        h('div', { class: 'folder' }, T('プレハブ（{0}）', Object.keys(s.prefabs).length)),
        Object.values(s.prefabs).map((p) => {
          const n = lockCount(`@${p.name}`);
          return h('div', {
            class: `item ${sel?.kind === 'prefab' && sel.name === p.name ? 'sel' : ''}`,
            onclick: () => app.select({ kind: 'prefab', name: p.name }),
            'data-ai': `@${p.name}`,
            // 右クリック: 拡張の menus（where: 'prefab'。本体の写す・名前を変える・削除も）
            oncontextmenu: (ev: MouseEvent) => {
              ev.preventDefault();
              if (app.play) return;
              app.select({ kind: 'prefab', name: p.name });
              const items = menuItemsFor(app, 'prefab', [`@${p.name}`]);
              if (items.length) menu(ev.clientX, ev.clientY, items);
            },
            // ゲームの画面へ運ぶと、落とした所にインスタンス（プレハブとつながった物）を置く
            draggable: true, title: T('ゲームの画面へ運ぶと、その場所にこのプレハブのインスタンスを置く。右クリックで写す・名前を変える・削除'),
            ondragstart: (e: DragEvent) => { e.dataTransfer!.setData(PREFAB_MIME, p.name); e.dataTransfer!.effectAllowed = 'copy'; },
          }, '@' + p.name, h('span', { class: 'muted' }, p.base ? `← @${p.base}${p.desc ? ' ' + p.desc : ''}` : p.desc ?? ''), n ? h('span', { style: 'color:var(--lock)' }, '🔒' + n) : null);
        }),
        app.registry?.tables.size ? h('div', { class: 'folder' }, T('表（{0}）', app.registry.tables.size)) : null,
        [...(app.registry?.tables.values() ?? [])].map((t) => {
          const n = lockCount(`$${t.name}`);
          const rows = s.tables?.[t.name]?.rows.length ?? 0;
          // 説明は最初の文だけ（全体は名前にカーソルを乗せると出る）
          const first = TD(t.desc).split(/。|\. /)[0];
          return h('div', { class: 'item', onclick: () => app.emit('openTable', { name: t.name }), title: T('{0}\n表のエディタで開く', t.desc ?? '') },
            '$' + t.name, h('span', { class: 'muted' }, T('{0}行 {1}', rows, first)), n ? h('span', { style: 'color:var(--lock)' }, '🔒' + n) : null);
        })),
    );
  };
  app.on('change', render);
  app.on('select', () => { revealSelected(); render(); });
  app.on('play', render);
  return { id: 'hierarchy', title: T('階層'), el, render };
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
    const drop = h('div', { class: 'drop-hint' }, T('ここにファイルをドロップすると assets/ に追加します'));
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
        title: T('{0}（{1} bytes）', f.path, f.size),
        // 画像は「切り方」で開く（コマ・基準点・動きを決められる）
        onclick: () => /^data\/.+\.table\.json$/.test(f.path) ? app.emit('openTable', { name: f.path.slice(5, -'.table.json'.length) }) : TEXT_EXT.test(f.path) ? openText(f.path) : kindOf(f.path) ? app.emit('revealAsset', f.path) : window.open(`/project@${app.state.version}/${f.path}`),
      }, f.path.split('/').pop()!, h('span', { class: 'muted' }, kb(f.size)))),
    ])));
  };
  app.on('change', render);
  return { id: 'project', title: T('プロジェクト'), el, render };
}

const kb = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

// ---------- ゲーム ---------- → game.ts

// ---------- テキスト ----------
export function textPanel(app: App, layout: () => Layout): Panel & { open(path: string): void } {
  const label = h('span', { class: 'muted', style: 'flex:1;font:var(--mono)' }, T('ファイルを選ぶと開きます'));
  const area = h('textarea', { class: 'code', spellcheck: false }) as HTMLTextAreaElement;
  let path = '';
  let dirty = false;
  const save = async () => {
    if (!path) return;
    try {
      await app.api(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', raw: area.value });
      dirty = false;
      label.textContent = path;
      toast(T('保存しました: {0}', path));
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
  const el = h('div', {}, h('div', { class: 'toolbar' }, label, h('button', { onclick: save, title: 'Ctrl+S' }, T('保存'))), area);
  return {
    id: 'text', title: T('テキスト'), el, fill: true,
    open: async (p: string) => {
      if (dirty && !confirm(T('{0} の未保存の変更を捨てて {1} を開きますか？', path, p))) return;
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
        if (root && prev?.root === root && prev.t === e.t && prev.who === e.who) { prev.n = (prev.n ?? 1) + 1; prev.to = T('切り方 {0}件変更', prev.n); continue; }
        entries.push(root ? { ...e, path: root, from: undefined, to: T('切り方 {0} {1}', e.path.split('|')[1], typeof e.to === 'string' ? e.to : T('変更')), root } as E : e);
      }
      // 1回の編集（tx）の最初の行に「戻す」を出す（AI の編集も、人が選んで戻せる）
      const firstOfTx = new Set<E>();
      const seen = new Set<string>();
      for (const e of entries) if (e.tx && !seen.has(e.tx)) { seen.add(e.tx); firstOfTx.add(e); }
      clear(el, entries.length ? entries.reverse().map((e) => h('div', { class: 'line' },
        h('span', { class: 'muted' }, time(e.t), ' '),
        h('span', { class: `who-${e.kind}` }, `${e.who}`), h('span', { class: 'muted' }, `(${e.win ?? e.kind}) `),
        e.op === 'undo' ? h('span', { class: 'muted' }, T('↶元に戻す ')) : e.op === 'redo' ? h('span', { class: 'muted' }, T('↷やり直し ')) : null,
        `${e.path} `, ...shownChange(e),
        firstOfTx.has(e) && e.op !== 'undo' && e.kind !== 'system' ? h('button', { class: 'icon tiny undo-tx', title: T('この編集を元に戻す（その後で変えられた所があれば止まります）'), onclick: () => app.undo(false, e.tx) }, '↶') : null)) : h('div', { class: 'pad muted' }, T('まだ編集はありません')));
    } catch { /* 起動直後など */ }
  };
  /** 変更の見せ方（ID の変更・リストの並べ替えは言葉で） */
  const shownChange = (e: { path?: string; from?: unknown; to?: unknown; auto?: boolean }) => {
    const auto = e.auto ? h('span', { class: 'muted' }, T('（自動）')) : null;
    if (e.path?.startsWith('file:')) {
      const word: Record<string, string> = { added: T('取り込み'), replaced: T('差し替え'), removed: T('削除') };
      return typeof e.to === 'string' && word[e.to] ? [h('span', { class: 'muted' }, word[e.to])] : [h('span', { class: 'muted' }, T('場所を ')), fmt(e.to), h('span', { class: 'muted' }, T(' に変更'))];
    }
    if (typeof e.to === 'string' && e.to.startsWith('renamed:')) return [h('span', { class: 'muted' }, T('ID を ')), e.to.slice(8), h('span', { class: 'muted' }, T(' に変更'))];
    if (typeof e.to === 'string' && e.to.startsWith('moved:')) return [h('span', { class: 'muted' }, `${fmt(e.from)} → `), e.to.slice(6), h('span', { class: 'muted' }, T(' へ移動'))];
    return [h('span', { class: 'muted' }, e.from !== undefined && typeof e.from !== 'object' ? `${fmt(e.from)} → ` : ''), fmt(e.to), auto];
  };
  app.on('change', render);
  return { id: 'log', title: T('操作ログ'), el, render };
}

// ---------- Git ----------
export function gitPanel(app: App): Panel {
  const status = h('pre', { class: 'pad muted' });
  const who = h('div', { class: 'pad' });
  const helpBox = h('div', { class: 'pad' });
  const msg = h('textarea', { style: 'width:100%;height:90px;font:var(--mono)', placeholder: T('コミットの説明（操作ログから下書きされます）') }) as HTMLTextAreaElement;
  const out = h('pre', { class: 'pad' });
  let edited = false;
  /** GitHub のユーザー名の見当（送り先の持ち主） */
  let owner = '';
  msg.addEventListener('input', () => { edited = true; });
  const render = async () => {
    try {
      const r = await app.api<{ branch: string; status: string; draft: string; identity?: { name: string; email: string }; owner?: string | null }>('/api/git/status');
      status.textContent = T('ブランチ: {0}\n{1}', r.branch || T('（なし）'), r.status || T('変更なし'));
      if (!edited) msg.value = r.draft;
      owner = r.owner ?? '';
      // コミットに入る名前・アドレス（プッシュすると誰でも見られる）
      const id = r.identity;
      clear(who);
      if (!id?.email) {
        who.append(h('span', { style: 'color:var(--warn)' }, T('コミットに入れる名前とメールアドレスが決まっていません ')), fixButton({ kind: 'identity' }));
      } else {
        const hidden = /@users\.noreply\.github\.com$/i.test(id.email);
        who.append(h('span', { class: 'muted' }, T('コミットに入る名前: {0} <{1}>{2} ', id.name || T('（なし）'), id.email, hidden ? T('（GitHub の noreply のアドレス）') : T('（プッシュすると誰でも見られます）'))));
        if (!hidden) who.append(h('button', { onclick: () => noreplyDialog(), title: T('アドレスを公開したくないときは、GitHub の noreply のアドレスにします') }, T('noreply のアドレスにする')));
      }
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  /** よくある失敗の説明と、直すボタン */
  const showHelp = (helps: GitHelp[] = []) => {
    clear(helpBox);
    for (const x of helps) {
      const color = x.level === 'bad' ? 'var(--bad)' : x.level === 'warn' ? 'var(--warn)' : 'var(--accent)';
      helpBox.append(h('div', { style: `border-left:3px solid ${color};padding:4px 8px;margin:4px 0` },
        h('div', { style: `color:${color};font-weight:600` }, x.title),
        h('div', { class: 'muted' }, x.detail),
        x.fix ? h('div', { class: 'toolbar' }, fixButton(x.fix)) : null));
    }
  };
  const FIX_LABEL: Record<GitFix['kind'], string> = {
    noreply: T('公開してよいアドレス（noreply）にする'), 'set-url': T('送り先を新しい場所に直す'), pushpull: T('取り込んでからプッシュ'),
    'set-upstream': T('送り先を決めてプッシュ'), identity: T('名前とアドレスを決める'),
  };
  function fixButton(f: GitFix): HTMLElement {
    const go = () => {
      if (f.kind === 'noreply') return noreplyDialog();
      if (f.kind === 'identity') return identityDialog();
      if (f.kind === 'pushpull') return void sync('pushpull');
      return void doFix(f);
    };
    return h('button', { onclick: go }, FIX_LABEL[f.kind]);
  }
  const doFix = async (body: Record<string, unknown>) => {
    out.textContent = T('直しています…');
    const r = await app.api<{ ok: boolean; out: string }>('/api/git/fix', { body });
    out.textContent = r.out;
    toast(r.ok ? r.out.split('\n').slice(-1)[0] : T('直せませんでした。Git のパネルに出力があります'), r.ok ? undefined : 'bad', 8000);
    if (r.ok) showHelp([]);
    await render();
    void check(true);
  };
  /** GH007: アドレスを GitHub の noreply にして、プッシュしていないコミットを作り直す（確かめてから） */
  function noreplyDialog(name?: string): void {
    const login = h('input', { type: 'text', value: owner, placeholder: T('GitHub のユーザー名'), style: 'width:16em' }) as HTMLInputElement;
    modal((close) => h('div', {},
      h('p', {}, T('コミットに入るメールアドレスを、公開してよい GitHub の noreply のアドレス（番号+ユーザー名@users.noreply.github.com）にします。')),
      h('p', {}, T('まだプッシュしていないコミットは、新しいアドレスで作り直します（中身は変わりません）。このリポジトリだけの設定です。')),
      h('div', { class: 'toolbar' }, h('label', {}, T('GitHub のユーザー名 '), login)),
      h('div', { class: 'toolbar' },
        h('button', { onclick: () => { close(); void doFix({ kind: 'noreply', login: login.value.trim(), ...(name ? { name } : {}) }); } }, T('直す')),
        h('button', { onclick: close }, T('やめる')))));
  }
  function identityDialog(): void {
    const name = h('input', { type: 'text', placeholder: T('名前（ハンドルネームでよい）'), style: 'width:16em' }) as HTMLInputElement;
    const email = h('input', { type: 'text', placeholder: T('メールアドレス'), style: 'width:22em' }) as HTMLInputElement;
    modal((close) => h('div', {},
      h('p', {}, T('コミットに入れる名前とメールアドレスを決めます（このリポジトリだけ）。GitHub にプッシュすると誰でも見られます。')),
      h('div', { class: 'toolbar' }, name), h('div', { class: 'toolbar' }, email),
      h('p', { class: 'muted' }, T('アドレスを公開したくなければ、名前だけ入れて「noreply のアドレスにする」を押します。')),
      h('div', { class: 'toolbar' },
        h('button', { onclick: () => { close(); void doFix({ kind: 'identity', name: name.value, email: email.value }); } }, T('決める')),
        h('button', { onclick: () => { close(); noreplyDialog(name.value.trim() || undefined); } }, T('noreply のアドレスにする')),
        h('button', { onclick: close }, T('やめる')))));
  }
  const OP_NAME: Record<string, string> = { pull: T('取り込み（プル）'), commit: T('コミット'), push: T('プッシュ') };
  const run = (op: string) => async () => {
    out.textContent = `${op}…`;
    showHelp([]);
    const r = await app.api<{ ok: boolean; out: string; help?: GitHelp[]; locks?: { approved: boolean; diff: { added: string[]; removed: string[]; changed: string[] } } | null }>(`/api/git/${op}`, { body: op === 'commit' ? { message: msg.value } : {} });
    out.textContent = r.out;
    showHelp(r.help);
    // 失敗したら警告を出す（出力の欄だけだと、うまくいったと思ってしまう）
    const first = r.help?.find((x) => x.level !== 'info');
    if (!r.ok && !(op === 'commit' && r.help?.length && r.help.every((x) => x.level === 'info'))) toast(T('{0}できませんでした: {1}', OP_NAME[op] ?? op, first?.title ?? T('Git のパネルに出力があります')), 'bad', 10000);
    else if (r.ok && op === 'push') toast(T('プッシュしました'));
    if (r.locks) {
      const d = r.locks.diff;
      const n = T('増えたロック {0}件・消えたロック {1}件・値が変わったロック {2}件', d.added.length, d.removed.length, d.changed.length);
      toast(T('チームのロックの変更を取り込みました（{0}）。ロックマネージャーで確かめて承認するまで、AI の編集は止まります', n), 'lock', 10000);
      app.openLocks();
    }
    if (op === 'commit' && r.ok) edited = false;
    await app.refresh();
    render();
    if (op !== 'commit') void check(true);
  };
  // ---- GitHub からの自動の取り込み（エディタを開いて見ている間だけ、1分に1回ほど「変わったか」だけを聞く） ----
  const remoteLine = h('div', { class: 'pad muted' });
  const AUTO_KEY = 'ages.autoPull';
  const auto = h('input', { type: 'checkbox' }) as HTMLInputElement;
  auto.checked = localStorage.getItem(AUTO_KEY) !== 'off';
  auto.addEventListener('change', () => { localStorage.setItem(AUTO_KEY, auto.checked ? 'on' : 'off'); if (auto.checked) check(false); });
  /** 聞いたのにまだ取り込んでいない上流の先（同じ変更について何度も聞かない） */
  let asked = '';
  let busy = false;
  const sync = async (mode: 'pull' | 'pushpull') => {
    const r = await app.api<{ ok: boolean; out: string; conflict?: boolean; step: string; help?: GitHelp[] }>('/api/git/sync', { body: { mode } });
    out.textContent = r.out;
    showHelp(r.help);
    if (r.ok) toast(mode === 'pull' ? T('GitHub の変更を取り込みました') : T('手元の変更をプッシュし、GitHub の変更を取り込みました'));
    else if (r.conflict) toast(T('手元の変更と GitHub の変更が同じ所で食い違ったので、取り込みをやめました（手元の変更はコミット済み・プッシュはしていません）。どちらを残すか決めて合わせる必要があります（AI に頼めます）'), 'bad', 15000);
    else toast(T('GitHub との同期が止まりました（{0}）: {1}', r.step, r.help?.find((x) => x.level !== 'info')?.title ?? T('Git のパネルに出力があります')), 'warn', 10000);
    await app.refresh();
    render();
  };
  const ask = (s: { remoteHead?: string; behind: number; ahead: number; dirty: number }) => {
    asked = s.remoteHead ?? '';
    const what = [s.dirty ? T('コミットしていない変更 {0}件', s.dirty) : '', s.ahead ? T('プッシュしていないコミット {0}件', s.ahead) : ''].filter(Boolean).join(T('・'));
    modal((close) => h('div', {},
      h('p', {}, T('GitHub に新しい変更があります（{0}件のコミット）。', s.behind)),
      h('p', {}, T('手元にまだプッシュしていない変更があります（{0}）。手元の変更をプッシュしてから、GitHub の変更を取り込みますか？', what)),
      h('p', { class: 'muted' }, T('GitHub に新しいコミットがあるとそのままではプッシュできないので、コミット → 取り込み → プッシュ の順に行います。同じ所を両方で変えていたら、取り込みをやめて元に戻し、プッシュしません。')),
      h('div', { class: 'toolbar' },
        h('button', { onclick: () => { close(); void sync('pushpull'); } }, T('プッシュしてから取り込む')),
        h('button', { onclick: close }, T('あとで')))));
  };
  /** 上流が変わったかを聞き、変わっていれば取り込む（手元に変更があれば聞く）。force は「今すぐ取り込む」 */
  const check = async (force: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const s = await app.api<{ upstream: string | null; remoteHead?: string; behind: number; ahead: number; dirty: number; checked: string; error?: string }>(`/api/git/remote${force ? '?force=1' : ''}`);
      const at = new Date(s.checked).toLocaleTimeString();
      if (!s.upstream) { remoteLine.textContent = T('GitHub: 上流の枝がないので、自動の取り込みは使えません（git push -u で設定）'); return; }
      if (s.error) { remoteLine.textContent = T('GitHub（{0}）に聞けませんでした: {1}（{2}）', s.upstream, s.error, at); return; }
      remoteLine.textContent = s.behind ? T('GitHub（{0}）に新しい変更 {1}件（{2} に確かめた）', s.upstream, s.behind, at) : T('GitHub（{0}）: 最新（{1} に確かめた）', s.upstream, at);
      // プッシュしていないコミットは目立たせる（プッシュが失敗したままに気づけるように）
      if (s.ahead) remoteLine.append(h('span', { style: 'color:var(--warn);font-weight:600' }, T('　⚠ プッシュしていないコミット {0}件', s.ahead)));
      if (!s.behind) return;
      if (!s.dirty && !s.ahead) await sync('pull');
      else if (force || asked !== (s.remoteHead ?? '')) ask(s);
    } catch (e) {
      remoteLine.textContent = `GitHub: ${(e as Error).message}`;
    } finally {
      busy = false;
    }
  };
  setInterval(() => { if (auto.checked && document.visibilityState === 'visible') void check(false); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (auto.checked && document.visibilityState === 'visible') void check(false); });
  if (auto.checked) setTimeout(() => void check(false), 3000);
  const el = h('div', {},
    h('div', { class: 'toolbar' }, h('button', { onclick: run('pull') }, T('プル')), h('button', { onclick: run('commit') }, T('コミット')), h('button', { onclick: run('push') }, T('プッシュ')), h('button', { class: 'icon', onclick: render, title: T('更新') }, '↻')),
    h('div', { class: 'toolbar' }, h('label', {}, auto, T(' GitHub から自動で取り込む（開いている間、1分ごとに確かめる）')), h('button', { onclick: () => void check(true) }, T('今すぐ取り込む'))),
    remoteLine, helpBox, who, status, h('div', { class: 'pad' }, msg), out);
  app.on('change', () => { if (el.classList.contains('active')) render(); });
  return { id: 'git', title: 'Git', el, render };
}

// ---------- 書き出し（Web と、デスクトップ＝Tauri の元） ----------
export function exportPanel(app: App): Panel {
  const status = h('div', { class: 'pad muted' });
  const out = h('pre', { class: 'pad' });
  const desktop = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const fullscreen = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const id = h('input', { type: 'text', placeholder: T('com.自分の名前.ゲーム（デスクトップの初めの1回だけ）'), style: 'width:22em' }) as HTMLInputElement;
  const open = h('a', { href: '/play/', target: '_blank', rel: 'noopener', style: 'display:none' }, T('書き出したものを開く（新しいタブ）'));
  let made = false;
  const opts = h('div', { class: 'toolbar' }, h('label', {}, fullscreen, T(' 全画面で始める')), id);
  const sync = () => { opts.style.display = desktop.checked && !made ? '' : 'none'; };
  desktop.addEventListener('change', sync);
  const render = async () => {
    try {
      const s = await app.api<{ web: string | null; desktop: boolean; id: string | null }>('/api/export');
      made = s.desktop;
      status.textContent = s.web
        ? T('前の書き出し: {0}（dist/web）{1}', new Date(s.web).toLocaleString(), s.desktop ? T('・デスクトップの元あり（dist/desktop。ID {0}）', s.id ?? '?') : '')
        : T('まだ書き出していません');
      open.style.display = s.web ? '' : 'none';
      sync();
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  const run = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    out.textContent = T('書き出しています…');
    try {
      const r = await app.api<{ ok: boolean; out: string }>('/api/export', { body: { desktop: desktop.checked, id: id.value.trim() || undefined, fullscreen: fullscreen.checked } });
      out.textContent = r.out;
      if (r.ok) toast(T('書き出しました（dist/web）'));
      else toast(T('書き出せませんでした。出力を見てください'), 'bad', 8000);
    } catch (e) {
      out.textContent = (e as Error).message;
    } finally {
      btn.disabled = false;
      await render();
    }
  };
  const go = h('button', { onclick: () => void run(go) }, T('書き出す'));
  const el = h('div', {},
    h('div', { class: 'pad muted' }, T('エディタを含まない、ゲームだけのファイル一式を dist/ に作ります（Git には入れない）。Web はフォルダごと置けば遊べ、itch.io なら zip にして HTML のゲームとして上げます。デスクトップ（Steam 向けの exe）は、できた dist/desktop/README.md の手順で作ります（Rust と Tauri の道具が要る）。')),
    h('div', { class: 'toolbar' }, go, h('label', {}, desktop, T(' デスクトップ（Tauri）の元も作る')), open),
    opts, status, out);
  sync();
  return { id: 'export', title: T('書き出し'), el, render };
}
