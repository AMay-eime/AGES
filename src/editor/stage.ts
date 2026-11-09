// 試しの舞台: 空のシーンにプレハブを出して、小さな画面でくり返し動かす（拡張の API の api.stage）。
// 中身は ages run --spawn と同じ（core/tryout.ts）。音は鳴らさず、数だけを返す。
import type { App } from './app.ts';
import { Renderer } from '../render/webgl.ts';
import { Game } from '../core/game.ts';
import { MemoryStore } from '../core/save.ts';
import { InputPlayback, actionsFromRows, keysToEvents } from '../core/input.ts';
import { spawnTryout, tryoutGone, tryoutScene } from '../core/tryout.ts';
import type { StageHandle, StageOptions, StageSummary } from './window-api.ts';
import { h } from './ui/dom.ts';

/** 回の終わりから次の回までの間（秒。実時間） */
const GAP = 0.4;

export function createStage(app: App, el: HTMLElement, init: StageOptions): StageHandle {
  let o: Required<Omit<StageOptions, 'onCycle'>> & Pick<StageOptions, 'onCycle'> = { seconds: 3, speed: 1, zoom: 2, follow: false, keys: '', width: 240, height: 150, ...init };
  const canvas = h('canvas', { width: o.width, height: o.height, style: 'display:block;max-width:100%' }) as HTMLCanvasElement;
  const note = h('div', { style: 'position:absolute;left:6px;top:4px;right:6px;font-size:12px;color:var(--dim);pointer-events:none;white-space:pre-wrap' });
  el.append(h('div', { style: 'position:relative;display:inline-block' }, canvas, note));
  let renderer: Renderer | null = null;
  let game: Game | null = null;
  let ids: string[] = [];
  let play = new InputPlayback([]);
  let error = '';
  let done: { at: number; gone: boolean } | null = null;
  let acc = 0;
  let last = performance.now();
  let dead = false;
  let detached = 0;

  const summary = (gone: boolean): StageSummary => ({
    frames: game?.frame ?? 0, gone,
    sounds: Object.fromEntries(game?.soundCounts ?? []), particles: Object.fromEntries(game?.particleCounts ?? []), events: Object.fromEntries(game?.counts ?? []),
    warnings: [...(game?.warnings ?? [])], ...(error ? { error } : {}),
  });

  /** 最新の値で、最初から作り直す */
  const build = () => {
    renderer?.particles.clear();
    error = '';
    done = null;
    ids = [];
    try {
      if (!app.registry || !app.state?.config) throw new Error('読み込み中…');
      if (!o.spawn.length) throw new Error('出すプレハブがありません');
      const v = app.state.config.view;
      const scene = tryoutScene();
      scene.entities.push({ id: 'tryout-camera', name: 'Camera', components: { Transform: { x: v.width / 2, y: v.height / 2 }, Camera: { zoom: o.zoom } } });
      const g = new Game(app.registry, app.state.config, scene, app.state.config.seed, { store: new MemoryStore({}), lang: app.previewLang || undefined });
      g.particleListeners.push((cmd) => renderer?.particles.burst(g.world, cmd.id, cmd.count));
      ids = spawnTryout(g, o.spawn, v.width, v.height);
      if (o.follow && ids[0]) g.world.get('tryout-camera')!.c.Camera.follow = ids[0];
      play = new InputPlayback(keysToEvents(o.keys, actionsFromRows(app.registry.tableView('actions').rows)));
      game = g;
    } catch (e) {
      game = null;
      error = (e as Error).message;
    }
    note.textContent = error;
  };

  const ensureRenderer = () => {
    if (renderer || !app.state?.config || !app.registry) return;
    try {
      renderer = new Renderer(canvas, { urlOf: (p) => app.assetUrl(p), sheets: app.registry.sheets, filter: app.state.config.view.filter, shaders: app.registry.shaders });
    } catch (e) {
      error = `この画面では描けません（WebGL2）: ${(e as Error).message}`;
      note.textContent = error;
    }
  };

  const loop = (now: number) => {
    if (dead) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    // 外された（拡張を読み直した）ら片付ける。見えていない（タブの裏）間は進めない
    if (!canvas.isConnected) { if (++detached > 120) handle.destroy(); return; }
    detached = 0;
    if (!canvas.offsetParent) return;
    ensureRenderer();
    if (!game && !error) build();
    if (!renderer || !game) return;
    const fps = app.state.config.fps;
    if (done) {
      if ((now - done.at) / 1000 > GAP) build();
    } else {
      acc += dt * o.speed;
      let n = 0;
      while (acc >= 1 / fps && n++ < 16 && !done) {
        acc -= 1 / fps;
        try {
          game.step(play.at(game.frame));
        } catch (e) {
          error = (e as Error).message;
          note.textContent = error;
          o.onCycle?.(summary(false));
          return;
        }
        const gone = tryoutGone(game, ids);
        if (gone || game.frame >= o.seconds * fps) {
          done = { at: now, gone };
          o.onCycle?.(summary(gone));
        }
      }
    }
    renderer.opts.sheets = app.registry.sheets;
    renderer.opts.shaders = app.registry.shaders;
    renderer.draw(game.world, { background: app.state.config.view.background, design: { width: o.width, height: o.height }, particles: { dt: done ? 0 : dt * o.speed } });
  };

  // 値が変わったら、すぐ最初から（新しい値で）
  const off = app.on('change', () => build());
  requestAnimationFrame(loop);

  const handle: StageHandle = {
    set(next) {
      o = { ...o, ...next };
      if (next.width || next.height) { canvas.width = o.width; canvas.height = o.height; }
    },
    restart: () => build(),
    destroy() {
      if (dead) return;
      dead = true;
      off();
      (renderer?.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
      renderer = null;
    },
  };
  return handle;
}
