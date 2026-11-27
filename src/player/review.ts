// 確認用のページ（ages export --review）。書き出したゲームに、2つの見方を足す（スマホのブラウザでも使える）:
// - 再生: ages run と同じ入力（--replay）で、同じように動かす。最初から・一時停止・コマ送り・速さ・フレームの番号。途中から自分で操作もできる
// - 区切り（--chapters）: 押すとその区切りから再生する（params で始め直す・frame まで見せずに速く進める）
// - 見本帳（--gallery で指定したものだけ）: プレハブ（演出・音・物）と音のファイルを並べ、押すと空の場面に1つだけ出して見る・聞く（くり返す）
// ゲームの決まりは書き出したゲームと同じ（同じ Game・同じ描画・同じ音）。保存データはこのページだけのもの（遊ぶ版のセーブに触れない）
import { Game } from '../core/game.ts';
import type { Registry } from '../core/registry.ts';
import { MemoryStore } from '../core/save.ts';
import { parseDate } from '../core/clock.ts';
import { RunInput, type RunKeys } from '../core/runinput.ts';
import { spawnTryout, tryoutGone, tryoutScene } from '../core/tryout.ts';
import type { Renderer } from '../render/webgl.ts';
import type { AudioPlayer } from '../audio/player.ts';
import type { Devices } from '../input/devices.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { TableDoc } from '../core/table.ts';

/** ages export --review が書く review.json */
export interface ReviewData {
  replay: {
    scene: string;
    seed: number;
    keys: RunKeys;
    save: Record<string, unknown>;
    date: string;
    params?: Record<string, unknown>;
    lang?: string;
    /** ここで止める（省くと、止めずに進める） */
    end?: number;
  };
  /** 見本帳（--gallery で指定したものだけ。省くと見本帳なし） */
  gallery?: {
    prefabs: { name: string; desc: string; kind: 'fx' | 'sound' | 'thing'; is3d: boolean }[];
    sounds: string[];
  };
  /** 区切り（--chapters）: 押すとそこから再生する。params は場面をその値で始め直す、frame は見せずに速く進めてそこから見せる */
  chapters?: { name: string; params?: Record<string, unknown>; frame?: number }[];
  /** 書き出したアセット（再生と見本帳で使うものだけにしたとき。省くと全部） */
  assets?: string[];
  /** 案くらべ（--variants）: 値を変えた案。今の値と並べて、同じ入力で同時に再生する。変わった文書だけ持つ */
  variants?: { name: string; desc?: string; set: Record<string, unknown>; prefabs: Record<string, PrefabDoc>; scenes: Record<string, SceneDoc>; tables: Record<string, TableDoc> }[];
}

export interface ReviewHost {
  data: ReviewData;
  registry: Registry;
  config: ProjectConfig;
  scenes: Record<string, SceneDoc>;
  renderer: Renderer;
  audio: AudioPlayer;
  devices: Devices;
  /** 画面の上と下に、ゲームを描かない幅を取る（px） */
  setInsets(top: number, bottom: number): void;
  /** シーンで使う画像・音を読み込む（終わるまで進めない） */
  hold(scene: string, first: boolean): void;
  /** 全部の画像・音を読み込む（見本帳） */
  preloadAll(): Promise<void>;
  loading(): boolean;
  /** 案くらべ: 案の値に変えた決まり（案ごと）と、案ごとの描く場所 */
  variantRegistry?(i: number): Registry;
  makeRenderer?(canvas: HTMLCanvasElement): Renderer;
  /** 案くらべの絵を先に読む（全部の画像） */
  imagePaths?: string[];
  /** ゲームを描く本来の canvas（案くらべの間は隠す） */
  gameCanvas?: HTMLCanvasElement;
  /** hash は再生が止めるフレームまで来たときの状態（ages run の hash= と同じなら、同じように動いた）。hashes は案くらべの案ごと */
  status: { frame: number; scene: string; error: string; hash?: string; hashes?: string[] };
  fail(e: unknown): void;
}

const css = {
  bar: 'position:fixed;left:0;right:0;top:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:5px 6px;box-sizing:border-box;background:#15171f;color:#eee;font:14px system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;z-index:5',
  btn: 'flex-shrink:0;min-width:40px;height:38px;padding:0 10px;border:1px solid #3a3f52;border-radius:8px;background:#232737;color:#eee;font:inherit;touch-action:manipulation',
  on: 'background:#3d5afe;border-color:#3d5afe',
  panel: 'position:fixed;left:0;right:0;bottom:0;overflow-y:auto;background:#101219;color:#eee;font:14px system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;z-index:5;padding:6px;box-sizing:border-box;-webkit-overflow-scrolling:touch',
};

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.setAttribute('style', css.btn);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

export function startReview(h: ReviewHost): void {
  const { data, registry, config, renderer, audio, devices } = h;
  const v = config.view;
  const fps = config.fps;
  const SPEEDS = [0.25, 0.5, 1, 2];

  let mode: 'replay' | 'gallery' | 'compare' = 'replay';
  let game!: Game;
  let play: RunInput | null = null;
  let paused = false;
  let speed = 1;
  let acc = 0;
  let pendingSteps = 0;
  // 見本帳: 出している物・くり返しの待ち
  let showing: { name: string; sound?: string; ids: string[]; wait: number } | null = null;
  let repeat = true;
  // 区切り: いまの区切り（-1 = 最初から）と、見せずに速く進める先
  let chapter = -1;
  let skipTo = 0;
  const chapterOf = () => (chapter >= 0 ? data.chapters?.[chapter] : undefined);
  /** 区切りの params は、再生の params に重ねる */
  const paramsOf = () => { const c = chapterOf(); return c?.params ? { ...(data.replay.params ?? {}), ...c.params } : data.replay.params; };

  /** 区切りまで見せずに速く進めている間（音・粒は出さない） */
  const skipping = () => (mode === 'replay' || mode === 'compare') && !!play && game && game.frame < skipTo;
  const listen = (g: Game) => {
    g.audioListeners.push((cmd) => { if (!skipping()) audio.handle(cmd); });
    g.particleListeners.push((cmd) => { if (!skipping()) renderer.particles.burst(g.world, cmd.id, cmd.count); });
    g.sceneListeners.push((_from, to) => h.hold(to, false));
  };
  const reset = () => { audio.stopAll(); renderer.particles.clear(); acc = 0; pendingSteps = 0; };

  // ---- 再生 ----
  const startReplay = () => {
    reset();
    const r = data.replay;
    const doc = h.scenes[r.scene];
    if (!doc) throw new Error(`シーン ${r.scene} がありません`);
    game = new Game(registry, config, doc, r.seed, { store: new MemoryStore(structuredClone(r.save)), lang: r.lang, params: paramsOf(), date: parseDate(r.date) });
    listen(game);
    skipTo = chapterOf()?.frame ?? 0;
    audio.setBuses(game.audioBuses());
    play = new RunInput(r.keys);
    paused = false;
    delete h.status.hash;
    h.hold(r.scene, true);
    refresh();
  };

  // ---- 案くらべ（--variants）: 今の値と、値を変えた案を、同じ入力で同時に再生して並べる ----
  type Pane = { name: string; sub: string; game: Game; play: RunInput; renderer: Renderer; canvas: HTMLCanvasElement; cell: HTMLDivElement };
  let panes: Pane[] = [];
  let sel = 0; // 音を鳴らす案
  const grid = document.createElement('div');
  grid.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;display:none;gap:4px;padding:4px;box-sizing:border-box;background:#0b0c10;z-index:4');
  document.body.append(grid);
  const startCompare = () => {
    reset();
    const r = data.replay;
    const list = [{ name: '今の値', sub: '', reg: registry }, ...(data.variants ?? []).map((x, i) => ({ name: x.name, sub: Object.entries(x.set).map(([k, val]) => `${k.split('.').slice(-2).join('.')}=${JSON.stringify(val)}`).join(' '), reg: h.variantRegistry!(i) }))];
    if (!panes.length) {
      // 案ごとの描く場所（WebGL の canvas と描く道具）は最初に1回だけ作る
      panes = list.map((x) => {
        const cell = document.createElement('div');
        cell.setAttribute('style', 'position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;border:2px solid transparent;border-radius:6px;background:#000');
        const canvas = document.createElement('canvas');
        canvas.width = v.width; canvas.height = v.height;
        canvas.style.imageRendering = v.filter === 'nearest' ? 'pixelated' : 'auto';
        const tag = document.createElement('div');
        tag.textContent = x.sub ? `${x.name}  ${x.sub}` : x.name;
        tag.setAttribute('style', 'position:absolute;left:4px;top:4px;right:4px;padding:2px 6px;background:#000a;color:#fff;font:12px system-ui,sans-serif;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none');
        cell.append(canvas, tag);
        grid.append(cell);
        const renderer = h.makeRenderer!(canvas);
        void renderer.preload(h.imagePaths ?? []).catch(() => {});
        return { name: x.name, sub: x.sub, game: null as unknown as Game, play: null as unknown as RunInput, renderer, canvas, cell };
      });
      panes.forEach((pn, i) => pn.cell.addEventListener('click', () => { sel = i; audio.stopAll(); refresh(); }));
    }
    panes.forEach((pn, i) => {
      const reg = list[i].reg;
      const doc = reg.scenes.get(r.scene) ?? h.scenes[r.scene];
      if (!doc) throw new Error(`シーン ${r.scene} がありません`);
      const g = new Game(reg, config, doc, r.seed, { store: new MemoryStore(structuredClone(r.save)), lang: r.lang, params: paramsOf(), date: parseDate(r.date) });
      g.audioListeners.push((cmd) => { if (i === sel && !skipping()) audio.handle(cmd); });
      g.particleListeners.push((cmd) => { if (!skipping()) pn.renderer.particles.burst(g.world, cmd.id, cmd.count); });
      g.sceneListeners.push((_from, to) => h.hold(to, false));
      pn.renderer.particles.clear();
      pn.game = g;
      pn.play = new RunInput(r.keys);
    });
    game = panes[0].game;
    play = panes[0].play;
    skipTo = chapterOf()?.frame ?? 0;
    audio.setBuses(panes[sel].game.audioBuses());
    paused = false;
    delete h.status.hash;
    delete h.status.hashes;
    h.hold(r.scene, true);
    refresh();
  };

  // ---- 見本帳 ----
  const newTryout = () => {
    reset();
    game = new Game(registry, config, tryoutScene(), config.seed, { store: new MemoryStore({}), date: parseDate(data.replay.date) });
    listen(game);
    audio.setBuses(game.audioBuses());
    play = null;
    paused = false;
  };
  const spawnShowing = () => {
    if (!showing) return;
    const p = data.gallery?.prefabs.find((x) => x.name === showing!.name);
    if (showing.sound) { game.ctx.sound.play(showing.sound); showing.ids = []; return; }
    if (p?.is3d) {
      // 3D の物は、空の場面にカメラと光を置いて、真ん中に出す
      if (!game.world.get('$review-cam')) {
        game.world.add({ id: '$review-cam', name: 'カメラ', components: { Transform3D: { y: 1.6, z: 5, rx: -12 }, Camera3D: {} } });
        game.world.add({ id: '$review-sun', name: '光', components: { Transform3D: { rx: 50, ry: -30 }, Light3D: { kind: 'sun' } } });
      }
      const e = game.world.spawn(showing.name);
      const snd = e.c.Sound as { playOnStart?: boolean } | undefined;
      if (snd && !snd.playOnStart) game.ctx.sound.play(showing.name);
      showing.ids = [e.id];
    } else showing.ids = spawnTryout(game, [{ prefab: showing.name }], v.width, v.height);
  };
  const show = (name: string, sound?: string) => {
    newTryout();
    showing = { name, sound, ids: [], wait: 0 };
    spawnShowing();
    refresh();
  };

  // ---- 画面の部品 ----
  const bar = document.createElement('div');
  bar.setAttribute('style', css.bar);
  const panel = document.createElement('div');
  panel.setAttribute('style', css.panel);
  const label = document.createElement('span');
  label.setAttribute('style', 'flex-basis:100%;padding:0 2px;font-size:12px;font-variant-numeric:tabular-nums;color:#aab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
  document.body.append(bar, panel);

  const tabReplay = button('再生', '決まった入力で動かす', () => { mode = 'replay'; startReplay(); });
  const tabGallery = button('見本帳', '演出・音を1つずつ', () => { mode = 'gallery'; newTryout(); showing = null; refresh(); });
  const tabCompare = button('案くらべ', '値を変えた案を、同じ入力で同時に並べて再生する（押した案の音が鳴る）', () => { mode = 'compare'; startCompare(); });
  const restart = button('⏮', '最初から', () => (mode === 'replay' ? startReplay() : mode === 'compare' ? startCompare() : showing ? show(showing.name, showing.sound) : undefined));
  const pause = button('⏸', '一時停止 / 続ける', () => { paused = !paused; refresh(); });
  const stepBtn = button('▶|', '1フレーム進める（止まっているとき）', () => { paused = true; pendingSteps++; refresh(); });
  const speedBtn = button('×1', '速さ', () => { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; refresh(); });
  const self = button('自分で', 'ここから自分で操作する（キーボード・ゲームパッド・タッチ）', () => { play = null; paused = false; refresh(); });
  const again = button('くり返す', '消えたら、また出す', () => { repeat = !repeat; refresh(); });
  // 区切りのボタン（押すとその区切りから。再生・案くらべのとき）
  const chapterBtns = data.chapters?.length ? [{ name: '最初から', i: -1 }, ...data.chapters.map((c, i) => ({ name: c.name, i }))].map((c) => {
    const ch = c.i >= 0 ? data.chapters![c.i] : undefined;
    const tip = !ch ? '最初から再生する' : ch.frame !== undefined ? `f${ch.frame} まで見せずに進めて、そこから見せる` : `場面を ${JSON.stringify(ch.params)} で始め直す`;
    const b = button(c.name, tip, () => { chapter = c.i; if (mode === 'gallery') mode = 'replay'; if (mode === 'compare') startCompare(); else startReplay(); });
    b.dataset.chapter = String(c.i);
    return b;
  }) : [];
  const chapterRow = document.createElement('span');
  chapterRow.setAttribute('style', 'display:contents');
  chapterRow.append(...chapterBtns);
  bar.append(tabReplay, ...(data.gallery ? [tabGallery] : []), ...(data.variants?.length && h.makeRenderer && h.variantRegistry ? [tabCompare] : []), restart, pause, stepBtn, speedBtn, self, again, chapterRow, label);

  const kindLabel = { fx: '演出', sound: '音', thing: '物' } as const;
  const buildPanel = () => {
    panel.textContent = '';
    if (!data.gallery) return;
    const gallery = data.gallery;
    const groups: [string, { label: string; sub: string; act: () => void; key: string }[]][] = [];
    for (const kind of ['fx', 'sound', 'thing'] as const) {
      const list = gallery.prefabs.filter((p) => p.kind === kind).map((p) => ({ label: p.name, sub: p.desc, act: () => show(p.name), key: p.name }));
      if (list.length) groups.push([`${kindLabel[kind]}（プレハブ）`, list]);
    }
    if (gallery.sounds.length) groups.push(['音のファイル', gallery.sounds.map((s) => ({ label: s.split('/').pop()!, sub: s, act: () => show(s, s), key: s }))]);
    if (!groups.length) panel.textContent = 'プレハブも音もありません';
    for (const [title, items] of groups) {
      const head = document.createElement('div');
      head.textContent = title;
      head.setAttribute('style', 'margin:8px 2px 4px;color:#99a;font-size:12px');
      const grid = document.createElement('div');
      grid.setAttribute('style', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px');
      for (const it of items) {
        const b = button(it.label, it.sub || it.label, it.act);
        b.dataset.key = it.key;
        b.style.cssText += ';height:auto;min-height:40px;text-align:left;overflow:hidden;text-overflow:ellipsis';
        grid.append(b);
      }
      panel.append(head, grid);
    }
  };
  buildPanel();

  const layout = () => {
    const bottom = mode === 'gallery' ? Math.round(Math.min(window.innerHeight * 0.42, 320)) : 0;
    panel.style.display = mode === 'gallery' ? 'block' : 'none';
    panel.style.height = `${bottom}px`;
    h.setInsets(bar.offsetHeight, bottom);
    // 案くらべ: 本来の画面を隠し、案を格子に並べる（2つなら横か縦に、3・4つなら2×2）
    const cmp = mode === 'compare';
    if (h.gameCanvas) h.gameCanvas.style.visibility = cmp ? 'hidden' : 'visible';
    grid.style.display = cmp ? 'grid' : 'none';
    if (cmp && panes.length) {
      grid.style.top = `${bar.offsetHeight}px`;
      const W = window.innerWidth, H = Math.max(1, window.innerHeight - bar.offsetHeight);
      const cols = panes.length <= 1 ? 1 : panes.length === 2 ? (W / H >= (v.width / v.height) ? 2 : 1) : 2;
      const rows = Math.ceil(panes.length / cols);
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      const cw = (W - 8 - (cols - 1) * 4) / cols - 4, ch = (H - 8 - (rows - 1) * 4) / rows - 4;
      const s = Math.min(cw / v.width, ch / v.height);
      panes.forEach((pn, i) => {
        Object.assign(pn.canvas.style, { width: `${Math.floor(v.width * s)}px`, height: `${Math.floor(v.height * s)}px` });
        pn.cell.style.borderColor = i === sel ? '#3d5afe' : 'transparent';
      });
    }
  };
  function refresh(): void {
    tabReplay.setAttribute('style', css.btn + (mode === 'replay' ? ';' + css.on : ''));
    tabGallery.setAttribute('style', css.btn + (mode === 'gallery' ? ';' + css.on : ''));
    tabCompare.setAttribute('style', css.btn + (mode === 'compare' ? ';' + css.on : ''));
    pause.textContent = paused ? '▶' : '⏸';
    speedBtn.textContent = `×${speed}`;
    self.style.display = mode === 'replay' && play ? '' : 'none';
    again.style.display = mode === 'gallery' ? '' : 'none';
    if (mode === 'gallery') again.setAttribute('style', css.btn + (repeat ? ';' + css.on : ''));
    for (const b of chapterBtns) b.setAttribute('style', css.btn + (mode !== 'gallery' && Number(b.dataset.chapter) === chapter ? ';' + css.on : ''));
    for (const b of panel.querySelectorAll('button')) (b as HTMLElement).style.outline = showing && (b as HTMLElement).dataset.key === (showing.sound ?? showing.name) ? '2px solid #3d5afe' : '';
    layout();
  }
  window.addEventListener('resize', layout);

  // ---- 進める ----
  const stepOnce = () => {
    // 案くらべ: どの案も同じ入力で1フレームずつ進める
    if (mode === 'compare') {
      for (const pn of panes) pn.game.step(pn.play.at(pn.game, v.width, v.height).input);
      audio.setBuses(panes[sel].game.audioBuses());
      return;
    }
    const input = play ? play.at(game, v.width, v.height).input : devices.frame();
    game.step(input);
    audio.setBuses(game.audioBuses());
    // 見本帳: 出した物がすべて消えたら、少し置いてまた出す
    if (mode === 'gallery' && showing && repeat) {
      const gone = showing.sound ? audio.playing().length === 0 : tryoutGone(game, showing.ids);
      if (gone && ++showing.wait > fps / 2) { showing.wait = 0; spawnShowing(); }
    }
  };
  let last = performance.now();
  const loop = (now: number) => {
    if (h.status.error) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    try {
      let advanced = 0;
      const replaying = mode === 'replay' || mode === 'compare';
      const ended = replaying && data.replay.end !== undefined && game.frame >= data.replay.end && !!play;
      if (ended && !paused) {
        paused = true;
        h.status.hash = game.hash();
        if (mode === 'compare') h.status.hashes = panes.map((pn) => pn.game.hash());
        refresh();
      }
      if (!h.loading() && skipping()) {
        // 区切り: 見せずに速く進める（1回の描画のあいだに、時間で区切って進める）
        const t0 = performance.now();
        while (skipping() && performance.now() - t0 < 30 && !h.loading()) stepOnce();
        acc = 0;
        if (!skipping()) { renderer.particles.clear(); for (const pn of panes) pn.renderer.particles.clear(); }
      } else if (!h.loading()) {
        if (!paused) {
          acc += dt * speed;
          let n = 0;
          // 止めるフレームを越えない（その後のコマ送り・自分での操作は越えてよい）
          const stop = replaying && play && data.replay.end !== undefined && game.frame < data.replay.end ? data.replay.end : Infinity;
          while (acc >= 1 / fps && n++ < 8 && game.frame < stop) { stepOnce(); acc -= 1 / fps; advanced++; }
        } else {
          acc = 0;
          while (pendingSteps > 0) { pendingSteps--; stepOnce(); advanced++; }
        }
      }
      if (mode === 'compare') for (const pn of panes) pn.renderer.draw(pn.game.world, { background: v.background, design: { width: v.width, height: v.height }, overlay: pn.game.overlay(), particles: { dt: advanced / fps }, post: true });
      else renderer.draw(game.world, { background: v.background, design: { width: v.width, height: v.height }, overlay: game.overlay(), particles: { dt: advanced / fps }, post: true });
      h.status.frame = game.frame;
      h.status.scene = game.sceneName;
      const end = replaying && data.replay.end !== undefined ? ` / ${data.replay.end}` : '';
      const ff = skipping() ? `早送り中（区切り f${skipTo} まで）` : '';
      const cname = chapterOf() && mode !== 'gallery' ? `［${chapterOf()!.name}］` : '';
      const who = ff ? ff : cname + (mode === 'compare' ? `案くらべ ${panes.length}つ（音: ${panes[sel]?.name ?? ''}）` : mode === 'replay' ? (play ? '再生' : '自分で') : showing ? (showing.sound ?? showing.name) : '下から選ぶ');
      label.textContent = `f${game.frame}${end}  ${who}${paused ? '（止めています）' : ''}`;
    } catch (e) {
      h.fail(e);
    }
  };

  // 見本帳の画像・音は、先に全部読んでおく（押したらすぐ出るように）
  if (data.gallery) void h.preloadAll();
  startReplay();
  requestAnimationFrame(loop);
}
