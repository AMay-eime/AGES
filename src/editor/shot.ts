// 決まったフレームの画面を撮る（ages run --shot）。CLI が headless の Chrome でこのページを開き、window.agesShot(設定) を呼ぶ。
// ages run と同じ入力（core/runinput.ts）で同じフレームまで進め、そのフレームの画面を PNG で返す。音は鳴らさない。
import { loadPackages } from '../packages/index.ts';
import { Registry, type GameModule } from '../core/registry.ts';
import { Game } from '../core/game.ts';
import { MemoryStore } from '../core/save.ts';
import { shaderMap } from '../core/shader.ts';
import { modelsOf } from '../core/assets.ts';
import { languagesOf } from '../core/i18n.ts';
import { spawnTryout, tryoutScene, type TryoutSpawn } from '../core/tryout.ts';
import { RunInput, type RunKeys } from '../core/runinput.ts';
import { parseDate } from '../core/clock.ts';
import { Renderer } from '../render/webgl.ts';
import { camerasOf, worldToScreen } from '../core/camera.ts';
import type { EditorState } from './app.ts';

export interface ShotConfig {
  scene: string;
  seed: number;
  /** 撮るフレーム（そのフレームまで進めた後の画面。0 は最初のフレームを進める前） */
  frames: number[];
  /** 入力（--keys・--input をまとめたもの） */
  keys: RunKeys;
  /** 始めの日時（ctx.date。ages run と同じ） */
  date: string;
  params?: Record<string, unknown>;
  save?: Record<string, unknown>;
  lang?: string;
  spawns?: TryoutSpawn[];
  /** 画面の大きさの倍率（1 = view の大きさ） */
  scale?: number;
  /** 状態をまるごと返す（ages run と違うときに、どこが違うかを調べる） */
  dump?: boolean;
  /** 物のまわり（または画面の点 x:y）を w×h だけ切り抜いて、zoom 倍に（最近傍。ドット絵がにじまない） */
  around?: { target: string; w: number; h: number; zoom: number };
  /** 撮ったフレームを、フレームの番号つきで1枚に並べる */
  sheet?: boolean;
}

/** そのフレームを描いたときの数（描く命令の回数・2D の四角・2D の粒と、層ごとの数） */
export interface DrawStats { draws: number; quads: number; particles: number; layers: Record<string, Record<string, number>> }

export interface ShotResult {
  shots: { frame: number; hash: string; png: string; snapshot?: unknown; stats: DrawStats; /** 切り抜いた真ん中（画面の画素）と、注意 */ at?: [number, number]; note?: string }[];
  /** 並べた1枚（sheet のとき）と、その並び */
  sheet?: { png: string; cols: number; rows: number; w: number; h: number };
  /** 進めたフレーム */
  frame: number;
  error?: string;
}

async function shoot(cfg: ShotConfig): Promise<ShotResult> {
  const state = (await (await fetch('/api/state')).json()) as EditorState;
  if (state.error) throw new Error(state.error);
  const mod = (await import(`/project@${state.version}/${state.config.game}`)) as GameModule;
  const registry = Registry.from(mod, [], await loadPackages(state.config.packages));
  registry.prefabs = new Map(Object.entries(state.prefabs));
  registry.scenes = new Map(Object.entries(state.scenes));
  registry.sheets = new Map(Object.entries(state.sheets ?? {}));
  registry.tableData = new Map(Object.entries(state.tables ?? {}));
  registry.images = new Map(state.assets.filter((a) => a.w && a.h).map((a) => [a.path, { w: a.w!, h: a.h! }]));
  registry.shaders = shaderMap(state.assets.flatMap((a) => (a.shader ? [{ ...a.shader, path: a.path }] : [])));
  registry.models = modelsOf(state.assets);
  registry.setLanguages(languagesOf(state.config));
  const urlOf = (path: string) => {
    const f = state.files.find((x) => x.path === path);
    return `/project@${state.version}/${path.split('/').map(encodeURIComponent).join('/')}?m=${f?.mtime ?? 0}`;
  };

  const v = state.config.view;
  const scale = cfg.scale ?? 1;
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = Math.round(v.width * scale);
  canvas.height = Math.round(v.height * scale);
  const renderer = new Renderer(canvas, { urlOf, sheets: registry.sheets, filter: v.filter, shaders: registry.shaders, packages: registry.packages });

  const store = new MemoryStore(cfg.save ?? {});
  const doc = cfg.spawns?.length ? tryoutScene() : state.scenes[cfg.scene];
  if (!doc) throw new Error(`シーン ${cfg.scene} はありません`);
  const game = new Game(registry, state.config, doc, cfg.seed, { store, lang: cfg.lang, params: cfg.spawns?.length ? undefined : cfg.params, date: parseDate(cfg.date) });
  if (cfg.spawns?.length) spawnTryout(game, cfg.spawns, v.width, v.height);
  game.particleListeners.push((cmd) => renderer.particles.burst(game.world, cmd.id, cmd.count));
  const play = new RunInput(cfg.keys);

  const draw = () => renderer.draw(game.world, { background: v.background, design: { width: canvas.width, height: canvas.height }, overlay: game.overlay(), particles: { dt: 0 }, post: true });
  const capture = async (): Promise<string> => {
    // 画像・フォントが読み込み終わるまで描き直す（描いて初めて読み込みが始まるものもある）
    for (let i = 0; i < 6; i++) {
      draw();
      await renderer.settled();
    }
    draw();
    return canvas.toDataURL('image/png').split(',')[1];
  };

  /** 切り抜く真ん中（画面の画素）。物は 2D の Transform の位置をカメラで写したもの。x:y なら画面の点 */
  const centerOf = (target: string): { at: [number, number]; note?: string } => {
    const k = canvas.width / v.width;
    const pt = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(target);
    if (pt) return { at: [Number(pt[1]) * k, Number(pt[2]) * k] };
    const e = target.startsWith('@')
      ? [...game.world.entities.values()].find((x) => game.world.isAlive(x.id) && !x.id.includes('/') && (x.id === target.slice(1) || x.id.startsWith(target.slice(1) + '~')))
      : game.world.get(target);
    const mid: [number, number] = [canvas.width / 2, canvas.height / 2];
    if (!e || !game.world.isAlive(e.id)) return { at: mid, note: `${target} がいないので、画面の真ん中` };
    if (!e.c.Transform) return { at: mid, note: `${target} は 2D の物でない（3D は ages space で画面の位置を見て x:y で）。画面の真ん中` };
    const t = game.world.pose(e)!;
    const cams = camerasOf(game.world, v.width, v.height);
    const layer = Number(e.c.Sprite?.layer ?? e.c.Shape?.layer ?? e.c.Text?.layer ?? 0);
    const cam = cams.find((c) => layer >= c.layerMin && layer <= c.layerMax) ?? cams[0];
    const [sx, sy] = worldToScreen(cam, t.x, t.y);
    return { at: [sx * k, sy * k] };
  };
  /** 切り抜いて拡大した canvas（外にはみ出した所は灰色） */
  const crop = (src: HTMLCanvasElement, at: [number, number], a: NonNullable<ShotConfig['around']>): HTMLCanvasElement => {
    const k = canvas.width / v.width, w = Math.round(a.w * k), hh = Math.round(a.h * k);
    const out = document.createElement('canvas');
    out.width = w * a.zoom; out.height = hh * a.zoom;
    const g = out.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#808080';
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(src, Math.round(at[0] - w / 2), Math.round(at[1] - hh / 2), w, hh, 0, 0, out.width, out.height);
    return out;
  };
  const tiles: { frame: number; img: HTMLCanvasElement }[] = [];

  const targets = [...new Set(cfg.frames)].sort((a, b) => a - b);
  const shots: ShotResult['shots'] = [];
  const dt = 1 / state.config.fps;
  try {
    for (const t of targets) {
      while (game.frame < t) {
        const { input } = play.at(game, v.width, v.height);
        game.step(input);
        renderer.particles.update(game.world, dt);
        for (const l of renderer.layers) l.update?.(game.world, dt);
      }
      const hash = game.hash();
      const snapshot = cfg.dump ? game.snapshot() : undefined;
      let png = await capture();
      let at: [number, number] | undefined, note: string | undefined;
      if (cfg.around || cfg.sheet) {
        let img: HTMLCanvasElement = canvas;
        if (cfg.around) { const c = centerOf(cfg.around.target); at = c.at; note = c.note; img = crop(canvas, c.at, cfg.around); png = img.toDataURL('image/png').split(',')[1]; }
        if (cfg.sheet) { const copy = document.createElement('canvas'); copy.width = img.width; copy.height = img.height; copy.getContext('2d')!.drawImage(img, 0, 0); tiles.push({ frame: game.frame, img: copy }); }
      }
      const stats: DrawStats = { ...renderer.stats, particles: renderer.particles.count(), layers: Object.fromEntries(renderer.layers.filter((l) => l.stats).map((l) => [l.name, { ...l.stats } as Record<string, number>])) };
      shots.push({ frame: game.frame, hash, png, stats, ...(snapshot ? { snapshot } : {}), ...(at ? { at: [Math.round(at[0]), Math.round(at[1])] as [number, number] } : {}), ...(note ? { note } : {}) });
    }
  } catch (e) {
    return { shots, frame: game.frame, error: (e as Error).message };
  }
  // 並べる: 横に、幅 2048 を超えたら折り返す。左上にフレームの番号
  if (cfg.sheet && tiles.length) {
    const w = tiles[0].img.width, hh = tiles[0].img.height, gap = 4;
    const cols = Math.max(1, Math.min(tiles.length, Math.floor((2048 + gap) / (w + gap)))), rows = Math.ceil(tiles.length / cols);
    const out = document.createElement('canvas');
    out.width = cols * w + (cols - 1) * gap; out.height = rows * hh + (rows - 1) * gap;
    const g = out.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, out.width, out.height);
    g.imageSmoothingEnabled = false;
    g.font = 'bold 12px sans-serif';
    tiles.forEach((t, i) => {
      const x = (i % cols) * (w + gap), y = Math.floor(i / cols) * (hh + gap);
      g.drawImage(t.img, x, y);
      const label = `f${t.frame}`;
      g.fillStyle = 'rgba(0,0,0,.7)';
      g.fillRect(x, y, g.measureText(label).width + 8, 16);
      g.fillStyle = '#ffffff';
      g.fillText(label, x + 4, y + 12);
    });
    return { shots, frame: game.frame, sheet: { png: out.toDataURL('image/png').split(',')[1], cols, rows, w: out.width, h: out.height } };
  }
  return { shots, frame: game.frame };
}

(window as unknown as { agesShot: typeof shoot }).agesShot = shoot;
