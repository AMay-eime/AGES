// エディタの中心。状態の読み込み、サーバーとのやりとり、再生（プレイモード）を受け持つ。
import { Registry, type GameModule } from '../core/registry.ts';
import { Game, busesOf } from '../core/game.ts';
import { InputRecorder, InputPlayback, type InputEvent } from '../core/input.ts';
import type { PrefabDoc, ProjectConfig, SceneDoc } from '../core/docs.ts';
import type { Op, Change } from '../core/patch.ts';
import { modal, toast, h } from './ui/dom.ts';
import { AudioPlayer } from '../audio/player.ts';
import { DEFAULT_SOUND, playCmd, type SoundSettings } from '../core/audio.ts';

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
  assets: { path: string; kind: 'image' | 'sound' | 'font'; bytes: number; w?: number; h?: number; sec?: number }[];
  error?: string;
}

export type Selection = { kind: 'scene'; scene: string; id: string } | { kind: 'prefab'; name: string } | null;

export interface PlayState {
  game: Game;
  paused: boolean;
  /** 実行中にインスペクタで変えた値（停止時に保存するか選ぶ） */
  edits: Map<string, unknown>;
  recorder?: InputRecorder;
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
  keys = new Set<string>();
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
    if (!res.ok || data?.error) throw new Error(data?.error ?? res.statusText);
    return data;
  }

  setUser(name: string): void {
    this.user = name.trim() || 'human';
    localStorage.setItem('ages.user', this.user);
  }

  async refresh(): Promise<void> {
    const s = await this.api<EditorState>('/api/state');
    this.state = s;
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
      this.registry.sheets = new Map(Object.entries(s.sheets ?? {}));
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
      const r = await this.api<{ changes: Change[] }>('/api/patch', { body: { ops, win } });
      await this.refresh();
      return r.changes;
    } catch (e) {
      toast((e as Error).message, 'bad', 6000);
      await this.refresh();
      return null;
    }
  }

  async setLock(paths: string[], locked: boolean, note?: string, win = 'inspector'): Promise<void> {
    try {
      await this.api(locked ? '/api/lock' : '/api/unlock', { body: { paths, note, win } });
      await this.refresh();
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
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
      // 音: 再生ボタンのクリックの中で準備する（ブラウザの決まり）。音のファイルは先に読み込んでおく
      this.audio.ensure();
      const l = this.localAudio;
      this.audio.setLocal(l.volume, l.muted);
      this.audio.preload(this.state.assets.filter((a) => a.kind === 'sound').map((a) => a.path));
      this.audio.resume();
      this.audio.setBuses(game.audioBuses());
      game.audioListeners.push((cmd) => this.audio.handle(cmd));
      this.play = { game, paused: false, edits: new Map(), recorder: record ? new InputRecorder() : undefined };
      this.emit('play');
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
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
    try {
      p.recorder?.record(p.game.frame, this.keys);
      p.game.step(this.keys);
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
    this.keys.clear();
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

  /** 画面なしでの試し実行（カスタムウインドウ用）。keys は "0-600:KeyZ;100-200:ArrowLeft" の形 */
  simulate(frames: number, keys = '', seed?: number): { counts: Record<string, number>; frame: number; ms: number } {
    const game = new Game(this.registry, this.state.config, this.state.scenes[this.scene], seed ?? this.state.config.seed);
    const play = new InputPlayback(parseKeys(keys));
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) game.step(play.keysAt(game.frame));
    return { counts: Object.fromEntries(game.counts), frame: game.frame, ms: performance.now() - t0 };
  }
}

function parseKeys(spec: string): InputEvent[] {
  const ev: InputEvent[] = [];
  for (const seg of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = seg.match(/^(\d+)-(\d+):(.+)$/);
    if (!m) throw new Error(`keys の書き方が違います: ${seg}`);
    const keys = m[3].split('+');
    ev.push({ f: Number(m[1]), d: keys }, { f: Number(m[2]), u: keys });
  }
  return ev.sort((a, b) => a.f - b.f);
}
