// インスペクタ。コンポーネントの宣言（型・範囲・説明）から入力欄を自動で作る。
// 各フィールドに 🔒（AIが変更できないロック）を付けられる。人が触った値には ★ が付く。
import type { App } from '../app.ts';
import type { Field } from '../../core/schema.ts';
import { ASSET_LABEL, brief, defaultOf, matrixSize, typeOf, variantDefault, type ListField, type OneOfField, type StructField } from '../../core/schema.ts';
import { formatSub, getIn, setIn, type EntityData, type PrefabDoc } from '../../core/docs.ts';
import { prefabChoices, resolveEntity, resolvePrefab } from '../../core/variant.ts';
import type { Op } from '../../core/patch.ts';
import { h, clear, time, modal, toast, menu } from './dom.ts';
import { findFrame, frameLabel, listFrames, type FrameRef, type SheetDef } from '../../core/sheet.ts';
import { EASES, EASE_NAMES, type EaseName } from '../../core/ease.ts';
import { buttonLabel } from '../../core/input.ts';
import { captureNext } from '../../input/devices.ts';
import { ASSET_MIME, assetLabel } from './assets.ts';
import { kindOf } from '../../core/assets.ts';
import type { Panel } from './layout.ts';
import { componentDrawersFor, fieldDrawerFor, noteFor } from '../extensions.ts';
import type { EditorApi, FieldView } from '../window-api.ts';
import { T, TD } from '../i18n.ts';

interface Live { path: string; comp: string; field: string; set(v: unknown): void; el: HTMLElement }

export function inspectorPanel(app: App): Panel {
  const el = h('div', {});
  let live: Live[] = [];
  // パラメータが多いとき用: ロックした値（もう人が決めた値）を隠す。設定で切り替える（人ごとにブラウザに記憶する）
  const setHide = (v: boolean) => { app.showLocked = !v; };

  // 拡張（欄・部品の見せ方）の後片付け。描き直すたびに呼ぶ
  let cleanups: (() => void)[] = [];
  const render = () => {
    runCleanups(cleanups);
    cleanups = [];
    live = [];
    const sel = app.sel;
    if (!app.state || app.state.error || !app.registry) return clear(el, h('div', { class: 'pad muted' }, app.state?.error ?? T('読み込み中…')));
    if (!sel) return clear(el, h('div', { class: 'pad muted' }, T('階層・ゲーム画面・プロジェクトから選ぶと、ここに表示されます。')));

    const playing = !!app.play && sel.kind === 'scene';
    const base = sel.kind === 'scene' ? `${sel.scene}#${sel.id}` : `@${sel.name}`;
    let holder: { name?: string; tags?: string[]; components: Record<string, Record<string, unknown>> } | undefined;
    if (playing) {
      const e = app.play!.game.world.get(sel.id);
      holder = e ? { name: e.name, tags: e.tags, components: e.c } : undefined;
    } else if (sel.kind === 'scene') {
      holder = app.state.scenes[sel.scene]?.entities.find((e) => e.id === sel.id);
      // プレハブのインスタンス: プレハブと重ねた値を見せ、プレハブから変えた所に印と「戻す」を付ける（派生と同じ）
      if (holder && (holder as EntityData).prefab) {
        try { holder = resolveEntity(new Map(Object.entries(app.state.prefabs)), holder as EntityData); } catch (e) { return clear(el, h('div', { class: 'pad', style: 'color:var(--bad)' }, (e as Error).message)); }
      }
    } else {
      holder = app.state.prefabs[sel.name];
      // 派生: 元と重ねた値を見せ、元から変えた所に印と「元に戻す」を付ける
      if (holder && (holder as PrefabDoc).base) {
        try { holder = resolvePrefab(new Map(Object.entries(app.state.prefabs)), sel.name); } catch (e) { return clear(el, h('div', { class: 'pad', style: 'color:var(--bad)' }, (e as Error).message)); }
      }
    }
    const rawEnt = sel.kind === 'scene' && !playing ? app.state.scenes[sel.scene]?.entities.find((e) => e.id === sel.id) : undefined;
    const raw: { components: Record<string, Record<string, unknown>>; remove?: string[] } | undefined = sel.kind === 'prefab' ? app.state.prefabs[sel.name] : rawEnt?.prefab ? rawEnt : undefined;
    /** 受け継ぐ元: 派生の元か、インスタンスのプレハブ */
    const variantOf = !playing ? (sel.kind === 'prefab' ? app.state.prefabs[sel.name]?.base : rawEnt?.prefab) : undefined;
    const instance = !!rawEnt?.prefab;
    const what = instance ? T('インスタンス') : T('派生');
    const own = (c: string, f?: string) => !!raw?.components[c] && (f === undefined || f in raw.components[c]);
    if (!holder) return clear(el, h('div', { class: 'pad muted' }, playing ? T('{0} はもう存在しません', sel.kind === 'scene' ? sel.id : '') : T('見つかりません')));
    const savable = sel.kind === 'prefab' || !!app.state.scenes[sel.scene]?.entities.some((e) => e.id === sel.id);

    const nameInput = h('input', {
      type: 'text', value: holder.name ?? '', style: 'flex:1;font-weight:600', disabled: playing,
      // プレハブの名前はファイルの名前（指している所も直す renamePrefab）。シーンの物の名前は見せる名前（rename）
      onchange: () => {
        if (sel.kind === 'scene') { app.patch([{ op: 'rename', target: base, name: nameInput.value }]); return; }
        const to = nameInput.value.trim();
        if (!to || to === sel.name) { nameInput.value = sel.name; return; }
        app.patch([{ op: 'renamePrefab', name: sel.name, to }]).then((r) => { if (r) app.select({ kind: 'prefab', name: to }); });
      },
    });
    const lockedHere = Object.keys(app.state.locks).filter((k) => k.startsWith(base + '.')).length;
    const head = h('div', { class: 'pad', style: 'border-bottom:1px solid var(--line)' },
      h('div', { class: 'row' }, nameInput,
        h('label', { class: 'row muted', style: 'gap:4px;white-space:nowrap', title: T('ロックした値を表示しない（人が決め終えた値を画面から外して、残りに集中する）') },
          h('input', { type: 'checkbox', checked: !app.showLocked, onchange: (e: Event) => setHide((e.target as HTMLInputElement).checked) }), T('🔒を隠す{0}', lockedHere ? T('（{0}）', lockedHere) : ''))),
      h('div', { class: 'muted', style: 'margin-top:4px;font:var(--mono)' }, base, holder.tags?.length ? `  tags:${holder.tags.join(',')}` : '',
        playing ? T('  ▶ 実行中（変更は停止時に保存するか選べます）') : ''),
      sel.kind === 'prefab' && !playing ? prefabBar(app, sel.name, app.state.prefabs[sel.name]) : null,
      rawEnt && !playing ? instanceBar(app, base, rawEnt) : null,
      app.extra.length ? h('div', { class: 'muted', style: 'margin-top:4px' }, T('ほか {0}体も選んでいます（{1}{2}）。ここで変えるのはこの物だけ。動かす・複製・削除はまとめて', app.extra.length, app.extra.slice(0, 4).join(', '), app.extra.length > 4 ? ' …' : '')) : null);

    let hiddenCount = 0;
    const comps = Object.entries(holder.components).map(([cname, values]) => {
      const def = app.registry.components.get(cname);
      if (!def) return h('div', { class: 'comp' }, h('div', { class: 'head' }, cname, h('span', { class: 'desc', style: 'color:var(--bad)' }, T('未定義のコンポーネント'))));
      const entries = Object.entries(def.fields);
      // 部品の見せ方（拡張）: 欄の上に中身を足す。hide の欄は出さない
      const cds = componentDrawersFor(app, cname);
      const hidden = new Set(cds.flatMap(({ drawer }) => (drawer.hide === 'all' ? entries.map(([k]) => k) : drawer.hide ?? [])));
      const sections = cds.map(({ drawer, x }) => {
        const box = h('div', { class: 'ext-comp', 'data-ext': x.ext.id });
        const filled = { ...Object.fromEntries(entries.map(([k, f]) => [k, defaultOf(f)])), ...values };
        const view = {
          target: base, component: cname, values: filled, playing, editable: !playing && savable, holder: holder!.components,
          locked: (field: string) => !!app.state.locks[`${base}.${cname}.${field}`],
          set: (field: string, v: unknown) => {
            if (app.state.locks[`${base}.${cname}.${field}`]) { toast(T('🔒 {0}.{1}.{2} はロックされています', base, cname, field), 'lock'); return; }
            if (playing || !savable) return;
            x.api.patch([{ op: 'set', path: `${base}.${cname}.${field}`, value: v }]);
          },
        };
        mountExt(box, x.ext.id, () => drawer.mount(box, view, x.api), cleanups);
        return box;
      });
      const shown = entries.filter(([fname]) => !hidden.has(fname));
      const visible = !app.showLocked ? shown.filter(([fname]) => !app.state.locks[`${base}.${cname}.${fname}`]) : shown;
      hiddenCount += shown.length - visible.length;
      const rows = visible.map(([fname, f]) => {
        const path = `${base}.${cname}.${fname}`;
        const has = fname in values;
        const value = has ? values[fname] : defaultOf(f);
        const lock = app.state.locks[path];
        const touched = app.state.touched[path];
        const commit = (v: unknown, final: boolean) => {
          if (playing) {
            const e = app.play!.game.world.get(sel.kind === 'scene' ? sel.id : '');
            if (e?.c[cname]) e.c[cname][fname] = v;
            if (final && savable) app.play!.edits.set(path, v);
          } else if (final) {
            app.patch([{ op: 'set', path, value: v }]);
          }
        };
        // リスト・構造体・どれか1つ: 中まで並べて編集する。変更は中の場所ごとの操作で送る（操作ログが細かく残る）
        const nestedEmit = (op: NestedOp) => {
          if (playing) {
            const e = app.play!.game.world.get(sel.kind === 'scene' ? sel.id : '');
            if (!e?.c[cname]) return;
            e.c[cname][fname] = applyNested(e.c[cname][fname], op);
            if (savable) app.play!.edits.set(path, structuredClone(e.c[cname][fname]));
            render();
          } else app.patch([toOp(path, op)]);
        };
        // 拡張の欄の見せ方からの変更（入れ子の中も）: 再生中はその場の値に、止めているときは拡張の api で
        const extSet = (p: string, sub: (string | number)[], v: unknown, final: boolean, api: EditorApi) => {
          if (playing) { if (!sub.length) commit(v, final); else if (final) nestedEmit({ kind: 'set', sub, value: v }); } else if (final) void api.patch([{ op: 'set', path: p, value: v }]);
        };
        const wctx: Ctx = { comp: cname, field: fname, holder: holder!.components, ext: { playing, cleanups, set: extSet } };
        // シェーダーの値: 選んだシェーダーの uniform を並べる
        const pf = f.type === 'params' ? app.registry.shaderParams(values[f.of]) : null;
        const standard = () => f.type === 'matrix'
          ? matrixWidget(app, path, value, f.cell ?? 'number')
          : f.type === 'params' ? { el: pf ? nestedWidget(app, pf, value, path, [], nestedEmit, wctx) : h('span', { class: 'muted' }, values[f.of] ? T('シェーダー {0} が見つかりません', values[f.of]) : T('{0} でシェーダーを選ぶと、ここに値が並びます', f.of)), set: () => {} }
          : isNested(f) ? { el: nestedWidget(app, f, value, path, [], nestedEmit, wctx), set: () => {} }
          : widget(app, f, value, commit, wctx);
        // 欄の見せ方（拡張）があれば、それで作る
        const drawn = drawnField(app, { path, f, value, isDefault: !has, sub: [], ctx: wctx, standard: () => standard().el });
        const w: { el: HTMLElement; set(v: unknown): void } = drawn ? { el: drawn, set: () => {} } : standard();
        // ロックされた値は、ここでは見るだけ（変えるのはロックマネージャーで）
        if (lock) { w.el.setAttribute('inert', ''); w.el.classList.add('locked-value'); }
        const lockBtn = h('button', {
          class: `icon lockbtn ${lock ? 'on' : ''}`,
          title: lock ? T('🔒 ロック中（{0} {1}）{2}\nAI もエディタも変えられません。クリックでロックマネージャーを開く（外す・値を変える）', lock.who, time(lock.t), lock.note ? '\n' + lock.note : '') : T('ロックする（AI もエディタも変えられなくなります。外すのはロックマネージャーで）'),
          disabled: !savable || (playing && !lock),
          onclick: () => (lock ? app.openLocks(path) : app.lock([path])),
        }, lock ? '🔒' : '🔓');
        // 派生・インスタンスで元（プレハブ）から変えた値は印を付け、元の値に戻せるようにする
        const over = variantOf && own(cname, fname) && !!app.state.prefabs[variantOf] ? true : false;
        const revert = over && !lock ? h('button', { class: 'icon tiny', title: T('元（@{0}）の値に戻す', variantOf), onclick: () => app.patch([{ op: 'revert', path }]) }, '↺') : null;
        const row = h('div', {
          class: `field ${isWide(f) ? 'wide' : ''} ${has ? '' : 'default'} ${touched ? 'touched' : ''} ${lock ? 'locked' : ''} ${over ? 'override' : ''}`,
          'data-ai': path, 'data-path': path,
        }, h('label', { oncontextmenu: (e: MouseEvent) => { e.preventDefault(); menu(e.clientX, e.clientY, [[T('📌 AI への付箋…'), () => void noteFor(app, path)]]); }, title: T('{0}: {1}{2}{3}{4}', fname, brief(f), f.desc ? '\n' + TD(f.desc) : '', touched ? T('\n★ {0} が {1} に調整', touched.who, time(touched.t)) : '', variantOf ? (over ? T('\n{0}で変えた値（元 @{1} から）', what, variantOf) : T('\n元 @{0} から受け継いだ値', variantOf)) : has ? '' : T('\n（省略中: 既定値）')) }, revert, fname), w.el, lockBtn);
        live.push({ path, comp: cname, field: fname, set: w.set, el: row });
        return row;
      });
      const allLocked = entries.length > 0 && visible.length === 0;
      const inheritedComp = variantOf && !!resolvedBase(app, variantOf)?.components[cname];
      return h('div', { class: 'comp' },
        h('div', { class: 'head' }, cname, h('span', { class: 'desc', title: TD(def.desc) }, allLocked ? T('（すべて🔒）') : variantOf && !inheritedComp ? T('（{0}で足した部品）{1}', what, TD(def.desc)) : TD(def.desc)),
          inheritedComp && own(cname) && !playing ? h('button', { class: 'icon', title: T('{0} の値をすべて元（@{1}）に戻す', cname, variantOf), onclick: () => app.patch([{ op: 'revert', path: `${base}.${cname}` }]) }, '↺') : null,
          cname === 'Sound' ? h('button', { class: 'icon', title: T('今の設定で試しに鳴らす'), onclick: () => app.previewSound(holder!.components.Sound as never) }, '▶') : null,
          !playing && savable && !entries.every(([fname]) => app.state.locks[`${base}.${cname}.${fname}`]) ? h('button', { class: 'icon', title: T('{0} の値をまとめてロックする（外すのはロックマネージャーで）', cname), onclick: () => app.lock(entries.map(([fname]) => `${base}.${cname}.${fname}`).filter((p2) => !app.state.locks[p2])) }, '🔓') : null,
          !playing && h('button', { class: 'icon', title: T('{0} を外す', cname), onclick: () => app.patch([{ op: 'removeComponent', target: base, component: cname }]) }, '×')),
        sections, rows);
    });

    const missing = [...app.registry.components.keys()].filter((n) => !(n in holder!.components));
    const add = !playing && missing.length
      ? h('div', { class: 'pad' }, h('select', {
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v) app.patch([{ op: 'addComponent', target: base, component: v }]);
        },
      }, h('option', { value: '' }, T('＋ コンポーネントを追加…')), missing.map((n) => h('option', { value: n }, `${n} — ${TD(app.registry.components.get(n)!.desc)}`))))
      : null;

    // 派生・インスタンスで外した、元の部品（戻せる）
    const removed = variantOf && raw?.remove?.length
      ? h('div', { class: 'pad muted' }, T('元から外した部品: '), raw.remove.map((c) => h('button', { class: 'tiny', title: T('{0} を元（@{1}）から受け継ぐように戻す', c, variantOf), onclick: () => app.patch([{ op: 'revert', path: `${base}.${c}` }]) }, `↺ ${c}`)))
      : null;
    const note = hiddenCount
      ? h('div', { class: 'pad muted', style: 'font-size:12px;cursor:pointer', onclick: () => setHide(false) }, T('🔒 ロック中の {0} 項目を隠しています（クリックで表示）', hiddenCount))
      : null;
    clear(el, head, note, comps, removed, add);
  };

  // 実行中は値を画面に流し込む（入力中の欄は触らない）
  setInterval(() => {
    if (!app.play || app.sel?.kind !== 'scene') return;
    const e = app.play.game.world.get(app.sel.id);
    if (!e) return;
    for (const l of live) {
      if (l.el.contains(document.activeElement)) continue;
      const v = e.c[l.comp]?.[l.field];
      if (v !== undefined) l.set(v);
    }
  }, 120);

  app.on('change', render);
  app.on('select', render);
  app.on('nestToggle', render);
  app.on('settings', render);
  app.on('play', render);
  app.on('extensions', render);
  return { id: 'inspector', title: T('インスペクタ'), el, render };
}

/** 派生の元を、元と重ねた形で（見つからなければ undefined） */
function resolvedBase(app: App, name: string): PrefabDoc | undefined {
  try { return resolvePrefab(new Map(Object.entries(app.state.prefabs)), name); } catch { return undefined; }
}

/** プレハブの帯: 派生の元へ移る・派生を作る・切り離す */
function prefabBar(app: App, name: string, raw: PrefabDoc): HTMLElement {
  const derive = () => modal((close) => {
    const input = h('input', { type: 'text', value: `${name}_variant`, style: 'flex:1' }) as HTMLInputElement;
    const go = () => { const v = input.value.trim(); close(); if (v) app.patch([{ op: 'addPrefab', name: v, base: name }]).then((r) => { if (r) app.select({ kind: 'prefab', name: v }); }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return h('div', {}, h('h3', {}, T('@{0} の派生を作る', name)),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, '@'), input),
      h('p', { class: 'muted' }, T('元の値を受け継ぎ、変えた値だけを持つプレハブです。元を変えると、変えていない値は一緒に変わります。')),
      h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, T('やめる')), h('button', { class: 'primary', onclick: go }, T('作る'))));
  });
  const kids = Object.values(app.state.prefabs).filter((p) => p.base === name).map((p) => p.name);
  return h('div', { class: 'row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' },
    raw.base ? h('span', { class: 'muted' }, T('派生の元: '), h('a', { href: '#', style: 'color:var(--accent)', onclick: (e: Event) => { e.preventDefault(); app.select({ kind: 'prefab', name: raw.base! }); } }, '@' + raw.base)) : null,
    kids.length ? h('span', { class: 'muted' }, T('派生: {0}', kids.map((k) => '@' + k).join(' '))) : null,
    h('span', { style: 'flex:1' }),
    h('button', { class: 'tiny', title: T('このプレハブを元にして、一部だけ変えたプレハブを作る'), onclick: derive }, T('＋派生を作る')),
    raw.base ? h('button', { class: 'tiny', title: T('元から切り離して、今の値をまるごと持つふつうのプレハブにする（値は変わらない）'), onclick: () => app.patch([{ op: 'setPrefab', name, base: null }]) }, T('切り離す')) : null);
}

/** シーンの物の帯: インスタンスならプレハブへ移る・切り離す。ふつうの物ならプレハブにつなぐ */
function instanceBar(app: App, target: string, e: EntityData): HTMLElement | null {
  if (!e.prefab) {
    const names = Object.keys(app.state.prefabs);
    if (!names.length) return null;
    const pick = h('select', {
      class: 'tiny', title: T('プレハブにつなぐ（今の値は変わらない。プレハブと違う値だけが、この物の値として残る）'),
      onchange: (ev: Event) => { const v = (ev.target as HTMLSelectElement).value; if (v) app.patch([{ op: 'linkPrefab', target, prefab: v }]); },
    }, h('option', { value: '' }, T('プレハブにつなぐ…')), names.map((n) => h('option', { value: n }, '@' + n)));
    return h('div', { class: 'row', style: 'margin-top:6px;gap:6px' }, h('span', { style: 'flex:1' }), pick);
  }
  return h('div', { class: 'row', style: 'margin-top:6px;gap:6px;flex-wrap:wrap' },
    h('span', { class: 'muted' }, T('プレハブのインスタンス: '), h('a', { href: '#', style: 'color:var(--accent)', onclick: (ev: Event) => { ev.preventDefault(); app.select({ kind: 'prefab', name: e.prefab! }); } }, '@' + e.prefab)),
    h('span', { class: 'muted', title: T('プレハブを直すと、この物で変えていない値も一緒に変わります') }, T('（つながっています）')),
    h('span', { style: 'flex:1' }),
    h('button', { class: 'tiny', title: T('プレハブから切り離して、今の値をまるごと持つふつうの物にする（値は変わらない）'), onclick: () => app.patch([{ op: 'linkPrefab', target, prefab: null }]) }, T('切り離す')));
}

export interface Ctx {
  comp: string;
  field: string;
  holder: Record<string, Record<string, unknown>>;
  /** 拡張の欄の見せ方を使う（入れ子の中も）。ないなら標準の欄だけ（api.input） */
  ext?: ExtCtx;
}

/** 拡張の欄の見せ方を使うときの決まり（インスペクタ・表のエディタが渡す） */
export interface ExtCtx {
  playing: boolean;
  /** 表の欄なら、その行（既定値で埋めた値） */
  row?: { table: string; id: string; values: Record<string, unknown> };
  /** 拡張の mount の後片付け（描き直すときに呼ぶ） */
  cleanups: (() => void)[];
  /** 見せ方の欄から値を変える（p は欄の住所、sub は一番外の欄からの場所。api は拡張のもの） */
  set(p: string, sub: (string | number)[], v: unknown, final: boolean, api: EditorApi): void;
}

/** 欄を2段（名前の下に中身）に並べる型 */
const isWide = (f: Field) => isNested(f) || f.type === 'params' || (f.type === 'string' && !!f.multiline);

/** 拡張の mount を呼ぶ。失敗しても、ほかの所は動かす */
export function mountExt(box: HTMLElement, id: string, mount: () => void | (() => void), cleanups: (() => void)[]): void {
  try {
    const c = mount();
    if (typeof c === 'function') cleanups.push(c);
  } catch (e) {
    box.append(h('span', { style: 'color:var(--bad)', title: (e as Error).stack ?? '' }, T('拡張 {0} のエラー: {1}', id, (e as Error).message)));
  }
}

export function runCleanups(cleanups: (() => void)[]): void {
  for (const c of cleanups) { try { c(); } catch (e) { console.error(e); } }
}

/** その住所（かその外・中）がロックされているか */
export function lockAt(locks: Record<string, { who: string }>, path: string): { who: string } | undefined {
  if (locks[path]) return locks[path];
  for (const k of Object.keys(locks)) if (path.startsWith(k + '.') || path.startsWith(k + '[') || k.startsWith(path + '.') || k.startsWith(path + '[')) return locks[k];
  return undefined;
}

/**
 * 拡張の欄の見せ方（fields）で作った欄。当たる見せ方がない・ctx.ext がないなら null（標準の欄を使う）。
 * インスペクタの欄・入れ子の中の欄・表のエディタの欄で同じものを使う
 */
export function drawnField(app: App, o: { path: string; f: Field; value: unknown; isDefault: boolean; sub: (string | number)[]; parent?: unknown; ctx: Ctx; standard(): HTMLElement }): HTMLElement | null {
  const ext = o.ctx.ext;
  if (!ext) return null;
  const fd = fieldDrawerFor(app, o.path, o.f.type);
  if (!fd) return null;
  const lock = lockAt(app.state.locks, o.path);
  const box = h('div', { class: 'ctl', 'data-ext': fd.x.ext.id });
  const view: FieldView = {
    path: o.path, component: o.ctx.comp, field: o.ctx.field, sub: o.sub, ...(o.sub.length ? { parent: o.parent } : {}), ...(ext.row ? { row: ext.row } : {}),
    def: o.f, value: o.value, isDefault: o.isDefault, locked: !!lock, playing: ext.playing, holder: o.ctx.holder,
    set: (v: unknown, final = true) => {
      if (lock) { toast(T('🔒 {0} はロックされています', o.path), 'lock'); return; }
      ext.set(o.path, o.sub, v, final, fd.x.api);
    },
    standard: () => { const st = o.standard(); st.style.flex = '1 1 auto'; return st; },
    hide: () => {
      // 置かれた後で、名前の行（インスペクタ・表の .field、入れ子の .nest-row）ごと隠す
      const go = () => { const r = box.closest('.nest-row, .field') as HTMLElement | null; (r ?? box).style.display = 'none'; };
      if (box.isConnected) go(); else queueMicrotask(go);
    },
  };
  mountExt(box, fd.x.ext.id, () => fd.drawer.mount(box, view, fd.x.api), ext.cleanups);
  return box;
}

/** api.input: インスペクタと同じ標準の欄（拡張の見せ方は使わない）。入れ子は中の操作をこの値に当て、まるごと onChange に渡す */
let inputSeq = 0;
export function inputWidget(app: App, f: Field, value: unknown, onChange: (v: unknown, final: boolean) => void): HTMLElement {
  const ctx: Ctx = { comp: '', field: '', holder: {} };
  if (f.type === 'matrix' || f.type === 'params') return h('span', { class: 'muted' }, f.type === 'matrix' ? T('行列{0}（api.input では作れません）', matrixSize(value)) : T('シェーダーの値（api.input では作れません）'));
  if (!isNested(f)) return widget(app, f, value, onChange, ctx).el;
  const box = h('div', { class: 'ctl', style: 'display:block' });
  const key = `input:${++inputSeq}`;
  let cur = value;
  let seen = false;
  const draw = () => box.replaceChildren(nestedWidget(app, f, cur, key, [], (op) => { cur = applyNested(cur, op); onChange(structuredClone(cur), true); draw(); }, ctx));
  draw();
  // リストを開く・閉じるは描き直して見せる（ページから外れたら聞くのをやめる）
  const off = app.on('nestToggle', () => { if (box.isConnected) { seen = true; draw(); } else if (seen) off(); });
  return box;
}

/** 同じ物の Sprite の画像に付いているスプライトシート */
function sheetOfHolder(app: App, holder: Ctx['holder'], comp = 'Sprite'): { image: string; sheet: SheetDef; w: number; h: number } | null {
  const image = holder[comp]?.image;
  if (typeof image !== 'string' || !image) return null;
  const sheet = app.registry.sheets.get(image);
  const info = app.state.assets.find((a) => a.path === image);
  if (!sheet || !info?.w || !info.h) return null;
  return { image, sheet, w: info.w, h: info.h };
}

export function widget(app: App, f: Field, value: unknown, commit: (v: unknown, final: boolean) => void, ctx: Ctx): { el: HTMLElement; set(v: unknown): void } {
  // 標準の Sprite.frame はシートの絵から選べる。Animator.clip はシートの動き一覧から選べる
  if ((ctx.comp === 'Sprite' || ctx.comp === 'Particles') && ctx.field === 'frame') {
    const s = sheetOfHolder(app, ctx.holder, ctx.comp);
    if (s) return frameWidget(app, s, value as FrameRef, commit);
  }
  const wrap = h('div', { class: 'ctl' });
  switch (f.type) {
    case 'number':
    case 'int': {
      const step = f.type === 'int' ? 1 : f.step ?? 'any';
      const num = h('input', { type: 'number', step: String(step), value: String(value), min: f.min ?? '', max: f.max ?? '' }) as HTMLInputElement;
      const parse = (s: string) => (f.type === 'int' ? Math.round(Number(s)) : Number(s));
      num.addEventListener('change', () => commit(parse(num.value), true));
      wrap.append(num);
      let range: HTMLInputElement | null = null;
      if (f.min !== undefined && f.max !== undefined) {
        range = h('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.type === 'int' ? 1 : f.step ?? (f.max - f.min) / 200), value: String(value) }) as HTMLInputElement;
        range.addEventListener('input', () => { num.value = range!.value; commit(parse(range!.value), false); });
        range.addEventListener('change', () => commit(parse(range!.value), true));
        wrap.append(range);
      }
      return { el: wrap, set: (v) => { num.value = String(round(v as number)); if (range) range.value = String(v); } };
    }
    case 'bool': {
      const cb = h('input', { type: 'checkbox', checked: !!value }) as HTMLInputElement;
      cb.addEventListener('change', () => commit(cb.checked, true));
      wrap.append(cb);
      return { el: wrap, set: (v) => { cb.checked = !!v; } };
    }
    case 'enum':
    case 'prefab': {
      // 音量の区分を選ぶ欄は、AudioBus の付いたプレハブだけを出す
      const busOnly = (ctx.comp === 'Sound' && ctx.field === 'bus') || (ctx.comp === 'AudioBus' && ctx.field === 'parent');
      const prefabs = f.type === 'prefab' && f.tags?.length ? prefabChoices(new Map(Object.entries(app.state.prefabs)), f.tags)
        : Object.values(app.state.prefabs).filter((p) => !busOnly || p.components.AudioBus).map((p) => p.name);
      const options = f.type === 'enum' ? f.options : [...(f.default === '' ? [''] : []), ...prefabs];
      if (f.type === 'prefab' && typeof value === 'string' && !options.includes(value)) options.push(value);
      const label = (o: string) => (o === '' ? (busOnly ? T('（なし: 全体の直下）') : T('（なし）')) : o);
      const sel = h('select', { title: f.type === 'prefab' && f.tags?.length ? T('タグ {0} のプレハブ', f.tags.join(' ')) : '' }, options.map((o) => h('option', { value: o, selected: o === value }, label(o)))) as HTMLSelectElement;
      sel.addEventListener('change', () => commit(sel.value, true));
      wrap.append(sel);
      return { el: wrap, set: (v) => { sel.value = String(v); } };
    }
    case 'color': {
      const c = h('input', { type: 'color', value: String(value).slice(0, 7) }) as HTMLInputElement;
      const t = h('input', { type: 'text', value: String(value), style: 'width:84px;font:var(--mono)' }) as HTMLInputElement;
      // 色の選び器は #rrggbb だけなので、透け具合（#rrggbbaa の aa）は今の値から引き継ぐ
      const pick = () => c.value + (t.value.length === 9 ? t.value.slice(7) : '');
      c.addEventListener('input', () => { t.value = pick(); commit(t.value, false); });
      c.addEventListener('change', () => commit(pick(), true));
      t.addEventListener('change', () => commit(t.value, true));
      wrap.append(c, t);
      return { el: wrap, set: (v) => { t.value = String(v); c.value = String(v).slice(0, 7); } };
    }
    case 'ease': {
      // 動き方の名前を選ぶ。横に形（0→1 の進み方）を小さく描く
      const sel = h('select', {}, EASE_NAMES.map((o) => h('option', { value: o, selected: o === value }, o))) as HTMLSelectElement;
      if (!EASE_NAMES.includes(String(value) as EaseName)) sel.prepend(h('option', { value: String(value), selected: true }, T('{0}（ありません）', String(value))));
      const cv = h('canvas', { width: 48, height: 32, class: 'ease-curve', title: T('進み方（横: 時間、縦: 値）') }) as HTMLCanvasElement;
      const draw = (name: string) => {
        const g = cv.getContext('2d');
        const fn = EASES[name as EaseName];
        if (!g) return;
        g.clearRect(0, 0, cv.width, cv.height);
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.strokeRect(0.5, 6.5, cv.width - 1, cv.height - 13);
        if (!fn) return;
        g.strokeStyle = '#ffb02e';
        g.lineWidth = 1.5;
        g.beginPath();
        for (let i = 0; i <= 40; i++) {
          const k = i / 40, x = 1 + k * (cv.width - 2), y = cv.height - 7 - fn(k) * (cv.height - 14);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
      };
      sel.addEventListener('change', () => { draw(sel.value); commit(sel.value, true); });
      draw(String(value));
      wrap.append(sel, cv);
      return { el: wrap, set: (v) => { sel.value = String(v); draw(String(v)); } };
    }
    case 'vec2': {
      const [x, y] = (value as [number, number]) ?? [0, 0];
      const a = h('input', { type: 'number', step: 'any', value: String(x) }) as HTMLInputElement;
      const b = h('input', { type: 'number', step: 'any', value: String(y) }) as HTMLInputElement;
      const send = () => commit([Number(a.value), Number(b.value)], true);
      a.addEventListener('change', send);
      b.addEventListener('change', send);
      wrap.append(a, b);
      return { el: wrap, set: (v) => { const [p, q] = v as [number, number]; a.value = String(p); b.value = String(q); } };
    }
    case 'vec3': {
      const cur = (value as number[]) ?? [0, 0, 0];
      const ins = [0, 1, 2].map((k) => h('input', { type: 'number', step: 'any', value: String(cur[k] ?? 0), title: 'xyz'[k] }) as HTMLInputElement);
      for (const a of ins) a.addEventListener('change', () => commit(ins.map((x) => Number(x.value)), true));
      wrap.append(...ins);
      return { el: wrap, set: (v) => { (v as number[]).forEach((n, k) => { if (ins[k]) ins[k].value = String(n); }); } };
    }
    case 'asset': {
      // そのプロジェクトにある、種類の合うファイルから選ぶ。画像なら小さく表示する
      // シェーダーは標準のもの（std:名前）も選べる
      const files = [...app.state.assets.filter((a) => a.kind === f.kind).map((a) => a.path), ...(f.kind === 'shader' ? [...app.registry.shaders.keys()].filter((k) => k.startsWith('std:')) : [])];
      const cur = String(value ?? '');
      const options = ['', ...files];
      if (cur && !files.includes(cur)) options.splice(1, 0, cur);
      // 名前を先に見せる（長い場所は欄に収まらないので）
      const label = (o: string) => (o.includes('/') ? `${o.slice(o.lastIndexOf('/') + 1)} — ${o.slice(0, o.lastIndexOf('/'))}` : o);
      const sel = h('select', { style: 'min-width:0;flex:1', title: cur }, options.map((o) => h('option', { value: o, selected: o === cur },
        o === '' ? T('（なし）') : files.includes(o) ? label(o) : T('{0}（見つかりません）', label(o))))) as HTMLSelectElement;
      const thumb = h('img', { class: 'asset-thumb', alt: '' }) as HTMLImageElement;
      const show = (v: string) => {
        if (f.kind === 'image' && v && files.includes(v)) { thumb.src = app.assetUrl(v); thumb.style.display = ''; } else thumb.style.display = 'none';
      };
      show(cur);
      sel.addEventListener('change', () => { show(sel.value); commit(sel.value, true); });
      thumb.addEventListener('click', () => { if (sel.value) app.emit('openSprite', sel.value); });
      wrap.append(thumb, sel);
      // アセットの画面からドラッグして入れられる（種類が合うものだけ）
      wrap.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes(ASSET_MIME)) return;
        e.preventDefault();
        wrap.classList.add('drop-on');
      });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-on'));
      wrap.addEventListener('drop', (e) => {
        wrap.classList.remove('drop-on');
        const path = e.dataTransfer?.getData(ASSET_MIME);
        if (!path) return;
        e.preventDefault();
        if (kindOf(path) !== f.kind) return toast(T('{0} は{1}ではありません', path, assetLabel(f.kind)), 'bad');
        sel.value = path;
        show(path);
        commit(path, true);
      });
      wrap.append(h('button', { class: 'icon', title: T('アセットの画面で見る（使っている所・名前の変更・移動）'), onclick: () => { if (sel.value) app.emit('revealAsset', sel.value); } }, '◎'));
      if (f.kind === 'image') wrap.append(h('button', { class: 'icon', title: T('この画像の切り方（コマ・基準点・動き）を開く'), onclick: () => { if (sel.value) app.emit('openSprite', sel.value); } }, '✂'));
      if (f.kind === 'sound') {
        thumb.remove();
        const info = () => app.state.assets.find((a) => a.path === sel.value);
        wrap.append(h('button', { class: 'icon', title: T('このファイルを試しに鳴らす'), onclick: () => { if (sel.value) app.previewSound({ ...(ctx.comp === 'Sound' ? ctx.holder.Sound : {}), clip: sel.value } as never); } }, '▶'),
          h('span', { class: 'muted', style: 'font-size:11px' }, info()?.sec !== undefined ? `${info()!.sec}s` : ''));
      }
      return { el: wrap, set: (v) => { sel.value = String(v ?? ''); show(String(v ?? '')); } };
    }
    case 'row': {
      // 表の行から選ぶ
      const ids = (app.registry.tableData.get(f.table)?.rows ?? []).map((r) => r.id);
      const cur = String(value ?? '');
      const options = [...(f.default === '' ? [''] : []), ...ids];
      if (!options.includes(cur)) options.push(cur);
      // 行の名前の横に、その行の最初の文字の列（言葉の表なら既定の言語）を少し出す
      const textCol = Object.entries(app.registry.tables.get(f.table)?.columns ?? {}).find(([, cf]) => cf.type === 'string')?.[0];
      const rowsById = new Map((app.registry.tableData.get(f.table)?.rows ?? []).map((r) => [r.id, r]));
      const label = (o: string) => {
        const t = textCol ? String(rowsById.get(o)?.[textCol] ?? '').replace(/\s+/g, ' ').trim() : '';
        return t ? `${o} — ${t.length > 24 ? t.slice(0, 24) + '…' : t}` : o;
      };
      const sel = h('select', { title: T('表 {0} の行', f.table) }, options.map((o) => h('option', { value: o, selected: o === cur }, o === '' ? T('（なし）') : ids.includes(o) ? label(o) : T('{0}（表にありません）', o)))) as HTMLSelectElement;
      sel.addEventListener('change', () => commit(sel.value, true));
      wrap.append(sel, h('button', { class: 'icon row-open', title: T('表 {0} を開く', f.table), onclick: () => app.emit('openTable', { name: f.table, row: sel.value }) }, '▦'));
      return { el: wrap, set: (v) => { sel.value = String(v); } };
    }
    case 'scene': {
      const names = Object.keys(app.state.scenes);
      const cur = String(value ?? '');
      const options = [...(f.default === '' ? [''] : []), ...names];
      if (!options.includes(cur)) options.push(cur);
      const sel = h('select', { title: T('シーン') }, options.map((o) => h('option', { value: o, selected: o === cur }, o === '' ? T('（なし）') : names.includes(o) ? o : T('{0}（ありません）', o)))) as HTMLSelectElement;
      sel.addEventListener('change', () => commit(sel.value, true));
      wrap.append(sel);
      return { el: wrap, set: (v) => { sel.value = String(v); } };
    }
    case 'input': {
      // ボタン・軸の名前。「押して決める」で、次に押したキー・マウス・パッドのボタン（analog なら倒した軸）が入る
      const t = h('input', { type: 'text', value: String(value ?? ''), style: 'width:110px;font:var(--mono)', title: f.analog ? T('軸の名前（例 Pad.LX）') : T('ボタンの名前（例 KeyZ, Space, Mouse0, Pad.A）') }) as HTMLInputElement;
      const label = h('span', { class: 'muted input-label' });
      const show = (v: string) => { label.textContent = v ? buttonLabel(v) : ''; label.style.display = v && buttonLabel(v) !== v ? '' : 'none'; };
      show(String(value ?? ''));
      t.addEventListener('change', () => { show(t.value.trim()); commit(t.value.trim(), true); });
      const pick = h('button', { class: 'icon', title: f.analog ? T('倒して決める: 次に大きく倒したスティック・トリガーが入る') : T('押して決める: 次に押したキー・マウス・パッドのボタンが入る'), onclick: () => capture(!!f.analog, (code) => { t.value = code; show(code); commit(code, true); }) }, '⌨');
      wrap.append(t, label, pick);
      return { el: wrap, set: (v) => { t.value = String(v ?? ''); show(String(v ?? '')); } };
    }
    case 'frame': {
      // シートがない画像: 番号か名前を直接入れる。切り方の画面へも行ける
      const t = h('input', { type: 'text', value: String(value ?? 0), style: 'width:80px' }) as HTMLInputElement;
      t.addEventListener('change', () => commit(/^\d+$/.test(t.value.trim()) ? Number(t.value) : t.value.trim(), true));
      const image = ctx.holder.Sprite?.image;
      wrap.append(t);
      if (typeof image === 'string' && image) wrap.append(h('button', { title: T('この画像をコマに切る'), onclick: () => app.emit('openSprite', image) }, T('✂ 切る')));
      return { el: wrap, set: (v) => { t.value = String(v); } };
    }
    default: {
      // 言葉の名前（Text.key）: 表 $text の行から選べる。横に今の言語の言葉を出す
      if (ctx.comp === 'Text' && ctx.field === 'key') {
        const rows = app.state.tables.text?.rows ?? [];
        const id = `keys-${Math.random().toString(36).slice(2)}`;
        const t = h('input', { type: 'text', value: String(value ?? ''), list: id, placeholder: T('表 $text の行（空なら text のまま）') }) as HTMLInputElement;
        const lang = app.previewLang || (app.state.config.languages ?? ['ja'])[0];
        const show = h('span', { class: 'muted', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px' });
        const preview = (k: string) => { const r = rows.find((x) => x.id === k) as Record<string, unknown> | undefined; show.textContent = k ? (r ? String(r[lang] || T('（{0} 未訳）', lang)) : T('（ない行）')) : ''; };
        t.addEventListener('change', () => { commit(t.value.trim(), true); preview(t.value.trim()); });
        preview(String(value ?? ''));
        wrap.append(t, h('datalist', { id }, rows.map((r) => h('option', { value: r.id }))), show);
        return { el: wrap, set: (v) => { t.value = String(v ?? ''); preview(String(v ?? '')); } };
      }
      // モデルの動き（Model3D.clip）: そのモデルの中の動きの名前から選べる
      if (ctx.comp === 'Model3D' && ctx.field === 'clip') {
        const clips = Object.entries(app.registry.models.get(String(ctx.holder.Model3D?.model ?? '')) ?? {});
        const id = `clips-${Math.random().toString(36).slice(2)}`;
        const t = h('input', { type: 'text', value: String(value ?? ''), list: id, placeholder: clips.length ? T('動きの名前（空なら元の姿勢）') : T('このモデルに動きはありません') }) as HTMLInputElement;
        t.addEventListener('change', () => commit(t.value.trim(), true));
        wrap.append(t, h('datalist', { id }, clips.map(([name, sec]) => h('option', { value: name }, T('{0}秒', Math.round(sec * 100) / 100)))));
        return { el: wrap, set: (v) => { t.value = String(v ?? ''); } };
      }
      // UI の親・隣に付ける相手は、同じシーンの UI の物から選ぶ
      if (f.type === 'ref' && ctx.comp === 'UI') {
        const ids = (app.sceneView(app.scene)?.entities ?? []).filter((e) => e.components.UI && e.components.UI !== ctx.holder.UI).map((e) => e.id);
        const cur = value === null || value === undefined ? '' : String(value);
        const options = ['', ...ids];
        if (cur && !ids.includes(cur)) options.push(cur);
        const sel = h('select', {}, options.map((o) => h('option', { value: o, selected: o === cur }, o === '' ? (ctx.field === 'parent' ? T('（なし: 画面）') : T('（なし）')) : ids.includes(o) ? o : T('{0}（ありません）', o)))) as HTMLSelectElement;
        sel.addEventListener('change', () => commit(sel.value === '' ? null : sel.value, true));
        wrap.append(sel);
        return { el: wrap, set: (v) => { sel.value = v === null ? '' : String(v); } };
      }
      // 複数行の文字: 広い欄（離れたときに確定）
      if (f.type === 'string' && f.multiline) {
        const text = String(value ?? '');
        const ta = h('textarea', { rows: Math.min(8, Math.max(2, text.split('\n').length)), style: 'flex:1;min-width:0;resize:vertical;font:inherit' }) as HTMLTextAreaElement;
        ta.value = text;
        ta.addEventListener('change', () => commit(ta.value, true));
        wrap.append(ta);
        return { el: wrap, set: (v) => { ta.value = String(v ?? ''); } };
      }
      const t = h('input', { type: 'text', value: value === null ? '' : String(value) }) as HTMLInputElement;
      t.addEventListener('change', () => commit(f.type === 'ref' && t.value === '' ? null : t.value, true));
      wrap.append(t);
      return { el: wrap, set: (v) => { t.value = v === null ? '' : String(v); } };
    }
  }
}

/** 行列はインスペクタに直接並べず、大きさだけ表示して専用の行列エディタで開く */
function matrixWidget(app: App, path: string, value: unknown, cell: string): { el: HTMLElement; set(v: unknown): void } {
  const size = h('span', { class: 'muted', style: 'font:var(--mono)' }, `${matrixSize(value)} ${cell}`);
  const wrap = h('div', { class: 'ctl' }, size,
    h('button', { onclick: () => app.emit('openMatrix', path), title: T('行列エディタで確認・編集') }, T('開く')),
    h('button', { class: 'icon', title: T('別のウインドウで開く'), onclick: () => window.open(`/?solo=matrix&path=${encodeURIComponent(path)}`, `ages-matrix-${path}`, 'width=900,height=640') }, '↗'));
  return { el: wrap, set: (v) => { size.textContent = `${matrixSize(v)} ${cell}`; } };
}

/** スプライトシートのコマ。番号か名前を入れられるし、絵を見てクリックでも選べる（名前のあるコマは名前で入る） */
function frameWidget(app: App, s: { image: string; sheet: SheetDef; w: number; h: number }, value: FrameRef, commit: (v: unknown, final: boolean) => void): { el: HTMLElement; set(v: unknown): void } {
  const all = listFrames(s.sheet, s.w, s.h);
  const count = all.length;
  const num = h('input', { type: 'text', value: String(value ?? 0), style: 'width:90px;font:var(--mono)', title: T('番号（0から）か名前') }) as HTMLInputElement;
  const preview = h('canvas', { width: 28, height: 28, class: 'asset-thumb', title: T('クリックで絵から選ぶ') }) as HTMLCanvasElement;
  const img = new Image();
  img.src = app.assetUrl(s.image);
  const parse = (t: string): FrameRef => (/^\d+$/.test(t.trim()) ? Number(t) : t.trim());
  const paint = (ref: FrameRef) => {
    const g = preview.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 28, 28);
    const f = findFrame(s.sheet, s.w, s.h, ref);
    if (!img.complete || !img.naturalWidth || !f) return;
    const k = Math.min(28 / f.w, 28 / f.h);
    g.drawImage(img, f.x, f.y, f.w, f.h, (28 - f.w * k) / 2, (28 - f.h * k) / 2, f.w * k, f.h * k);
  };
  img.onload = () => paint(parse(num.value));
  num.addEventListener('change', () => { const v = parse(num.value); paint(v); commit(v, true); });
  const pick = () => modal((close) => {
    const zoom = Math.max(1, Math.min(4, Math.floor(560 / s.w)));
    const cur = findFrame(s.sheet, s.w, s.h, parse(num.value));
    const grid = h('div', { class: 'frame-grid', style: `position:relative;width:${s.w * zoom}px;height:${s.h * zoom}px;background:url("${app.assetUrl(s.image)}") 0 0 / ${s.w * zoom}px ${s.h * zoom}px no-repeat` });
    for (const f of all) {
      grid.append(h('button', {
        class: `frame-cell ${f.index === cur?.index ? 'on' : ''}`,
        title: frameLabel(f),
        style: `left:${f.x * zoom}px;top:${f.y * zoom}px;width:${f.w * zoom}px;height:${f.h * zoom}px`,
        onclick: () => { const v = f.name ?? f.index; num.value = String(v); paint(v); commit(v, true); close(); },
      }));
    }
    const clips = Object.entries(s.sheet.clips ?? {}).map(([n, c]) => `${n}: ${c.frames.join(',')}`).join('  ');
    const kind = s.sheet.frames ? T('自由な矩形') : T('格子 {0}px', s.sheet.frame!.join('x'));
    return h('div', {}, h('h3', {}, T('コマを選ぶ — {0}', s.image)),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, T('{0}コマ（{1}）{2}', count, kind, clips ? T('　動き {0}', clips) : '')),
      h('div', { style: 'overflow:auto;max-height:60vh' }, grid),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' },
        h('button', { onclick: () => { close(); app.emit('openSprite', s.image); } }, T('✂ 切り方を編集')),
        h('button', { onclick: close }, T('閉じる'))));
  });
  preview.addEventListener('click', pick);
  const wrap = h('div', { class: 'ctl' }, preview, num, h('button', { onclick: pick, title: T('絵を見て選ぶ') }, T('選ぶ')), h('span', { class: 'muted' }, `/${count}`));
  return { el: wrap, set: (v) => { num.value = String(v); paint(v as FrameRef); } };
}

const round = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000);

// ---------- リスト・構造体・どれか1つ ----------

/** 入れ子の値への操作（sub はフィールドの中の場所） */
export type NestedOp =
  | { kind: 'set'; sub: (string | number)[]; value: unknown }
  | { kind: 'insert'; sub: (string | number)[]; value?: unknown; index?: number }
  | { kind: 'remove'; sub: (string | number)[] }
  | { kind: 'move'; sub: (string | number)[]; to: number };

export const isNested = (f: Field): f is ListField | StructField | OneOfField => f.type === 'list' || f.type === 'struct' || f.type === 'oneOf';

export function toOp(path: string, op: NestedOp): Op {
  const at = path + formatSub(op.sub);
  if (op.kind === 'set') return { op: 'set', path: at, value: op.value };
  if (op.kind === 'insert') return { op: 'insert', path: at, ...(op.value !== undefined ? { value: op.value } : {}), ...(op.index !== undefined ? { index: op.index } : {}) };
  if (op.kind === 'remove') return { op: 'removeItem', path: at };
  return { op: 'moveItem', path: at, to: op.to };
}

/** 実行中の値に、その場で操作を当てる */
export function applyNested(top: unknown, op: NestedOp): unknown {
  if (op.kind === 'set') return setIn(top, op.sub, op.value);
  if (op.kind === 'insert') {
    const list = [...((getIn(top, op.sub) as unknown[]) ?? [])];
    list.splice(op.index ?? list.length, 0, op.value);
    return setIn(top, op.sub, list);
  }
  const listSub = op.sub.slice(0, -1), i = op.sub[op.sub.length - 1] as number;
  const list = [...((getIn(top, listSub) as unknown[]) ?? [])];
  const [item] = list.splice(i, 1);
  if (op.kind === 'move') list.splice(op.to, 0, item);
  return setIn(top, listSub, list);
}

/** 開いているリスト（描き直しても閉じないよう覚えておく） */
const opened = new Set<string>();
const closed = new Set<string>();

/** 表のセルなどに出す短い要約 */
export const valueSummary = (f: Field, v: unknown): string => {
  if (f.type === 'list') {
    const a = Array.isArray(v) ? v : [];
    // ボタンの割り当てなどの短いリストは、中身をそのまま見せる
    const text = f.of.type === 'input' ? a.map((x) => buttonLabel(String(x))).join(' / ')
      : ['string', 'number', 'int', 'enum', 'row', 'prefab', 'bool'].includes(f.of.type) ? a.map((x) => String(x)).join(', ') : '';
    if (!a.length) return T('（なし）');
    return text && text.length <= 32 ? text : T('{0}件', a.length);
  }
  if (f.type === 'oneOf') return String((v as { kind?: string } | null)?.kind ?? '');
  if (f.type === 'struct') return '';
  if (f.type === 'string' && f.multiline) {
    const text = String(v ?? ''), first = text.split('\n')[0];
    return (first.length > 24 ? first.slice(0, 22) + '…' : first) + (text.includes('\n') ? ' ⏎…' : '');
  }
  const s = JSON.stringify(v) ?? '';
  return s.length > 24 ? s.slice(0, 22) + '…' : s;
};

/** リスト・構造体・どれか1つを、中まで編集する部品（入れ子にもなる） */
export function nestedWidget(app: App, f: Field, value: unknown, path: string, sub: (string | number)[], emit: (op: NestedOp) => void, ctx: Ctx): HTMLElement {
  const key = path + formatSub(sub);
  const leaf = (lf: Field, lv: unknown, lsub: (string | number)[], isDefault = false, parent?: unknown): HTMLElement => {
    const standard = () => isNested(lf) ? nestedWidget(app, lf, lv, path, lsub, emit, ctx)
      : lf.type === 'matrix' ? h('span', { class: 'muted' }, T('行列{0}（JSON で編集）', matrixSize(lv)))
      : widget(app, lf, lv, (v, final) => { if (final) emit({ kind: 'set', sub: lsub, value: v }); }, ctx).el;
    // 拡張の欄の見せ方（match の [] と .名前 で入れ子の中にも）
    return drawnField(app, { path: path + formatSub(lsub), f: lf, value: lv, isDefault, sub: lsub, parent, ctx, standard }) ?? standard();
  };
  const row = (label: string, title: string, el: HTMLElement, ...tools: (HTMLElement | null)[]) =>
    h('div', { class: 'nest-row' }, h('span', { class: 'nest-label', title }, label), h('div', { class: 'nest-val' }, el), ...tools);

  if (f.type === 'list') {
    const list = Array.isArray(value) ? value : [];
    // 短いリストは開いて始める（長いものは ▸ で開く。開いた・閉じたはエディタを開いている間おぼえる）
    const open = closed.has(key) ? false : opened.has(key) || list.length <= 8;
    const toggle = h('button', { class: 'icon', title: open ? T('閉じる') : T('開く'), onclick: () => { if (open) { opened.delete(key); closed.add(key); } else { closed.delete(key); opened.add(key); } app.emit('nestToggle'); } }, open ? '▾' : '▸');
    const add = h('button', { class: 'icon', title: T('最後に足す（{0}）', typeOf(f.of)), disabled: f.max !== undefined && list.length >= f.max, onclick: () => emit({ kind: 'insert', sub, value: defaultOf(f.of) }) }, T('＋'));
    const full = f.max !== undefined && list.length >= f.max;
    const items = open ? list.map((v, i) => row(`[${i}]`, `${key}[${i}]`, leaf(f.of, v, [...sub, i], false, list),
      h('button', { class: 'icon tiny', title: T('複製して、すぐ下に置く'), disabled: full, onclick: () => emit({ kind: 'insert', sub, value: structuredClone(v), index: i + 1 }) }, '⧉'),
      h('button', { class: 'icon tiny', title: T('上へ'), disabled: i === 0, onclick: () => emit({ kind: 'move', sub: [...sub, i], to: i - 1 }) }, '↑'),
      h('button', { class: 'icon tiny', title: T('下へ'), disabled: i === list.length - 1, onclick: () => emit({ kind: 'move', sub: [...sub, i], to: i + 1 }) }, '↓'),
      h('button', { class: 'icon tiny', title: T('消す'), disabled: f.min !== undefined && list.length <= f.min, onclick: () => emit({ kind: 'remove', sub: [...sub, i] }) }, '×'))) : [];
    const t = typeOf(f.of);
    return h('div', { class: 'nest' }, h('div', { class: 'nest-head', title: T('{0}件 list<{1}>', list.length, t) }, toggle, h('span', { class: 'muted' }, T('{0}件{1}', list.length, t.length <= 20 ? ' ' + t : '')), add), items);
  }
  if (f.type === 'struct') {
    const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return h('div', { class: 'nest' }, Object.entries(f.fields).map(([k, sf]) => row(k, `${k}: ${typeOf(sf)}${sf.desc ? '\n' + TD(sf.desc) : ''}`, leaf(sf, k in obj ? obj[k] : defaultOf(sf), [...sub, k], !(k in obj), obj))));
  }
  // どれか1つ: 種類を選ぶと、その種類の既定値に入れ替わる（同じ名前・同じ型の欄は今の値を引き継ぐ）
  const o = f as OneOfField;
  const obj = (value && typeof value === 'object' ? value : defaultOf(o)) as Record<string, unknown>;
  const kind = String(obj.kind ?? Object.keys(o.variants)[0]);
  const pick = h('select', {}, Object.entries(o.variants).map(([k, v]) => h('option', { value: k, selected: k === kind, title: TD(v.desc) }, k))) as HTMLSelectElement;
  pick.addEventListener('change', () => {
    const next = variantDefault(pick.value, o.variants[pick.value].fields) as Record<string, unknown>;
    const before = o.variants[kind]?.fields ?? {};
    for (const [k, sf] of Object.entries(o.variants[pick.value].fields)) {
      if (k in obj && before[k] && typeOf(before[k]) === typeOf(sf)) next[k] = structuredClone(obj[k]);
    }
    emit({ kind: 'set', sub, value: next });
  });
  const fields = o.variants[kind]?.fields ?? {};
  return h('div', { class: 'nest' }, row('kind', TD(o.variants[kind]?.desc) || T('種類'), pick),
    Object.entries(fields).map(([k, sf]) => row(k, `${k}: ${typeOf(sf)}${sf.desc ? '\n' + TD(sf.desc) : ''}`, leaf(sf, k in obj ? obj[k] : defaultOf(sf), [...sub, k], !(k in obj), obj))));
}

/** 「押して決める」の画面。次に押されたボタン（analog なら大きく倒した軸）を返す */
function capture(analog: boolean, done: (code: string) => void): void {
  modal((close) => {
    const area = h('div', { class: 'capture-area', tabindex: 0 }, analog ? T('スティックかトリガーを大きく倒してください') : T('キーかゲームパッドのボタンを押してください\n（この枠の中でクリックすると、マウスのボタン）'));
    const stop = captureNext((code) => { close(); done(code); }, { analog, target: area, alive: () => area.isConnected });
    return h('div', {},
      h('h3', {}, analog ? T('軸を決める') : T('ボタンを決める')),
      area,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, h('button', { onclick: () => { stop(); close(); } }, T('取り消す'))));
  });
}
