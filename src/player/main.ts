// 書き出したゲームの再生（エディタなし・ゲームだけ）。ages export が書き出した project.json と game/ を読んで動かす。
// Web（静的なファイル一式）でも、デスクトップ（Tauri の窓の中）でも同じ。動き方はエディタの再生と同じにする（同じ Game・同じ描画・同じ音）
import { loadPackages } from '../packages/index.ts';
import { Registry, type GameModule } from '../core/registry.ts';
import { Game } from '../core/game.ts';
import { Devices } from '../input/devices.ts';
import { AudioPlayer } from '../audio/player.ts';
import { assetRefs, kindOf, preloadSet } from '../core/assets.ts';
import { shaderMap, type ShaderDef } from '../core/shader.ts';
import { LocalStore } from '../core/save.ts';
import { languagesOf } from '../core/i18n.ts';
import { fitView } from '../core/camera.ts';
import { realDate } from '../core/clock.ts';
import { Renderer } from '../render/webgl.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { TableDoc } from '../core/table.ts';
import type { SheetDef } from '../core/sheet.ts';
import type { AssetKind } from '../core/schema.ts';

/** ages export が書く project.json */
export interface ExportBundle {
  /** ゲームのコードの入り口（書き出した先の場所。例 game/index.js） */
  entry: string;
  config: ProjectConfig;
  scenes: Record<string, SceneDoc>;
  prefabs: Record<string, PrefabDoc>;
  tables: Record<string, TableDoc>;
  sheets: Record<string, SheetDef>;
  assets: { path: string; kind: AssetKind; w?: number; h?: number; shader?: Omit<ShaderDef, 'path'> }[];
  /** コードの中で場所を書いているアセット（いつも先に読み込む） */
  codeRefs: string[];
}

/** 外から様子を見る（ages export --check が headless の Chrome で読む） */
const status = { ready: false, frame: 0, scene: '', loading: false, error: '', started: false };
(window as unknown as { agesPlayer: typeof status }).agesPlayer = status;

const msg = document.getElementById('msg') as HTMLDivElement;
const show = (text: string) => { msg.textContent = text; msg.style.display = text ? 'flex' : 'none'; };
const fail = (e: unknown) => {
  status.error = (e as Error)?.message ?? String(e);
  show(`エラー / Error: ${status.error}`);
  console.error(e);
};
window.addEventListener('error', (e) => fail(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

async function main(): Promise<void> {
  const b = (await (await fetch('./project.json')).json()) as ExportBundle;
  const mod = (await import(new URL(b.entry, location.href).href)) as GameModule;
  const registry = Registry.from(mod, [], await loadPackages(b.config.packages));
  registry.prefabs = new Map(Object.entries(b.prefabs));
  registry.scenes = new Map(Object.entries(b.scenes));
  registry.sheets = new Map(Object.entries(b.sheets));
  registry.tableData = new Map(Object.entries(b.tables));
  registry.images = new Map(b.assets.filter((a) => a.w && a.h).map((a) => [a.path, { w: a.w!, h: a.h! }]));
  registry.shaders = shaderMap(b.assets.flatMap((a) => (a.shader ? [{ ...a.shader, path: a.path } as ShaderDef] : [])));
  registry.setLanguages(languagesOf(b.config));
  const v = b.config.view;
  document.title = b.config.name;

  const urlOf = (path: string) => new URL(path.split('/').map(encodeURIComponent).join('/'), location.href).href;
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  canvas.style.imageRendering = v.filter === 'nearest' ? 'pixelated' : 'auto';
  const renderer = new Renderer(canvas, { urlOf, sheets: registry.sheets, filter: v.filter, shaders: registry.shaders });
  const audio = new AudioPlayer(urlOf);

  // 画面の大きさに合わせる（view.fit。エディタのゲームの画面と同じ計算）
  const layout = () => {
    const pf = fitView(v.width, v.height, window.innerWidth, window.innerHeight, v.fit ?? 'contain');
    if (canvas.width !== pf.viewW || canvas.height !== pf.viewH) { canvas.width = pf.viewW; canvas.height = pf.viewH; }
    Object.assign(canvas.style, { left: `${pf.x}px`, top: `${pf.y}px`, width: `${pf.w}px`, height: `${pf.h}px` });
  };
  window.addEventListener('resize', layout);
  layout();

  // 入力: キーボード・ゲームパッドと、画面の点 → ゲームの画面の座標
  const devices = new Devices();
  devices.bindKeyboard(window);
  devices.bindPointer(canvas, (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const px = ((cx - r.left) / r.width) * canvas.width, py = ((cy - r.top) / r.height) * canvas.height;
    if (px < 0 || py < 0 || px > canvas.width || py > canvas.height) return null;
    return { x: px - (canvas.width - v.width) / 2, y: py - (canvas.height - v.height) / 2 };
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 全画面: F11 か Alt+Enter（デスクトップでは窓ごと。Web では画面いっぱい）
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F11' || (e.code === 'Enter' && e.altKey)) { e.preventDefault(); void toggleFullscreen(); }
  }, true);

  // セーブはこのブラウザ（デスクトップでは、このアプリ）の localStorage。エディタの再生と同じ置き方
  const store = new LocalStore(`ages.save.${b.config.name}.`, localStorage);
  const start = b.scenes[b.config.startScene] ?? Object.values(b.scenes)[0];
  if (!start) throw new Error('シーンがありません');
  const game = new Game(registry, b.config, start, b.config.seed, { store, date: realDate() });
  game.audioListeners.push((cmd) => audio.handle(cmd));
  game.particleListeners.push((cmd) => renderer.particles.burst(game.world, cmd.id, cmd.count));

  // シーンに入る前に、そのシーンで使う画像・音を読み込む（終わるまでフレームを進めない）
  const docs = { scenes: registry.scenes, prefabs: registry.prefabs, tables: new Map(Object.entries(b.tables)) };
  const refs = assetRefs(docs, registry);
  let loads = 0;
  const hold = (scene: string, first: boolean) => {
    const paths = preloadSet(refs, scene, first, b.codeRefs);
    if (!paths.length) return;
    loads++;
    status.loading = true;
    const images = paths.filter((p) => kindOf(p) === 'image');
    const sounds = paths.filter((p) => kindOf(p) === 'sound');
    void Promise.all([renderer.preload(images).catch(() => {}), audio.preload(sounds).catch(() => {})]).then(() => { if (--loads === 0) status.loading = false; });
  };
  game.sceneListeners.push((_from, to) => hold(to, false));

  // 音はブラウザの決まりで、人の操作の中でないと鳴らせないことがある。鳴らせないときは「はじめる」を待つ
  audio.ensure();
  audio.setLocal(1, false);
  audio.setBuses(game.audioBuses());
  const begin = () => {
    if (status.started) return;
    status.started = true;
    show('');
    audio.resume();
    hold(start.name, true);
    requestAnimationFrame(loop);
  };
  const ac = audio.ensure();
  if (ac.state === 'running') begin();
  else {
    show('クリックしてはじめる / Click to start');
    const go = () => { audio.resume(); begin(); };
    for (const t of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(t, go, { once: true });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) audio.suspend(); else audio.resume(); });

  // 一定の間隔で進める（エディタの再生と同じ。遅れても1回に5フレームまで）
  let last = performance.now();
  let acc = 0;
  const step = 1 / b.config.fps;
  function loop(now: number): void {
    if (status.error) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    try {
      if (!status.loading) {
        acc += dt;
        let n = 0;
        while (acc >= step && n++ < 5) {
          game.step(devices.frame());
          audio.setBuses(game.audioBuses());
          acc -= step;
        }
      } else acc = 0;
      const overlay = status.loading ? { color: game.transition?.color ?? '#000000', alpha: game.transition ? 1 : 0 } : game.overlay();
      renderer.draw(game.world, { background: v.background, design: { width: v.width, height: v.height }, overlay, particles: { dt: status.loading ? 0 : dt }, post: true });
      status.frame = game.frame;
      status.scene = game.sceneName;
    } catch (e) {
      fail(e);
    }
  }
  status.ready = true;
}

/** 全画面の切り替え（Tauri の窓なら窓ごと、ブラウザなら画面いっぱい。Esc はゲームに渡す） */
async function toggleFullscreen(): Promise<void> {
  const tauri = (window as unknown as { __TAURI__?: { window: { getCurrentWindow(): { isFullscreen(): Promise<boolean>; setFullscreen(v: boolean): Promise<void> } } } }).__TAURI__;
  if (tauri) {
    const w = tauri.window.getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
    return;
  }
  if (document.fullscreenElement) { await document.exitFullscreen(); return; }
  await document.documentElement.requestFullscreen();
  try { await (navigator as unknown as { keyboard?: { lock(keys: string[]): Promise<void> } }).keyboard?.lock(['Escape']); } catch { /* 使えないブラウザ */ }
}

main().catch(fail);
