// 音を実際に鳴らす側（ブラウザ専用。Web Audio）。ゲームのロジックが出した音の命令（core/audio.ts）を受けて鳴らす。
// - 区分（se / bgm / voice / ui）ごとの音量、全体の音量
// - 同時に鳴らす数の上限（音ごと・全体。超えたら古いものから止める）
// - BGM は1曲だけ。新しい曲はフェードで切り替わる（同じ曲ならそのまま）
// - 高さのばらつきは見た目・聞こえ方だけのものなので、ゲームの乱数は使わない
import type { AudioCmd, Bus, PlayCmd, StopCmd } from '../core/audio.ts';

interface Voice {
  cue: string;
  owner?: string;
  bus: Bus;
  src: AudioBufferSourceNode;
  gain: GainNode;
  volume: number;
  fadeOut: number;
  started: number;
  stopping: boolean;
}

export interface Mix {
  master: number;
  bgm: number;
  se: number;
  voice: number;
  ui: number;
  maxVoices: number;
}

const BUS_LIST: Bus[] = ['se', 'bgm', 'voice', 'ui'];

export class AudioPlayer {
  private ac: AudioContext | null = null;
  private out!: GainNode;
  private master!: GainNode;
  private buses = {} as Record<Bus, GainNode>;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private voices: Voice[] = [];
  private music: Voice | null = null;
  /** 読み込み中に止められた音を鳴らさないための番号 */
  private epoch = 0;
  private pendingStops: { cmd: StopCmd; epoch: number }[] = [];
  mix: Mix = { master: 1, bgm: 1, se: 1, voice: 1, ui: 1, maxVoices: 32 };
  /** エディタの手元の音量（プロジェクトには保存しない） */
  local = 1;
  muted = false;
  /** 読み込めなかったファイル */
  errors = new Set<string>();
  readonly urlOf: (path: string) => string;

  constructor(urlOf: (path: string) => string) {
    this.urlOf = urlOf;
  }

  /** 音を出す準備（ブラウザの決まりで、クリックなど人の操作の中で最初に呼ぶ） */
  ensure(): AudioContext {
    if (this.ac) { if (this.ac.state === 'suspended') void this.ac.resume(); return this.ac; }
    const ac = new AudioContext();
    this.ac = ac;
    this.out = ac.createGain();
    this.out.connect(ac.destination);
    this.master = ac.createGain();
    this.master.connect(this.out);
    for (const b of BUS_LIST) { this.buses[b] = ac.createGain(); this.buses[b].connect(this.master); }
    this.apply();
    return ac;
  }

  get ready(): boolean { return !!this.ac; }

  /** 先に読み込んでおく（鳴らすときの遅れをなくす） */
  preload(paths: string[]): void {
    if (!this.ac) return;
    for (const p of paths) void this.load(p);
  }

  /** ファイルが変わったら読み直す */
  invalidate(path?: string): void {
    for (const k of [...this.buffers.keys()]) if (!path || k === path) this.buffers.delete(k);
  }

  private load(path: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(path);
    if (!p) {
      p = fetch(this.urlOf(path))
        .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.arrayBuffer(); })
        .then((b) => this.ensure().decodeAudioData(b))
        .catch(() => { this.errors.add(path); return null; });
      this.buffers.set(path, p);
    }
    return p;
  }

  setMix(m: Partial<Mix>): void {
    let changed = false;
    for (const k of Object.keys(this.mix) as (keyof Mix)[]) if (m[k] !== undefined && m[k] !== this.mix[k]) { this.mix[k] = m[k]!; changed = true; }
    if (changed) this.apply();
  }

  setLocal(volume: number, muted: boolean): void {
    this.local = volume;
    this.muted = muted;
    this.apply();
  }

  private apply(): void {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    this.out.gain.setTargetAtTime(this.muted ? 0 : this.local, t, 0.01);
    this.master.gain.setTargetAtTime(this.mix.master, t, 0.01);
    for (const b of BUS_LIST) this.buses[b].gain.setTargetAtTime(this.mix[b], t, 0.01);
  }

  handle(cmd: AudioCmd): void {
    if (!this.ac) return;
    if (cmd.t === 'play') void this.play(cmd);
    else if (cmd.t === 'stop') { this.stop(cmd); this.pendingStops.push({ cmd, epoch: this.epoch }); }
    else { this.mix[cmd.bus] = cmd.value; this.apply(); }
  }

  private async play(cmd: PlayCmd): Promise<void> {
    const ac = this.ensure();
    if (cmd.bus === 'bgm' && this.music?.cue === cmd.cue && !this.music.stopping) return; // 同じ曲はそのまま
    const asked = ac.currentTime;
    const epoch = ++this.epoch;
    const buf = await this.load(cmd.clip);
    if (!buf) return;
    // 読み込みを待つ間に止められていたら鳴らさない。効果音は遅れすぎたら鳴らさない
    if (this.pendingStops.some((s) => s.epoch < epoch && matches(s.cmd, cmd))) return;
    if (!cmd.loop && cmd.bus !== 'bgm' && ac.currentTime - asked > 0.25) return;
    this.pendingStops = this.pendingStops.filter((s) => ac.currentTime - asked < 5 || s.epoch >= epoch);
    // 同時に鳴らす数: この音と、全体
    const same = this.voices.filter((v) => v.cue === cmd.cue && !v.stopping && v !== this.music);
    if (same.length >= cmd.maxVoices) this.fade(same[0], 0.02);
    const alive = this.voices.filter((v) => !v.stopping && v !== this.music);
    if (alive.length >= this.mix.maxVoices) this.fade(alive[0], 0.02);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = cmd.loop || cmd.bus === 'bgm' && cmd.loop;
    const jitter = cmd.pitchJitter ? (Math.random() * 2 - 1) * cmd.pitchJitter : 0;
    src.playbackRate.value = Math.max(0.05, cmd.pitch * (1 + jitter));
    const gain = ac.createGain();
    const t = ac.currentTime;
    if (cmd.fadeIn > 0) { gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(cmd.volume, t + cmd.fadeIn); }
    else gain.gain.value = cmd.volume;
    let node: AudioNode = src;
    if (cmd.pan) { const p = ac.createStereoPanner(); p.pan.value = cmd.pan; src.connect(p); node = p; }
    node.connect(gain);
    gain.connect(this.buses[cmd.bus]);
    const v: Voice = { cue: cmd.cue, owner: cmd.owner, bus: cmd.bus, src, gain, volume: cmd.volume, fadeOut: cmd.fadeOut, started: t, stopping: false };
    src.onended = () => { this.voices = this.voices.filter((x) => x !== v); if (this.music === v) this.music = null; };
    if (cmd.bus === 'bgm') {
      // 曲の切り替え: 今の曲を、その曲の fadeOut でフェードアウト
      if (this.music) this.fade(this.music, this.music.fadeOut);
      this.music = v;
    }
    this.voices.push(v);
    src.start();
  }

  stop(cmd: StopCmd): void {
    for (const v of this.voices) if (!v.stopping && matches(cmd, v)) this.fade(v, cmd.fade ?? v.fadeOut);
  }

  private fade(v: Voice, sec: number): void {
    if (!this.ac || v.stopping) return;
    v.stopping = true;
    const t = this.ac.currentTime;
    const end = t + Math.max(0.01, sec);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, end);
    try { v.src.stop(end + 0.02); } catch { /* すでに止まっている */ }
    if (this.music === v) this.music = null;
  }

  /** 全部止める（再生をやめたとき） */
  stopAll(fade = 0.05): void {
    this.epoch++;
    for (const v of this.voices) this.fade(v, fade);
    this.pendingStops = [];
    this.music = null;
  }

  suspend(): void { void this.ac?.suspend(); }
  resume(): void { void this.ac?.resume(); }

  /** 鳴っている音（エディタの表示用） */
  playing(): { cue: string; bus: Bus }[] {
    return this.voices.filter((v) => !v.stopping).map((v) => ({ cue: v.cue, bus: v.bus }));
  }
}

function matches(stop: StopCmd, v: { cue: string; owner?: string; bus: Bus }): boolean {
  if (stop.cue && stop.cue !== v.cue) return false;
  if (stop.owner && stop.owner !== v.owner) return false;
  if (stop.bus && stop.bus !== v.bus) return false;
  return true;
}
