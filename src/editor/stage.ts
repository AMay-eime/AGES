// 試しの舞台（拡張の API の api.stage）: シーン（scene・params・values）か、空のシーンに出したプレハブ（spawn）を、小さな画面でくり返し動かす。
// 中身は api.run・ages run と同じ（core/trial.ts）。時間の操作は stage-player.ts、描き込み・座標は stage-draw.ts。ここは画面（DOM）だけ。
// 音は鳴らさず、数だけを返す。WebGL の上に 2D のキャンバスを重ね、拡張の描き込み・当たり判定・画面の枠を描き、マウスを受ける。
import type { App } from './app.ts';
import { Renderer } from '../render/webgl.ts';
import { camerasOf, defaultCamera, screenToWorld, visibleCorners, worldToScreen, type CameraView } from '../core/camera.ts';
import { startTrial } from '../core/trial.ts';
import { StagePlayer } from './stage-player.ts';
import { canvasToWorld, drawColliders, drawScreens, fitBox, freeView, makeDraw, visibleRect } from './stage-draw.ts';
import type { StageDraw, StageHandle, StageOptions, StagePointer, StageView } from './window-api.ts';
import type { Game } from '../core/game.ts';
import { h } from './ui/dom.ts';
import { T } from './i18n.ts';

/** シーク・作り直しの早送りに、1回の描画のあいだ使う時間(ms)。残りで画面とほかの窓を動かす */
const FF_BUDGET = 24;
/** 作り直しを伴う設定 */
const BUILD_KEYS = ['scene', 'params', 'values', 'spawn', 'date', 'seed', 'keys', 'zoom', 'follow'] as const;

export function createStage(app: App, el: HTMLElement, init: StageOptions): StageHandle {
  let o: StageOptions = { ...init };
  const canvas = h('canvas', { width: 240, height: 150, style: 'display:block;max-width:100%;height:auto' }) as HTMLCanvasElement;
  const over = h('canvas', { width: 240, height: 150, style: 'position:absolute;left:0;top:0;width:100%;height:100%;touch-action:none' }) as HTMLCanvasElement;
  const note = h('div', { style: 'position:absolute;left:6px;top:4px;right:6px;font-size:12px;line-height:1.4;color:var(--dim);pointer-events:none;white-space:pre-wrap' });
  el.append(h('div', { style: 'position:relative;display:inline-block;max-width:100%;vertical-align:top' }, canvas, over, note));
  const og = over.getContext('2d')!;
  let renderer: Renderer | null = null;
  let rendererError = '';
  let last = performance.now();
  let dead = false;
  let detached = 0;
  /** 自由な視点（ホイール・右ドラッグで変わる。set の view で戻る） */
  let fv = { zoom: o.view?.zoom ?? 1, x: o.view?.x, y: o.view?.y };
  const draws = new Set<(g: StageDraw, view: StageView) => void>();
  const pointers = new Set<(ev: StagePointer) => boolean | void>();

  const design = () => app.state.config.view;
  const isScene = () => o.scene !== undefined;
  const isFree = () => !!o.view?.free;

  const player = new StagePlayer(
    () => {
      if (!app.registry || !app.state?.config) throw new Error(T('読み込み中…'));
      renderer?.particles.clear();
      const t = startTrial(app.registry, app.state.config, o, { lang: app.previewLang || undefined, camera: isScene() ? undefined : { zoom: o.zoom ?? 2, follow: !!o.follow } });
      t.game.particleListeners.push((cmd) => { if (!player.ff) renderer?.particles.burst(t.game.world, cmd.id, cmd.count); });
      return t;
    },
    () => {
      const fps = app.state?.config.fps ?? 60;
      const sec = o.seconds ?? (isScene() ? Infinity : 3);
      return { fps, limit: sec * fps, loop: o.loop !== false, speed: o.speed ?? 1, onCycle: o.onCycle };
    },
  );

  /** 値が変わったとき（onChange に従う） */
  const changed = () => {
    const m = o.onChange ?? 'restart';
    if (m === 'restart') player.build();
    else if (m === 'keepTime') player.rebuildKeep();
  };

  // ---------- 大きさと視点 ----------
  const layout = () => {
    const d = design();
    let cw: number, ch: number, cssW: number;
    if (!isScene() && !isFree()) {
      cw = o.width ?? 240; ch = o.height ?? 150; cssW = cw;
    } else {
      const bw = o.width ?? 320, bh = o.height ?? Math.round((bw * d.height) / d.width);
      if (isFree()) {
        const dpr = globalThis.devicePixelRatio || 1;
        cw = Math.round(bw * dpr); ch = Math.round(bh * dpr); cssW = bw;
      } else {
        // 設計の大きさ（×resolution）で描いて、縮めて見せる（エディタのゲームの画面と同じ）
        const r = Math.max(0.1, Math.min(1, o.resolution ?? 1));
        cw = Math.round(d.width * r); ch = Math.round(d.height * r); cssW = fitBox(d.width, d.height, bw, bh).w;
      }
    }
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    canvas.style.width = `${cssW}px`;
    canvas.style.imageRendering = app.state.config.view.filter === 'nearest' ? 'pixelated' : 'auto';
  };
  const freeCam = () => freeView(design(), canvas.width, canvas.height, fv);
  /** 描いたときのカメラ（UI の視点を除く）。自由な視点ならそれだけ */
  const cams = (): CameraView[] => {
    if (isFree()) return [freeCam()];
    const r = renderer?.cams.filter((c) => c !== renderer!.uiView) ?? [];
    if (r.length) return r;
    const d = isScene() ? design() : { width: canvas.width, height: canvas.height };
    return [defaultCamera(canvas.width, canvas.height, d.width, d.height)];
  };
  /** プレイヤーに見える画面の枠（ワールドの角） */
  const screens = (game: Game): number[][] => {
    const d = design();
    if (!isScene()) return [[0, 0, d.width, 0, d.width, d.height, 0, d.height]];
    return camerasOf(game.world, d.width, d.height, d.width, d.height).map((c) => [...visibleCorners(c)]);
  };

  // ---------- 描く ----------
  const ensureRenderer = () => {
    if (renderer || rendererError || !app.state?.config || !app.registry) return;
    try {
      renderer = new Renderer(canvas, { urlOf: (p) => app.assetUrl(p), sheets: app.registry.sheets, filter: app.state.config.view.filter, shaders: app.registry.shaders, packages: app.registry.packages });
    } catch (e) {
      rendererError = T('この画面では描けません（WebGL2）: {0}', (e as Error).message);
    }
  };

  const render = (dt: number) => {
    const game = player.game;
    if (!renderer || !game) return;
    renderer.opts.sheets = app.registry.sheets;
    renderer.opts.shaders = app.registry.shaders;
    const d = design();
    const particles = { dt: player.done || player.paused ? 0 : dt * (o.speed ?? 1) };
    if (isFree()) renderer.draw(game.world, { background: d.background, design: d, view: freeCam(), particles, post: false });
    else if (isScene()) renderer.draw(game.world, { background: d.background, design: d, overlay: game.overlay(), particles });
    else renderer.draw(game.world, { background: d.background, design: { width: canvas.width, height: canvas.height }, particles });
    drawOver(game);
  };

  const drawOver = (game: Game) => {
    const dpr = globalThis.devicePixelRatio || 1;
    const ow = Math.max(1, Math.round(canvas.clientWidth * dpr)), oh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (over.width !== ow || over.height !== oh) { over.width = ow; over.height = oh; }
    og.clearRect(0, 0, ow, oh);
    const frame = o.view?.frame ?? isFree();
    if (!draws.size && !o.colliders && !frame) return;
    const k = ow / canvas.width;
    const cs = cams();
    if (o.colliders) drawColliders(og, game.world, cs, k, dpr);
    const main = cs[0];
    const scr = screens(game);
    if (frame) drawScreens(og, main, scr, k, dpr);
    if (!draws.size) return;
    const g = makeDraw(og, main, k, dpr);
    const fps = app.state.config.fps;
    const view: StageView = { game, frame: game.frame, time: game.frame / fps, scale: (main.zoom * k) / dpr, visible: visibleRect(main), screens: scr };
    for (const fn of draws) {
      try { fn(g, view); } catch (e) { console.error(e); }
    }
  };

  const loop = (now: number) => {
    if (dead) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    // 外されている間（タブを離れた・作り直した）は止める。2秒たったら描く側（WebGL）だけ返し、また付いたら作り直して続ける。
    // 10分たっても付かなければ片付ける（拡張が destroy を忘れても残らないように）
    if (!canvas.isConnected) {
      detached++;
      if (detached === 120 && renderer) { (renderer.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext(); renderer = null; }
      if (detached > 36000) handle.destroy();
      return;
    }
    detached = 0;
    if (!canvas.offsetParent || !app.state?.config) return;
    layout();
    ensureRenderer();
    if (!player.trial && !player.error) player.build();
    if (player.target !== null) {
      // シーク・作り直しの早送り: 着くまで描かない（前の絵のまま）
      player.fastForward(FF_BUDGET);
      if (player.target !== null) {
        note.textContent = T('進めています {0} / {1}秒', (player.game!.frame / app.state.config.fps).toFixed(1), (player.target / app.state.config.fps).toFixed(1));
        return;
      }
    } else player.tick(dt, now);
    note.textContent = rendererError || player.error;
    render(dt);
  };

  // 値が変わったら onChange に従う
  const off = app.on('change', changed);
  requestAnimationFrame(loop);

  // ---------- マウス ----------
  let pan: { x: number; y: number; cx: number; cy: number } | null = null;
  const send = (type: StagePointer['type'], e: PointerEvent): boolean => {
    const w = handle.toWorld(e.clientX, e.clientY);
    if (!w) return false;
    const ev: StagePointer = { type, x: w[0], y: w[1], button: e.button, buttons: e.buttons, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, native: e };
    let used = false;
    for (const fn of [...pointers]) {
      try { if (fn(ev) === true) used = true; } catch (err) { console.error(err); }
    }
    return used;
  };
  /** 画面の点 → キャンバスの px */
  const toCanvas = (cx: number, cy: number): [number, number] | null => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [((cx - r.left) / r.width) * canvas.width, ((cy - r.top) / r.height) * canvas.height];
  };
  over.addEventListener('pointerdown', (e) => {
    over.setPointerCapture(e.pointerId);
    if (send('down', e)) { e.preventDefault(); return; }
    if (isFree() && (e.button === 1 || e.button === 2)) {
      e.preventDefault();
      pan = { x: e.clientX, y: e.clientY, cx: freeCam().x, cy: freeCam().y };
    }
  });
  over.addEventListener('pointermove', (e) => {
    if (pan) {
      const s = canvas.width / (canvas.getBoundingClientRect().width || 1);
      const z = freeCam().zoom;
      fv = { ...fv, x: pan.cx - ((e.clientX - pan.x) * s) / z, y: pan.cy - ((e.clientY - pan.y) * s) / z };
      return;
    }
    send('move', e);
  });
  over.addEventListener('pointerup', (e) => { if (pan) { pan = null; return; } send('up', e); });
  over.addEventListener('pointerleave', (e) => { if (!pan) send('leave', e); });
  over.addEventListener('contextmenu', (e) => { if (isFree() || pointers.size) e.preventDefault(); });
  over.addEventListener('wheel', (e) => {
    if (!isFree()) return;
    e.preventDefault();
    const p = toCanvas(e.clientX, e.clientY);
    if (!p) return;
    // カーソルの下の点が動かないように拡大する
    const before = freeCam();
    const [wx, wy] = screenToWorld(before, p[0], p[1]);
    fv = { ...fv, x: before.x, y: before.y, zoom: Math.max(0.05, Math.min(32, fv.zoom * Math.exp(-e.deltaY * 0.0015))) };
    const [nx, ny] = screenToWorld(freeCam(), p[0], p[1]);
    fv = { ...fv, x: before.x + wx - nx, y: before.y + wy - ny };
  }, { passive: false });

  const handle: StageHandle = {
    set(next) {
      const rebuild = BUILD_KEYS.some((k) => k in next && JSON.stringify(next[k]) !== JSON.stringify(o[k]));
      o = { ...o, ...next };
      if ('view' in next) fv = { zoom: o.view?.zoom ?? 1, x: o.view?.x, y: o.view?.y };
      if (rebuild) changed();
    },
    restart: () => player.build(),
    destroy() {
      if (dead) return;
      dead = true;
      off();
      player.settle();
      (renderer?.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
      renderer = null;
    },
    get playing() { return player.playing; },
    set playing(v: boolean) { player.playing = v; },
    step: (n = 1) => player.step(n),
    seek: (sec) => player.seek(sec),
    get frame() { return player.game?.frame ?? 0; },
    get time() { return (player.game?.frame ?? 0) / (app.state?.config.fps ?? 60); },
    get game() { return player.game; },
    send(event, data) {
      const g = player.game;
      if (!g) throw new Error(T('舞台のゲームがありません{0}', player.error ? T('（{0}）', player.error) : T('（まだ作っていない）')));
      try { g.ctx.emit(event, data); } catch (e) { player.error = (e as Error).message; }
    },
    onFrame(fn) { player.frameFns.add(fn); return () => { player.frameFns.delete(fn); }; },
    draw(fn) { draws.add(fn); return () => { draws.delete(fn); }; },
    onPointer(fn) { pointers.add(fn); return () => { pointers.delete(fn); }; },
    toWorld(cx, cy) {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return canvasToWorld(cams(), canvas.width, canvas.height, (cx - r.left) / r.width, (cy - r.top) / r.height);
    },
    toScreen(x, y) {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const [sx, sy] = worldToScreen(cams()[0], x, y);
      return [r.left + (sx / canvas.width) * r.width, r.top + (sy / canvas.height) * r.height];
    },
  };
  return handle;
}
