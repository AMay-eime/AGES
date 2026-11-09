// ゲーム画面。WebGL2 で描き、その上の透明なキャンバスに選択の枠や印を描く。
// - クリックだけで選べる。重なっているときは、同じ場所をもう一度クリックすると奥のものへ
// - 画像も図形も文字もないもの（カメラ・敵を出す役など）は、編集中だけ◇の印を出して、それをクリックして選べる
// - 視点は「カメラ」（プレイヤーに見える通り）と「自由」（ホイールで拡大・右ドラッグで移動。カメラの範囲は枠で見える）
// - 画面の形（16:9・スマホ縦など）と合わせ方（view.fit）を切り替えて、見え方を確かめられる
import { resolvePrefab } from '../../core/variant.ts';
import type { App } from '../app.ts';
import { Renderer } from '../../render/webgl.ts';
import { camerasOf, fitView, screenToWorld, visibleCorners, worldToScreen, FIT_MODES, type CameraView, type FitMode } from '../../core/camera.ts';
import { h, menu, modal, toast } from './dom.ts';
import { menuItemsFor } from '../extensions.ts';
import { movable } from '../edit-ops.ts';
import type { Op } from '../../core/patch.ts';
import type { Panel } from './layout.ts';
import { ASSET_MIME, PREFAB_MIME } from './assets.ts';
import { baseOf, extOf, kindOf } from '../../core/assets.ts';
import type { ParticleCmd } from '../../core/particles.ts';
import { drawColliders, makeDraw, visibleRect } from '../stage-draw.ts';

const SCREENS: [string, number | null][] = [['パネルに合わせる', null], ['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['9:16（スマホ縦）', 9 / 16], ['9:19.5（細長いスマホ縦）', 9 / 19.5], ['19.5:9（細長いスマホ横）', 19.5 / 9]];
const FIT_LABEL: Record<FitMode, string> = { contain: '全体を入れる', cover: 'はみ出しを切る', stretch: '伸ばす', expand: '広い分だけ周りも見せる', pixel: '整数倍だけ' };
const MARK = 7;

export function gamePanel(app: App): Panel & { canvas: HTMLCanvasElement } {
  const canvas = h('canvas', { width: 480, height: 640, tabindex: 0 }) as HTMLCanvasElement;
  const overlay = h('canvas', { width: 480, height: 640, style: 'position:absolute;left:0;top:0;pointer-events:none' }) as HTMLCanvasElement;
  const screen = h('div', { class: 'game-screen' }, canvas, overlay);
  const hud = h('div', { class: 'game-hud-text' });
  let viewMode: 'camera' | 'free' = 'camera';
  let screenAspect: number | null = null;
  let fitOverride: FitMode | null = null;
  const viewSel = h('select', { title: 'カメラ: プレイヤーに見える通り / 自由: ホイールで拡大・右ドラッグで移動（カメラの範囲は枠で見える）', onchange: (e: Event) => { viewMode = (e.target as HTMLSelectElement).value as 'camera' | 'free'; if (viewMode === 'free') resetFree(); layoutScreen(); } },
    h('option', { value: 'camera' }, '視点: カメラ'), h('option', { value: 'free' }, '視点: 自由')) as HTMLSelectElement;
  const screenSel = h('select', { title: '試しに見る画面の形', onchange: (e: Event) => { screenAspect = SCREENS[Number((e.target as HTMLSelectElement).value)][1]; layoutScreen(); } },
    SCREENS.map(([l], i) => h('option', { value: String(i) }, `画面: ${l}`))) as HTMLSelectElement;
  const fitSel = h('select', { title: '画面の大きさへの合わせ方。ここでの変更は試しに見るだけ（決めるのは ages.project.json の view.fit）', onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; fitOverride = v ? (v as FitMode) : null; layoutScreen(); } }) as HTMLSelectElement;
  const resetBtn = h('button', { title: '自由な視点を、ゲームの画面全体が見える位置に戻す', onclick: () => { resetFree(); }, style: 'display:none' }, '全体');
  // 当たり判定（Collider）の形を重ねて見せる（手元の設定）
  let showHits = localStorage.getItem('ages.showHits') === '1';
  const hitsBox = h('label', { class: 'row muted', style: 'gap:4px;white-space:nowrap', title: '当たり判定（Collider）の形を重ねて見せる。グループごとに色が変わる' },
    h('input', { type: 'checkbox', checked: showHits, onchange: (e: Event) => { showHits = (e.target as HTMLInputElement).checked; localStorage.setItem('ages.showHits', showHits ? '1' : '0'); } }), '当たり判定');
  // 格子への吸着（ドラッグ・矢印で動かすとき、位置を格子の目にそろえる。手元の設定）
  let snap = localStorage.getItem('ages.snap') === '1';
  let gridSize = Number(localStorage.getItem('ages.gridSize') ?? 16) || 16;
  const gridInput = h('input', { type: 'number', min: '1', max: '512', step: '1', value: String(gridSize), style: 'width:48px', title: '格子の目の大きさ(px)',
    onchange: (e: Event) => { gridSize = Math.max(1, Number((e.target as HTMLInputElement).value) || 16); localStorage.setItem('ages.gridSize', String(gridSize)); } });
  const snapBox = h('label', { class: 'row muted', style: 'gap:4px;white-space:nowrap', title: 'ドラッグ・矢印キーで動かすとき、位置を格子の目にそろえる（格子も見える）' },
    h('input', { type: 'checkbox', checked: snap, onchange: (e: Event) => { snap = (e.target as HTMLInputElement).checked; localStorage.setItem('ages.snap', snap ? '1' : '0'); app.emit('snap'); } }), '格子', gridInput);
  app.snap = () => (snap ? gridSize : 0);
  const saveBtn = h('button', { class: 'icon', title: '保存データ（このブラウザに残る。消す・saves/ に書き出す・saves/ から戻す）', onclick: () => saveDialog(app) }, '💾');
  // 言語（2つ以上あるとき）: 止めている画面と再生の言語を選ぶ
  const langSel = h('select', { title: '見る言語（表 $text の列。「設定のまま」なら保存の設定か既定の言語）' }) as HTMLSelectElement;
  const fillLang = () => {
    const langs = app.state.config.languages ?? [];
    langSel.style.display = langs.length > 1 ? '' : 'none';
    const cur = app.previewLang;
    langSel.replaceChildren(h('option', { value: '', selected: cur === '' }, '言語: 設定のまま'), ...langs.map((l) => h('option', { value: l, selected: cur === l }, `言語: ${l}`)));
  };
  langSel.addEventListener('change', () => { app.previewLang = langSel.value; });
  app.on('change', fillLang);
  fillLang();
  const bar = h('div', { class: 'game-hud' }, hud, resetBtn, viewSel, screenSel, fitSel, hitsBox, snapBox, langSel, saveBtn);
  const wrap = h('div', { class: 'game-wrap' }, screen);
  // 状態の表示はゲーム画面の外（上の帯）に出す。画面の左上はゲームの HUD が来やすいので重ねない
  const el = h('div', {}, bar, wrap);
  const og = overlay.getContext('2d')!;
  let renderer: Renderer | null = null;
  let glError = '';
  let mtimes = new Map<string, number>();
  let hint = '';

  // 画像が書き換わったら読み直す（ファイルの更新時刻で見分ける）
  const syncFiles = () => {
    const next = new Map((app.state?.files ?? []).map((f) => [f.path, f.mtime]));
    if (renderer) for (const [p, m] of next) if (mtimes.has(p) && mtimes.get(p) !== m) renderer.invalidate(p);
    mtimes = next;
  };
  const ensureRenderer = () => {
    if (renderer || glError || !app.state || app.state.error) return;
    try {
      syncFiles();
      renderer = new Renderer(canvas, {
        urlOf: (p) => app.assetUrl(p), sheets: app.registry?.sheets ?? new Map(), filter: app.state.config.view.filter,
        // シェーダーのコンパイルの結果: エラーはここで知らせ、サーバーに渡して ages check で AI が読めるようにする
        onShaderResult: (path, hash, error) => {
          if (error) toast(`シェーダーのエラー\n${error}`, 'bad', 10000);
          void fetch('/api/shader-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, hash, error }) }).catch(() => {});
        },
      });
    } catch (e) {
      glError = (e as Error).message;
      hud.textContent = glError;
    }
  };
  // シーンに入る前の画像の読み込みを、この画面の描く側が受け持つ
  app.preloaders.push((paths) => {
    ensureRenderer();
    const images = paths.filter((p) => kindOf(p) === 'image');
    return renderer && images.length ? renderer.preload(images) : Promise.resolve();
  });
  const fitMode = (): FitMode => fitOverride ?? app.state?.config?.view?.fit ?? 'contain';
  const renderFitSel = () => {
    const proj = app.state?.config?.view?.fit ?? 'contain';
    fitSel.replaceChildren(
      h('option', { value: '' }, `合わせ方: ${FIT_LABEL[proj] ?? proj}（設定）`),
      ...FIT_MODES.filter((m) => m !== proj).map((m) => h('option', { value: m, selected: m === fitOverride }, `試す: ${FIT_LABEL[m]}`)));
  };
  app.on('change', () => {
    syncFiles();
    ensureRenderer();
    if (renderer) renderer.opts.filter = app.state.config.view.filter;
    renderFitSel();
    layoutScreen();
  });

  // ---------- 画面の大きさ ----------
  /** プレイヤーに見える描く先の大きさ（自由な視点でカメラの枠を出すのに使う） */
  let playerView = { w: 480, h: 640 };
  /** 自由な視点のカメラ */
  let free: CameraView = { id: null, x: 240, y: 320, rot: 0, zoom: 1, vx: 0, vy: 0, vw: 480, vh: 640, layerMin: -Infinity, layerMax: Infinity, depth: 0, clear: null };
  let freeReady = false;
  const design = () => ({ width: app.state.config.view.width, height: app.state.config.view.height });
  const layoutScreen = () => {
    if (!app.state || app.state.error) return;
    const d = design();
    const r = wrap.getBoundingClientRect();
    const availW = Math.max(40, r.width - 16), availH = Math.max(40, r.height - 16);
    // 試しに見る画面の形（パネルに入る一番大きな形）
    let sw = availW, sh = availH;
    if (screenAspect) { if (availW / availH > screenAspect) sw = availH * screenAspect; else sh = availW / screenAspect; }
    screen.style.width = `${sw}px`;
    screen.style.height = `${sh}px`;
    let cw: number, ch: number, css: { x: number; y: number; w: number; h: number };
    const pf = fitView(d.width, d.height, sw, sh, fitMode());
    playerView = { w: pf.viewW, h: pf.viewH };
    if (viewMode === 'free') {
      cw = Math.round(sw); ch = Math.round(sh);
      css = { x: 0, y: 0, w: sw, h: sh };
      if (!freeReady) resetFree();
      free = { ...free, vw: cw, vh: ch };
    } else {
      cw = pf.viewW; ch = pf.viewH;
      css = pf;
    }
    for (const c of [canvas, overlay]) {
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      Object.assign(c.style, { left: `${css.x}px`, top: `${css.y}px`, width: `${css.w}px`, height: `${css.h}px` });
    }
    canvas.style.imageRendering = app.state.config.view.filter === 'nearest' ? 'pixelated' : 'auto';
    resetBtn.style.display = viewMode === 'free' ? '' : 'none';
  };
  /** 自由な視点を、ゲームの画面全体が見える位置に */
  function resetFree(): void {
    if (!app.state || app.state.error) return;
    const d = design();
    const r = screen.getBoundingClientRect();
    const w = r.width || d.width, hh = r.height || d.height;
    free = { ...free, x: d.width / 2, y: d.height / 2, zoom: Math.min(w / d.width, hh / d.height) * 0.9, vw: w, vh: hh };
    freeReady = true;
  }
  window.addEventListener('resize', layoutScreen);
  new ResizeObserver(layoutScreen).observe(wrap);

  // ---------- 座標 ----------
  const toCanvas = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
  };
  const inView = (c: CameraView, x: number, y: number) => x >= c.vx && y >= c.vy && x <= c.vx + c.vw && y <= c.vy + c.vh;

  // ---------- ゲームへのマウス・タッチ ----------
  /** 再生中（一時停止していない）のカメラの視点では、クリックはゲームの入力になる。選ぶのは一時停止中か自由な視点で */
  const gameHasMouse = () => !!app.play && !app.play.paused && viewMode === 'camera';
  /** 画面の点 → ゲームの画面の座標（ctx.view と同じ、設計の大きさで数える。expand で広がった所は 0〜幅 の外になる） */
  const toGame = (cx: number, cy: number): { x: number; y: number } | null => {
    if (!app.state || app.state.error) return null;
    const d = design();
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    let px = ((cx - r.left) / r.width) * canvas.width, py = ((cy - r.top) / r.height) * canvas.height;
    if (px < 0 || py < 0 || px > canvas.width || py > canvas.height) return null;
    let vw = canvas.width, vh = canvas.height;
    if (viewMode === 'free') {
      // 自由な視点: ワールドの点を、それを映しているプレイヤーのカメラの画面の点に直す
      const w = app.world;
      if (!w) return null;
      const [wx, wy] = screenToWorld(free, px, py);
      const cams = camerasOf(w, playerView.w, playerView.h, d.width, d.height).reverse();
      const hit = cams.map((c) => ({ c, s: worldToScreen(c, wx, wy) })).find((x) => inView(x.c, x.s[0], x.s[1]));
      if (!hit) return null;
      [px, py] = hit.s;
      vw = playerView.w; vh = playerView.h;
    }
    return { x: px - (vw - d.width) / 2, y: py - (vh - d.height) / 2 };
  };
  app.devices.bindPointer(canvas, toGame, gameHasMouse);

  /** 位置はあるのに何も描かれていないもの（カメラ・Transform だけ・空の文字・非表示など）。編集中・自由な視点で印を出す */
  const markers = (): { id: string; x: number; y: number; cam: number }[] => {
    const w = app.world;
    if (!w || !renderer || (app.play && viewMode !== 'free')) return [];
    const drawn = new Set(renderer.shapes.map((s) => s.id));
    const out: { id: string; x: number; y: number; cam: number }[] = [];
    for (const e of w.entities.values()) {
      if (drawn.has(e.id)) continue;
      // UI の物は、画面に固定した四角の中心に
      if (e.c.UI) {
        const r = renderer.uiRect(e.id), v = renderer.uiView;
        if (!r?.visible || !v) continue;
        const [x, y] = worldToScreen(v, r.x + r.w / 2, r.y + r.h / 2);
        out.push({ id: e.id, x, y, cam: renderer.cams.indexOf(v) });
        continue;
      }
      if (!e.c.Transform) continue;
      // その位置が映っている最初のカメラで描く
      for (let i = 0; i < renderer.cams.length; i++) {
        const [x, y] = worldToScreen(renderer.cams[i], e.c.Transform.x, e.c.Transform.y);
        if (inView(renderer.cams[i], x, y)) { out.push({ id: e.id, x, y, cam: i }); break; }
      }
    }
    return out;
  };

  // ---------- アセットを落として置く ----------
  // 画像は Sprite、音は Sound、フォントは Text を付けた物を、落とした場所に作る
  canvas.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(ASSET_MIME) && !e.dataTransfer?.types.includes(PREFAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  canvas.addEventListener('drop', async (e) => {
    const prefab = e.dataTransfer?.getData(PREFAB_MIME);
    if (prefab && renderer) {
      // プレハブ: 落とした所に、プレハブとつながったインスタンスを置く（位置だけが物の値）
      e.preventDefault();
      if (app.play) return toast('停止してから置いてください', 'bad');
      const scene = app.state.scenes[app.scene];
      if (!scene) return;
      const p = toCanvas(e);
      const cam = viewMode === 'free' ? free : [...renderer.cams].reverse().find((c) => inView(c, p.x, p.y)) ?? renderer.cams[0];
      const [wx, wy] = cam ? screenToWorld(cam, p.x, p.y) : [p.x, p.y];
      const taken = new Set(scene.entities.map((x) => x.id));
      let id = prefab;
      for (let i = 2; taken.has(id); i++) id = `${prefab}_${i}`;
      const pf = app.state.prefabs[prefab];
      let comps: Record<string, Record<string, unknown>> = {};
      try { comps = resolvePrefab(new Map(Object.entries(app.state.prefabs)), prefab).components; } catch { comps = pf?.components ?? {}; }
      const components: Record<string, Record<string, unknown>> = comps.UI ? {} : { Transform: { x: Math.round(wx), y: Math.round(wy) } };
      const r = await app.patch([{ op: 'addEntity', scene: app.scene, entity: { id, name: id, prefab, components } }], 'game');
      if (r) app.select({ kind: 'scene', scene: app.scene, id });
      return;
    }
    const path = e.dataTransfer?.getData(ASSET_MIME);
    const kind = path ? kindOf(path) : null;
    if (!path || !kind || !renderer) return;
    e.preventDefault();
    if (app.play) return toast('停止してから置いてください', 'bad');
    const scene = app.state.scenes[app.scene];
    if (!scene) return;
    const p = toCanvas(e);
    const cam = viewMode === 'free' ? free : [...renderer.cams].reverse().find((c) => inView(c, p.x, p.y)) ?? renderer.cams[0];
    const [wx, wy] = cam ? screenToWorld(cam, p.x, p.y) : [p.x, p.y];
    const stem = baseOf(path).slice(0, -extOf(path).length).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || kind;
    const taken = new Set(scene.entities.map((x) => x.id));
    let id = stem;
    for (let i = 2; taken.has(id); i++) id = `${stem}_${i}`;
    const pos = { x: Math.round(wx), y: Math.round(wy) };
    const components: Record<string, Record<string, unknown>> = kind === 'image' ? { Transform: pos, Sprite: { image: path } }
      : kind === 'sound' ? { Sound: { clip: path } }
      : { Transform: pos, Text: { text: 'テキスト', font: path } };
    const r = await app.patch([{ op: 'addEntity', scene: app.scene, entity: { id, name: baseOf(path).slice(0, -extOf(path).length) || id, components } }], 'game');
    if (r) app.select({ kind: 'scene', scene: app.scene, id });
  });

  // ---------- マウス ----------
  // 左クリックで選ぶ（Shift・Ctrl で足す・外す）。何もない所からドラッグすると四角で囲んで選ぶ。選んだ物をドラッグするとまとめて動く（格子があれば目にそろえる）。
  // 右クリックで、拡張のメニュー（複製・削除・プレハブにする など）
  let last: { x: number; y: number; ids: string[]; i: number } | null = null;
  type Moving = { id: string; what: 'UI' | 'Transform'; x: number; y: number };
  let drag: { lead: Moving; cam: CameraView; wx: number; wy: number; all: Moving[]; moved: boolean } | null = null;
  let band: { x0: number; y0: number; x1: number; y1: number; add: boolean } | null = null;
  let pan: { x: number; y: number; cx: number; cy: number; moved: boolean; e: MouseEvent } | null = null;
  const sceneDoc = () => app.sceneView(app.scene);
  const moving = (id: string): Moving | null => {
    const e = app.preview?.world.get(id);
    const doc = sceneDoc()?.entities.find((x) => x.id === id);
    const what = doc ? movable(sceneDoc()!, doc) : null;
    if (!e || !what || !e.c[what]) return null;
    return { id, what, x: Number(e.c[what].x ?? 0), y: Number(e.c[what].y ?? 0) };
  };
  /** 画面の点にある物（手前から） */
  const pickAt = (p: { x: number; y: number }) => {
    const ms = markers().filter((m) => Math.abs(m.x - p.x) <= MARK && Math.abs(m.y - p.y) <= MARK);
    return { ms, ids: [...ms.map((m) => m.id), ...renderer!.pickAll(p.x, p.y)] };
  };
  const openMenu = (e: MouseEvent, p: { x: number; y: number }) => {
    if (app.play && !app.play.paused) return;
    const { ids } = pickAt(p);
    if (ids.length && !app.selectedIds().includes(ids[0])) app.select({ kind: 'scene', scene: app.scene, id: ids[0] });
    const targets = app.selectedIds().map((id) => `${app.scene}#${id}`);
    if (!targets.length) return;
    const items = menuItemsFor(app, 'entity', targets);
    if (items.length) menu(e.clientX, e.clientY, items);
  };
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 自由な視点で右ドラッグして動かしたときは出さない
    if (pan) return;
    if (renderer && !gameHasMouse()) openMenu(e, toCanvas(e));
  });
  canvas.addEventListener('mousedown', (e) => {
    const w = app.world;
    if (!w || !renderer || gameHasMouse()) return;
    const p = toCanvas(e);
    // 自由な視点では、右・中ボタンのドラッグで動かす（右は動かさなければメニュー）
    if (viewMode === 'free' && (e.button === 1 || e.button === 2)) { e.preventDefault(); pan = { x: p.x, y: p.y, cx: free.x, cy: free.y, moved: false, e }; return; }
    if (e.button !== 0) return;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const { ms, ids } = pickAt(p);
    if (!ids.length) {
      last = null;
      // 何もない所: 四角で囲んで選ぶ（動かさなければ、選ぶのをやめる）
      if (!app.play) band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, add };
      else if (!add) app.select(null);
      return;
    }
    // 同じ場所をもう一度クリックしたら、ひとつ奥のものへ
    let i = 0;
    if (!add && last && Math.hypot(last.x - p.x, last.y - p.y) < 4 && last.ids.join() === ids.join()) i = (last.i + 1) % ids.length;
    last = { x: p.x, y: p.y, ids, i };
    const hit = w.get(ids[i])!;
    // 選んでいる物の上を押したら、選び方はそのまま（まとめて動かすため）
    const already = app.selectedIds().includes(hit.id);
    if (add) app.select({ kind: 'scene', scene: app.scene, id: hit.id }, { add: true });
    else if (!already || app.selectedIds().length === 1) app.select({ kind: 'scene', scene: app.scene, id: hit.id });
    else if (app.sel?.kind === 'scene' && app.sel.id !== hit.id) app.selectMany([hit.id, ...app.selectedIds().filter((x) => x !== hit.id)]);
    hint = ids.length > 1 ? `重なり ${i + 1}/${ids.length}（同じ場所をもう一度クリックで奥へ）` : '';
    if (app.play || !app.selectedIds().includes(hit.id)) return;
    const lead = moving(hit.id);
    if (!lead) return;
    // 選んだものを映しているカメラで、画面の動きをワールドの動きにする
    const camIndex = ms.find((m) => m.id === hit.id)?.cam ?? [...renderer.shapes].reverse().find((s) => s.id === hit.id && s.cam !== undefined)?.cam ?? 0;
    const cam = renderer.cams[camIndex];
    const [wx, wy] = screenToWorld(cam, p.x, p.y);
    const all = app.selectedIds().map(moving).filter((m): m is Moving => !!m);
    drag = { lead, cam, wx, wy, all, moved: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (pan) {
      const p = toCanvas(e);
      if (Math.hypot(p.x - pan.x, p.y - pan.y) > 3) pan.moved = true;
      const r = (free.rot * Math.PI) / 180;
      const dx = (p.x - pan.x) / free.zoom, dy = (p.y - pan.y) / free.zoom;
      free = { ...free, x: pan.cx - (dx * Math.cos(r) - dy * Math.sin(r)), y: pan.cy - (dx * Math.sin(r) + dy * Math.cos(r)) };
      return;
    }
    if (band) { const p = toCanvas(e); band.x1 = p.x; band.y1 = p.y; return; }
    if (!drag || !app.preview) return;
    const p = toCanvas(e);
    const [wx, wy] = screenToWorld(drag.cam, p.x, p.y);
    // 先頭の物の行き先（格子があれば目にそろえる）。ほかの物は同じだけ動かす
    const g = app.snap();
    let nx = drag.lead.x + wx - drag.wx, ny = drag.lead.y + wy - drag.wy;
    nx = g ? Math.round(nx / g) * g : Math.round(nx);
    ny = g ? Math.round(ny / g) * g : Math.round(ny);
    if (!drag.moved && Math.hypot(wx - drag.wx, wy - drag.wy) < 2) return; // クリックしただけでは動かさない
    const dx = nx - drag.lead.x, dy = ny - drag.lead.y;
    for (const m of drag.all) {
      const c = app.preview.world.get(m.id)?.c[m.what];
      if (c) { c.x = m.x + dx; c.y = m.y + dy; }
    }
    drag.moved = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (pan) {
      const pn = pan;
      pan = null;
      // 右ボタンを動かさずに離したら、メニュー
      if (!pn.moved && pn.e.button === 2 && renderer) openMenu(e, { x: pn.x, y: pn.y });
      return;
    }
    if (band) {
      const b = band;
      band = null;
      const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      if (x1 - x0 < 3 && y1 - y0 < 3) { if (!b.add) app.select(null); return; }
      const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
      const ids = new Set<string>();
      for (const s of renderer?.shapes ?? []) {
        const xs = [s.corners[0], s.corners[2], s.corners[4], s.corners[6]], ys = [s.corners[1], s.corners[3], s.corners[5], s.corners[7]];
        // 四角が形の外枠と重なれば選ぶ
        if (Math.max(...xs) >= x0 && Math.min(...xs) <= x1 && Math.max(...ys) >= y0 && Math.min(...ys) <= y1) ids.add(s.id);
      }
      for (const m of markers()) if (inside(m.x, m.y)) ids.add(m.id);
      app.selectMany([...ids], b.add);
      hint = ids.size ? `${ids.size}体を選びました（ドラッグでまとめて動かす・右クリックで複製や削除）` : '';
      return;
    }
    const d = drag;
    drag = null;
    if (!d?.moved || !app.preview) return;
    const ops: Op[] = [];
    for (const m of d.all) {
      const c = app.preview.world.get(m.id)?.c[m.what];
      if (!c) continue;
      const base = `${app.scene}#${m.id}.${m.what}`;
      ops.push({ op: 'set', path: `${base}.x`, value: c.x }, { op: 'set', path: `${base}.y`, value: c.y });
    }
    if (ops.length) app.patch(ops, 'game');
  });
  canvas.addEventListener('wheel', (e) => {
    if (viewMode !== 'free') return;
    e.preventDefault();
    // カーソルの下の点を動かさずに拡大・縮小
    const p = toCanvas(e);
    const [wx, wy] = screenToWorld(free, p.x, p.y);
    const zoom = Math.max(0.02, Math.min(64, free.zoom * Math.exp(-e.deltaY * 0.0015)));
    free = { ...free, zoom };
    const [nx, ny] = screenToWorld(free, p.x, p.y);
    free = { ...free, x: free.x + wx - nx, y: free.y + wy - ny };
  }, { passive: false });
  // ほかの場所（階層など）で選び直したら、重なりの案内を消す
  app.on('select', () => {
    if (!last || app.sel?.kind !== 'scene' || app.sel.id !== last.ids[last.i]) { last = null; hint = ''; }
  });

  // ---------- 重ねて描くもの ----------
  const poly = (q: number[], dash: number[] = []) => {
    og.setLineDash(dash);
    og.beginPath();
    og.moveTo(q[0], q[1]); og.lineTo(q[2], q[3]); og.lineTo(q[4], q[5]); og.lineTo(q[6], q[7]); og.closePath();
    og.stroke();
    og.setLineDash([]);
  };
  /** 当たり判定の形（グループごとの色。カメラの範囲の中だけ。試しの舞台と同じ描き方） */
  const drawHits = (w: NonNullable<App['world']>) => {
    if (renderer) drawColliders(og, w, renderer.cams.filter((c) => c !== renderer!.uiView));
  };
  const drawOverlay = (w: NonNullable<App['world']>) => {
    og.clearRect(0, 0, overlay.width, overlay.height);
    const sel = app.sel?.kind === 'scene' ? app.sel.id : null;
    if (!app.play) drawGrid();
    if (viewMode === 'free') {
      // プレイヤーに見える範囲（カメラごと）を枠で出す
      const d = design();
      og.lineWidth = 1;
      og.font = '11px ui-monospace, monospace';
      for (const c of camerasOf(w, playerView.w, playerView.h, d.width, d.height)) {
        const q = visibleCorners(c).flatMap((_, i, a) => (i % 2 ? [] : worldToScreen(free, a[i], a[i + 1])));
        og.strokeStyle = c.id === sel ? '#ffb02e' : 'rgba(126,231,135,0.85)';
        poly(q, [6, 4]);
        og.fillStyle = og.strokeStyle;
        og.fillText(c.id ? `カメラ ${c.id}` : 'カメラ（既定: 画面全体）', q[0] + 4, q[1] + 13);
      }
    }
    if (showHits) drawHits(w);
    og.lineWidth = 1.5;
    for (const m of markers()) {
      og.strokeStyle = m.id === sel ? '#ffb02e' : w.get(m.id)?.c.Camera ? 'rgba(126,231,135,0.9)' : 'rgba(255,255,255,0.55)';
      og.beginPath();
      og.moveTo(m.x, m.y - MARK); og.lineTo(m.x + MARK, m.y); og.lineTo(m.x, m.y + MARK); og.lineTo(m.x - MARK, m.y); og.closePath();
      og.stroke();
    }
    if (band) {
      og.strokeStyle = 'rgba(79,163,255,0.9)';
      og.fillStyle = 'rgba(79,163,255,0.12)';
      og.fillRect(Math.min(band.x0, band.x1), Math.min(band.y0, band.y1), Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
      og.strokeRect(Math.min(band.x0, band.x1), Math.min(band.y0, band.y1), Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
    }
    // 拡張が重ねて描くもの（api.overlay。ワールドの座標で）
    if (app.overlays.size && renderer) {
      const cam = viewMode === 'free' ? free : renderer.cams.filter((c) => c !== renderer!.uiView)[0];
      if (cam) {
        const g = makeDraw(og, cam, 1, 1);
        const view = { world: w, game: app.play?.game ?? null, scale: cam.zoom, visible: visibleRect(cam) };
        for (const fn of app.overlays) { try { fn(g, view); } catch (e) { console.error(e); } }
      }
    }
    if (!sel || !renderer) return;
    // 選んでいる物の枠（手前の物は濃く、一緒に選んでいる物は薄く）
    const extra = new Set(app.extra);
    for (const s of renderer.shapes) {
      if (s.id === sel) { og.strokeStyle = '#ffb02e'; poly(s.corners, [5, 3]); }
      else if (extra.has(s.id)) { og.strokeStyle = 'rgba(255,176,46,0.55)'; poly(s.corners, [3, 3]); }
    }
    og.lineWidth = 1.5;
    for (const m of markers()) {
      if (!extra.has(m.id)) continue;
      og.strokeStyle = 'rgba(255,176,46,0.7)';
      og.beginPath();
      og.moveTo(m.x, m.y - MARK); og.lineTo(m.x + MARK, m.y); og.lineTo(m.x, m.y + MARK); og.lineTo(m.x - MARK, m.y); og.closePath();
      og.stroke();
    }
  };
  /** 格子の線（ワールドの座標で gridSize ごと。細かすぎるときは間引く） */
  const drawGrid = () => {
    if (!snap || !renderer) return;
    const cams = viewMode === 'free' ? [free] : renderer.cams.filter((c) => c !== renderer!.uiView);
    og.lineWidth = 1;
    for (const cam of cams) {
      const q = visibleCorners(cam);
      const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
      let g = gridSize;
      while (g * cam.zoom < 6) g *= 2;
      const x0 = Math.floor(Math.min(...xs) / g) * g, x1 = Math.max(...xs), y0 = Math.floor(Math.min(...ys) / g) * g, y1 = Math.max(...ys);
      if ((x1 - x0) / g > 400 || (y1 - y0) / g > 400) continue;
      og.save();
      og.beginPath();
      og.rect(cam.vx, cam.vy, cam.vw, cam.vh);
      og.clip();
      og.strokeStyle = 'rgba(255,255,255,0.08)';
      og.beginPath();
      for (let x = x0; x <= x1; x += g) { const a = worldToScreen(cam, x, Math.min(...ys)), b = worldToScreen(cam, x, y1); og.moveTo(a[0], a[1]); og.lineTo(b[0], b[1]); }
      for (let y = y0; y <= y1; y += g) { const a = worldToScreen(cam, Math.min(...xs), y), b = worldToScreen(cam, x1, y); og.moveTo(a[0], a[1]); og.lineTo(b[0], b[1]); }
      og.stroke();
      og.restore();
    }
  };

  // ---------- ループ ----------
  let lastT = performance.now();
  let acc = 0;
  let particleGame: unknown;
  app.on('particles', (cmd) => {
    const c = cmd as ParticleCmd;
    if (app.play && renderer) renderer.particles.burst(app.play.game.world, c.id, c.count);
  });
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.25, (now - lastT) / 1000);
    lastT = now;
    if (!app.state || app.state.error) return;
    ensureRenderer();
    const p = app.play;
    if (p && !p.paused) {
      acc += dt * app.playSpeed;
      const step = 1 / app.state.config.fps;
      let n = 0;
      const most = Math.ceil(5 * Math.max(1, app.playSpeed));
      const t0 = performance.now();
      while (acc >= step && n++ < most && app.play) { app.tick(); acc -= step; }
      if (n) app.perf.stepMs = (performance.now() - t0) / n;
      if (n) app.emit('frame');
    } else acc = 0;
    const w = app.world;
    if (!w || !renderer) return;
    if (app.registry) {
      renderer.opts.sheets = app.registry.sheets;
      // シェーダーが変わったら、使っていないものもコンパイルして確かめる
      if (renderer.opts.shaders !== app.registry.shaders) { renderer.opts.shaders = app.registry.shaders; renderer.compileAll(); }
    }
    const d = design();
    // シーンの切り替えのフェードは、カメラの視点でだけ画面を覆う（自由な視点では様子を見られるように覆わない）
    const overlay = p && viewMode === 'camera' ? (p.loading ? { color: p.game.transition?.color ?? '#000000', alpha: p.game.transition ? 1 : 0 } : p.game.overlay()) : null;
    // パーティクル: 再生中は実時間で動かす（一時停止中は止める）。編集中は選んだ物だけ試しに出す
    if (p?.game !== particleGame) { renderer.particles.clear(); particleGame = p?.game; }
    const selId = app.sel?.kind === 'scene' ? app.sel.id : '';
    const particles = p ? { dt: p.paused || p.loading ? 0 : dt } : { dt, preview: selId && w.get(selId)?.c.Particles ? [selId] : [] };
    const td = performance.now();
    renderer.draw(w, { background: app.state.config.view.background, design: d, view: viewMode === 'free' ? free : undefined, overlay, particles, post: viewMode !== 'free' });
    app.perf.drawMs = performance.now() - td;
    app.perf.draws = renderer.stats.draws;
    app.perf.quads = renderer.stats.quads;
    app.perf.fps = dt > 0 ? app.perf.fps * 0.9 + (1 / dt) * 0.1 : app.perf.fps;
    drawOverlay(w);
    const cams = renderer.cams.filter((c) => c.id).length;
    const where = viewMode === 'free' ? `自由な視点 ${Math.round(free.zoom * 100)}%（ホイールで拡大・右ドラッグで移動）` : cams ? `カメラ ${cams}台` : '';
    const mouse = gameHasMouse() ? 'マウスはゲームへ（選ぶには一時停止）' : '';
    const tail = [where, mouse, hint].filter(Boolean).join('  ');
    const tr = p?.game.transition;
    const sceneText = p ? `シーン ${p.game.sceneName}${tr ? `（${tr.phase === 'out' ? `→ ${tr.to}` : '入るところ'}）` : ''}${p.loading ? `  読み込み中 ${p.loading.done}/${p.loading.total}` : ''}` : '';
    hud.textContent = p
      ? `${p.paused ? '⏸' : '▶'} f${p.game.frame}  ${(p.game.frame / app.state.config.fps).toFixed(1)}s  ${sceneText}  ${w.entities.size}体${p.recorder ? '  ●REC' : ''}  ${tail}`
      : `編集中  ${w.entities.size}体  クリックで選択・ドラッグで移動  ${tail}`;
  };
  requestAnimationFrame(loop);
  renderFitSel();

  return { id: 'game', title: 'ゲーム', el, fill: true, canvas, render: layoutScreen };
}

/** 保存データの窓: 中身を見る・消す・saves/ に書き出す・saves/ から戻す */
function saveDialog(app: App): void {
  modal((close) => {
    const store = app.saveStore();
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:6px;min-width:460px;max-width:640px' });
    const render = () => {
      body.replaceChildren();
      const data = store.load();
      const keys = Object.keys(data).sort();
      body.append(h('div', { style: 'font-weight:600' }, `保存データ（このブラウザ・${app.state.config.name}）`),
        h('div', { class: 'muted' }, 'ゲームの ctx.save で書いた値。設定（キーの割り当て・音量）は $settings に自動で入る。変えると次の再生から効く'));
      if (!keys.length) body.append(h('div', { class: 'muted', style: 'padding:6px 0' }, '空（初めて遊ぶ状態）'));
      for (const k of keys) {
        const text = data[k];
        body.append(h('div', { class: 'row', style: 'gap:6px;align-items:flex-start' },
          h('code', { style: 'min-width:120px' }, k),
          h('code', { class: 'muted', style: 'flex:1;white-space:pre-wrap;word-break:break-all;max-height:5.5em;overflow:auto' }, text.length > 400 ? text.slice(0, 400) + '…' : text),
          h('button', { class: 'icon', title: `${k} を消す`, onclick: () => { store.write(k, null); render(); } }, '×')));
      }
      const name = h('input', { type: 'text', value: 'save1', style: 'width:120px' }) as HTMLInputElement;
      const pick = h('select', {}, [h('option', { value: '' }, '（saves/ のファイル）'), ...(app.state.saves ?? []).map((p) => h('option', { value: p }, p))]) as HTMLSelectElement;
      body.append(
        h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
          h('button', { onclick: () => { store.clear(); render(); toast('保存データを消しました（次の再生は初めて遊ぶ状態）'); } }, 'すべて消す'),
          h('span', { style: 'flex:1' }),
          'saves/', name, '.save.json',
          h('button', { title: 'AI が ages run --save で同じ状態から確かめられる', onclick: async () => {
            const n = name.value.trim().replace(/[^\w.-]/g, '_');
            if (!n) return;
            const values = Object.fromEntries(Object.entries(store.load()).map(([k, v]) => [k, JSON.parse(v)]));
            await fetch(`/api/file?path=${encodeURIComponent(`saves/${n}.save.json`)}`, { method: 'PUT', body: JSON.stringify(values, null, 2) + '\n' });
            toast(`saves/${n}.save.json に書き出しました\nAIは ages run --save saves/${n}.save.json でこの状態から確かめられます`);
          } }, '書き出す')),
        h('div', { class: 'row', style: 'gap:6px' },
          h('span', { class: 'muted' }, 'この保存データにする:'), pick,
          h('button', { onclick: async () => {
            if (!pick.value) return;
            const r = await (await fetch(`/api/file?path=${encodeURIComponent(pick.value)}`)).json() as { text: string };
            const values = JSON.parse(r.text) as Record<string, unknown>;
            store.clear();
            for (const [k, v] of Object.entries(values)) store.write(k, JSON.stringify(v));
            render();
            toast(`${pick.value} の状態にしました（次の再生から）`);
          } }, '読む')),
        h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { onclick: close }, '閉じる')));
    };
    render();
    return body;
  });
}
