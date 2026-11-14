// アセットの画面。画像・音・フォントをフォルダごとに見て、取り込み・名前の変更・移動・削除をする。プレハブ（タグ・名前の頭で分ける）と表もここに並べる。
// 場所を変えると、使っている値（シーン・プレハブ・表）と画像の切り方も一緒に直る（moveAsset）。使われているものは消せない。
import type { App } from '../app.ts';
import type { Panel } from './layout.ts';
import { clear, h, menu, modal, toast } from './dom.ts';
import { assetRefs, baseOf, checkAssetPath, dirOf, extOf, isUnder, kindOf, RESERVED_DIRS } from '../../core/assets.ts';
import { ASSET_LABEL, brief, type AssetKind } from '../../core/schema.ts';
import { T } from '../i18n.ts';
import { ORIGIN_BY, originOf, type OriginBy, type OriginInput } from '../../core/origin.ts';
import { resolvePrefab } from '../../core/variant.ts';
import { menuItemsFor } from '../extensions.ts';
import { TD } from '../i18n.ts';

/** 出どころの名前（エディタの言語で） */
const ORIGIN_LABEL = (by: OriginBy): string => ({ own: T('自作'), ai: T('AI 生成'), stock: T('配布・購入の素材'), commission: T('人に頼んだ') })[by];

/** ドラッグで運ぶアセットの場所（ゲームの画面・インスペクタ・フォルダへ落とせる） */
export const ASSET_MIME = 'application/x-ages-asset';
/** プロジェクトのプレハブをゲームの画面へ運ぶとき（落とした所にインスタンスを置く） */
export const PREFAB_MIME = 'application/x-ages-prefab';

type Asset = App['state']['assets'][number];

/** アセットの種類の名前（エディタの言葉で） */
export const assetLabel = (k: AssetKind): string => ({ image: T('画像'), sound: T('音'), font: T('フォント'), shader: T('シェーダー'), model: T('モデル') })[k] ?? ASSET_LABEL[k];
const KIND_LABEL: Record<AssetKind, string> = { image: assetLabel('image'), sound: assetLabel('sound'), font: assetLabel('font'), shader: assetLabel('shader'), model: assetLabel('model') };
const kb = (n: number) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

/** フォントを画面で使える名前にする（見本の表示用） */
const fontFamilies = new Map<string, string>();
function fontFamily(app: App, path: string): string {
  let fam = fontFamilies.get(path);
  if (fam) return fam;
  fam = `ages-asset-font-${fontFamilies.size}`;
  fontFamilies.set(path, fam);
  const f = new FontFace(fam, `url(${app.assetUrl(path)})`);
  f.load().then(() => document.fonts.add(f)).catch(() => {});
  return fam;
}

/** ファイルを取り込む。同じ名前があれば、差し替えるか両方残すかを聞く。取り込んだ場所を返す */
export async function importFiles(app: App, files: File[], folder: string): Promise<string[]> {
  const done: string[] = [];
  let all: 'replace' | 'keep' | null = null;
  for (const file of files) {
    const path = folder ? `${folder}/${file.name}` : file.name;
    const bad = checkAssetPath(path);
    if (bad) { toast(bad, 'bad', 6000); continue; }
    const send = (mode: string) => app.api<{ path: string }>(`/api/upload?path=${encodeURIComponent(path)}&mode=${mode}`, { raw: file });
    try {
      done.push((await send('new')).path);
    } catch (e) {
      const data = (e as { data?: { exists?: boolean; free?: string } }).data;
      if (!data?.exists) { toast((e as Error).message, 'bad', 6000); continue; }
      const choice = all ?? await new Promise<'replace' | 'keep' | null>((ok) => {
        const rest = h('input', { type: 'checkbox' }) as HTMLInputElement;
        modal((close) => {
          const pick = (v: 'replace' | 'keep' | null) => { if (rest.checked && v) all = v; close(); ok(v); };
          return h('div', {},
            h('h3', {}, T('同じ名前のファイルがあります')),
            h('p', {}, path),
            h('p', { class: 'muted' }, T('差し替えると、使っている所はそのまま新しい中身になります。')),
            files.length > 1 ? h('label', { class: 'row' }, rest, T('残りも同じようにする')) : null,
            h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' },
              h('button', { onclick: () => pick(null) }, T('やめる')),
              h('button', { onclick: () => pick('keep') }, T('両方残す（{0}）', baseOf(data.free ?? ''))),
              h('button', { class: 'primary', onclick: () => pick('replace') }, T('差し替える'))));
        });
      });
      if (!choice) continue;
      try { done.push((await send(choice)).path); } catch (e2) { toast((e2 as Error).message, 'bad', 6000); }
    }
  }
  if (done.length) toast(T('取り込みました: {0}', done.map(baseOf).join(', ')));
  await app.refresh();
  return done;
}

export function assetsPanel(app: App): Panel & { reveal(path: string): void } {
  const el = h('div', { class: 'assets', tabindex: 0 });
  let folder = 'assets';
  let selected = '';
  let search = '';
  let kind: '' | AssetKind = '';
  let unusedOnly = false;
  const closed = new Set<string>();
  // プレハブ・表も、ファイルと並べてここに出す（Unity の Project ウインドウのように）。
  // プレハブはタグごとに分け（ptag: null はすべて・'' はタグなし）、名前の頭（se_ など）が5つ以上そろえば1つにまとめる（ppre）
  let view: 'files' | 'prefabs' | 'tables' = 'files';
  let ptag: string | null = null;
  let ppre: string | null = null;
  const prefabMap = () => new Map(Object.entries(app.state.prefabs));
  const tagsOf = (n: string): string[] => { try { return resolvePrefab(prefabMap(), n).tags ?? []; } catch { return app.state.prefabs[n]?.tags ?? []; } };
  const prefixOf = (n: string) => /^([A-Za-z0-9]+_)./.exec(n)?.[1];
  const firstSentence = (s?: string) => (s ?? '').split(/。|\. /)[0];
  const lockN = (pre: string) => Object.keys(app.state.locks).filter((k) => k.startsWith(pre + '.') || k.startsWith(pre + '/')).length;
  const GROUP_MIN = 5;

  // ---------- 情報 ----------
  const refsOf = (): Map<string, string[]> => {
    const s = app.state;
    if (!app.registry) return new Map();
    const docs = { scenes: new Map(Object.entries(s.scenes)), prefabs: new Map(Object.entries(s.prefabs)), tables: new Map(Object.entries(s.tables)) };
    const refs = assetRefs(docs, app.registry);
    for (const [k, v] of Object.entries(s.codeRefs ?? {})) refs.set(k, [...(refs.get(k) ?? []), ...v.map((c) => T('{0}（コード）', c))]);
    return refs;
  };
  /** アセットを置けるフォルダ（空のものも）。決まった置き場所（scenes/ など）は出さない */
  const folders = (): string[] => {
    const set = new Set<string>();
    for (const a of app.state.assets) for (let d = dirOf(a.path); d; d = dirOf(d)) set.add(d);
    // 空のフォルダは、アセットのある一番上のフォルダ（ふつうは assets/）の中か、assets/ そのものだけ出す（tools/ などは出さない）
    const tops = new Set([...set].map((d) => d.split('/')[0]).concat('assets'));
    for (const d of app.state.dirs ?? []) if (!RESERVED_DIRS.includes(d.split('/')[0]) && tops.has(d.split('/')[0])) set.add(d);
    return [...set].sort();
  };

  // ---------- 操作 ----------
  const move = async (from: string, to: string) => {
    if (from === to) return;
    const r = await app.patch([{ op: 'moveAsset', from, to }], 'assets');
    if (!r) return;
    const fixed = r.filter((c) => c.auto).length;
    toast(T('{0} → {1}{2}', baseOf(from), to, fixed ? T('（使っている値 {0}か所も直しました）', fixed) : ''));
    if (selected === from) selected = to;
    else if (isUnder(selected, from)) selected = to + selected.slice(from.length);
    if (folder === from || isUnder(folder, from)) folder = to + folder.slice(from.length);
    render();
  };
  const rename = (path: string, dir: boolean) => {
    const ext = dir ? '' : extOf(path);
    const stem = baseOf(path).slice(0, baseOf(path).length - ext.length);
    modal((close) => {
      const input = h('input', { type: 'text', value: stem, style: 'flex:1' }) as HTMLInputElement;
      const go = () => { const v = input.value.trim(); close(); if (v && v !== stem) move(path, (dirOf(path) ? dirOf(path) + '/' : '') + v + ext); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return h('div', {}, h('h3', {}, dir ? T('フォルダの名前を変える') : T('名前を変える')),
        h('div', { class: 'row' }, input, ext ? h('span', { class: 'muted' }, ext) : null),
        h('p', { class: 'muted' }, T('使っている値と画像の切り方も一緒に直ります。')),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, T('やめる')), h('button', { class: 'primary', onclick: go }, T('変える'))));
    });
  };
  const moveTo = (path: string, dir: boolean) => {
    modal((close) => {
      const options = ['', ...folders()].filter((d) => !dir || (d !== path && !isUnder(d, path)));
      const sel = h('select', { style: 'flex:1' }, options.map((d) => h('option', { value: d, selected: d === dirOf(path) }, d ? d + '/' : T('（プロジェクトの直下）')))) as HTMLSelectElement;
      const go = () => { close(); move(path, (sel.value ? sel.value + '/' : '') + baseOf(path)); };
      return h('div', {}, h('h3', {}, T('{0} を動かす', baseOf(path))), h('div', { class: 'row' }, sel),
        h('p', { class: 'muted' }, T('フォルダへのドラッグでも動かせます。')),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, T('やめる')), h('button', { class: 'primary', onclick: go }, T('動かす'))));
    });
  };
  const remove = (path: string, dir: boolean) => {
    const refs = refsOf();
    const used = dir ? app.state.assets.filter((a) => isUnder(a.path, path)).flatMap((a) => (refs.get(a.path) ?? []).map((r) => `${baseOf(a.path)}: ${r}`)) : refs.get(path) ?? [];
    modal((close) => used.length
      ? h('div', {}, h('h3', {}, T('{0} は使われています', baseOf(path))),
        h('p', { class: 'muted' }, T('使われているものは消せません。先にその指定を変えてください。')),
        h('ul', { class: 'refs' }, used.slice(0, 12).map((r) => h('li', {}, r))), used.length > 12 ? h('p', { class: 'muted' }, T('ほか {0}か所', used.length - 12)) : null,
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, h('button', { onclick: close }, T('閉じる'))))
      : h('div', {}, h('h3', {}, T('{0}{1} を消しますか？', dir ? T('フォルダ ') : '', path)),
        dir ? h('p', { class: 'muted' }, T('中のファイルもすべて消えます。')) : null,
        h('p', { class: 'muted' }, T('Git で共有していれば、コミット前なら戻せます。')),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, T('やめる')),
          h('button', { class: 'danger', onclick: async () => { close(); if (await app.patch([{ op: 'removeAsset', path }], 'assets')) { toast(T('消しました: {0}', path)); if (selected === path || isUnder(selected, path)) selected = ''; if (folder === path || isUnder(folder, path)) folder = dirOf(path); render(); } } }, T('消す')))));
  };
  const newFolder = () => {
    modal((close) => {
      const input = h('input', { type: 'text', value: '', placeholder: T('例 enemies'), style: 'flex:1' }) as HTMLInputElement;
      const go = async () => {
        const name = input.value.trim();
        if (!name) return;
        const path = (folder ? folder + '/' : '') + name;
        close();
        try { await app.api(`/api/mkdir?path=${encodeURIComponent(path)}`, { method: 'POST' }); folder = path; await app.refresh(); } catch (e) { toast((e as Error).message, 'bad'); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      setTimeout(() => input.focus(), 0);
      return h('div', {}, h('h3', {}, T('新しいフォルダ（{0} の中）', folder || T('プロジェクトの直下'))), h('div', { class: 'row' }, input),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, T('やめる')), h('button', { class: 'primary', onclick: go }, T('作る'))));
    });
  };
  const open = (a: Asset) => {
    if (a.kind === 'image') app.emit('openSprite', a.path);
    else if (a.kind === 'sound') app.previewSound({ clip: a.path });
    else if (a.kind === 'shader') app.emit('openText', a.path);
  };
  const fileMenu = (e: MouseEvent, a: Asset) => {
    e.preventDefault();
    selected = a.path;
    render();
    menu(e.clientX, e.clientY, [
      ...(a.kind === 'image' ? [[T('切り方を開く'), () => open(a)] as [string, () => void]] : a.kind === 'sound' ? [[T('鳴らす'), () => open(a)] as [string, () => void]] : []),
      [T('名前を変える（F2）'), () => rename(a.path, false)],
      [T('別のフォルダへ'), () => moveTo(a.path, false)],
      [T('場所をコピー'), () => { navigator.clipboard?.writeText(a.path); toast(T('コピーしました: {0}', a.path)); }],
      [app.state.locks[`file:${a.path}`] ? T('🔒 ロック中（ロックマネージャーで外す）') : T('🔒 ロックする'), () => (app.state.locks[`file:${a.path}`] ? app.openLocks(`file:${a.path}`) : app.lock([`file:${a.path}`], 'assets'))],
      [T('消す（Delete）'), () => remove(a.path, false)],
    ]);
  };
  const folderMenu = (e: MouseEvent, d: string) => {
    e.preventDefault();
    e.stopPropagation();
    menu(e.clientX, e.clientY, [
      [T('新しいフォルダ'), () => { folder = d; newFolder(); }],
      [T('名前を変える'), () => rename(d, true)],
      [T('別のフォルダへ'), () => moveTo(d, true)],
      [T('消す'), () => remove(d, true)],
    ]);
  };

  // ---------- ドラッグ ----------
  /** el をフォルダ dest への落とし先にする（アセットなら移動、外のファイルなら取り込み） */
  const dropTarget = (target: HTMLElement, destOf: string | (() => string)) => {
    target.addEventListener('dragover', (e) => {
      if (view !== 'files' && target === grid) return;
      const types = e.dataTransfer?.types ?? [];
      if (!types.includes(ASSET_MIME) && !types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      target.classList.add('drop-on');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-on'));
    target.addEventListener('drop', async (e) => {
      target.classList.remove('drop-on');
      const dest = typeof destOf === 'string' ? destOf : destOf();
      const path = e.dataTransfer?.getData(ASSET_MIME);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!path && !files.length) return;
      e.preventDefault();
      e.stopPropagation();
      if (path) {
        if (path === dest || dirOf(path) === dest) return;
        if (isUnder(dest, path)) return toast(T('フォルダを自分の中へは動かせません'), 'bad');
        await move(path, (dest ? dest + '/' : '') + baseOf(path));
      } else {
        const done = await importFiles(app, files, dest);
        if (done.length) { folder = dest; selected = done[done.length - 1]; render(); }
      }
    });
  };
  const draggable = (target: HTMLElement, path: string) => {
    target.draggable = true;
    target.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData(ASSET_MIME, path);
      e.dataTransfer!.setData('text/plain', path);
      e.dataTransfer!.effectAllowed = 'copyMove';
    });
  };

  // ---------- 描く ----------
  const tree = h('div', { class: 'asset-tree' });
  const grid = h('div', { class: 'asset-grid' });
  const side = h('div', { class: 'asset-side' });
  const searchBox = h('input', { type: 'search', placeholder: T('🔍 名前で探す'), style: 'width:140px' }) as HTMLInputElement;
  searchBox.addEventListener('input', () => { search = searchBox.value.trim().toLowerCase(); renderGrid(); });
  const kindSel = h('select', { title: T('種類') }, h('option', { value: '' }, T('すべて')), (Object.keys(KIND_LABEL) as AssetKind[]).map((k) => h('option', { value: k }, KIND_LABEL[k]))) as HTMLSelectElement;
  kindSel.addEventListener('change', () => { kind = kindSel.value as AssetKind | ''; renderGrid(); });
  const unusedBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
  unusedBox.addEventListener('change', () => { unusedOnly = unusedBox.checked; renderGrid(); });
  const picker = h('input', { type: 'file', multiple: true, style: 'display:none' }) as HTMLInputElement;
  picker.addEventListener('change', async () => {
    const done = await importFiles(app, [...(picker.files ?? [])], folder);
    picker.value = '';
    if (done.length) { selected = done[done.length - 1]; render(); }
  });
  const crumbs = h('span', { class: 'crumbs' });
  const pickBtn = h('button', { title: T('ファイルを選んで、このフォルダに取り込む（ドロップでも可）'), onclick: () => picker.click() }, T('＋ 取り込む'));
  const folderBtn = h('button', { class: 'icon', title: T('このフォルダの中に新しいフォルダ'), onclick: newFolder }, '📁+');
  const bar = h('div', { class: 'toolbar' }, crumbs, h('span', { class: 'spacer' }), searchBox, kindSel,
    h('label', { class: 'row', title: T('どこからも使われていないものだけ') }, unusedBox, T('未使用')),
    pickBtn, folderBtn, picker);
  el.append(bar, h('div', { class: 'asset-body' }, tree, grid, side));
  dropTarget(grid, () => folder);

  const renderCrumbs = () => {
    const files = view === 'files';
    for (const x of [kindSel, unusedBox.parentElement!, pickBtn, folderBtn]) x.style.display = files ? '' : 'none';
    if (view === 'tables') return clear(crumbs, T('📋 表'));
    if (view === 'prefabs') return clear(crumbs, h('a', { onclick: () => { ptag = null; ppre = null; render(); } }, T('🧩 プレハブ')),
      ptag !== null ? [h('span', { class: 'muted' }, ' / '), h('a', { onclick: () => { ppre = null; render(); } }, ptag === '' ? T('（タグなし）') : T('🏷 {0}', ptag))] : null,
      ppre ? [h('span', { class: 'muted' }, ' / '), `${ppre}…`] : null);
    const parts = folder ? folder.split('/') : [];
    clear(crumbs, h('a', { onclick: () => { folder = ''; render(); } }, '📁'),
      parts.map((p, i) => [h('span', { class: 'muted' }, ' / '), h('a', { onclick: () => { folder = parts.slice(0, i + 1).join('/'); render(); } }, p)]));
  };

  const renderTree = () => {
    const all = folders();
    const counts = new Map<string, number>();
    for (const a of app.state.assets) for (let d = dirOf(a.path); d; d = dirOf(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
    const node = (d: string, depth: number): HTMLElement[] => {
      const kids = all.filter((x) => dirOf(x) === d);
      const shut = closed.has(d);
      const row = h('div', { class: `tree-item${view === 'files' && d === folder ? ' on' : ''}`, style: `padding-left:${4 + depth * 12}px`, title: d || T('プロジェクトの直下'),
        onclick: () => { view = 'files'; folder = d; render(); } },
        h('span', { class: 'twisty', onclick: (e: Event) => { e.stopPropagation(); if (shut) closed.delete(d); else closed.add(d); renderTree(); } }, kids.length ? (shut ? '▸' : '▾') : ' '),
        T('📁 {0}', d ? baseOf(d) : T('（直下）')), counts.get(d) ? h('span', { class: 'muted' }, ` ${counts.get(d)}`) : null);
      if (d) row.addEventListener('contextmenu', (e) => folderMenu(e, d));
      if (d) draggable(row, d);
      dropTarget(row, d);
      return [row, ...(shut ? [] : kids.flatMap((k) => node(k, depth + 1)))];
    };
    const roots = all.filter((d) => !dirOf(d));
    const rootFiles = app.state.assets.some((a) => !dirOf(a.path));
    // プレハブ（タグごと）と表
    const names = Object.keys(app.state.prefabs);
    const tags = new Map<string, number>();
    let untagged = 0;
    for (const n of names) { const t = tagsOf(n); if (!t.length) untagged++; for (const x of t) tags.set(x, (tags.get(x) ?? 0) + 1); }
    const pick = (tag: string | null) => () => { view = 'prefabs'; ptag = tag; ppre = null; render(); };
    const shutP = closed.has('@prefabs');
    const prow = (label: string, n: number, on: boolean, depth: number, go: () => void, twisty = ' ') => h('div', { class: `tree-item${on ? ' on' : ''}`, style: `padding-left:${4 + depth * 12}px`, onclick: go },
      h('span', { class: 'twisty', onclick: (e: Event) => { if (twisty === ' ') return; e.stopPropagation(); if (shutP) closed.delete('@prefabs'); else closed.add('@prefabs'); renderTree(); } }, twisty), label, h('span', { class: 'muted' }, ` ${n}`));
    const prefabRows = names.length ? [
      prow(T('🧩 プレハブ'), names.length, view === 'prefabs' && ptag === null, 0, pick(null), tags.size || untagged ? (shutP ? '▸' : '▾') : ' '),
      ...(shutP ? [] : [...[...tags].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => prow(T('🏷 {0}', t), n, view === 'prefabs' && ptag === t, 1, pick(t))),
        ...(untagged && tags.size ? [prow(T('（タグなし）'), untagged, view === 'prefabs' && ptag === '', 1, pick(''))] : [])]),
    ] : [];
    const tableRows = app.registry?.tables.size ? [prow(T('📋 表'), app.registry.tables.size, view === 'tables', 0, () => { view = 'tables'; render(); })] : [];
    clear(tree, rootFiles ? node('', 0).slice(0, 1) : null, roots.flatMap((r) => node(r, 0)), prefabRows, tableRows);
  };

  /** プレハブの見本（絵があれば絵、なければ名前）。クリックで選ぶ・ダブルクリックで開く・運ぶとインスタンス・右クリックでメニュー */
  const prefabTile = (n: string) => {
    const raw = app.state.prefabs[n];
    let comps = raw.components;
    try { comps = resolvePrefab(prefabMap(), n).components; } catch { /* 元がない派生: 書いてある値で */ }
    const img = comps.Sprite?.image as string | undefined;
    const pixel = app.state.config.view.filter === 'nearest';
    const desc = raw.desc ? TD(raw.desc) : '';
    const locks = lockN(`@${n}`);
    const on = app.sel?.kind === 'prefab' && app.sel.name === n;
    const t = h('div', {
      class: `tile prefab${on ? ' on' : ''}`, 'data-ai': `@${n}`, draggable: true,
      title: T('@{0}{1}{2}{3}\nダブルクリックで開く。ゲームの画面・階層へ運ぶと置く。右クリックで写す・名前を変える・削除', n, raw.base ? ` ← @${raw.base}` : '', desc ? '\n' + desc : '', tagsOf(n).length ? '\n🏷 ' + tagsOf(n).join(', ') : ''),
      onclick: () => app.select({ kind: 'prefab', name: n }),
      ondblclick: () => app.openPrefab(n),
      ondragstart: (e: DragEvent) => { e.dataTransfer!.setData(PREFAB_MIME, n); e.dataTransfer!.effectAllowed = 'copy'; },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        if (app.play) return;
        app.select({ kind: 'prefab', name: n });
        const items = menuItemsFor(app, 'prefab', [`@${n}`]);
        if (items.length) menu(e.clientX, e.clientY, items);
      },
    },
    h('div', { class: 'tile-pic' }, img ? h('img', { src: app.assetUrl(img), loading: 'lazy', alt: '', style: pixel ? 'image-rendering:pixelated' : '' }) : h('div', { class: 'tile-icon' }, '🧩')),
    h('div', { class: 'tile-name' }, locks ? h('span', { style: 'color:var(--lock)' }, `🔒${locks} `) : '', '@' + n),
    h('div', { class: 'tile-meta muted' }, raw.base ? `← @${raw.base}` : firstSentence(desc)));
    return t;
  };

  const renderPrefabGrid = () => {
    let names = Object.keys(app.state.prefabs).sort();
    if (search) { clear(grid, ...(names = names.filter((n) => n.toLowerCase().includes(search))).map(prefabTile)); if (!names.length) clear(grid, h('div', { class: 'muted empty' }, T('見つかりません'))); return; }
    if (ptag !== null) names = names.filter((n) => (ptag === '' ? !tagsOf(n).length : tagsOf(n).includes(ptag!)));
    if (ppre) { clear(grid, names.filter((n) => prefixOf(n) === ppre).map(prefabTile)); return; }
    const count = new Map<string, number>();
    for (const n of names) { const p = prefixOf(n); if (p) count.set(p, (count.get(p) ?? 0) + 1); }
    const done = new Set<string>();
    const items: HTMLElement[] = [];
    for (const n of names) {
      const p = prefixOf(n);
      if (p && (count.get(p) ?? 0) >= GROUP_MIN) {
        if (done.has(p)) continue;
        done.add(p);
        items.push(h('div', { class: 'tile folder', title: T('名前が {0} で始まるプレハブ {1}個', p, count.get(p)), onclick: () => { ppre = p; render(); } },
          h('div', { class: 'tile-pic' }, h('div', { class: 'tile-icon' }, '🧩')), h('div', { class: 'tile-name' }, `${p}…`), h('div', { class: 'tile-meta muted' }, `×${count.get(p)}`)));
        continue;
      }
      items.push(prefabTile(n));
    }
    clear(grid, items.length ? items : h('div', { class: 'muted empty' }, T('プレハブはまだありません')));
  };

  const renderTableGrid = () => {
    const list = [...(app.registry?.tables.values() ?? [])].filter((t) => !search || t.name.toLowerCase().includes(search));
    clear(grid, list.map((t) => {
      const rows = app.state.tables?.[t.name]?.rows.length ?? 0;
      const locks = lockN(`$${t.name}`);
      return h('div', { class: 'tile', 'data-ai': `$${t.name}`, title: T('{0}\n表のエディタで開く', TD(t.desc ?? '')), onclick: () => app.emit('openTable', { name: t.name }) },
        h('div', { class: 'tile-pic' }, h('div', { class: 'tile-icon' }, '📋')),
        h('div', { class: 'tile-name' }, locks ? h('span', { style: 'color:var(--lock)' }, `🔒${locks} `) : '', '$' + t.name),
        h('div', { class: 'tile-meta muted' }, T('{0}行 {1}', rows, firstSentence(TD(t.desc ?? '')))));
    }));
  };

  const tile = (a: Asset, refs: Map<string, string[]>, showDir: boolean) => {
    const n = refs.get(a.path)?.length ?? 0;
    const pixel = app.state.config.view.filter === 'nearest';
    const pic = a.kind === 'image' ? h('img', { src: app.assetUrl(a.path), loading: 'lazy', alt: '', style: pixel ? 'image-rendering:pixelated' : '' })
      : a.kind === 'sound' ? h('div', { class: 'tile-icon' }, '🔊', h('button', { class: 'icon tile-play', title: T('鳴らす'), onclick: (e: Event) => { e.stopPropagation(); open(a); } }, '▶'))
      : a.kind === 'shader' ? h('div', { class: 'tile-icon', title: a.shader?.desc ?? '' }, a.shader?.errors.length ? '⚠' : '✦')
      : a.kind === 'model' ? h('div', { class: 'tile-icon' }, '🧊')
      : h('div', { class: 'tile-icon', style: `font-family:${fontFamily(app, a.path)}` }, T('Aaあ'));
    const meta = a.kind === 'image' ? `${a.w ?? '?'}×${a.h ?? '?'}` : a.kind === 'model' && a.model ? `${a.model.size.join('×')}m` : a.kind === 'sound' ? (a.sec !== undefined ? T('{0}秒', a.sec) : kb(a.bytes)) : kb(a.bytes);
    const locked = !!app.state.locks[`file:${a.path}`];
    const t = h('div', { class: `tile${a.path === selected ? ' on' : ''}${n ? '' : ' unused'}`, title: T('{0}\n{1} {2} {3}\n{4}{5}', a.path, KIND_LABEL[a.kind], meta, kb(a.bytes), n ? T('{0}か所で使用', n) : T('未使用'), locked ? T('\n🔒 ロック中（差し替え・移動・削除はできません）') : ''),
      onclick: () => { selected = a.path; renderGrid(); renderSide(); el.focus(); },
      ondblclick: () => open(a) },
      h('div', { class: 'tile-pic' }, pic),
      h('div', { class: 'tile-name' }, locked ? '🔒' : '', baseOf(a.path)),
      h('div', { class: 'tile-meta muted' }, showDir ? dirOf(a.path) : T('{0}{1}', meta, n ? '' : T(' ・未使用'))));
    t.addEventListener('contextmenu', (e) => fileMenu(e, a));
    draggable(t, a.path);
    return t;
  };

  const renderGrid = () => {
    if (view === 'prefabs') return renderPrefabGrid();
    if (view === 'tables') return renderTableGrid();
    const refs = refsOf();
    const match = (a: Asset) => (!kind || a.kind === kind) && (!unusedOnly || !refs.get(a.path)?.length);
    let items: HTMLElement[];
    if (search) {
      items = app.state.assets.filter((a) => match(a) && a.path.toLowerCase().includes(search)).map((a) => tile(a, refs, true));
    } else {
      const subs = folders().filter((d) => dirOf(d) === folder).map((d) => {
        const t = h('div', { class: 'tile folder', title: d, onclick: () => { folder = d; render(); } }, h('div', { class: 'tile-pic' }, h('div', { class: 'tile-icon' }, '📁')), h('div', { class: 'tile-name' }, baseOf(d)));
        t.addEventListener('contextmenu', (e) => folderMenu(e, d));
        draggable(t, d);
        dropTarget(t, d);
        return t;
      });
      items = [...subs, ...app.state.assets.filter((a) => dirOf(a.path) === folder && match(a)).map((a) => tile(a, refs, false))];
    }
    clear(grid, items.length ? items : h('div', { class: 'muted empty' }, search ? T('見つかりません') : T('ここにファイルをドロップすると、このフォルダに取り込みます')));
  };

  const renderSide = () => {
    if (view !== 'files') {
      const n = app.sel?.kind === 'prefab' ? app.sel.name : '';
      const p = view === 'prefabs' ? app.state.prefabs[n] : undefined;
      if (!p) return clear(side, h('div', { class: 'muted' }, view === 'prefabs' ? T('プレハブを選ぶと、インスペクタに出ます。ダブルクリックで開き、ゲームの画面・階層へ運ぶと置けます') : T('表をクリックすると、表のエディタで開きます')));
      return clear(side,
        h('div', { class: 'side-path' }, `@${n}`, p.base ? h('span', { class: 'muted' }, ` ← @${p.base}`) : null),
        p.desc ? h('div', {}, TD(p.desc)) : null,
        tagsOf(n).length ? h('div', { class: 'muted' }, '🏷 ' + tagsOf(n).join(', ')) : null,
        h('div', { class: 'row', style: 'gap:4px;margin:6px 0' }, h('button', { onclick: () => app.openPrefab(n) }, T('開く'))));
    }
    const a = app.state.assets.find((x) => x.path === selected);
    if (!a) return clear(side, h('div', { class: 'muted' }, T('アセットを選ぶと、ここに詳しく出ます。ゲームの画面へドラッグすると置けます')));
    const refs = refsOf().get(a.path) ?? [];
    const preview = a.kind === 'image' ? h('div', { class: 'side-pic' }, h('img', { src: app.assetUrl(a.path), alt: '', style: app.state.config.view.filter === 'nearest' ? 'image-rendering:pixelated' : '' }))
      : a.kind === 'sound' ? h('div', { class: 'row' }, h('button', { onclick: () => open(a) }, T('▶ 鳴らす')), h('button', { onclick: () => app.audio.stopAll() }, '■'))
      : a.kind === 'shader' ? h('div', { class: 'shader-info' },
        h('div', {}, a.shader?.desc || T('（説明なし: 先頭の // コメントに書く）')),
        ...Object.entries(a.shader?.uniforms ?? {}).map(([k, f]) => h('div', { class: 'muted', style: 'font:var(--mono)' }, `${k}: ${brief(f)}${f.desc ? ' — ' + f.desc : ''}`)),
        ...(a.shader?.errors ?? []).map((e) => h('div', { style: 'color:var(--bad)' }, e)),
        h('button', { onclick: () => open(a) }, T('中身を開く')))
      : a.kind === 'model' ? h('div', { class: 'shader-info' },
        a.model ? h('div', {}, T('大きさ {0} m（幅×高さ×奥行き）', a.model.size.join(' × '))) : null,
        a.model ? h('div', { class: 'muted' }, T('三角形 {0}', a.model.tris)) : null,
        ...(a.model?.clips ?? []).map((c, i) => h('div', { class: 'muted', style: 'font:var(--mono)' }, `▶ ${c}  ${T('{0}秒', Math.round((a.model!.clipSec?.[i] ?? 0) * 100) / 100)}`)),
        h('div', { class: 'muted' }, T('「3D シーン」へドラッグすると置けます')))
      : h('div', { class: 'font-sample', contenteditable: 'true', style: `font-family:${fontFamily(app, a.path)}` }, T('あいうえお 漢字 ABC abc 123'));
    const sheet = app.state.sheets[a.path];
    const go = (r: string) => {
      const m = r.match(/^([^#@$]+)#([^.]+)/);
      if (m) return app.select({ kind: 'scene', scene: m[1], id: m[2] });
      const pf = r.match(/^@([^.]+)/);
      if (pf) return app.select({ kind: 'prefab', name: pf[1] });
      const t = r.match(/^\$([^.]+)\.([^.]+)/);
      if (t) app.emit('openTable', { name: t[1], row: t[2] });
    };
    // 出どころ（自作・AI 生成・素材・人に頼んだ）。ストアの申告とクレジットのための記録。シェーダーはコードなので出さない
    const origin = (): HTMLElement | null => {
      if (a.kind === 'shader') return null;
      const og = originOf(app.state.origins ?? {}, a.path), cur = og?.origin;
      const save = async (path: string, input: OriginInput) => {
        const r = await fetch('/api/origin', { method: 'POST', body: JSON.stringify({ path, origin: input }) });
        const j = (await r.json()) as { error?: string };
        if (j.error) toast(j.error);
        await app.refresh();
      };
      const by = h('select', { title: T('この素材をどう用意したか（ストアへの申告とクレジットのための記録）') },
        h('option', { value: '' }, T('未記入')),
        ...ORIGIN_BY.map((b) => h('option', { value: b }, ORIGIN_LABEL(b)))) as HTMLSelectElement;
      by.value = cur?.by ?? '';
      const values = (): OriginInput => ({ by: by.value || 'none', tool: tool.value, license: license.value, from: from.value });
      const field = (key: 'tool' | 'license' | 'from', hint: string) => {
        const el = h('input', { type: 'text', placeholder: hint, title: hint, value: cur?.[key] ?? '', style: 'flex:1;min-width:90px' }) as HTMLInputElement;
        el.addEventListener('change', () => { if (by.value) void save(a.path, values()); });
        return el;
      };
      const tool = field('tool', T('使った道具（AI の名前など）')), license = field('license', T('ライセンス（CC0 など）')), from = field('from', T('入手元（作者・配布元・URL）'));
      by.addEventListener('change', () => { if (by.value || originOf(app.state.origins ?? {}, a.path)?.key === a.path) void save(a.path, values()); });
      const dir = dirOf(a.path);
      return h('div', { class: 'origin', style: 'margin:6px 0' },
        h('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap' },
          h('span', { style: cur ? '' : 'color:var(--bad)' }, T('出どころ')), by,
          dir ? h('button', { title: T('同じフォルダの素材すべてを、この出どころにする（ファイルごとに書いたものは、そのまま）'), onclick: () => { if (by.value) void save(dir + '/', values()); } }, T('フォルダ全部に')) : null),
        h('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;margin-top:4px' }, tool, license, from),
        og && og.key !== a.path ? h('div', { class: 'muted' }, T('フォルダ {0} の記録', og.key)) : null);
    };
    clear(side,
      preview,
      h('div', { class: 'side-path' }, a.path),
      app.state.locks[`file:${a.path}`] ? h('div', { style: 'color:var(--lock);margin:2px 0' }, T('🔒 ロック中（差し替え・移動・削除はできません） '), h('a', { style: 'cursor:pointer;text-decoration:underline', onclick: () => app.openLocks(`file:${a.path}`) }, T('ロックマネージャー'))) : null,
      h('div', { class: 'muted' }, [KIND_LABEL[a.kind], a.kind === 'image' ? `${a.w}×${a.h}` : '', a.sec !== undefined ? T('{0}秒', a.sec) : '', kb(a.bytes), sheet ? (sheet.frames ? T('コマ{0}（自由）', sheet.frames.length) : sheet.frame ? T('コマ {0}×{1}', sheet.frame[0], sheet.frame[1]) : '') : ''].filter(Boolean).join(T('・'))),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin:6px 0' },
        a.kind === 'image' ? h('button', { onclick: () => open(a) }, T('✂ 切り方')) : null,
        h('button', { onclick: () => rename(a.path, false) }, T('名前')),
        h('button', { onclick: () => moveTo(a.path, false) }, T('移動')),
        h('button', { onclick: () => remove(a.path, false), title: refs.length ? T('使われているので消せません') : '' }, T('消す')),
        app.state.locks[`file:${a.path}`]
          ? h('button', { onclick: () => app.openLocks(`file:${a.path}`), title: T('ロックを見る・外す（ロックマネージャーで）') }, '🔒')
          : h('button', { onclick: () => app.lock([`file:${a.path}`], 'assets'), title: T('このファイルそのものをロックする（差し替え・移動・削除ができなくなります。外すのはロックマネージャーで）') }, '🔓')),
      origin(),
      h('div', { class: 'muted' }, refs.length ? T('使っている所 {0}', refs.length) : T('使っている所はありません')),
      h('ul', { class: 'refs' }, refs.map((r) => h('li', {}, r.endsWith('（コード）') ? h('span', {}, r.replace(/（コード）$/, T('（コード）'))) : h('a', { onclick: () => go(r) }, r)))));
  };

  const render = () => {
    if (!app.state || app.state.error) return;
    if (folder && !folders().includes(folder)) folder = folders().includes('assets') ? 'assets' : '';
    renderCrumbs();
    renderTree();
    renderGrid();
    renderSide();
  };

  el.addEventListener('keydown', (e) => {
    if (e.target !== el || !selected) return;
    const a = app.state.assets.find((x) => x.path === selected);
    if (!a) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(a.path, false); }
    if (e.key === 'F2') { e.preventDefault(); rename(a.path, false); }
    if (e.key === 'Enter') open(a);
  });
  app.on('change', render);
  app.on('select', () => { if (view === 'prefabs') { renderGrid(); renderSide(); } });
  return {
    id: 'assets', title: T('アセット'), el, fill: true, area: 'bottom', render,
    reveal(path: string) {
      view = 'files';
      folder = kindOf(path) ? dirOf(path) : path;
      selected = path;
      search = '';
      searchBox.value = '';
      render();
    },
  };
}
