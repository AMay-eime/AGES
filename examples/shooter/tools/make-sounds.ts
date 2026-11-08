// サンプル用の仮の音を作る（依存ゼロ。外の素材を使わないので、使い方の決まりを気にしなくてよい）。
// 実行: node examples/shooter/tools/make-sounds.ts   → assets/sounds/ に WAV を書き出す
// 本物のゲームでは、音は人が決める（手触りの一部）。これはエンジンの動作確認用の仮の音。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const RATE = 22050;
const OUT = new URL('../assets/sounds/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** WAV に書く（mono。bits 16 か 8） */
function wav(name: string, samples: Float32Array, bits: 8 | 16 = 16): void {
  const bytes = bits / 8;
  const data = Buffer.alloc(samples.length * bytes);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    if (bits === 16) data.writeInt16LE(Math.round(v * 32767), i * 2);
    else data[i] = Math.round(v * 127 + 128);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * bytes, 28); h.writeUInt16LE(bytes, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(join(OUT, name), Buffer.concat([h, data]));
}

let seed = 12345;
const noise = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2147483648) - 1;
const square = (ph: number, duty = 0.5) => (ph % 1 < duty ? 1 : -1);
const tri = (ph: number) => 1 - 4 * Math.abs((ph % 1) - 0.5);

// 弾: 高い音から下がる短い矩形波
{
  const n = Math.round(RATE * 0.09);
  const s = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    ph += (1200 - 900 * t) / RATE;
    s[i] = square(ph, 0.25) * (1 - t) * 0.45;
  }
  wav('shot.wav', s);
}

// 爆発: だんだんこもる雑音と、低い響き
{
  const n = Math.round(RATE * 0.6);
  const s = new Float32Array(n);
  let lp = 0, ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const k = 0.5 * (1 - t) + 0.03;
    lp += (noise() - lp) * k;
    ph += (70 - 40 * t) / RATE;
    s[i] = (lp * 1.6 + Math.sin(ph * Math.PI * 2) * 0.5 * (1 - t)) * Math.exp(-4 * t) * 0.8;
  }
  wav('explosion.wav', s);
}

// 被弾: 低く下がる音と雑音
{
  const n = Math.round(RATE * 0.28);
  const s = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    ph += (220 - 160 * t) / RATE;
    s[i] = (square(ph) * 0.5 + noise() * 0.35) * (1 - t) * 0.7;
  }
  wav('hit.wav', s);
}

// BGM: 4小節の繰り返し（Am - F - C - G、150BPM の8分音符）
{
  const step = 60 / 150 / 2; // 8分音符の秒数
  const steps = 32;
  const n = Math.round(RATE * step * steps);
  const s = new Float32Array(n);
  const hz = (m: number) => 440 * 2 ** ((m - 69) / 12); // MIDI の音の番号 → 周波数
  const bass = [45, 41, 48, 43]; // A2 F2 C3 G2
  const chord = [[69, 72, 76], [65, 69, 72], [72, 76, 79], [67, 71, 74]];
  const melody = [
    [76, 0, 76, 74, 72, 0, 74, 76], [77, 0, 76, 74, 72, 0, 69, 0],
    [79, 0, 76, 72, 74, 0, 76, 79], [74, 0, 71, 67, 69, 0, 71, 74],
  ];
  const note = (start: number, len: number, f: number, wave: (ph: number) => number, vol: number) => {
    const a = Math.round(start * RATE), b = Math.min(n, Math.round((start + len) * RATE));
    let ph = 0;
    for (let i = a; i < b; i++) {
      const t = (i - a) / RATE, rest = (b - i) / RATE;
      const env = Math.min(1, t / 0.005) * Math.min(1, rest / 0.01) * (0.6 + 0.4 * Math.exp(-t * 8));
      ph += f / RATE;
      s[i] += wave(ph) * env * vol;
    }
  };
  for (let i = 0; i < steps; i++) {
    const bar = Math.floor(i / 8), k = i % 8, t = i * step;
    note(t, step * 0.9, hz(bass[bar] + (k % 2 ? 12 : 0)), tri, 0.32);
    note(t, step * 0.5, hz(chord[bar][k % 3] + 12), (ph) => square(ph, 0.125), 0.06);
    const m = melody[bar][k];
    if (m) note(t, step * (melody[bar][k + 1] === 0 ? 1.8 : 0.85), hz(m), (ph) => square(ph, 0.25), 0.13);
  }
  wav('bgm.wav', s, 8);
}

console.log(`書き出しました: ${OUT}`);
