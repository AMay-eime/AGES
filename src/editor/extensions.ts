// エディタ拡張の受け皿: 拡張（本体の拡張とプロジェクトの拡張）を持ち、窓口ごとに探す。
// 本体の機能（src/editor/builtin/）もプロジェクトの拡張と同じ API で書き、ここに並べる（API が足りているかの確かめと、手本を兼ねる）。
import type { App } from './app.ts';
import { asExtension, fieldKey, matchField, matchRank, type ComponentDrawer, type EditorApi, type EditorExtension, type EditorWindow, type FieldDrawer, type RowDrawer } from './window-api.ts';
import type { Op } from '../core/patch.ts';
import { parseAddress } from '../core/docs.ts';
import { resolvePrefab } from '../core/variant.ts';
import { h, modal, toast } from './ui/dom.ts';
import { BUILTIN_EXTENSIONS } from './builtin/index.ts';
import { createStage } from './stage.ts';
import { inputWidget } from './ui/inspector.ts';
import { SaveData } from '../core/save.ts';
import { ASSET_MIME, PREFAB_MIME } from './ui/assets.ts';

export interface LoadedExtension {
  ext: EditorExtension;
  api: EditorApi;
  /** 本体の拡張（操作ログには inspector と残る） */
  builtin: boolean;
  /** プロジェクトの中の場所 */
  path?: string;
}

/** 拡張に渡す API。win は操作ログに残る名前（プロジェクトの拡張は window:<id>） */
export function makeApi(app: App, win: string): EditorApi {
  return {
    get state() { return app.state; },
    get user() { return app.user; },
    get playing() { return !!app.play; },
    patch: (ops: Op[]) => app.patch(ops, win),
    get(path: string) {
      const a = parseAddress(path);
      if (a.kind === 'table') {
        const view = app.registry.tableView(a.doc);
        if (!a.entity) return view.rows;
        const row = view.has(a.entity) ? view.get(a.entity) as Record<string, unknown> : undefined;
        let v: unknown = a.field ? row?.[a.field] : row;
        for (const k of a.sub ?? []) v = v == null ? undefined : (v as Record<string | number, unknown>)[k];
        return v;
      }
      let holder: { components: Record<string, Record<string, unknown>> } | undefined;
      if (a.kind === 'prefab') {
        try { holder = resolvePrefab(new Map(Object.entries(app.state.prefabs)), a.doc); } catch { holder = undefined; }
      } else holder = app.sceneView(a.doc)?.entities.find((e) => e.id === a.entity);
      const comp = a.component ? holder?.components[a.component] : undefined;
      if (!a.field) return comp ?? holder;
      return comp && a.field in comp ? comp[a.field] : app.registry.components.get(a.component!)?.fields[a.field]?.default;
    },
    select(address: string | null, add = false) {
      if (address === null) return app.select(null);
      const a = parseAddress(address);
      // 表の行: 表のエディタをその行で開く（選んだ行は api.selection に出る）
      if (a.kind === 'table') return void app.emit('openTable', { name: a.doc, row: a.entity });
      app.select(a.kind === 'prefab' ? { kind: 'prefab', name: a.doc } : { kind: 'scene', scene: a.doc, id: a.entity! }, { add });
    },
    play: (opts) => app.startPlay({ ...opts }),
    stop: () => app.stopPlay(),
    table: (name) => app.registry.tableView(name),
    simulate: (frames, keys, seed) => app.simulate(frames, keys, seed),
    sheet: (image: string) => app.registry.sheets.get(image),
    assetUrl: (path) => app.assetUrl(path),
    notify: (text, kind = 'info') => { toast(text, kind === 'info' ? '' : kind, kind === 'bad' ? 8000 : 4000); },
    get selection() { if (app.row) return `$${app.row.table}.${app.row.id}`; const s = app.sel; return !s ? null : s.kind === 'prefab' ? `@${s.name}` : `${s.scene}#${s.id}`; },
    get selected() { if (app.row) return [`$${app.row.table}.${app.row.id}`]; const s = app.sel; return !s ? [] : s.kind === 'prefab' ? [`@${s.name}`] : app.selectedIds().map((id) => `${s.scene}#${id}`); },
    ask: (title, value = '') => askText(title, value),
    input: (field, value, onChange) => inputWidget(app, field, value, onChange),
    stage: (el, opts) => createStage(app, el, opts),
    get game() { return app.play?.game ?? null; },
    pause: (paused) => {
      if (!app.play) return;
      if (paused === undefined || paused !== app.play.paused) app.togglePause();
    },
    step: (frames = 1) => {
      if (!app.play) app.stepOnce(); else { if (!app.play.paused) app.togglePause(); app.stepOnce(); }
      for (let i = 1; i < frames && app.play; i++) app.stepOnce();
    },
    get speed() { return app.playSpeed; },
    set speed(v: number) { app.playSpeed = v; },
    get save() {
      const data = () => app.play?.game.save ?? new SaveData(app.saveStore());
      return { read: (k: string) => data().read(k), write: (k: string, v: unknown) => data().write(k, v), delete: (k: string) => data().delete(k), keys: () => data().keys() };
    },
    schema: (name) => (name.startsWith('$') ? app.registry.tables.get(name.slice(1)) : app.registry.components.get(name)),
    modal: (build) => { modal(build); },
    show: (extId, args) => { app.emit('showPanel', `win:${extId}`); app.emit(`show:${extId}`, args); },
    dragTypes: { asset: ASSET_MIME, prefab: PREFAB_MIME },
    on: ((ev: string, fn: (d?: unknown) => void) => app.on(ev === 'show' ? `show:${win.replace(/^window:/, '')}` : ev, fn)) as EditorApi['on'],
    h: h as unknown as EditorApi['h'],
  };
}

/** 本体の拡張（いつもある） */
export function builtinExtensions(app: App): LoadedExtension[] {
  return BUILTIN_EXTENSIONS.map((ext) => ({ ext, api: makeApi(app, 'inspector'), builtin: true }));
}

/** プロジェクトの拡張を、拡張の形にそろえて読む */
export function projectExtension(app: App, path: string, mod: EditorExtension | EditorWindow): LoadedExtension {
  const ext = asExtension(mod);
  return { ext, api: makeApi(app, `window:${ext.id}`), builtin: false, path };
}

/** この欄に使う見せ方（細かい match ほど先。同じ細かさならプロジェクトの拡張が本体より先）。path は欄の住所（入れ子の中・表の欄も） */
export function fieldDrawerFor(app: App, path: string, type: string): { drawer: FieldDrawer; x: LoadedExtension } | undefined {
  let best: { drawer: FieldDrawer; x: LoadedExtension; rank: number } | undefined;
  const key = fieldKey(path);
  for (const x of app.extensions) {
    for (const d of x.ext.fields ?? []) {
      for (const m of [d.match].flat()) {
        if (!matchField(m, path, key, type)) continue;
        const rank = matchRank(m) * 2 + (x.builtin ? 0 : 1);
        if (!best || rank > best.rank) best = { drawer: d, x, rank };
      }
    }
  }
  return best && { drawer: best.drawer, x: best.x };
}

/** この部品に使う見せ方（本体の拡張から順に、すべて） */
export function componentDrawersFor(app: App, component: string): { drawer: ComponentDrawer; x: LoadedExtension }[] {
  return app.extensions.flatMap((x) => (x.ext.components ?? []).filter((d) => d.component === component).map((drawer) => ({ drawer, x })));
}

/** この表の行の見せ方（本体の拡張から順に、すべて） */
export function rowDrawersFor(app: App, table: string): { drawer: RowDrawer; x: LoadedExtension }[] {
  return app.extensions.flatMap((x) => (x.ext.rows ?? []).filter((d) => d.table === table).map((drawer) => ({ drawer, x })));
}

/** 右クリックのメニューの項目（拡張の menus から。when で絞る） */
export function menuItemsFor(app: App, where: 'entity' | 'prefab', targets: string[]): [string, () => void][] {
  const out: [string, () => void][] = [];
  for (const x of app.extensions) {
    for (const m of x.ext.menus ?? []) {
      if (m.where !== where) continue;
      try { if (m.when && !m.when(targets, x.api)) continue; } catch { continue; }
      out.push([m.label, () => { Promise.resolve(m.run(targets, x.api)).catch((e) => toast(`${x.ext.id}: ${(e as Error).message}`, 'bad', 8000)); }]);
    }
  }
  return out;
}

/** 1行の文字を尋ねる小さな窓 */
export function askText(title: string, value = ''): Promise<string | null> {
  return new Promise((done) => {
    let answered = false;
    modal((close) => {
      const input = h('input', { type: 'text', value, style: 'flex:1' }) as HTMLInputElement;
      const finish = (v: string | null) => { if (answered) return; answered = true; close(); done(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); if (e.key === 'Escape') finish(null); });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return h('div', {}, h('h3', {}, title), h('div', { class: 'row' }, input),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: () => finish(null) }, 'やめる'), h('button', { class: 'primary', onclick: () => finish(input.value.trim()) }, 'OK')));
    });
  });
}
