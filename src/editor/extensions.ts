// エディタ拡張の受け皿: 拡張（本体の拡張とプロジェクトの拡張）を持ち、窓口ごとに探す。
// 本体の機能（src/editor/builtin/）もプロジェクトの拡張と同じ API で書き、ここに並べる（API が足りているかの確かめと、手本を兼ねる）。
import type { App } from './app.ts';
import { asExtension, fieldKey, matchField, matchRank, type ComponentDrawer, type EditorApi, type EditorExtension, type EditorWindow, type FieldDrawer, type RowDrawer } from './window-api.ts';
import type { Change, Op } from '../core/patch.ts';
import { defaultOf, defaultsOf, type Field } from '../core/schema.ts';
import { parseAddress, type PrefabDoc } from '../core/docs.ts';
import { childAt, instanceChildren, prefabChildren, resolvePrefab } from '../core/variant.ts';
import { h, modal, toast } from './ui/dom.ts';
import { BUILTIN_EXTENSIONS } from './builtin/index.ts';
import { createStage } from './stage.ts';
import { inputWidget } from './ui/inspector.ts';
import { SaveData } from '../core/save.ts';
import { ASSET_MIME, PREFAB_MIME } from './ui/assets.ts';
import { runTrial, startTrial } from '../core/trial.ts';
import { T } from './i18n.ts';

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
  let queue: Promise<Change[] | null> = Promise.resolve(null);
  return {
    get state() { return app.state; },
    get user() { return app.user; },
    get playing() { return !!app.play; },
    // 拡張ごとに1つずつ順に送る。関数を渡すと、前の変更が終わった後の最新の中身で ops を作る（続けてのクリックで古い値から作らない）
    patch: (ops) => {
      const send = () => { const list = typeof ops === 'function' ? ops() : ops; return list.length ? app.patch(list, win) : Promise.resolve([] as Change[]); };
      return (queue = queue.then(send, send));
    },
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
      const prefabs = new Map(Object.entries(app.state.prefabs));
      if (a.child?.length) {
        // 子（@プレハブ/子・シーン#置いた物/子）: 元・子にしたプレハブ・置いた物ごとの値を重ねた子
        try {
          const raw = a.kind === 'scene' ? app.state.scenes[a.doc]?.entities.find((e) => e.id === a.entity) : undefined;
          const kids = a.kind === 'prefab' ? prefabChildren(prefabs, a.doc) : raw ? instanceChildren(prefabs, raw) : [];
          holder = childAt(kids, a.child, a.kind === 'prefab' ? `@${a.doc}` : `${a.doc}#${a.entity}`);
          // 位置の部品は、書いていなくても出すときに付く（親から見た位置）
          if (a.component && !holder.components[a.component] && (a.component === 'Transform' || a.component === 'Transform3D')) holder = { components: { ...holder.components, [a.component]: {} } };
        } catch { return undefined; } // ない子
      } else if (a.kind === 'prefab') {
        try { holder = resolvePrefab(prefabs, a.doc); } catch { holder = undefined; }
      } else holder = app.sceneView(a.doc)?.entities.find((e) => e.id === a.entity);
      const comp = a.component ? holder?.components[a.component] : undefined;
      // 部品まるごとは、書いていないフィールドを既定値で埋めて返す
      if (!a.field) return a.component ? (comp ? { ...defaultsOf(app.registry.components.get(a.component)!), ...structuredClone(comp) } : undefined) : holder;
      const def = app.registry.components.get(a.component!)?.fields[a.field];
      const top = comp && a.field in comp ? comp[a.field] : def ? defaultOf(def) : undefined;
      return nestedValue(top, def, a.sub ?? []);
    },
    select(address: string | null, add = false) {
      if (address === null) return app.select(null);
      const a = parseAddress(address);
      // 表の行: 表のエディタをその行で開く（選んだ行は api.selection に出る）
      if (a.kind === 'table') return void app.emit('openTable', { name: a.doc, row: a.entity });
      app.select(a.kind === 'prefab' ? { kind: 'prefab', name: a.doc } : { kind: 'scene', scene: a.doc, id: a.entity! }, { add });
    },
    play: (opts = {}) => {
      const { show, ...rest } = opts;
      app.startPlay(rest);
      if (show !== false && app.play) app.emit('showPanel', 'game');
    },
    stop: () => app.stopPlay(),
    table: (name) => app.registry.tableView(name),
    prefabs: (tag) => {
      // 派生は元と重ねた形（受け継いだタグ・部品も）。元が見つからない派生はそのまま
      const map = new Map(Object.entries(app.state.prefabs));
      const out: PrefabDoc[] = [];
      for (const name of map.keys()) { let p: PrefabDoc; try { p = resolvePrefab(map, name); } catch { p = map.get(name)!; } if (!tag || (p.tags ?? []).includes(tag)) out.push(p); }
      return out;
    },
    simulate: (frames, keys, seed) => app.simulate(frames, keys, seed),
    sheet: (image: string) => app.registry.sheets.get(image),
    assetUrl: (path) => app.assetUrl(path),
    notify: (text, kind = 'info') => { toast(text, kind === 'info' ? '' : kind, kind === 'bad' ? 8000 : 4000); },
    get selection() { if (app.row) return `$${app.row.table}.${app.row.id}`; const s = app.sel; return !s ? null : s.kind === 'prefab' ? `@${s.name}` : `${s.scene}#${s.id}`; },
    get selected() { if (app.row) return [`$${app.row.table}.${app.row.id}`]; const s = app.sel; return !s ? [] : s.kind === 'prefab' ? [`@${s.name}`] : app.selectedIds().map((id) => `${s.scene}#${id}`); },
    ask: (title, value = '') => askText(title, value),
    input: (field, value, onChange) => inputWidget(app, field, value, onChange),
    stage: (el, opts) => createStage(app, el, opts),
    // 画面なしで動かす（舞台と同じ作り方。少しずつ回す）
    run: async (opts) => {
      const t = startTrial(app.registry, app.state.config, opts, { lang: app.previewLang || undefined });
      return runTrial(t, { frames: opts.frames ?? 600, onFrame: opts.onFrame, onEvent: opts.onEvent, until: opts.until, signal: opts.signal });
    },
    get game() { return app.play?.game ?? null; },
    pause: (paused) => {
      if (!app.play) return;
      if (paused === undefined || paused !== app.play.paused) app.togglePause();
    },
    step: (frames = 1) => {
      if (!app.play) app.stepOnce(); else { if (!app.play.paused) app.togglePause(); app.stepOnce(); }
      for (let i = 1; i < frames && app.play; i++) app.stepOnce();
    },
    get paused() { return !!app.play?.paused; },
    get perf() { return { ...app.perf }; },
    overlay: (fn) => { app.overlays.add(fn); return () => { app.overlays.delete(fn); }; },
    get speed() { return app.playSpeed; },
    set speed(v: number) { app.playSpeed = v; },
    get save() {
      const data = () => app.play?.game.save ?? new SaveData(app.saveStore());
      return { read: (k: string) => data().read(k), write: (k: string, v: unknown) => data().write(k, v), delete: (k: string) => data().delete(k), keys: () => data().keys() };
    },
    schema: (name) => (name.startsWith('$') ? app.registry.tables.get(name.slice(1)) : app.registry.components.get(name)),
    modal: (build) => { modal(build); },
    show: (extId, args) => {
      // 相手の拡張がいなければ知らせて false（読み込みに失敗した・登録し忘れ）
      if (!app.extensions.some((x) => x.ext.id === extId)) { toast(T('拡張 {0} がありません（ages.project.json の editorWindows を確かめる）', extId), 'bad'); return false; }
      app.emit('showPanel', `win:${extId}`); app.emit(`show:${extId}`, args);
      return true;
    },
    dragTypes: { asset: ASSET_MIME, prefab: PREFAB_MIME },
    on: ((ev: string, fn: (d?: unknown) => void) => app.on(ev === 'show' ? `show:${win.replace(/^window:/, '')}` : ev, fn)) as EditorApi['on'],
    h: h as unknown as EditorApi['h'],
  };
}

/** 入れ子の中の値（書いていない所は、その型の既定値） */
function nestedValue(v: unknown, f: Field | undefined, sub: (string | number)[]): unknown {
  for (const k of sub) {
    const inner: Field | undefined = f?.type === 'struct' ? f.fields[String(k)] : f?.type === 'list' ? f.of : undefined;
    const x = v == null ? undefined : (v as Record<string | number, unknown>)[k];
    v = x === undefined && inner ? defaultOf(inner) : x;
    f = inner;
  }
  return v;
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
  // AI への付箋（1つ選んでいるとき。AI は次の作業の区切りで読む）
  if (targets.length === 1) out.push([T('📌 AI への付箋…'), () => void noteFor(app, targets[0])]);
  return out;
}

/** その住所に AI への付箋を貼る（文字を尋ねる） */
export async function noteFor(app: App, addr: string): Promise<void> {
  const text = await askText(T('📌 {0} への付箋（AI は次の作業の区切りで読みます）', addr));
  if (text) await app.ai.note(text, addr);
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
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: () => finish(null) }, T('やめる')), h('button', { class: 'primary', onclick: () => finish(input.value.trim()) }, 'OK')));
    });
  });
}
