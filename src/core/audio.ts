// 音の命令。ゲームのロジックは「何を鳴らすか」を決めるだけで、実際に鳴らすのはブラウザの側（src/audio/player.ts）。
// 画面なしの実行（ages run）でも同じ命令が出るので、AIは音を聞かずに「何が何回鳴ったか」を確かめられる。
//
// 音量の区分（バス）はプロジェクトが決める: AudioBus を付けたプレハブ1つが区分1つ（プレハブの名前が区分の名前）。
// 区分は親子にでき（親の音量も掛かる）、「同時に1つだけ」（普通のBGM）にもできる。区分を作らなければ、音はすべて全体の直下。

export const SOUND_EXT = ['.wav', '.mp3', '.ogg', '.m4a'];

export interface PlayCmd {
  t: 'play';
  frame: number;
  /** 鳴らした名前（プレハブ名か、ファイルの場所） */
  cue: string;
  clip: string;
  /** 区分の名前（AudioBus のプレハブ）。空なら全体の直下 */
  bus: string;
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
  /** 鳴っているこの音（名前か物のID）と、曲の中の位置をそろえて鳴らし始める（重ねるBGMに） */
  with?: string;
}

export interface StopCmd {
  t: 'stop';
  frame: number;
  /** 名前か、持ち主の物のID。省くと、ほかの条件に合うものすべて */
  target?: string;
  bus?: string;
  /** フェードの秒数（省くと、その音の fadeOut） */
  fade?: number;
}

/** 鳴っている音の音量を、時間をかけて変える（重ねたBGMの層を出し入れするなど） */
export interface FadeCmd {
  t: 'fade';
  frame: number;
  /** 名前か、持ち主の物のID */
  target: string;
  volume: number;
  sec: number;
}

export interface VolumeCmd {
  t: 'volume';
  frame: number;
  /** 区分の名前。空なら全体 */
  bus: string;
  value: number;
}

export type AudioCmd = PlayCmd | StopCmd | FadeCmd | VolumeCmd;

/** 区分の設定（AudioBus のプレハブから作る） */
export interface BusDef {
  volume: number;
  /** 親の区分の名前。空なら全体の直下 */
  parent: string;
  /** 同時に1つだけ鳴らす（新しい音を鳴らすと、今の音がフェードしながら切り替わる） */
  exclusive: boolean;
  /** この区分で同時に鳴らす数の上限（0 なら制限なし） */
  maxVoices: number;
}

/** ゲームのコードから使う音の命令（ctx.sound） */
export interface SoundApi {
  /**
   * 鳴らす。name は Sound の付いたプレハブの名前（例 'se_shot'）か、音のファイルの場所（例 'assets/se/shot.wav'。設定は既定）。
   * 間引き（cooldown）で鳴らさなかったとき・名前が見つからないときは false。
   * with: 鳴っている音（名前か物のID）と曲の中の位置をそろえて鳴らし始める（重ねるBGMの層を後から足すとき）
   * fadeIn: この回だけのフェードインの秒数（省くとその音の Sound.fadeIn）
   */
  play(name: string, opts?: { volume?: number; pitch?: number; pan?: number; with?: string; fadeIn?: number }): boolean;
  /** 止める。target は名前か持ち主の物のID。省くと全部。fade は秒（省くとその音の fadeOut） */
  stop(target?: string, fade?: number): void;
  /** 区分の音を全部止める */
  stopBus(bus: string, fade?: number): void;
  /** 鳴っている音の音量を、sec 秒かけて volume にする（target は名前か持ち主の物のID） */
  fade(target: string, volume: number, sec: number): void;
  /** 物に付いた Sound を鳴らす（その物が持ち主になり、stop(物のID) か、物が消えたときに止まる） */
  playFrom(entityId: string): boolean;
  /** 区分の音量を変える（0〜1。オプション画面などから）。bus が空なら全体 */
  volume(bus: string, value: number): void;
  /** 区分の今の音量（オプション画面の表示などに） */
  getVolume(bus: string): number;
}

export interface SoundSettings {
  clip: string;
  bus: string;
  volume: number;
  pitch: number;
  pitchJitter: number;
  pan: number;
  loop: boolean;
  playOnStart: boolean;
  fadeIn: number;
  fadeOut: number;
  maxVoices: number;
  cooldown: number;
}

export const DEFAULT_SOUND: SoundSettings = { clip: '', bus: '', volume: 1, pitch: 1, pitchJitter: 0, pan: 0, loop: false, playOnStart: false, fadeIn: 0, fadeOut: 0, maxVoices: 4, cooldown: 0 };

export function playCmd(frame: number, cue: string, s: SoundSettings, opts: { volume?: number; pitch?: number; pan?: number; with?: string; fadeIn?: number } = {}, owner?: string): PlayCmd {
  const cmd: PlayCmd = {
    t: 'play', frame, cue, clip: s.clip, bus: s.bus,
    volume: s.volume * (opts.volume ?? 1), pitch: s.pitch * (opts.pitch ?? 1), pitchJitter: s.pitchJitter, pan: opts.pan ?? s.pan,
    loop: s.loop, fadeIn: Math.max(0, opts.fadeIn ?? s.fadeIn), fadeOut: s.fadeOut, maxVoices: s.maxVoices,
  };
  if (owner) cmd.owner = owner;
  if (opts.with) cmd.with = opts.with;
  return cmd;
}

export const isSoundPath = (name: string) => name.includes('/') && SOUND_EXT.some((e) => name.toLowerCase().endsWith(e));
