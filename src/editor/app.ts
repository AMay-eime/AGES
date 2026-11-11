// エディタの中心。状態の読み込み、サーバーとのやりとり、再生（プレイモード）を受け持つ。
import { Registry, type GameModule } from '../core/registry.ts';
import { Game, busesOf } from '../core/game.ts';
import { InputRecorder, type InputEvent } from '../core/input.ts';
import { formatDate, parseDate, realDate } from '../core/clock.ts';
import { parseParams } from '../core/runinput.ts';
import { startTrial } from '../core/trial.ts';
import { Devices } from '../input/devices.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { Op, Change } from '../core/patch.ts';
import { modal, toast, h } from './ui/dom.ts';
import { AudioPlayer } from '../audio/player.ts';
import { DEFAULT_SOUND, playCmd, type SoundSettings } from '../core/audio.ts';
import { assetRefs, modelsOf, preloadSet } from '../core/assets.ts';
import { shaderMap, type ShaderDef } from '../core/shader.ts';
import { LocalStore } from '../core/save.ts';
import { languagesOf } from '../core/i18n.ts';
import { resolveEntity } from '../core/variant.ts';
import { T, lang } from './i18n.ts';
import { AiModel } from './ai.ts';
import { loadPackages } from '../packages/index.ts';

export interface LockMark { who: string; t: string; value: unknown; note?: string }
export interface TouchMark { who: string; t: string }

export interface EditorState {
  config: ProjectConfig;
  scenes: Record<string, SceneDoc>;
  prefabs: Record<string, PrefabDoc>;
  touched: Record<string, TouchMark>;
  locks: Record<string, LockMark>;
  issues: string[];
  lockReport: string[];
  integrity: { ok: boolean; reason?: string; diff: { added: string[]; removed: string[]; changed: string[] }; hasBackup: boolean };
  version: number;
  files: { path: string; size: number; mtime: number }[];
  sheets: Record<string, import('../core/sheet.ts').SheetDef>;
  tables: Record<string, import('../core/table.ts').TableDoc>;
  assets: { path: string; kind: import('../core/schema.ts').AssetKind; bytes: number; w?: number; h?: number; sec?: number; shader?: ShaderDef; model?: { size: [number, number, number]; center: [number, number, number]; tris: number; clips: string[]; clipSec?: number[] } }[];
  /** 保存データのファイル（saves/*.save.json） */
  saves?: string[];
  /** コードの中でアセットの場所を書いている所（場所 → "game/x.ts:12"） */
  codeRefs: Record<string, string[]>;
  /** フォルダの一覧（空のフォルダも） */
  dirs: string[];
  /** ロックマネージャーの場所（別のポート） */
  lockManager?: string;
  error?: string;
}

export type Selection = { kind: 'scene'; scene: string; id: string } | { kind: 'prefab'; name: string } | null;

export interface PlayState {
  game: Game;
  paused: boolean;
  /** 実行中にインスペクタで変えた値（停止時に保存するか選ぶ） */
  edits: Map<string, unknown>;
  recorder?: InputRecorder;
  /** 始めたときの保存データ（記録に入れて、AI が同じ状態から再現できるように） */
  saveAtStart?: Record<string, unknown>;
  /** 再生を始めたシーン（止めたらここに戻る） */
  from: string;
  /** 読み込み中（終わるまでフレームを進めない。結果は変わらない） */
  loading?: { done: number; total: number };
  /** 始めのシーンに渡したもの（記録に残す） */
  params?: Record<string, unknown>;
}

/** 再生の始め方（拡張の api.play・再生の設定） */
export interface PlayOptions {
  /** 始めるシーン（省くと今のシーン） */
  scene?: string;
  /** 始めのシーンに渡す ctx.scene.params */
  params?: Record<string, unknown>;
  /** ctx.date の始め（'2026-12-25T09:00'。省くと実際の時計） */
  date?: string;
  /** 入力を記録する */
  record?: boolean;
}

type Listener = (detail?: unknown) => void;

export class App {
  state!: EditorState;
  registry!: Registry;
  scene = '';
  sel: Selection = null;
  user = localStorage.getItem('ages.user') || 'human';
  play: PlayState | null = null;
  /** 編集モードで描く用のゲーム（シーンを並べただけで、進めない） */
  preview: Game | null = null;
  /** キーボード・マウス・タッチ・ゲームパッド（再生中だけゲームへ） */
  readonly devices = new Devices();
  /** エディタ拡張（本体の拡張とプロジェクトの拡張。extensions.ts） */
  extensions: import('./extensions.ts').LoadedExtension[] = [];
  /** AI とのやり取り（作業・質問・付箋）と、AI の変更を確かめたか（ai.ts） */
  readonly ai = new AiModel(this);
  private loadedVersion = 0;
  private listeners = new Map<string, Set<Listener>>();

  on(ev: string, fn: Listener): () => void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
    return () => this.listeners.get(ev)!.delete(fn);
  }

  emit(ev: string, detail?: unknown): void {
    for (const fn of this.listeners.get(ev) ?? []) {
      try { fn(detail); } catch (e) { console.error(e); }
    }
  }

  async api<T = any>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit } = {}): Promise<T> {
    const res = await fetch(path, {
      method: init.method ?? (init.body !== undefined || init.raw !== undefined ? 'POST' : 'GET'),
      headers: { 'x-ages-user': encodeURIComponent(this.user), 'x-ages-lang': lang, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    const data = await res.json();
    if (!res.ok || data?.error) throw Object.assign(new Error(data?.error ?? res.statusText), { status: res.status, data });
    return data;
  }

  setUser(name: string): void {
    this.user = name.trim() || 'human';
    localStorage.setItem('ages.user', this.user);
  }

  /** 次に「元に戻す」「やり直す」と何が起きるか（上のバーのボタンの説明） */
  undoInfo: { undo?: { id: string; label: string }; redo?: { id: string; label: string } } = {};

  /** 元に戻す（redo ならやり直す）。tx を渡すと、その編集（操作ログから選んだもの。AI の編集も） */
  async undo(redo = false, tx?: string): Promise<void> {
    if (this.play) { toast(T('再生中は元に戻せません（止めてから）'), 'bad'); return; }
    try {
      const r = await this.api<{ label: string; changes: Change[]; warnings?: string[] }>(redo ? '/api/redo' : '/api/undo', { body: { tx } });
      toast(T('{0}: {1}', redo ? T('やり直しました') : T('元に戻しました'), r.label));
      for (const w of r.warnings ?? []) toast(`⚠ ${w}`, 'bad', 8000);
    } catch (e) {
      toast((e as Error).message, 'bad', 8000);
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const [s, u] = await Promise.all([this.api<EditorState>('/api/state'), this.api<App['undoInfo']>('/api/undo').catch(() => ({}))]);
    this.state = s;
    this.undoInfo = u;
    if (s.error) {
      this.emit('change');
      return;
    }
    if (s.version !== this.loadedVersion) {
      try {
        const mod = (await import(`/project@${s.version}/${s.config.game}`)) as GameModule;
        this.registry = Registry.from(mod, [], await loadPackages(s.config.packages));
        this.loadedVersion = s.version;
      } catch (e) {
        toast(T('ゲームコードを読み込めません: {0}', (e as Error).message), 'bad', 8000);
      }
    }
    if (this.registry) {
      this.registry.prefabs = new Map(Object.entries(s.prefabs));
      this.registry.scenes = new Map(Object.entries(s.scenes));
      this.registry.sheets = new Map(Object.entries(s.sheets ?? {}));
      this.registry.tableData = new Map(Object.entries(s.tables ?? {}));
      this.registry.images = new Map(s.assets.filter((a) => a.w && a.h).map((a) => [a.path, { w: a.w!, h: a.h! }]));
      this.registry.shaders = shaderMap(s.assets.flatMap((a) => (a.shader ? [{ ...a.shader, path: a.path }] : [])));
      this.registry.models = modelsOf(s.assets);
      this.registry.setLanguages(languagesOf(s.config));
    }
    if (!this.scene || !s.scenes[this.scene]) this.scene = s.config.startScene in s.scenes ? s.config.startScene : Object.keys(s.scenes)[0] ?? '';
    this.rebuildPreview();
    this.emit('change');
  }

  private views = new WeakMap<object, Map<string, SceneDoc>>();
  /**
   * シーンの物を、プレハブのインスタンスはプレハブと重ねた中身にしたもの（読むだけ。値を見せる・動かす位置を求めるとき）。
   * 書くときの住所はそのまま（scene#id.部品.値）でよい（変えた値だけがインスタンスの値として残る）
   */
  sceneView(name = this.scene): SceneDoc | undefined {
    const s = this.state?.scenes[name];
    if (!s) return undefined;
    let m = this.views.get(this.state);
    if (!m) { m = new Map(); this.views.set(this.state, m); }
    let v = m.get(name);
    if (!v) {
      const prefabs = new Map(Object.entries(this.state.prefabs));
      v = { ...s, entities: s.entities.map((e) => { try { return resolveEntity(prefabs, e); } catch { return e; } }) };
      m.set(name, v);
    }
    return v;
  }

  rebuildPreview(): void {
    const doc = this.state.scenes[this.scene];
    if (!doc || !this.registry) { this.preview = null; return; }
    try {
      this.preview = new Game(this.registry, this.state.config, doc, this.state.config.seed, { lang: this.previewLang || undefined });
    } catch (e) {
      this.preview = null;
      toast((e as Error).message, 'bad');
    }
  }

  async patch(ops: Op[], win = 'inspector'): Promise<Change[] | null> {
    try {
      const r = await this.api<{ changes: Change[]; warnings?: string[] }>('/api/patch', { body: { ops, win } });
      await this.refresh();
      for (const w of r.warnings ?? []) toast(`⚠ ${w}`, 'bad', 8000);
      return r.changes;
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
      await this.refresh();
      return null;
    }
  }

  /**
   * ロックマネージャー（人だけが使う専用の画面。別のタブ）を開く。path を渡すと、その値を開いた状態で
   * ロックを付ける・外す・ロックされた値を変えるのは、そこからだけ
   */
  openLocks(path = ''): void {
    const base = this.state?.lockManager ?? `http://${location.hostname}:${Number(location.port || 80) + 1}`;
    // ロックマネージャーは別のオリジンなので、エディタの言葉を渡す（localStorage は別）
    const url = `${base}/?user=${encodeURIComponent(this.user)}&lang=${lang}${path ? `&focus=${encodeURIComponent(path)}` : ''}`;
    window.open(url, 'ages-locks');
  }

  /** ロックをかける（エディタから。外すのはロックマネージャーで）。押し間違えたときのために、外す場所へのリンクを出す */
  async lock(paths: string[], win = 'inspector'): Promise<void> {
    if (!paths.length) return;
    try {
      await this.api('/api/lock', { body: { paths, win } });
      const label = paths.length === 1 ? paths[0] : T('{0}件', paths.length);
      const t = toast(T('🔒 ロックしました: {0}（外すならロックマネージャーで）', label), 'lock', 6000);
      t?.addEventListener('click', () => this.openLocks(paths[0]));
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
    await this.refresh();
  }

  /** ロックされた値を表示するか（人ごとにブラウザに記憶する設定。既定は表示する） */
  get showLocked(): boolean {
    return localStorage.getItem('ages.showLocked') !== '0';
  }
  set showLocked(v: boolean) {
    localStorage.setItem('ages.showLocked', v ? '1' : '0');
    this.emit('settings');
  }

  /** 格子への吸着の目の大きさ（0 なら吸着しない。ゲームの画面が決める） */
  snap: () => number = () => 0;
  /** ゲームの画面の取っ手（移動・回転・拡大縮小。W・E・R）を切り替える（ゲームの画面が決める） */
  setTool: (tool: 'move' | 'rotate' | 'scale') => void = () => {};

  /** 一緒に選んでいる物（同じシーンの ID。sel が手前の1つで、インスペクタに出るのはそれ） */
  extra: string[] = [];

  /**
   * 選ぶ。add なら今の選びに足す（もう選んでいる物なら外す）。足した物が手前（インスペクタに出る物）になる
   */
  select(sel: Selection, opts: { add?: boolean } = {}): void {
    if (sel?.kind === 'scene' && sel.scene !== this.scene) {
      this.scene = sel.scene;
      this.rebuildPreview();
      opts = {};
    }
    const cur = this.sel?.kind === 'scene' ? this.sel : null;
    if (opts.add && sel?.kind === 'scene' && cur && cur.scene === sel.scene) {
      const all = [cur.id, ...this.extra];
      if (all.includes(sel.id)) {
        const rest = all.filter((x) => x !== sel.id);
        this.sel = rest.length ? { kind: 'scene', scene: sel.scene, id: rest[0] } : null;
        this.extra = rest.slice(1);
      } else {
        this.sel = sel;
        this.extra = all;
      }
    } else {
      this.sel = sel;
      this.extra = [];
    }
    this.row = null;
    this.emit('select');
  }

  /** 表のエディタで選んでいる行（拡張の api.selection に $表.行 で出る）。シーンの物・プレハブを選ぶと外れる */
  row: { table: string; id: string } | null = null;

  /** 表の行を選んだことにする（表のエディタから。インスペクタの選びはそのまま）。変わったら select を知らせる */
  selectRow(table: string, id: string | null): void {
    if ((this.row?.table ?? '') === (id ? table : '') && (this.row?.id ?? '') === (id ?? '')) return;
    this.row = id ? { table, id } : null;
    this.emit('select');
  }

  /** まとめて選ぶ（最初の物が手前） */
  selectMany(ids: string[], add = false): void {
    const cur = this.sel?.kind === 'scene' && this.sel.scene === this.scene ? [this.sel.id, ...this.extra] : [];
    const all = [...new Set([...(add ? cur : []), ...ids])].filter((id) => this.state.scenes[this.scene]?.entities.some((e) => e.id === id));
    this.sel = all.length ? { kind: 'scene', scene: this.scene, id: all[0] } : null;
    this.extra = all.slice(1);
    this.row = null;
    this.emit('select');
  }

  /** 選んでいるシーンの物の ID（手前の物が最初） */
  selectedIds(): string[] {
    return this.sel?.kind === 'scene' ? [this.sel.id, ...this.extra] : [];
  }

  /** アセットを読み込むURL（ファイルが変われば変わる） */
  assetUrl(path: string): string {
    const f = this.state.files.find((x) => x.path === path);
    return `/project@${this.state.version}/${path.split('/').map(encodeURIComponent).join('/')}?m=${f?.mtime ?? 0}`;
  }

  /** いま描くべきワールド */
  get world() {
    return this.play?.game.world ?? this.preview?.world ?? null;
  }

  // ---------- 再生 ----------
  /** 音を鳴らす側（再生中の音と、インスペクタの試し聞き） */
  readonly audio = new AudioPlayer((p) => this.assetUrl(p));

  /** 手元の音量とミュート（このブラウザだけ。プロジェクトには保存しない） */
  setLocalAudio(volume: number, muted: boolean): void {
    localStorage.setItem('ages.audio', JSON.stringify({ volume, muted }));
    this.audio.setLocal(volume, muted);
    this.emit('audio');
  }
  get localAudio(): { volume: number; muted: boolean } {
    try { return { volume: 1, muted: false, ...JSON.parse(localStorage.getItem('ages.audio') ?? '{}') }; } catch { return { volume: 1, muted: false }; }
  }

  /** 音量の区分（AudioBus のプレハブ）を、鳴らす側に伝える。再生中に人が区分の音量を変えても、その場で反映される */
  syncBuses(): void {
    if (!this.registry) return;
    this.audio.setBuses(this.play ? this.play.game.audioBuses() : busesOf(this.registry));
  }

  /** 試しに鳴らす（インスペクタの ▶） */
  previewSound(values: Partial<SoundSettings>, cue = 'preview'): void {
    const s = { ...DEFAULT_SOUND, ...values } as SoundSettings;
    if (!s.clip) { toast(T('音のファイルが決まっていません'), 'bad'); return; }
    this.audio.ensure();
    const l = this.localAudio;
    this.audio.setLocal(l.volume, l.muted);
    this.syncBuses();
    this.audio.stop({ t: 'stop', frame: 0, target: 'preview' });
    // 繰り返す音も、試し聞きは1回だけ（「同時に1つだけ」の区分の曲を止めないよう、区分は通すが切り替えはしない名前で鳴らす）
    this.audio.handle({ ...playCmd(-1, cue, s), loop: false });
    if (l.muted) toast(T('ミュート中です（上のバーの 🔇 で解除）'));
  }

  /** 再生の設定（このブラウザ・プロジェクトごと。▶ の横の … で決める）。params は --params と同じ書き方、date は空なら実際の時計 */
  get playSettings(): { params: string; date: string } {
    try { return { params: '', date: '', ...JSON.parse(localStorage.getItem(`ages.play.${this.state.config.name}`) ?? '{}') }; } catch { return { params: '', date: '' }; }
  }
  set playSettings(v: { params: string; date: string }) {
    if (v.params.trim()) parseParams(v.params, 'params');
    if (v.date.trim()) parseDate(v.date);
    try { localStorage.setItem(`ages.play.${this.state.config.name}`, JSON.stringify(v)); } catch { /* 使えなくても止めない */ }
    this.emit('play');
  }

  /** 再生を始める。opts を省くと、今のシーンを再生の設定（params・日時）で */
  startPlay(record: boolean | PlayOptions = false): void {
    if (this.play || !this.registry) return;
    const opts: PlayOptions = typeof record === 'boolean' ? { record } : record;
    const from = this.scene;
    try {
      if (opts.scene !== undefined) {
        if (!this.state.scenes[opts.scene]) throw new Error(T('シーン {0} はありません', opts.scene));
        this.scene = opts.scene;
      }
      const set = this.playSettings;
      const params = opts.params ?? (set.params.trim() ? parseParams(set.params, 'params') : undefined);
      const dateText = opts.date ?? set.date.trim();
      // セーブはこのブラウザの localStorage（プロジェクトごと）。止めても残り、次の再生で読める
      const store = this.saveStore();
      const saveAtStart = Object.fromEntries(Object.entries(store.load()).map(([k, v]) => [k, JSON.parse(v)]));
      const game = new Game(this.registry, this.state.config, this.state.scenes[this.scene], this.state.config.seed, { store, lang: this.previewLang || undefined, params, date: dateText ? parseDate(dateText) : realDate() });
      game.listeners.push((ev) => this.emit('gameEvent', ev));
      // 音: 再生ボタンのクリックの中で準備する（ブラウザの決まり）。画像・音のファイルは hold で先に読み込む
      this.audio.ensure();
      const l = this.localAudio;
      this.audio.setLocal(l.volume, l.muted);
      this.audio.resume();
      this.audio.setBuses(game.audioBuses());
      game.audioListeners.push((cmd) => this.audio.handle(cmd));
      // パーティクルを出す命令は、ゲームの画面（描く側）へ
      game.particleListeners.push((cmd) => this.emit('particles', cmd));
      const play: PlayState = { game, paused: false, edits: new Map(), recorder: opts.record ? new InputRecorder() : undefined, from, saveAtStart, ...(params ? { params } : {}) };
      this.play = play;
      // シーンが切り替わったら、エディタもそのシーンを見せ、次のシーンの画像・音を読み込む
      game.sceneListeners.push((from, to) => {
        this.scene = to;
        this.hold(play, to, false);
        this.emit('change');
        this.emit('scene', { from, to });
      });
      this.hold(play, this.scene, true);
      if (this.scene !== from) { this.rebuildPreview(); this.emit('change'); }
      this.emit('play');
    } catch (e) {
      if (this.scene !== from) this.scene = from;
      toast((e as Error).message, 'bad');
    }
  }

  /** 画像と音を読み込む人（ゲームの画面が描く側を登録する） */
  readonly preloaders: ((paths: string[]) => Promise<void>)[] = [(paths) => this.audio.preload(paths.filter((p) => /\.(wav|mp3|ogg|m4a)$/i.test(p)))];

  /** シーンに入る前に、そのシーンで使う画像・音を読み込む。終わるまでフレームを進めない */
  private hold(play: PlayState, scene: string, first: boolean): void {
    const s = this.state;
    const docs = { scenes: new Map(Object.entries(s.scenes)), prefabs: new Map(Object.entries(s.prefabs)), tables: new Map(Object.entries(s.tables)) };
    const paths = preloadSet(assetRefs(docs, this.registry), scene, first, Object.keys(s.codeRefs ?? {}));
    if (!paths.length) return;
    const loading = { done: 0, total: paths.length };
    play.loading = loading;
    const each = (p: string) => Promise.all(this.preloaders.map((f) => f([p]).catch(() => {}))).then(() => { loading.done++; });
    void Promise.all(paths.map(each)).then(() => { if (play.loading === loading) play.loading = undefined; this.emit('frame'); });
  }

  /** エディタのゲームの画面の重さ（直近のフレーム。拡張の api.perf） */
  perf = { stepMs: 0, drawMs: 0, draws: 0, quads: 0, fps: 0 };
  /** ゲームの画面に重ねて描くもの（拡張の api.overlay） */
  readonly overlays = new Set<(g: import('./window-api.ts').StageDraw, view: import('./window-api.ts').OverlayView) => void>();

  /** 再生の速さ（1 が実時間。拡張の api.speed・上のバーの ×1） */
  private speed = 1;
  get playSpeed(): number { return this.speed; }
  set playSpeed(v: number) {
    this.speed = Math.max(0.1, Math.min(8, Number(v) || 1));
    this.emit('play');
  }

  togglePause(): void {
    if (!this.play) return;
    this.play.paused = !this.play.paused;
    if (this.play.paused) this.audio.suspend(); else this.audio.resume();
    this.emit('play');
  }

  /** 1フレーム進める（再生中・一時停止中どちらでも） */
  stepOnce(): void {
    if (!this.play) {
      this.startPlay();
      const started = this.play as PlayState | null;
      if (started) started.paused = true;
    }
    if (!this.play) return;
    this.tick();
    this.emit('frame');
  }

  tick(): void {
    const p = this.play;
    if (!p || p.loading) return; // 止めた後（拡張がフレームの途中で止めたときも）・読み込みが終わるまでは進めない
    try {
      const input = this.devices.frame();
      p.recorder?.record(p.game.frame, input);
      p.game.step(input);
      this.syncBuses();
    } catch (e) {
      p.paused = true;
      toast((e as Error).message, 'bad', 10000);
      this.emit('play');
    }
  }

  async stopPlay(): Promise<void> {
    const p = this.play;
    if (!p) return;
    this.play = null;
    this.audio.stopAll();
    this.audio.resume();
    this.devices.clear();
    // 再生中にシーンが切り替わっていたら、始めたシーンに戻る
    if (this.scene !== p.from && this.state.scenes[p.from]) { this.scene = p.from; this.rebuildPreview(); this.emit('change'); }
    this.emit('play');
    if (p.recorder) await this.saveRecording(p.recorder.events, p.game.frame, p.saveAtStart, formatDate(p.game.dateStart), p.game.sceneLog[0]?.name ?? p.from, p.params);
    this.emit('save');
    if (p.edits.size) await this.askKeepEdits(p.edits);
  }

  /** エディタで見る言語（'' なら保存の設定・既定の言語のまま）。止めている画面と再生の両方に効く */
  get previewLang(): string {
    try { return localStorage.getItem(`ages.lang.${this.state.config.name}`) ?? ''; } catch { return ''; }
  }
  set previewLang(v: string) {
    try { localStorage.setItem(`ages.lang.${this.state.config.name}`, v); } catch { /* 使えなくても止めない */ }
    this.rebuildPreview();
    this.emit('change');
  }

  /** このプロジェクトの保存データの置き場所（このブラウザの localStorage） */
  saveStore(): LocalStore {
    return new LocalStore(`ages.save.${this.state.config.name}.`, localStorage);
  }

  private async saveRecording(events: InputEvent[], frames: number, save: Record<string, unknown> | undefined, date: string, scene: string, params?: Record<string, unknown>): Promise<void> {
    const name = `rec-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
    const path = `recordings/${name}.input.json`;
    // 始めた日時も残す（ctx.date を使うゲームも、ages run --input で同じ結果になるように）
    const data = { seed: this.state.config.seed, scene, frames, date, ...(params ? { params } : {}), ...(save && Object.keys(save).length ? { save } : {}), events };
    await this.api(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', raw: JSON.stringify(data, null, 2) + '\n' });
    toast(T('入力を記録しました: {0}\nAIは ages run --input {1} で同じ操作を再現できます', path, path));
  }

  /** 実行中の変更を保存するか選ぶ */
  private askKeepEdits(edits: Map<string, unknown>): Promise<void> {
    return new Promise((done) => {
      modal((close) => {
        const boxes = [...edits.entries()].map(([path, v]) => {
          const cb = h('input', { type: 'checkbox', checked: true });
          return { path, v, cb, row: h('label', { class: 'row', style: 'padding:2px 0' }, cb, h('code', {}, path), ' = ', JSON.stringify(v)) };
        });
        const finish = async (save: boolean) => {
          close();
          const ops: Op[] = save ? boxes.filter((b) => b.cb.checked).map((b) => ({ op: 'set', path: b.path, value: b.v })) : [];
          if (ops.length) await this.patch(ops, 'play');
          done();
        };
        return h('div', {},
          h('h3', {}, T('実行中の変更を保存しますか？')),
          h('div', { class: 'muted', style: 'margin-bottom:8px' }, T('チェックした値だけシーンに保存します。')),
          boxes.map((b) => b.row),
          h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
            h('button', { onclick: () => finish(false) }, T('捨てる')),
            h('button', { class: 'on', onclick: () => finish(true) }, T('保存する'))));
      });
    });
  }

  /** 画面なしでの試し実行（カスタムウインドウ用）。keys は ages run --keys と同じ書き方（"0-600:@fire;100-200:ArrowLeft"） */
  simulate(frames: number, keys = '', seed?: number): { counts: Record<string, number>; frame: number; ms: number } {
    // 中身は api.run・試しの舞台と同じ（core/trial.ts）。こちらは今のシーンを、続けて回す
    const t = startTrial(this.registry, this.state.config, { scene: this.scene, keys, seed });
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) t.step();
    return { counts: Object.fromEntries(t.game.counts), frame: t.game.frame, ms: performance.now() - t0 };
  }
}
