// 音の命令。ゲームのロジックは「何を鳴らすか」を決めるだけで、実際に鳴らすのはブラウザの側（src/audio/player.ts）。
// 画面なしの実行（ages run）でも同じ命令が出るので、AIは音を聞かずに「何が何回鳴ったか」を確かめられる。

/** 音量の区分。bgm は同時に1曲だけ（新しい曲を鳴らすと切り替わる） */
export type Bus = 'se' | 'bgm' | 'voice' | 'ui';
export const BUSES: Bus[] = ['se', 'bgm', 'voice', 'ui'];
export const SOUND_EXT = ['.wav', '.mp3', '.ogg', '.m4a'];

export interface PlayCmd {
  t: 'play';
  frame: number;
  /** 鳴らした名前（プレハブ名か、ファイルの場所） */
  cue: string;
  clip: string;
  bus: Bus;
  volume: number;
  pitch: number;
  pitchJitter: number;
  pan: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
  maxVoices: number;
  /** この音を鳴らしている物（消えたら止める） */
  owner?: string;
}

export interface StopCmd {
  t: 'stop';
  frame: number;
  /** 省くと、ほかの条件に合うものすべて */
  cue?: string;
  owner?: string;
  bus?: Bus;
  /** フェードの秒数（省くと、その音の fadeOut） */
  fade?: number;
}

export interface VolumeCmd {
  t: 'volume';
  frame: number;
  bus: Bus | 'master';
  value: number;
}

export type AudioCmd = PlayCmd | StopCmd | VolumeCmd;

/** ゲームのコードから使う音の命令（ctx.sound） */
export interface SoundApi {
  /**
   * 鳴らす。name は Sound の付いたプレハブの名前（例 'shot'）か、音のファイルの場所（例 'assets/se/shot.wav'。設定は既定）。
   * bgm の区分の音は、今の曲から切り替わる。間引き（cooldown）で鳴らさなかったとき・名前が見つからないときは false
   */
  play(name: string, opts?: { volume?: number; pitch?: number; pan?: number }): boolean;
  /** 止める。name を省くと全部。fade は秒（省くとその音の fadeOut） */
  stop(name?: string, fade?: number): void;
  /** BGM を止める */
  stopMusic(fade?: number): void;
  /** 物に付いた Sound を鳴らす（その物が持ち主になり、stopFrom か、物が消えたときに止まる） */
  playFrom(entityId: string): boolean;
  /** 物が鳴らしている音を止める */
  stopFrom(entityId: string, fade?: number): void;
  /** 区分の音量を変える（0〜1。オプション画面などから。シーンの Mixer の値が変わる） */
  volume(bus: Bus | 'master', value: number): void;
}

export interface SoundSettings {
  clip: string;
  bus: Bus;
  volume: number;
  pitch: number;
  pitchJitter: number;
  pan: number;
  loop: boolean;
  autoplay: boolean;
  fadeIn: number;
  fadeOut: number;
  maxVoices: number;
  cooldown: number;
}

export const DEFAULT_SOUND: SoundSettings = { clip: '', bus: 'se', volume: 1, pitch: 1, pitchJitter: 0, pan: 0, loop: false, autoplay: false, fadeIn: 0, fadeOut: 0, maxVoices: 4, cooldown: 0 };

export function playCmd(frame: number, cue: string, s: SoundSettings, opts: { volume?: number; pitch?: number; pan?: number } = {}, owner?: string): PlayCmd {
  const cmd: PlayCmd = {
    t: 'play', frame, cue, clip: s.clip, bus: s.bus,
    volume: s.volume * (opts.volume ?? 1), pitch: s.pitch * (opts.pitch ?? 1), pitchJitter: s.pitchJitter, pan: opts.pan ?? s.pan,
    loop: s.loop, fadeIn: s.fadeIn, fadeOut: s.fadeOut, maxVoices: s.maxVoices,
  };
  if (owner) cmd.owner = owner;
  return cmd;
}

export const isSoundPath = (name: string) => name.includes('/') && SOUND_EXT.some((e) => name.toLowerCase().endsWith(e));
