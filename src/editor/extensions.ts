// エディタ拡張の受け皿: 拡張（本体の拡張とプロジェクトの拡張）を持ち、窓口ごとに探す。
// 本体の機能（src/editor/builtin/）もプロジェクトの拡張と同じ API で書き、ここに並べる（API が足りているかの確かめと、手本を兼ねる）。
import type { App } from './app.ts';
import { asExtension, matchField, matchRank, type ComponentDrawer, type EditorApi, type EditorExtension, type EditorWindow, type FieldDrawer } from './window-api.ts';
import type { Op } from '../core/patch.ts';
import { parseAddress } from '../core/docs.ts';
import { resolvePrefab } from '../core/variant.ts';
import { h, toast } from './ui/dom.ts';
import { BUILTIN_EXTENSIONS } from './builtin/index.ts';

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
      let holder: { components: Record<string, Record<string, unknown>> } | undefined;
      if (a.kind === 'prefab') {
        try { holder = resolvePrefab(new Map(Object.entries(app.state.prefabs)), a.doc); } catch { holder = undefined; }
      } else holder = app.state.scenes[a.doc]?.entities.find((e) => e.id === a.entity);
      const comp = a.component ? holder?.components[a.component] : undefined;
      if (!a.field) return comp ?? holder;
      return comp && a.field in comp ? comp[a.field] : app.registry.components.get(a.component!)?.fields[a.field]?.default;
    },
    select(address: string) {
      const a = parseAddress(address);
      app.select(a.kind === 'prefab' ? { kind: 'prefab', name: a.doc } : { kind: 'scene', scene: a.doc, id: a.entity! });
    },
    simulate: (frames, keys, seed) => app.simulate(frames, keys, seed),
    sheet: (image: string) => app.registry.sheets.get(image),
    notify: (text, kind = 'info') => { toast(text, kind === 'info' ? '' : kind, kind === 'bad' ? 8000 : 4000); },
    on: ((ev: string, fn: (d?: unknown) => void) => app.on(ev, fn)) as EditorApi['on'],
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

/** この欄に使う見せ方（細かい match ほど先。同じ細かさならプロジェクトの拡張が本体より先） */
export function fieldDrawerFor(app: App, path: string, component: string, field: string, type: string): { drawer: FieldDrawer; x: LoadedExtension } | undefined {
  let best: { drawer: FieldDrawer; x: LoadedExtension; rank: number } | undefined;
  for (const x of app.extensions) {
    for (const d of x.ext.fields ?? []) {
      for (const m of [d.match].flat()) {
        if (!matchField(m, path, component, field, type)) continue;
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
