// 画像の切り方（スプライトエディタ）。Unity のスプライトエディタと同じように、コマの矩形を自由に決められる。
// - 格子（大きさ／数）・自動（描かれた部分ごと）で切る。切り直しても、同じ場所のコマは名前と基準点を引き継ぐ
// - 矩形はクリックで選び、ドラッグで移動、角や辺のつまみで大きさを変える。何もない所をドラッグすると新しいコマ
// - 名前・基準点（pivot）・動き（clips）もここで決める。保存は差分編集を通るので、操作ログ・★・🔒 が効く
import type { App } from '../app.ts';
import type { Op } from '../../core/patch.ts';
import { baseNameOf, checkSheet, checkSheetImage, isGrid, listFrames, sheetPathOf, type ClipDef, type FrameDef, type FrameRef, type SheetDef } from '../../core/sheet.ts';
import { autoRects, carryClips, gridRects, nameFrames, type Pixels, type Rect } from '../../core/slice.ts';
import { h, clear, toast, modal } from './dom.ts';
import type { Panel } from './layout.ts';

type DFrame = FrameDef & { orig?: string };
type Grid = { cell: [number, number]; spacing: number; margin: number };
type Mode = { kind: 'move' | 'create' | 'resize'; i: number; sx: number; sy: number; start: Rect; handle?: string };

const PIVOTS: [string, [number, number] | null][] = [
  ['なし（Sprite.anchor を使う）', null], ['中央', [0.5, 0.5]], ['下の中央', [0.5, 1]], ['上の中央', [0.5, 0]],
  ['左上', [0, 0]], ['左下', [0, 1]], ['右下', [1, 1]], ['左の中央', [0, 0.5]], ['右の中央', [1, 0.5]],
];
const HANDLE = 6;

export function spritePanel(app: App): Panel & { open(image: string): void } {
  const el = h('div', { class: 'sprite-ed' });
  let image = '';
  let img: HTMLImageElement | null = null;
  let pixels: Pixels | null = null;
  let W = 0, H = 0;
  let frames: DFrame[] = [];
  let clips: Record<string, ClipDef> = {};
  /** 格子のまま手を加えていないなら、その格子（保存すると短い格子の形になる） */
  let grid: Grid | null = null;
  let original: SheetDef | undefined;
  let dirty = false;
  let sel = -1;
  let zoom = 2;
  let mode: Mode | null = null;
  let preview: string | null = null;
  /** 画面に合わせた大きさにする必要があるか（画像を開いた直後。パネルが隠れている間は測れないので、見えたときに合わせる） */
  let needFit = true;

  const canvas = h('canvas', { tabindex: 0, class: 'sprite-canvas' }) as HTMLCanvasElement;
  const g = canvas.getContext('2d')!;
  const scroller = h('div', { class: 'sprite-scroll' }, canvas);
  const side = h('div', { class: 'sprite-side' });
  const bar = h('div', { class: 'sprite-bar' });
  const hint = h('div', { class: 'sprite-hint muted' }, 'クリックで選ぶ・ドラッグで移動・つまみで大きさ・何もない所をドラッグで新しいコマ・ダブルクリックで基準点・Delete で削除・矢印で1px（Shiftで10px）');
  const body = h('div', { class: 'sprite-body' }, scroller, side);

  const base = () => baseNameOf(image);
  const sheetOf = (): SheetDef | null => {
    if (!frames.length) return null;
    if (grid && !frames.some((f) => f.pivot)) {
      const s: SheetDef = { frame: grid.cell };
      if (grid.spacing) s.spacing = grid.spacing;
      if (grid.margin) s.margin = grid.margin;
      if (Object.keys(clips).length) s.clips = structuredClone(clips);
      return s;
    }
    const s: SheetDef = { frames: frames.map(({ orig: _o, ...f }) => structuredClone(f)) };
    if (Object.keys(clips).length) s.clips = structuredClone(clips);
    return s;
  };
  const touch = (structural = false) => {
    dirty = true;
    if (structural) grid = null;
    draw();
    status();
  };
  const freshName = () => {
    const names = new Set(frames.map((f) => f.name));
    let n = frames.length;
    while (names.has(`${base()}_${n}`)) n++;
    return `${base()}_${n}`;
  };
  const refOf = (i: number): FrameRef => (grid ? i : frames[i].name);

  // ---------- 読み込み ----------
  const load = () => {
    original = app.registry?.sheets.get(image);
    const size = app.registry?.images.get(image);
    W = size?.w ?? img?.naturalWidth ?? 0;
    H = size?.h ?? img?.naturalHeight ?? 0;
    clips = structuredClone(original?.clips ?? {});
    grid = null;
    if (original && isGrid(original)) {
      grid = { cell: original.frame!, spacing: original.spacing ?? 0, margin: original.margin ?? 0 };
      frames = listFrames(original, W, H).map((f) => ({ name: `${base()}_${f.index}`, rect: [f.x, f.y, f.w, f.h] }));
    } else {
      frames = (original?.frames ?? []).map((f) => ({ ...structuredClone(f), orig: f.name }));
    }
    dirty = false;
    sel = Math.min(sel, frames.length - 1);
  };

  const open = (path: string) => {
    if (dirty && path !== image && !confirm(`${image} の切り方の変更を保存していません。捨てて ${path} を開きますか？`)) return;
    const changed = path !== image;
    image = path;
    sel = -1;
    preview = null;
    if (changed || !img) {
      img = new Image();
      pixels = null;
      needFit = true;
      img.onload = () => {
        load();
        renderAll();
        fitIfNeeded();
      };
      img.src = app.assetUrl(image);
    }
    load();
    renderAll();
  };

  const getPixels = (): Pixels | null => {
    if (pixels || !img?.naturalWidth) return pixels;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cg = c.getContext('2d', { willReadFrequently: true })!;
    cg.drawImage(img, 0, 0);
    const d = cg.getImageData(0, 0, c.width, c.height);
    pixels = { w: d.width, h: d.height, data: d.data };
    return pixels;
  };

  // ---------- 描く ----------
  const fitIfNeeded = () => {
    if (!needFit || !img?.naturalWidth || scroller.clientWidth < 40) return;
    needFit = false;
    fit();
    draw();
    renderBar();
  };
  const fit = () => {
    if (!W || !H) return;
    const r = scroller.getBoundingClientRect();
    const z = Math.min((r.width - 24) / W, (r.height - 24) / H);
    zoom = z >= 1 ? Math.max(1, Math.floor(z)) : Math.max(0.1, Math.round(z * 100) / 100);
    zoom = Math.min(zoom, 8192 / Math.max(W, H));
  };
  const draw = () => {
    if (!img?.naturalWidth) return;
    const cw = Math.round(W * zoom), ch = Math.round(H * zoom);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    g.imageSmoothingEnabled = false;
    // 透明の部分が分かるよう市松模様
    const t = 8;
    for (let y = 0; y < ch; y += t) for (let x = 0; x < cw; x += t) { g.fillStyle = ((x + y) / t) % 2 ? '#2a2d36' : '#20232b'; g.fillRect(x, y, t, t); }
    g.drawImage(img, 0, 0, cw, ch);
    g.lineWidth = 1;
    g.font = '10px ui-monospace, monospace';
    frames.forEach((f, i) => {
      const [x, y, w, hh] = f.rect.map((v) => v * zoom);
      const on = i === sel;
      const inClip = preview && clips[preview]?.frames.some((r) => r === refOf(i));
      g.strokeStyle = on ? '#ffb02e' : inClip ? '#7ee787' : 'rgba(110,200,255,0.85)';
      g.lineWidth = on ? 2 : 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
      if (zoom >= 1.5 && w > 18 && hh > 12) {
        g.fillStyle = on ? '#ffb02e' : 'rgba(110,200,255,0.9)';
        g.fillText(String(i), x + 2, y + 10);
      }
      if (f.pivot) {
        const px = x + f.pivot[0] * w, py = y + f.pivot[1] * hh;
        g.strokeStyle = on ? '#ffb02e' : 'rgba(255,255,255,0.6)';
        g.beginPath(); g.moveTo(px - 4, py); g.lineTo(px + 4, py); g.moveTo(px, py - 4); g.lineTo(px, py + 4); g.stroke();
      }
    });
    if (sel >= 0 && frames[sel]) {
      g.fillStyle = '#ffb02e';
      for (const [, hx, hy] of handles(frames[sel].rect)) g.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
    }
  };
  const handles = (r: Rect): [string, number, number][] => {
    const [x, y, w, hh] = r.map((v) => v * zoom);
    return [['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y], ['e', x + w, y + hh / 2], ['se', x + w, y + hh], ['s', x + w / 2, y + hh], ['sw', x, y + hh], ['w', x, y + hh / 2]];
  };

  // ---------- マウス ----------
  const at = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top, x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };
  const inside = (r: Rect, x: number, y: number) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
  const clampRect = (r: Rect): Rect => {
    let [x, y, w, hh] = r.map(Math.round) as Rect;
    w = Math.max(1, Math.min(w, W)); hh = Math.max(1, Math.min(hh, H));
    x = Math.max(0, Math.min(x, W - w)); y = Math.max(0, Math.min(y, H - hh));
    return [x, y, w, hh];
  };
  canvas.addEventListener('mousedown', (e) => {
    if (!img?.naturalWidth) return;
    canvas.focus();
    const p = at(e);
    if (sel >= 0 && frames[sel]) {
      const hit = handles(frames[sel].rect).find(([, hx, hy]) => Math.abs(hx - p.mx) <= HANDLE && Math.abs(hy - p.my) <= HANDLE);
      if (hit) { mode = { kind: 'resize', i: sel, sx: p.x, sy: p.y, start: [...frames[sel].rect] as Rect, handle: hit[0] }; return; }
    }
    // 重なっていたら小さいもの（手前にありそうなもの）を選ぶ。選択中のものが含まれていればそれを優先
    const hits = frames.map((f, i) => ({ f, i })).filter(({ f }) => inside(f.rect, p.x, p.y)).sort((a, b) => a.f.rect[2] * a.f.rect[3] - b.f.rect[2] * b.f.rect[3]);
    const keep = hits.find((x) => x.i === sel);
    const pick = keep ?? hits[0];
    if (pick) {
      sel = pick.i;
      mode = { kind: 'move', i: sel, sx: p.x, sy: p.y, start: [...pick.f.rect] as Rect };
      renderSide();
      draw();
      return;
    }
    sel = -1;
    mode = { kind: 'create', i: -1, sx: Math.floor(p.x), sy: Math.floor(p.y), start: [Math.floor(p.x), Math.floor(p.y), 1, 1] };
    renderSide();
    draw();
  });
  window.addEventListener('mousemove', (e) => {
    if (!mode) return;
    const p = at(e);
    const dx = Math.round(p.x - mode.sx), dy = Math.round(p.y - mode.sy);
    if (mode.kind === 'move') {
      if (!dx && !dy && frames[mode.i].rect.join() === mode.start.join()) return;
      frames[mode.i].rect = clampRect([mode.start[0] + dx, mode.start[1] + dy, mode.start[2], mode.start[3]]);
    } else if (mode.kind === 'resize') {
      let [x0, y0] = [mode.start[0], mode.start[1]];
      let [x1, y1] = [mode.start[0] + mode.start[2], mode.start[1] + mode.start[3]];
      const hd = mode.handle!;
      if (hd.includes('w')) x0 = Math.min(x1 - 1, x0 + dx);
      if (hd.includes('e')) x1 = Math.max(x0 + 1, x1 + dx);
      if (hd.includes('n')) y0 = Math.min(y1 - 1, y0 + dy);
      if (hd.includes('s')) y1 = Math.max(y0 + 1, y1 + dy);
      frames[mode.i].rect = clampRect([Math.max(0, x0), Math.max(0, y0), Math.min(W, x1) - Math.max(0, x0), Math.min(H, y1) - Math.max(0, y0)]);
    } else {
      const x = Math.max(0, Math.min(W, Math.floor(p.x))), y = Math.max(0, Math.min(H, Math.floor(p.y)));
      const x0 = Math.min(mode.sx, x), y0 = Math.min(mode.sy, y);
      const r: Rect = [x0, y0, Math.max(1, Math.abs(x - mode.sx)), Math.max(1, Math.abs(y - mode.sy))];
      if (mode.i < 0) {
        if (r[2] < 2 && r[3] < 2) return; // クリックだけでは作らない
        frames.push({ name: freshName(), rect: clampRect(r) });
        mode.i = sel = frames.length - 1;
        renderSide();
      } else frames[mode.i].rect = clampRect(r);
    }
    touch(true);
    syncInputs();
  });
  window.addEventListener('mouseup', () => { if (mode) { mode = null; renderSide(); } });
  canvas.addEventListener('dblclick', (e) => {
    if (sel < 0) return;
    const p = at(e);
    const [x, y, w, hh] = frames[sel].rect;
    if (!inside(frames[sel].rect, p.x, p.y)) return;
    frames[sel].pivot = [round3((p.x - x) / w), round3((p.y - y) / hh)];
    touch(true);
    renderSide();
  });
  canvas.addEventListener('keydown', (e) => {
    if (sel < 0 || !frames[sel]) return;
    const step = e.shiftKey ? 10 : 1;
    const r = frames[sel].rect;
    const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (mv[e.key]) {
      e.preventDefault();
      frames[sel].rect = clampRect([r[0] + mv[e.key][0], r[1] + mv[e.key][1], r[2], r[3]]);
      touch(true);
      syncInputs();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSelected();
    }
  });
  const removeSelected = () => {
    if (sel < 0) return;
    const ref = refOf(sel);
    const using = Object.entries(clips).filter(([, c]) => c.frames.includes(ref)).map(([n]) => n);
    if (using.length) return toast(`このコマは動き ${using.join(', ')} で使われています。先に動きから外してください`, 'bad');
    // 番号で指定している動きは、後ろのコマが1つずつ前にずれるので、名前に変えておく
    for (const c of Object.values(clips)) c.frames = c.frames.map((r) => (typeof r === 'number' && r > sel ? frames[r].name : r));
    frames.splice(sel, 1);
    sel = Math.min(sel, frames.length - 1);
    touch(true);
    renderAll();
  };

  // ---------- 切る ----------
  const slice = (opts: { kind: 'cell' | 'count' | 'auto'; cell: [number, number]; count: [number, number]; spacing: number; margin: number; skipEmpty: boolean; alpha: number; min: number; gap: number; pad: number; pivot: [number, number] | null }) => {
    const px = opts.kind === 'auto' || opts.skipEmpty ? getPixels() : null;
    if ((opts.kind === 'auto' || opts.skipEmpty) && !px) return toast('画像の画素を読めませんでした', 'bad');
    let rects: Rect[];
    try {
      rects = opts.kind === 'auto'
        ? autoRects(px!, { alpha: opts.alpha, minSize: opts.min, gap: opts.gap, pad: opts.pad })
        : gridRects(W, H, { cell: opts.kind === 'cell' ? opts.cell : undefined, count: opts.kind === 'count' ? opts.count : undefined, spacing: opts.spacing, margin: opts.margin, skipEmpty: opts.skipEmpty }, px ?? undefined);
    } catch (e) { return toast((e as Error).message, 'bad'); }
    if (!rects.length) return toast('コマが1つも見つかりませんでした', 'bad');
    const before = sheetOf() ?? undefined;
    const pristineGrid = opts.kind === 'cell' && !opts.skipEmpty && !opts.pivot;
    // 前が自由な矩形なら、同じ場所のコマは名前と基準点を引き継ぐ
    const named = nameFrames(rects, base(), grid ? [] : frames, opts.pivot ?? undefined);
    const nextFrames: DFrame[] = named.map((f) => ({ ...f, orig: frames.find((o) => !grid && o.name === f.name)?.orig }));
    const nextGrid: Grid | null = pristineGrid ? { cell: opts.cell, spacing: opts.spacing, margin: opts.margin } : null;
    const nextSheet: SheetDef = nextGrid ? { frame: nextGrid.cell, spacing: nextGrid.spacing, margin: nextGrid.margin } : { frames: nextFrames.map(({ orig: _o, ...f }) => f) };
    const carried = carryClips(before, nextSheet, W, H);
    const apply = () => {
      frames = nextGrid ? named.map((f, i) => ({ name: `${base()}_${i}`, rect: f.rect })) : nextFrames;
      grid = nextGrid;
      if (carried.clips) clips = carried.clips;
      sel = -1;
      dirty = true;
      renderAll();
      toast(`${frames.length}コマに切りました（まだ保存していません）`);
    };
    if (!carried.missing.length) return apply();
    modal((close) => h('div', {},
      h('h3', {}, '動きのコマが無くなります'),
      h('div', {}, `この切り方では、次のコマが無くなります: ${carried.missing.join(', ')}`),
      h('div', { class: 'muted', style: 'margin-top:6px' }, '「外して切る」を選ぶと、そのコマを動きから外します'),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
        h('button', { onclick: close }, 'やめる'),
        h('button', { class: 'on', onclick: () => { close(); apply(); } }, '外して切る'))));
  };

  // ---------- 保存 ----------
  const save = async () => {
    if (!dirty) return;
    const sheet = sheetOf();
    const errs = sheet ? [...checkSheet(sheetPathOf(image), sheet), ...checkSheetImage(sheetPathOf(image), sheet, W, H)] : [];
    if (errs.length) return toast(errs.join('\n'), 'bad', 8000);
    const renames: Record<string, string> = {};
    for (const f of frames) if (f.orig && f.orig !== f.name) renames[f.orig] = f.name;
    const op: Op = { op: 'setSheet', image, sheet };
    if (Object.keys(renames).length) op.renames = renames;
    const r = await app.patch([op], 'sprite');
    if (r) { dirty = false; load(); renderAll(); toast(`保存しました（${image}）`); }
  };

  // ---------- 画面 ----------
  let saveBtn: HTMLButtonElement | null = null;
  let errBox: HTMLElement | null = null;
  const status = () => {
    if (saveBtn) { saveBtn.disabled = !dirty; saveBtn.className = dirty ? 'on' : ''; saveBtn.textContent = dirty ? '保存 ●' : '保存'; }
    if (errBox) {
      const s = sheetOf();
      const errs = s ? [...checkSheet(sheetPathOf(image), s), ...checkSheetImage(sheetPathOf(image), s, W, H)] : [];
      errBox.textContent = errs.length ? '⚠ ' + errs.join(' / ') : '';
      errBox.style.display = errs.length ? '' : 'none';
    }
  };

  const renderBar = () => {
    const images = app.state?.assets?.filter((a) => a.kind === 'image').map((a) => a.path) ?? [];
    const pick = h('select', { onchange: (e: Event) => open((e.target as HTMLSelectElement).value) },
      h('option', { value: '' }, '画像を選ぶ…'), images.map((p) => h('option', { value: p, selected: p === image }, p))) as HTMLSelectElement;
    const lockPath = `sheet:${image}`;
    const lock = app.state?.locks?.[lockPath];
    const touched = app.state?.touched?.[lockPath];
    const z = (f: number) => () => { zoom = Math.max(0.1, Math.min(32, f > 0 ? (zoom >= 1 ? zoom + 1 : zoom * 2) : (zoom > 1 ? zoom - 1 : zoom / 2))); draw(); zoomLabel.textContent = `${Math.round(zoom * 100)}%`; };
    const zoomLabel = h('span', { class: 'muted', style: 'min-width:44px;text-align:center' }, `${Math.round(zoom * 100)}%`);
    saveBtn = h('button', { onclick: save, title: '切り方を保存（操作ログに残ります）' }, '保存') as HTMLButtonElement;
    const solo = new URLSearchParams(location.search).get('solo');
    clear(bar,
      pick,
      image && h('span', { class: 'muted' }, `${W}x${H}`),
      h('button', { class: 'icon', title: '縮小', onclick: z(-1) }, '−'), zoomLabel, h('button', { class: 'icon', title: '拡大', onclick: z(1) }, '＋'),
      h('button', { title: '画面に合わせる', onclick: () => { fit(); draw(); zoomLabel.textContent = `${Math.round(zoom * 100)}%`; } }, '合わせる'),
      h('span', { class: 'spacer' }),
      touched && !lock ? h('span', { class: 'muted', title: `${touched.who} が調整` }, '★') : null,
      lock ? h('span', { style: 'color:var(--lock)', title: '変えるなら、ロックマネージャーで外してから' }, '🔒 ロック中（保存できません）') : null,
      image && h('button', {
        class: `icon lockbtn ${lock ? 'on' : ''}`,
        title: lock ? `🔒 この画像の切り方はロック中（${lock.who}）。AI もエディタも変えられません。クリックでロックマネージャーを開く` : 'この画像の切り方をロックする（ロックマネージャーが開きます）',
        onclick: () => app.openLocks(lockPath),
      }, lock ? '🔒' : '🔓'),
      h('button', { onclick: () => { load(); renderAll(); }, title: '保存していない変更を捨てる' }, '元に戻す'),
      saveBtn,
      solo || !image ? null : h('button', { class: 'icon', title: '別のウインドウで開く', onclick: () => window.open(`/?solo=sprite&image=${encodeURIComponent(image)}`, `ages-sprite-${image}`, 'width=1100,height=760') }, '↗'));
    status();
  };

  // 切り方の設定（前回の値を覚えておく）
  const sliceOpts = {
    kind: 'cell' as 'cell' | 'count' | 'auto', cell: [32, 32] as [number, number], count: [4, 4] as [number, number],
    spacing: 0, margin: 0, skipEmpty: false, alpha: 1, min: 2, gap: 0, pad: 0, pivot: null as [number, number] | null,
  };
  const sliceBox = () => {
    if (grid) { sliceOpts.cell = [...grid.cell] as [number, number]; sliceOpts.spacing = grid.spacing; sliceOpts.margin = grid.margin; }
    const o = sliceOpts;
    const numIn = (v: number, set: (n: number) => void, w = 52) => h('input', { type: 'number', value: String(v), min: '0', style: `width:${w}px`, onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value)) });
    const row = (label: string, ...c: unknown[]) => h('div', { class: 'row', style: 'gap:4px;margin:3px 0' }, h('span', { class: 'muted', style: 'width:64px' }, label), ...(c as HTMLElement[]));
    const params = h('div', {});
    const renderParams = () => clear(params,
      o.kind === 'cell' ? row('1コマ', numIn(o.cell[0], (n) => (o.cell[0] = n)), '×', numIn(o.cell[1], (n) => (o.cell[1] = n)), 'px') : null,
      o.kind === 'count' ? row('数', numIn(o.count[0], (n) => (o.count[0] = n)), '列 ×', numIn(o.count[1], (n) => (o.count[1] = n)), '行') : null,
      o.kind !== 'auto' ? row('隙間・余白', numIn(o.spacing, (n) => (o.spacing = n), 44), numIn(o.margin, (n) => (o.margin = n), 44)) : null,
      o.kind !== 'auto' ? row('', h('label', { class: 'row', style: 'gap:4px' }, h('input', { type: 'checkbox', checked: o.skipEmpty, onchange: (e: Event) => (o.skipEmpty = (e.target as HTMLInputElement).checked) }), '空のコマを除く')) : null,
      o.kind === 'auto' ? row('まとめる距離', numIn(o.gap, (n) => (o.gap = n), 44), h('span', { class: 'muted' }, 'px（離れた部品を1コマに）')) : null,
      o.kind === 'auto' ? row('小さすぎ', numIn(o.min, (n) => (o.min = n), 44), h('span', { class: 'muted' }, 'px未満は捨てる')) : null,
      o.kind === 'auto' ? row('広げる', numIn(o.pad, (n) => (o.pad = n), 44), h('span', { class: 'muted' }, 'px')) : null,
      row('基準点', h('select', { onchange: (e: Event) => (o.pivot = PIVOTS[Number((e.target as HTMLSelectElement).value)][1]) },
        PIVOTS.map(([l, v], i) => h('option', { value: String(i), selected: JSON.stringify(v) === JSON.stringify(o.pivot) }, l)))));
    renderParams();
    return h('div', { class: 'sprite-sec' },
      h('div', { class: 'sprite-h' }, '切る'),
      h('div', { class: 'seg' }, ([['cell', '格子（大きさ）'], ['count', '格子（数）'], ['auto', '自動']] as const).map(([k, l]) =>
        h('button', { class: o.kind === k ? 'on' : '', onclick: () => { o.kind = k; renderSide(); } }, l))),
      params,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:4px' },
        h('button', { class: 'on', disabled: !img?.naturalWidth, onclick: () => slice({ ...o }), title: '今のコマは置き換わります（同じ場所のコマは名前と基準点を引き継ぎます）' }, '切る')));
  };

  let inputs: { x: HTMLInputElement; y: HTMLInputElement; w: HTMLInputElement; h: HTMLInputElement } | null = null;
  const syncInputs = () => {
    if (!inputs || sel < 0 || !frames[sel]) return;
    const [x, y, w, hh] = frames[sel].rect;
    inputs.x.value = String(x); inputs.y.value = String(y); inputs.w.value = String(w); inputs.h.value = String(hh);
  };
  const frameBox = () => {
    inputs = null;
    if (sel < 0 || !frames[sel]) return h('div', { class: 'sprite-sec muted' }, frames.length ? 'コマを選ぶと、名前・位置・基準点を変えられます' : 'まだコマがありません。「切る」か、画像の上をドラッグして作ってください');
    const f = frames[sel];
    const setRect = (k: number) => (e: Event) => { const r = [...f.rect] as Rect; r[k] = Math.round(Number((e.target as HTMLInputElement).value)); f.rect = clampRect(r); touch(true); syncInputs(); };
    const n = (k: number) => h('input', { type: 'number', value: String(f.rect[k]), style: 'width:56px', onchange: setRect(k) }) as HTMLInputElement;
    inputs = { x: n(0), y: n(1), w: n(2), h: n(3) };
    const name = h('input', { type: 'text', value: f.name, style: 'flex:1' }) as HTMLInputElement;
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v || /^\d+$/.test(v)) { toast('名前は空や数字だけにできません', 'bad'); name.value = f.name; return; }
      if (frames.some((o, i) => i !== sel && o.name === v)) { toast(`${v} はもうあります`, 'bad'); name.value = f.name; return; }
      for (const c of Object.values(clips)) c.frames = c.frames.map((r) => (r === f.name ? v : r));
      f.name = v;
      touch(true);
      renderList();
    });
    const pv = f.pivot;
    const pvIdx = PIVOTS.findIndex(([, v]) => JSON.stringify(v) === JSON.stringify(pv ?? null));
    const px = h('input', { type: 'number', step: '0.05', value: pv ? String(pv[0]) : '', placeholder: '-', style: 'width:56px' }) as HTMLInputElement;
    const py = h('input', { type: 'number', step: '0.05', value: pv ? String(pv[1]) : '', placeholder: '-', style: 'width:56px' }) as HTMLInputElement;
    const setPivot = () => {
      if (px.value === '' && py.value === '') delete f.pivot;
      else f.pivot = [round3(Number(px.value || 0.5)), round3(Number(py.value || 0.5))];
      touch(true);
      renderSide();
    };
    px.addEventListener('change', setPivot);
    py.addEventListener('change', setPivot);
    return h('div', { class: 'sprite-sec' },
      h('div', { class: 'sprite-h' }, `コマ #${sel}`, grid ? h('span', { class: 'muted' }, '（格子のまま。番号で指定）') : null),
      h('div', { class: 'row', style: 'gap:4px' }, h('span', { class: 'muted', style: 'width:40px' }, '名前'), name),
      h('div', { class: 'row', style: 'gap:4px;margin-top:4px' }, h('span', { class: 'muted', style: 'width:40px' }, '位置'), inputs.x, inputs.y),
      h('div', { class: 'row', style: 'gap:4px;margin-top:4px' }, h('span', { class: 'muted', style: 'width:40px' }, '大きさ'), inputs.w, inputs.h),
      h('div', { class: 'row', style: 'gap:4px;margin-top:4px' }, h('span', { class: 'muted', style: 'width:40px' }, '基準点'),
        h('select', { style: 'flex:1;min-width:0', onchange: (e: Event) => { const v = PIVOTS[Number((e.target as HTMLSelectElement).value)][1]; if (v) f.pivot = [...v] as [number, number]; else delete f.pivot; touch(true); renderSide(); } },
          PIVOTS.map(([l], i) => h('option', { value: String(i), selected: i === pvIdx }, l)), pvIdx < 0 ? h('option', { selected: true }, '自由') : null)),
      h('div', { class: 'row', style: 'gap:4px;margin-top:4px' }, h('span', { class: 'muted', style: 'width:40px' }, ''), px, py, h('span', { class: 'muted' }, 'ダブルクリックでも')),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' },
        h('button', { onclick: () => { addToClip(); }, disabled: !preview, title: preview ? `動き ${preview} の最後に足す` : '動きを選ぶと使えます' }, `＋ ${preview ?? '動き'}に足す`),
        h('button', { onclick: removeSelected, style: 'color:var(--bad)' }, 'コマを消す')));
  };

  const listBox = h('div', { class: 'sprite-list' });
  const renderList = () => {
    clear(listBox, frames.map((f, i) => h('div', {
      class: `item ${i === sel ? 'sel' : ''}`,
      onclick: () => { sel = i; renderSide(); draw(); scrollTo(f.rect); },
    }, h('span', { class: 'muted', style: 'width:30px;display:inline-block' }, `#${i}`), f.name, h('span', { class: 'muted', style: 'margin-left:auto' }, `${f.rect[2]}x${f.rect[3]}`))));
  };
  const scrollTo = (r: Rect) => {
    const x = r[0] * zoom, y = r[1] * zoom;
    const sr = scroller.getBoundingClientRect();
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + sr.width - 40) scroller.scrollLeft = x - 40;
    if (y < scroller.scrollTop || y > scroller.scrollTop + sr.height - 40) scroller.scrollTop = y - 40;
  };

  // ---------- 動き ----------
  const addToClip = () => {
    if (!preview || sel < 0) return;
    clips[preview].frames.push(refOf(sel));
    touch();
    renderSide();
  };
  const parseRefs = (text: string): FrameRef[] => text.split(/[,\s]+/).filter(Boolean).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
  let previewCanvas: HTMLCanvasElement | null = null;
  const clipBox = () => {
    const names = Object.keys(clips);
    const rows = names.map((n) => {
      const c = clips[n];
      const nameIn = h('input', { type: 'text', value: n, style: 'width:84px' }) as HTMLInputElement;
      nameIn.addEventListener('change', () => {
        const v = nameIn.value.trim();
        if (!v || clips[v]) { nameIn.value = n; return toast(v ? `${v} はもうあります` : '名前が空です', 'bad'); }
        clips = Object.fromEntries(Object.entries(clips).map(([k, x]) => [k === n ? v : k, x]));
        if (preview === n) preview = v;
        touch();
        renderSide();
      });
      const framesIn = h('input', { type: 'text', value: c.frames.join(', '), style: 'flex:1;min-width:0;font:var(--mono)', title: 'コマの番号か名前を , で区切って' }) as HTMLInputElement;
      framesIn.addEventListener('change', () => { c.frames = parseRefs(framesIn.value); touch(); draw(); });
      return h('div', { class: `clip ${preview === n ? 'sel' : ''}` },
        h('div', { class: 'row', style: 'gap:4px' },
          h('button', { class: 'icon', title: 'この動きを再生（コマの上に足すときも、ここで選ぶ）', onclick: () => { preview = preview === n ? null : n; renderSide(); draw(); } }, preview === n ? '■' : '▶'),
          nameIn,
          h('input', { type: 'number', value: String(c.fps), min: '1', style: 'width:48px', title: '1秒あたりのコマ数', onchange: (e: Event) => { c.fps = Math.max(0.1, Number((e.target as HTMLInputElement).value)); touch(); } }), h('span', { class: 'muted' }, 'fps'),
          h('label', { class: 'row muted', style: 'gap:2px', title: '最後まで行ったら最初に戻る' }, h('input', { type: 'checkbox', checked: c.loop !== false, onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) delete c.loop; else c.loop = false; touch(); } }), '繰り返す'),
          h('button', { class: 'icon', title: 'この動きを消す', onclick: () => { delete clips[n]; if (preview === n) preview = null; touch(); renderSide(); } }, '×')),
        h('div', { class: 'row', style: 'gap:4px;margin-top:3px' }, framesIn));
    });
    previewCanvas = preview ? h('canvas', { width: 120, height: 120, class: 'sprite-preview' }) as HTMLCanvasElement : null;
    return h('div', { class: 'sprite-sec' },
      h('div', { class: 'sprite-h' }, '動き', h('span', { class: 'spacer' }),
        h('button', { onclick: () => {
          let i = names.length; while (clips[`anim${i}`]) i++;
          clips[`anim${i}`] = { frames: sel >= 0 ? [refOf(sel)] : frames.length ? [refOf(0)] : [], fps: 8 };
          preview = `anim${i}`;
          touch();
          renderSide();
        }, disabled: !frames.length }, '＋ 動き')),
      rows.length ? rows : h('div', { class: 'muted' }, 'まだありません'),
      previewCanvas);
  };
  // 動きの再生
  let last = performance.now(), t = 0;
  const tick = (now: number) => {
    requestAnimationFrame(tick);
    const dt = (now - last) / 1000;
    last = now;
    if (!preview || !previewCanvas || !img?.naturalWidth || !clips[preview]) return;
    const c = clips[preview];
    t += dt;
    const n = Math.floor(t * c.fps);
    const k = c.loop === false ? Math.min(n, c.frames.length - 1) : n % Math.max(1, c.frames.length);
    if (c.loop === false && n > c.frames.length + c.fps) t = 0; // 1回の動きも、少し待ってからもう一度見せる
    const ref = c.frames[k];
    const i = typeof ref === 'number' ? ref : frames.findIndex((f) => f.name === ref);
    const pg = previewCanvas.getContext('2d')!;
    pg.imageSmoothingEnabled = false;
    pg.fillStyle = '#20232b';
    pg.fillRect(0, 0, 120, 120);
    const f = frames[i];
    if (!f) return;
    // 基準点を真ん中に置いて描く（動きの中で位置がぶれないか確かめられる）
    const [x, y, w, hh] = f.rect;
    const s = Math.max(1, Math.floor(Math.min(100 / w, 100 / hh)));
    const [ax, ay] = f.pivot ?? [0.5, 0.5];
    pg.drawImage(img, x, y, w, hh, 60 - ax * w * s, 60 - ay * hh * s, w * s, hh * s);
    pg.strokeStyle = 'rgba(255,255,255,0.35)';
    pg.beginPath(); pg.moveTo(0, 60.5); pg.lineTo(120, 60.5); pg.moveTo(60.5, 0); pg.lineTo(60.5, 120); pg.stroke();
    pg.fillStyle = '#aaa';
    pg.font = '10px ui-monospace, monospace';
    pg.fillText(`${k + 1}/${c.frames.length} ${typeof ref === 'number' ? '#' + ref : ref}`, 4, 116);
  };
  requestAnimationFrame(tick);

  const renderSide = () => {
    errBox = h('div', { class: 'sprite-err' });
    renderList();
    clear(side, sliceBox(), frameBox(), clipBox(),
      h('div', { class: 'sprite-sec' }, h('div', { class: 'sprite-h' }, `コマ（${frames.length}）`, grid ? h('span', { class: 'muted' }, ' 格子') : null), listBox),
      errBox);
    status();
  };
  const renderAll = () => {
    renderBar();
    if (!image) {
      clear(el, bar, h('div', { class: 'pad muted' }, '画像を選ぶと、切り方（コマ・基準点・動き）を決められます。インスペクタの画像の ✂、プロジェクトの画像のクリックからも開けます'));
      return;
    }
    if (!el.contains(body)) clear(el, bar, body, hint);
    renderSide();
    draw();
  };

  // 外で切り方が変わったら（AIが変えた・Gitで取り込んだなど）、手を加えていなければ読み直す
  app.on('change', () => {
    if (!image) return renderBar();
    const cur = JSON.stringify(app.registry?.sheets.get(image) ?? null);
    if (!dirty && cur !== JSON.stringify(original ?? null)) { load(); renderAll(); }
    else renderBar();
  });
  new ResizeObserver(fitIfNeeded).observe(scroller);

  renderAll();
  return { id: 'sprite', title: '切り方', el, fill: true, area: 'center', open, render: fitIfNeeded };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
