// アセットの画面。画像・音・フォントをフォルダごとに見て、取り込み・名前の変更・移動・削除をする。
// 場所を変えると、使っている値（シーン・プレハブ・表）と画像の切り方も一緒に直る（moveAsset）。使われているものは消せない。
import type { App } from '../app.ts';
import type { Panel } from './layout.ts';
import { clear, h, menu, modal, toast } from './dom.ts';
import { assetRefs, baseOf, checkAssetPath, dirOf, extOf, isUnder, kindOf, RESERVED_DIRS } from '../../core/assets.ts';
import { ASSET_LABEL, brief, type AssetKind } from '../../core/schema.ts';

/** ドラッグで運ぶアセットの場所（ゲームの画面・インスペクタ・フォルダへ落とせる） */
export const ASSET_MIME = 'application/x-ages-asset';
/** プロジェクトのプレハブをゲームの画面へ運ぶとき（落とした所にインスタンスを置く） */
export const PREFAB_MIME = 'application/x-ages-prefab';

type Asset = App['state']['assets'][number];

const KIND_LABEL: Record<AssetKind, string> = ASSET_LABEL;
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
            h('h3', {}, '同じ名前のファイルがあります'),
            h('p', {}, path),
            h('p', { class: 'muted' }, '差し替えると、使っている所はそのまま新しい中身になります。'),
            files.length > 1 ? h('label', { class: 'row' }, rest, '残りも同じようにする') : null,
            h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' },
              h('button', { onclick: () => pick(null) }, 'やめる'),
              h('button', { onclick: () => pick('keep') }, `両方残す（${baseOf(data.free ?? '')}）`),
              h('button', { class: 'primary', onclick: () => pick('replace') }, '差し替える')));
        });
      });
      if (!choice) continue;
      try { done.push((await send(choice)).path); } catch (e2) { toast((e2 as Error).message, 'bad', 6000); }
    }
  }
  if (done.length) toast(`取り込みました: ${done.map(baseOf).join(', ')}`);
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

  // ---------- 情報 ----------
  const refsOf = (): Map<string, string[]> => {
    const s = app.state;
    if (!app.registry) return new Map();
    const docs = { scenes: new Map(Object.entries(s.scenes)), prefabs: new Map(Object.entries(s.prefabs)), tables: new Map(Object.entries(s.tables)) };
    const refs = assetRefs(docs, app.registry);
    for (const [k, v] of Object.entries(s.codeRefs ?? {})) refs.set(k, [...(refs.get(k) ?? []), ...v.map((c) => `${c}（コード）`)]);
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
    toast(`${baseOf(from)} → ${to}${fixed ? `（使っている値 ${fixed}か所も直しました）` : ''}`);
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
      return h('div', {}, h('h3', {}, dir ? 'フォルダの名前を変える' : '名前を変える'),
        h('div', { class: 'row' }, input, ext ? h('span', { class: 'muted' }, ext) : null),
        h('p', { class: 'muted' }, '使っている値と画像の切り方も一緒に直ります。'),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, 'やめる'), h('button', { class: 'primary', onclick: go }, '変える')));
    });
  };
  const moveTo = (path: string, dir: boolean) => {
    modal((close) => {
      const options = ['', ...folders()].filter((d) => !dir || (d !== path && !isUnder(d, path)));
      const sel = h('select', { style: 'flex:1' }, options.map((d) => h('option', { value: d, selected: d === dirOf(path) }, d ? d + '/' : '（プロジェクトの直下）'))) as HTMLSelectElement;
      const go = () => { close(); move(path, (sel.value ? sel.value + '/' : '') + baseOf(path)); };
      return h('div', {}, h('h3', {}, `${baseOf(path)} を動かす`), h('div', { class: 'row' }, sel),
        h('p', { class: 'muted' }, 'フォルダへのドラッグでも動かせます。'),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, 'やめる'), h('button', { class: 'primary', onclick: go }, '動かす')));
    });
  };
  const remove = (path: string, dir: boolean) => {
    const refs = refsOf();
    const used = dir ? app.state.assets.filter((a) => isUnder(a.path, path)).flatMap((a) => (refs.get(a.path) ?? []).map((r) => `${baseOf(a.path)}: ${r}`)) : refs.get(path) ?? [];
    modal((close) => used.length
      ? h('div', {}, h('h3', {}, `${baseOf(path)} は使われています`),
        h('p', { class: 'muted' }, '使われているものは消せません。先にその指定を変えてください。'),
        h('ul', { class: 'refs' }, used.slice(0, 12).map((r) => h('li', {}, r))), used.length > 12 ? h('p', { class: 'muted' }, `ほか ${used.length - 12}か所`) : null,
        h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, h('button', { onclick: close }, '閉じる')))
      : h('div', {}, h('h3', {}, `${dir ? 'フォルダ ' : ''}${path} を消しますか？`),
        dir ? h('p', { class: 'muted' }, '中のファイルもすべて消えます。') : null,
        h('p', { class: 'muted' }, 'Git で共有していれば、コミット前なら戻せます。'),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, 'やめる'),
          h('button', { class: 'danger', onclick: async () => { close(); if (await app.patch([{ op: 'removeAsset', path }], 'assets')) { toast(`消しました: ${path}`); if (selected === path || isUnder(selected, path)) selected = ''; if (folder === path || isUnder(folder, path)) folder = dirOf(path); render(); } } }, '消す'))));
  };
  const newFolder = () => {
    modal((close) => {
      const input = h('input', { type: 'text', value: '', placeholder: '例 enemies', style: 'flex:1' }) as HTMLInputElement;
      const go = async () => {
        const name = input.value.trim();
        if (!name) return;
        const path = (folder ? folder + '/' : '') + name;
        close();
        try { await app.api(`/api/mkdir?path=${encodeURIComponent(path)}`, { method: 'POST' }); folder = path; await app.refresh(); } catch (e) { toast((e as Error).message, 'bad'); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      setTimeout(() => input.focus(), 0);
      return h('div', {}, h('h3', {}, `新しいフォルダ（${folder || 'プロジェクトの直下'} の中）`), h('div', { class: 'row' }, input),
        h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px;margin-top:12px' }, h('button', { onclick: close }, 'やめる'), h('button', { class: 'primary', onclick: go }, '作る')));
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
      ...(a.kind === 'image' ? [['切り方を開く', () => open(a)] as [string, () => void]] : a.kind === 'sound' ? [['鳴らす', () => open(a)] as [string, () => void]] : []),
      ['名前を変える（F2）', () => rename(a.path, false)],
      ['別のフォルダへ', () => moveTo(a.path, false)],
      ['場所をコピー', () => { navigator.clipboard?.writeText(a.path); toast(`コピーしました: ${a.path}`); }],
      [app.state.locks[`file:${a.path}`] ? '🔒 ロック中（ロックマネージャーで外す）' : '🔒 ロックする', () => (app.state.locks[`file:${a.path}`] ? app.openLocks(`file:${a.path}`) : app.lock([`file:${a.path}`], 'assets'))],
      ['消す（Delete）', () => remove(a.path, false)],
    ]);
  };
  const folderMenu = (e: MouseEvent, d: string) => {
    e.preventDefault();
    e.stopPropagation();
    menu(e.clientX, e.clientY, [
      ['新しいフォルダ', () => { folder = d; newFolder(); }],
      ['名前を変える', () => rename(d, true)],
      ['別のフォルダへ', () => moveTo(d, true)],
      ['消す', () => remove(d, true)],
    ]);
  };

  // ---------- ドラッグ ----------
  /** el をフォルダ dest への落とし先にする（アセットなら移動、外のファイルなら取り込み） */
  const dropTarget = (target: HTMLElement, destOf: string | (() => string)) => {
    target.addEventListener('dragover', (e) => {
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
        if (isUnder(dest, path)) return toast('フォルダを自分の中へは動かせません', 'bad');
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
  const searchBox = h('input', { type: 'search', placeholder: '🔍 名前で探す', style: 'width:140px' }) as HTMLInputElement;
  searchBox.addEventListener('input', () => { search = searchBox.value.trim().toLowerCase(); renderGrid(); });
  const kindSel = h('select', { title: '種類' }, h('option', { value: '' }, 'すべて'), (Object.keys(KIND_LABEL) as AssetKind[]).map((k) => h('option', { value: k }, KIND_LABEL[k]))) as HTMLSelectElement;
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
  const bar = h('div', { class: 'toolbar' }, crumbs, h('span', { class: 'spacer' }), searchBox, kindSel,
    h('label', { class: 'row', title: 'どこからも使われていないものだけ' }, unusedBox, '未使用'),
    h('button', { title: 'ファイルを選んで、このフォルダに取り込む（ドロップでも可）', onclick: () => picker.click() }, '＋ 取り込む'),
    h('button', { class: 'icon', title: 'このフォルダの中に新しいフォルダ', onclick: newFolder }, '📁+'), picker);
  el.append(bar, h('div', { class: 'asset-body' }, tree, grid, side));
  dropTarget(grid, () => folder);

  const renderCrumbs = () => {
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
      const row = h('div', { class: `tree-item${d === folder ? ' on' : ''}`, style: `padding-left:${4 + depth * 12}px`, title: d || 'プロジェクトの直下',
        onclick: () => { folder = d; render(); } },
        h('span', { class: 'twisty', onclick: (e: Event) => { e.stopPropagation(); if (shut) closed.delete(d); else closed.add(d); renderTree(); } }, kids.length ? (shut ? '▸' : '▾') : ' '),
        `📁 ${d ? baseOf(d) : '（直下）'}`, counts.get(d) ? h('span', { class: 'muted' }, ` ${counts.get(d)}`) : null);
      if (d) row.addEventListener('contextmenu', (e) => folderMenu(e, d));
      if (d) draggable(row, d);
      dropTarget(row, d);
      return [row, ...(shut ? [] : kids.flatMap((k) => node(k, depth + 1)))];
    };
    const roots = all.filter((d) => !dirOf(d));
    const rootFiles = app.state.assets.some((a) => !dirOf(a.path));
    clear(tree, rootFiles ? node('', 0).slice(0, 1) : null, roots.flatMap((r) => node(r, 0)));
  };

  const tile = (a: Asset, refs: Map<string, string[]>, showDir: boolean) => {
    const n = refs.get(a.path)?.length ?? 0;
    const pixel = app.state.config.view.filter === 'nearest';
    const pic = a.kind === 'image' ? h('img', { src: app.assetUrl(a.path), loading: 'lazy', alt: '', style: pixel ? 'image-rendering:pixelated' : '' })
      : a.kind === 'sound' ? h('div', { class: 'tile-icon' }, '🔊', h('button', { class: 'icon tile-play', title: '鳴らす', onclick: (e: Event) => { e.stopPropagation(); open(a); } }, '▶'))
      : a.kind === 'shader' ? h('div', { class: 'tile-icon', title: a.shader?.desc ?? '' }, a.shader?.errors.length ? '⚠' : '✦')
      : h('div', { class: 'tile-icon', style: `font-family:${fontFamily(app, a.path)}` }, 'Aaあ');
    const meta = a.kind === 'image' ? `${a.w ?? '?'}×${a.h ?? '?'}` : a.kind === 'sound' ? (a.sec !== undefined ? `${a.sec}秒` : kb(a.bytes)) : kb(a.bytes);
    const locked = !!app.state.locks[`file:${a.path}`];
    const t = h('div', { class: `tile${a.path === selected ? ' on' : ''}${n ? '' : ' unused'}`, title: `${a.path}\n${KIND_LABEL[a.kind]} ${meta} ${kb(a.bytes)}\n${n ? `${n}か所で使用` : '未使用'}${locked ? '\n🔒 ロック中（差し替え・移動・削除はできません）' : ''}`,
      onclick: () => { selected = a.path; renderGrid(); renderSide(); el.focus(); },
      ondblclick: () => open(a) },
      h('div', { class: 'tile-pic' }, pic),
      h('div', { class: 'tile-name' }, locked ? '🔒' : '', baseOf(a.path)),
      h('div', { class: 'tile-meta muted' }, showDir ? dirOf(a.path) : `${meta}${n ? '' : ' ・未使用'}`));
    t.addEventListener('contextmenu', (e) => fileMenu(e, a));
    draggable(t, a.path);
    return t;
  };

  const renderGrid = () => {
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
    clear(grid, items.length ? items : h('div', { class: 'muted empty' }, search ? '見つかりません' : 'ここにファイルをドロップすると、このフォルダに取り込みます'));
  };

  const renderSide = () => {
    const a = app.state.assets.find((x) => x.path === selected);
    if (!a) return clear(side, h('div', { class: 'muted' }, 'アセットを選ぶと、ここに詳しく出ます。ゲームの画面へドラッグすると置けます'));
    const refs = refsOf().get(a.path) ?? [];
    const preview = a.kind === 'image' ? h('div', { class: 'side-pic' }, h('img', { src: app.assetUrl(a.path), alt: '', style: app.state.config.view.filter === 'nearest' ? 'image-rendering:pixelated' : '' }))
      : a.kind === 'sound' ? h('div', { class: 'row' }, h('button', { onclick: () => open(a) }, '▶ 鳴らす'), h('button', { onclick: () => app.audio.stopAll() }, '■'))
      : a.kind === 'shader' ? h('div', { class: 'shader-info' },
        h('div', {}, a.shader?.desc || '（説明なし: 先頭の // コメントに書く）'),
        ...Object.entries(a.shader?.uniforms ?? {}).map(([k, f]) => h('div', { class: 'muted', style: 'font:var(--mono)' }, `${k}: ${brief(f)}${f.desc ? ' — ' + f.desc : ''}`)),
        ...(a.shader?.errors ?? []).map((e) => h('div', { style: 'color:var(--bad)' }, e)),
        h('button', { onclick: () => open(a) }, '中身を開く'))
      : h('div', { class: 'font-sample', contenteditable: 'true', style: `font-family:${fontFamily(app, a.path)}` }, 'あいうえお 漢字 ABC abc 123');
    const sheet = app.state.sheets[a.path];
    const go = (r: string) => {
      const m = r.match(/^([^#@$]+)#([^.]+)/);
      if (m) return app.select({ kind: 'scene', scene: m[1], id: m[2] });
      const pf = r.match(/^@([^.]+)/);
      if (pf) return app.select({ kind: 'prefab', name: pf[1] });
      const t = r.match(/^\$([^.]+)\.([^.]+)/);
      if (t) app.emit('openTable', { name: t[1], row: t[2] });
    };
    clear(side,
      preview,
      h('div', { class: 'side-path' }, a.path),
      app.state.locks[`file:${a.path}`] ? h('div', { style: 'color:var(--lock);margin:2px 0' }, '🔒 ロック中（差し替え・移動・削除はできません） ', h('a', { style: 'cursor:pointer;text-decoration:underline', onclick: () => app.openLocks(`file:${a.path}`) }, 'ロックマネージャー')) : null,
      h('div', { class: 'muted' }, [KIND_LABEL[a.kind], a.kind === 'image' ? `${a.w}×${a.h}` : '', a.sec !== undefined ? `${a.sec}秒` : '', kb(a.bytes), sheet ? (sheet.frames ? `コマ${sheet.frames.length}（自由）` : sheet.frame ? `コマ ${sheet.frame[0]}×${sheet.frame[1]}` : '') : ''].filter(Boolean).join('・')),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin:6px 0' },
        a.kind === 'image' ? h('button', { onclick: () => open(a) }, '✂ 切り方') : null,
        h('button', { onclick: () => rename(a.path, false) }, '名前'),
        h('button', { onclick: () => moveTo(a.path, false) }, '移動'),
        h('button', { onclick: () => remove(a.path, false), title: refs.length ? '使われているので消せません' : '' }, '消す'),
        app.state.locks[`file:${a.path}`]
          ? h('button', { onclick: () => app.openLocks(`file:${a.path}`), title: 'ロックを見る・外す（ロックマネージャーで）' }, '🔒')
          : h('button', { onclick: () => app.lock([`file:${a.path}`], 'assets'), title: 'このファイルそのものをロックする（差し替え・移動・削除ができなくなります。外すのはロックマネージャーで）' }, '🔓')),
      h('div', { class: 'muted' }, refs.length ? `使っている所 ${refs.length}` : '使っている所はありません'),
      h('ul', { class: 'refs' }, refs.map((r) => h('li', {}, r.endsWith('（コード）') ? h('span', {}, r) : h('a', { onclick: () => go(r) }, r)))));
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
  return {
    id: 'assets', title: 'アセット', el, fill: true, area: 'bottom', render,
    reveal(path: string) {
      folder = kindOf(path) ? dirOf(path) : path;
      selected = path;
      search = '';
      searchBox.value = '';
      render();
    },
  };
}
