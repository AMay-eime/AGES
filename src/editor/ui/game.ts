// ゲーム画面。WebGL2 で描き、その上の透明なキャンバスに選択の枠や印を描く。
// - クリックだけで選べる。重なっているときは、同じ場所をもう一度クリックすると奥のものへ
// - 画像も図形も文字もないもの（カメラ・敵を出す役など）は、編集中だけ◇の印を出して、それをクリックして選べる
// - 視点は「カメラ」（プレイヤーに見える通り）と「自由」（ホイールで拡大・右ドラッグで移動。カメラの範囲は枠で見える）
// - 画面の形（16:9・スマホ縦など）と合わせ方（view.fit）を切り替えて、見え方を確かめられる
import type { App } from '../app.ts';
import { Renderer } from '../../render/webgl.ts';
import { camerasOf, fitView, screenToWorld, visibleCorners, worldToScreen, FIT_MODES, type CameraView, type FitMode } from '../../core/camera.ts';
import { h } from './dom.ts';
import type { Panel } from './layout.ts';

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
  const bar = h('div', { class: 'game-hud' }, hud, resetBtn, viewSel, screenSel, fitSel);
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
      renderer = new Renderer(canvas, { urlOf: (p) => app.assetUrl(p), sheets: app.registry?.sheets ?? new Map(), filter: app.state.config.view.filter });
    } catch (e) {
      glError = (e as Error).message;
      hud.textContent = glError;
    }
  };
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

  /** 位置はあるのに何も描かれていないもの（カメラ・Transform だけ・空の文字・非表示など）。編集中・自由な視点で印を出す */
  const markers = (): { id: string; x: number; y: number; cam: number }[] => {
    const w = app.world;
    if (!w || !renderer || (app.play && viewMode !== 'free')) return [];
    const drawn = new Set(renderer.shapes.map((s) => s.id));
    const out: { id: string; x: number; y: number; cam: number }[] = [];
    for (const e of w.entities.values()) {
      if (!e.c.Transform || drawn.has(e.id)) continue;
      // その位置が映っている最初のカメラで描く
      for (let i = 0; i < renderer.cams.length; i++) {
        const [x, y] = worldToScreen(renderer.cams[i], e.c.Transform.x, e.c.Transform.y);
        if (inView(renderer.cams[i], x, y)) { out.push({ id: e.id, x, y, cam: i }); break; }
      }
    }
    return out;
  };

  // ---------- マウス ----------
  let last: { x: number; y: number; ids: string[]; i: number } | null = null;
  let drag: { id: string; cam: CameraView; dx: number; dy: number; moved: boolean } | null = null;
  let pan: { x: number; y: number; cx: number; cy: number } | null = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    const w = app.world;
    if (!w || !renderer) return;
    const p = toCanvas(e);
    // 自由な視点では、右・中ボタンのドラッグで動かす
    if (viewMode === 'free' && (e.button === 1 || e.button === 2)) { e.preventDefault(); pan = { x: p.x, y: p.y, cx: free.x, cy: free.y }; return; }
    if (e.button !== 0) return;
    const ms = markers().filter((m) => Math.abs(m.x - p.x) <= MARK && Math.abs(m.y - p.y) <= MARK);
    const ids = [...ms.map((m) => m.id), ...renderer.pickAll(p.x, p.y)];
    if (!ids.length) { last = null; return app.select(null); }
    // 同じ場所をもう一度クリックしたら、ひとつ奥のものへ
    let i = 0;
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 4 && last.ids.join() === ids.join()) i = (last.i + 1) % ids.length;
    last = { x: p.x, y: p.y, ids, i };
    const hit = w.get(ids[i])!;
    app.select({ kind: 'scene', scene: app.scene, id: hit.id });
    hint = ids.length > 1 ? `重なり ${i + 1}/${ids.length}（同じ場所をもう一度クリックで奥へ）` : '';
    if (!app.play && hit.c.Transform) {
      // 選んだものを映しているカメラで、画面の動きをワールドの動きにする
      const camIndex = ms.find((m) => m.id === hit.id)?.cam ?? [...renderer.shapes].reverse().find((s) => s.id === hit.id && s.cam !== undefined)?.cam ?? 0;
      const cam = renderer.cams[camIndex];
      const [wx, wy] = screenToWorld(cam, p.x, p.y);
      drag = { id: hit.id, cam, dx: hit.c.Transform.x - wx, dy: hit.c.Transform.y - wy, moved: false };
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (pan) {
      const p = toCanvas(e);
      const r = (free.rot * Math.PI) / 180;
      const dx = (p.x - pan.x) / free.zoom, dy = (p.y - pan.y) / free.zoom;
      free = { ...free, x: pan.cx - (dx * Math.cos(r) - dy * Math.sin(r)), y: pan.cy - (dx * Math.sin(r) + dy * Math.cos(r)) };
      return;
    }
    if (!drag || !app.preview) return;
    const t = app.preview.world.get(drag.id)?.c.Transform;
    if (!t) return;
    const p = toCanvas(e);
    const [wx, wy] = screenToWorld(drag.cam, p.x, p.y);
    const nx = Math.round(wx + drag.dx), ny = Math.round(wy + drag.dy);
    if (!drag.moved && Math.hypot(nx - t.x, ny - t.y) < 2) return; // クリックしただけでは動かさない
    t.x = nx;
    t.y = ny;
    drag.moved = true;
  });
  window.addEventListener('mouseup', () => {
    pan = null;
    const d = drag;
    drag = null;
    if (!d?.moved || !app.preview) return;
    const t = app.preview.world.get(d.id)!.c.Transform;
    const base = `${app.scene}#${d.id}.Transform`;
    app.patch([{ op: 'set', path: `${base}.x`, value: t.x }, { op: 'set', path: `${base}.y`, value: t.y }], 'game');
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
  const drawOverlay = (w: NonNullable<App['world']>) => {
    og.clearRect(0, 0, overlay.width, overlay.height);
    const sel = app.sel?.kind === 'scene' ? app.sel.id : null;
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
    og.lineWidth = 1.5;
    for (const m of markers()) {
      og.strokeStyle = m.id === sel ? '#ffb02e' : w.get(m.id)?.c.Camera ? 'rgba(126,231,135,0.9)' : 'rgba(255,255,255,0.55)';
      og.beginPath();
      og.moveTo(m.x, m.y - MARK); og.lineTo(m.x + MARK, m.y); og.lineTo(m.x, m.y + MARK); og.lineTo(m.x - MARK, m.y); og.closePath();
      og.stroke();
    }
    if (!sel || !renderer) return;
    og.strokeStyle = '#ffb02e';
    for (const s of renderer.shapes) if (s.id === sel) poly(s.corners, [5, 3]);
  };

  // ---------- ループ ----------
  let lastT = performance.now();
  let acc = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.25, (now - lastT) / 1000);
    lastT = now;
    if (!app.state || app.state.error) return;
    ensureRenderer();
    const p = app.play;
    if (p && !p.paused) {
      acc += dt;
      const step = 1 / app.state.config.fps;
      let n = 0;
      while (acc >= step && n++ < 5) { app.tick(); acc -= step; }
      if (n) app.emit('frame');
    } else acc = 0;
    const w = app.world;
    if (!w || !renderer) return;
    if (app.registry) renderer.opts.sheets = app.registry.sheets;
    const d = design();
    renderer.draw(w, { background: app.state.config.view.background, design: d, view: viewMode === 'free' ? free : undefined });
    drawOverlay(w);
    const cams = renderer.cams.filter((c) => c.id).length;
    const where = viewMode === 'free' ? `自由な視点 ${Math.round(free.zoom * 100)}%（ホイールで拡大・右ドラッグで移動）` : cams ? `カメラ ${cams}台` : '';
    const tail = [where, hint].filter(Boolean).join('  ');
    hud.textContent = p
      ? `${p.paused ? '⏸' : '▶'} f${p.game.frame}  ${(p.game.frame / app.state.config.fps).toFixed(1)}s  ${w.entities.size}体${p.recorder ? '  ●REC' : ''}  ${tail}`
      : `編集中  ${w.entities.size}体  クリックで選択・ドラッグで移動  ${tail}`;
  };
  requestAnimationFrame(loop);
  renderFitSel();

  return { id: 'game', title: 'ゲーム', el, fill: true, canvas, render: layoutScreen };
}
