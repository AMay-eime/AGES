// collect3d のコンポーネント。数字（速さ・跳ぶ強さ・重さ）はエディタで人が決める
import { defineComponent } from 'ages';

export const Player = defineComponent({
  name: 'Player',
  desc: '操作するキャラクター。歩く・跳ぶ・落ちる（物理は本体にないので、systems.ts の playerMove が書いている）',
  fields: {
    speed: { type: 'number', default: 4.5, min: 0, max: 20, step: 0.1, desc: '歩く速さ（m/秒）' },
    jump: { type: 'number', default: 7.5, min: 0, max: 30, step: 0.1, desc: '跳ぶ強さ（上向きの速さ m/秒。7.5 で約 1.4m 跳ぶ）' },
    gravity: { type: 'number', default: 20, min: 0, max: 100, step: 0.5, desc: '落ちる強さ（m/秒²。大きいほど重い）' },
    turn: { type: 'number', default: 720, min: 0, max: 3600, step: 10, desc: '向きを変える速さ（度/秒）' },
    fallY: { type: 'number', default: -6, min: -100, max: 0, desc: 'この高さより下に落ちたら、始めの場所に戻る' },
    start: { type: 'vec3', default: [0, 0.5, 0], desc: '始めの場所（落ちたら戻る場所）' },
    vy: { type: 'number', default: 0, desc: '上下の速さ（自動で変化）' },
    grounded: { type: 'bool', default: false, desc: '地面に立っているか（自動で変化）' },
    coins: { type: 'int', default: 0, min: 0, desc: '集めたコインの数（自動で変化）' },
  },
});

export const Spin = defineComponent({
  name: 'Spin',
  desc: 'その場で回り続ける（コイン）',
  fields: {
    speed: { type: 'number', default: 180, min: -1440, max: 1440, step: 10, desc: '回る速さ（度/秒）' },
  },
});
