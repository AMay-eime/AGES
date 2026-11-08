// エディタの中心。状態の読み込み、サーバーとのやりとり、再生（プレイモード）を受け持つ。
import { Registry, type GameModule } from '../core/registry.ts';
import { Game, busesOf } from '../core/game.ts';
import { InputRecorder, InputPlayback, actionsFromRows, keysToEvents, type InputEvent } from '../core/input.ts';
import { Devices } from '../input/devices.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { Op, Change } from '../core/patch.ts';
import { modal, toast, h } from './ui/dom.ts';
import { AudioPlayer } from '../audio/player.ts';
import { DEFAULT_SOUND, playCmd, type SoundSettings } from '../core/audio.ts';
import { assetRefs, preloadSet } from '../core/assets.ts';

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
  assets: { path: string; kind: 'image' | 'sound' | 'font'; bytes: number; w?: number; h?: number; sec?: number }[];
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
  /** 再生を始めたシーン（止めたらここに戻る） */
  from: string;
  /** 読み込み中（終わるまでフレームを進めない。結果は変わらない） */
  loading?: { done: number; total: number };
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
      headers: { 'x-ages-user': encodeURIComponent(this.user), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
    if (this.play) return toast('再生中は元に戻せません（止めてから）', 'bad');
    try {
      const r = await this.api<{ label: string; changes: Change[]; warnings?: string[] }>(redo ? '/api/redo' : '/api/undo', { body: { tx } });
      toast(`${redo ? 'やり直しました' : '元に戻しました'}: ${r.label}`);
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
        this.registry = Registry.from(mod);
        this.loadedVersion = s.version;
      } catch (e) {
        toast(`ゲームコードを読み込めません: ${(e as Error).message}`, 'bad', 8000);
      }
    }
    if (this.registry) {
      this.registry.prefabs = new Map(Object.entries(s.prefabs));
      this.registry.scenes = new Map(Object.entries(s.scenes));
      this.registry.sheets = new Map(Object.entries(s.sheets ?? {}));
      this.registry.tableData = new Map(Object.entries(s.tables ?? {}));
      this.registry.images = new Map(s.assets.filter((a) => a.w && a.h).map((a) => [a.path, { w: a.w!, h: a.h! }]));
    }
    if (!this.scene || !s.scenes[this.scene]) this.scene = s.config.startScene in s.scenes ? s.config.startScene : Object.keys(s.scenes)[0] ?? '';
    this.rebuildPreview();
    this.emit('change');
  }

  rebuildPreview(): void {
    const doc = this.state.scenes[this.scene];
    if (!doc || !this.registry) { this.preview = null; return; }
    try {
      this.preview = new Game(this.registry, this.state.config, doc);
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
    const url = `${base}/?user=${encodeURIComponent(this.user)}${path ? `&focus=${encodeURIComponent(path)}` : ''}`;
    window.open(url, 'ages-locks');
  }

  /** ロックされた値を表示するか（人ごとにブラウザに記憶する設定。既定は表示する） */
  get showLocked(): boolean {
    return localStorage.getItem('ages.showLocked') !== '0';
  }
  set showLocked(v: boolean) {
    localStorage.setItem('ages.showLocked', v ? '1' : '0');
    this.emit('settings');
  }

  select(sel: Selection): void {
    if (sel?.kind === 'scene' && sel.scene !== this.scene) {
      this.scene = sel.scene;
      this.rebuildPreview();
    }
    this.sel = sel;
    this.emit('select');
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
    if (!s.clip) return toast('音のファイルが決まっていません', 'bad');
    this.audio.ensure();
    const l = this.localAudio;
    this.audio.setLocal(l.volume, l.muted);
    this.syncBuses();
    this.audio.stop({ t: 'stop', frame: 0, target: 'preview' });
    // 繰り返す音も、試し聞きは1回だけ（「同時に1つだけ」の区分の曲を止めないよう、区分は通すが切り替えはしない名前で鳴らす）
    this.audio.handle({ ...playCmd(-1, cue, s), loop: false });
    if (l.muted) toast('ミュート中です（上のバーの 🔇 で解除）');
  }

  startPlay(record = false): void {
    if (this.play || !this.registry) return;
    try {
      const game = new Game(this.registry, this.state.config, this.state.scenes[this.scene]);
      game.listeners.push((ev) => this.emit('gameEvent', ev));
      // 音: 再生ボタンのクリックの中で準備する（ブラウザの決まり）。画像・音のファイルは hold で先に読み込む
      this.audio.ensure();
      const l = this.localAudio;
      this.audio.setLocal(l.volume, l.muted);
      this.audio.resume();
      this.audio.setBuses(game.audioBuses());
      game.audioListeners.push((cmd) => this.audio.handle(cmd));
      const play: PlayState = { game, paused: false, edits: new Map(), recorder: record ? new InputRecorder() : undefined, from: this.scene };
      this.play = play;
      // シーンが切り替わったら、エディタもそのシーンを見せ、次のシーンの画像・音を読み込む
      game.sceneListeners.push((_from, to) => {
        this.scene = to;
        this.hold(play, to, false);
        this.emit('change');
      });
      this.hold(play, this.scene, true);
      this.emit('play');
    } catch (e) {
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
    const p = this.play!;
    if (p.loading) return; // 読み込みが終わってから進める
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
    if (p.recorder) await this.saveRecording(p.recorder.events, p.game.frame);
    if (p.edits.size) await this.askKeepEdits(p.edits);
  }

  private async saveRecording(events: InputEvent[], frames: number): Promise<void> {
    const name = `rec-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
    const path = `recordings/${name}.input.json`;
    const data = { seed: this.state.config.seed, scene: this.scene, frames, events };
    await this.api(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', raw: JSON.stringify(data, null, 2) + '\n' });
    toast(`入力を記録しました: ${path}\nAIは ages run --input ${path} で同じ操作を再現できます`);
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
          h('h3', {}, '実行中の変更を保存しますか？'),
          h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'チェックした値だけシーンに保存します。'),
          boxes.map((b) => b.row),
          h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
            h('button', { onclick: () => finish(false) }, '捨てる'),
            h('button', { class: 'on', onclick: () => finish(true) }, '保存する')));
      });
    });
  }

  /** 画面なしでの試し実行（カスタムウインドウ用）。keys は ages run --keys と同じ書き方（"0-600:@fire;100-200:ArrowLeft"） */
  simulate(frames: number, keys = '', seed?: number): { counts: Record<string, number>; frame: number; ms: number } {
    const game = new Game(this.registry, this.state.config, this.state.scenes[this.scene], seed ?? this.state.config.seed);
    const play = new InputPlayback(keysToEvents(keys, actionsFromRows(this.registry.tableView('actions').rows)));
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) game.step(play.at(game.frame));
    return { counts: Object.fromEntries(game.counts), frame: game.frame, ms: performance.now() - t0 };
  }
}
