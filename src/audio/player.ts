// 音を実際に鳴らす側（ブラウザ専用。Web Audio）。ゲームのロジックが出した音の命令（core/audio.ts）を受けて鳴らす。
// - 音量の区分（AudioBus のプレハブ）を親子どおりにつなぐ。区分ごとの音量・同時に鳴らす数・「同時に1つだけ」
// - 同じフレームに出た音は同じ瞬間に鳴らし始める（重ねるBGMの層がずれない）。with で鳴っている曲と位置をそろえられる
// - 同時に鳴らす数の上限（音ごと・区分ごと・全体。超えたら古いものから止める）
// - 高さのばらつきは聞こえ方だけのものなので、ゲームの乱数は使わない
import type { AudioCmd, BusDef, PlayCmd, StopCmd } from '../core/audio.ts';

interface Voice {
  cue: string;
  owner?: string;
  bus: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  fadeOut: number;
  /** 鳴らし始めた時刻と、そのときの曲の中の位置（with で位置をそろえるため） */
  started: number;
  offset: number;
  rate: number;
  duration: number;
  stopping: boolean;
}

/** 全体で同時に鳴らす数の上限（技術的な上限。区分ごとの上限は AudioBus で決める） */
const MAX_VOICES = 64;

export class AudioPlayer {
  private ac: AudioContext | null = null;
  private out!: GainNode;
  private master!: GainNode;
  private busNodes = new Map<string, GainNode>();
  private buses: Record<string, BusDef> = {};
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private voices: Voice[] = [];
  /** 読み込み中に止められた音を鳴らさないための番号 */
  private epoch = 0;
  private pendingStops: { cmd: StopCmd; epoch: number }[] = [];
  /** 同じフレームの音を同じ瞬間に鳴らすための、フレームごとの開始時刻 */
  private frameTime = new Map<number, number>();
  /** エディタの手元の音量（プロジェクトには保存しない） */
  local = 1;
  muted = false;
  /** ゲームの中で変えた全体の音量 */
  masterVolume = 1;
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
    this.rebuildBuses();
    this.applyLocal();
    return ac;
  }

  get ready(): boolean { return !!this.ac; }

  /** 先に読み込んでおく（鳴らすときの遅れをなくし、重ねる曲をそろえて鳴らせるように） */
  /** 音のファイルを先に読み込む（読み込み終わるか、読めなかったら終わる） */
  preload(paths: string[]): Promise<void> {
    if (!this.ac) return Promise.resolve();
    return Promise.all(paths.map((p) => this.load(p))).then(() => {});
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

  /** 音量の区分を決める（再生を始めるとき・区分の設定が変わったとき） */
  setBuses(defs: Record<string, BusDef>): void {
    const same = JSON.stringify(defs) === JSON.stringify(this.buses);
    this.buses = structuredClone(defs);
    if (!same) this.rebuildBuses();
  }

  private rebuildBuses(): void {
    if (!this.ac) return;
    // 今ある区分のつなぎ方を、親子どおりに作り直す（鳴っている音はつなぎ直す）
    for (const [name, def] of Object.entries(this.buses)) {
      let n = this.busNodes.get(name);
      if (!n) { n = this.ac.createGain(); this.busNodes.set(name, n); }
      n.gain.value = def.volume;
      n.disconnect();
    }
    for (const [name, def] of Object.entries(this.buses)) this.busNodes.get(name)!.connect(this.nodeOf(def.parent));
    for (const v of this.voices) { v.gain.disconnect(); v.gain.connect(this.nodeOf(v.bus)); }
  }

  /** 区分の入り口（ない区分・空は全体） */
  private nodeOf(bus: string): AudioNode {
    return (bus && this.busNodes.get(bus)) || this.master;
  }

  setLocal(volume: number, muted: boolean): void {
    this.local = volume;
    this.muted = muted;
    this.applyLocal();
  }

  private applyLocal(): void {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    this.out.gain.setTargetAtTime(this.muted ? 0 : this.local, t, 0.01);
    this.master.gain.setTargetAtTime(this.masterVolume, t, 0.01);
  }

  handle(cmd: AudioCmd): void {
    if (!this.ac) return;
    switch (cmd.t) {
      case 'play': void this.play(cmd); break;
      case 'stop': this.stop(cmd); this.pendingStops.push({ cmd, epoch: this.epoch }); break;
      case 'fade': {
        const t = this.ac.currentTime;
        for (const v of this.voices) if (!v.stopping && (v.cue === cmd.target || v.owner === cmd.target)) {
          v.gain.gain.cancelScheduledValues(t);
          v.gain.gain.setValueAtTime(v.gain.gain.value, t);
          v.gain.gain.linearRampToValueAtTime(cmd.volume, t + Math.max(0.01, cmd.sec));
        }
        break;
      }
      case 'volume': {
        if (!cmd.bus) { this.masterVolume = cmd.value; this.applyLocal(); break; }
        if (this.buses[cmd.bus]) this.buses[cmd.bus].volume = cmd.value;
        this.busNodes.get(cmd.bus)?.gain.setTargetAtTime(cmd.value, this.ac.currentTime, 0.01);
        break;
      }
    }
  }

  private async play(cmd: PlayCmd): Promise<void> {
    const ac = this.ensure();
    const bus = this.buses[cmd.bus];
    // 「同時に1つだけ」の区分で、同じ音がもう鳴っていればそのまま（シーンを行き来しても曲が頭から鳴り直さない）
    if (bus?.exclusive && this.voices.some((v) => v.bus === cmd.bus && v.cue === cmd.cue && !v.stopping)) return;
    const asked = ac.currentTime;
    const epoch = ++this.epoch;
    // 同じフレームの音は同じ瞬間に（少し先に予約する）
    let when = this.frameTime.get(cmd.frame);
    if (when === undefined || when < ac.currentTime) { when = ac.currentTime + 0.03; this.frameTime.set(cmd.frame, when); }
    if (this.frameTime.size > 120) this.frameTime.delete(this.frameTime.keys().next().value!);
    const buf = await this.load(cmd.clip);
    if (!buf) return;
    // 読み込みを待つ間に止められていたら鳴らさない。効果音は遅れすぎたら鳴らさない
    if (this.pendingStops.some((s) => s.epoch < epoch && matches(s.cmd, cmd))) return;
    if (!cmd.loop && ac.currentTime - asked > 0.25) return;
    this.pendingStops = this.pendingStops.filter((s) => s.epoch >= epoch - 64);
    if (when < ac.currentTime) when = ac.currentTime;
    // 同時に鳴らす数: この音、この区分、全体
    const alive = () => this.voices.filter((v) => !v.stopping);
    const same = alive().filter((v) => v.cue === cmd.cue);
    if (same.length >= cmd.maxVoices) this.fade(same[0], 0.02);
    if (bus?.maxVoices) { const inBus = alive().filter((v) => v.bus === cmd.bus); if (inBus.length >= bus.maxVoices) this.fade(inBus[0], 0.02); }
    if (alive().length >= MAX_VOICES) this.fade(alive()[0], 0.02);
    // 「同時に1つだけ」: 今鳴っている音を、その音の fadeOut で消しながら切り替える
    if (bus?.exclusive) for (const v of alive()) if (v.bus === cmd.bus) this.fade(v, v.fadeOut);

    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = cmd.loop;
    const jitter = cmd.pitchJitter ? (Math.random() * 2 - 1) * cmd.pitchJitter : 0;
    const rate = Math.max(0.05, cmd.pitch * (1 + jitter));
    src.playbackRate.value = rate;
    const gain = ac.createGain();
    if (cmd.fadeIn > 0) { gain.gain.setValueAtTime(0, when); gain.gain.linearRampToValueAtTime(cmd.volume, when + cmd.fadeIn); }
    else gain.gain.setValueAtTime(cmd.volume, when);
    let node: AudioNode = src;
    if (cmd.pan) { const p = ac.createStereoPanner(); p.pan.value = cmd.pan; src.connect(p); node = p; }
    node.connect(gain);
    gain.connect(this.nodeOf(cmd.bus));
    // with: 鳴っている曲と、曲の中の位置をそろえる
    let offset = 0;
    if (cmd.with) {
      const base = this.voices.find((v) => !v.stopping && (v.cue === cmd.with || v.owner === cmd.with));
      if (base) offset = ((base.offset + (when - base.started) * base.rate) % base.duration) % buf.duration;
    }
    const v: Voice = { cue: cmd.cue, owner: cmd.owner, bus: cmd.bus, src, gain, fadeOut: cmd.fadeOut, started: when, offset, rate, duration: buf.duration, stopping: false };
    src.onended = () => { this.voices = this.voices.filter((x) => x !== v); };
    this.voices.push(v);
    src.start(when, offset);
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
  }

  /** 全部止める（再生をやめたとき） */
  stopAll(fade = 0.05): void {
    this.epoch++;
    for (const v of this.voices) this.fade(v, fade);
    this.pendingStops = [];
    this.masterVolume = 1;
    this.applyLocal();
  }

  suspend(): void { void this.ac?.suspend(); }
  resume(): void { void this.ac?.resume(); }

  /** 鳴っている音（エディタの表示用） */
  playing(): { cue: string; bus: string; volume: number }[] {
    return this.voices.filter((v) => !v.stopping).map((v) => ({ cue: v.cue, bus: v.bus, volume: Math.round(v.gain.gain.value * 100) / 100 }));
  }
}

function matches(stop: StopCmd, v: { cue: string; owner?: string; bus: string }): boolean {
  if (stop.target && stop.target !== v.cue && stop.target !== v.owner) return false;
  if (stop.bus !== undefined && stop.bus !== v.bus) return false;
  return true;
}
