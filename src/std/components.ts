// 標準のコンポーネント。どのプロジェクトでも最初から使える（game/index.ts で定義しなくてよい）。
// 同じ名前をプロジェクトで定義するとエラーになる（どちらが使われるか迷わないように）。
import { defineComponent } from '../core/schema.ts';

export const Transform = defineComponent({
  name: 'Transform',
  desc: '位置・向き・大きさ（標準）',
  fields: {
    x: { type: 'number', default: 0, desc: '横位置(px)' },
    y: { type: 'number', default: 0, desc: '縦位置(px。下向きが正)' },
    rot: { type: 'number', default: 0, min: -360, max: 360, desc: '回転(度。時計回りが正)' },
    sx: { type: 'number', default: 1, min: -20, max: 20, step: 0.05, desc: '横の倍率' },
    sy: { type: 'number', default: 1, min: -20, max: 20, step: 0.05, desc: '縦の倍率' },
  },
});

const drawOrder = {
  layer: { type: 'int', default: 0, min: -100, max: 100, desc: '描く層。大きいほど手前' },
  order: { type: 'int', default: 0, min: -10000, max: 10000, desc: '同じ層の中の順番。大きいほど手前' },
  visible: { type: 'bool', default: true, desc: '表示するか' },
} as const;

export const Sprite = defineComponent({
  name: 'Sprite',
  desc: '画像を描く（標準）。スプライトシートなら frame でコマを選ぶ',
  fields: {
    image: { type: 'asset', kind: 'image', default: '', desc: '画像ファイル（例: assets/ship.png）' },
    frame: { type: 'int', default: 0, min: 0, max: 100000, desc: 'スプライトシートのコマ番号（左上から右へ、0から）' },
    size: { type: 'vec2', default: [0, 0], desc: '表示する大きさ [幅, 高さ](px)。0なら画像（コマ）の大きさ' },
    anchor: { type: 'vec2', default: [0.5, 0.5], desc: '位置の基準点。[0,0]=左上、[0.5,0.5]=中央' },
    tint: { type: 'color', default: '#ffffff', desc: '色をかける（白なら元の色）' },
    alpha: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, desc: '不透明度' },
    flipX: { type: 'bool', default: false, desc: '左右反転' },
    flipY: { type: 'bool', default: false, desc: '上下反転' },
    blend: { type: 'enum', options: ['normal', 'add', 'multiply', 'screen'], default: 'normal', desc: '重ね方。add=光る（加算）' },
    ...drawOrder,
  },
});

export const Animator = defineComponent({
  name: 'Animator',
  desc: 'スプライトシートの名前付きアニメーションを再生する（標準。Sprite と一緒に使う）',
  fields: {
    clip: { type: 'string', default: '', desc: '再生するアニメーションの名前（シートの clips の名前）' },
    speed: { type: 'number', default: 1, min: 0, max: 10, step: 0.05, desc: '再生の速さの倍率' },
    destroyOnEnd: { type: 'bool', default: false, desc: '繰り返さないアニメーションが終わったら消す（爆発などに）' },
    time: { type: 'number', default: 0, min: 0, desc: '再生位置(秒。自動で変化)' },
    current: { type: 'string', default: '', desc: 'いま再生しているアニメーション（自動で変化。clip を変えると最初から再生し直す）' },
    playing: { type: 'bool', default: true, desc: '再生中か（終わると false。自動で変化）' },
  },
});

export const Shape = defineComponent({
  name: 'Shape',
  desc: '単色の図形を描く（標準。試作や当たり判定の確認に）',
  fields: {
    kind: { type: 'enum', options: ['rect', 'circle'], default: 'rect', desc: '形' },
    w: { type: 'number', default: 16, min: 0, max: 4096, desc: '幅(px)' },
    h: { type: 'number', default: 16, min: 0, max: 4096, desc: '高さ(px)' },
    color: { type: 'color', default: '#ffffff', desc: '色' },
    alpha: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, desc: '不透明度' },
    ...drawOrder,
  },
});

export const Text = defineComponent({
  name: 'Text',
  desc: '文字を描く（標準）',
  fields: {
    text: { type: 'string', default: '', desc: '表示する文字' },
    size: { type: 'number', default: 16, min: 4, max: 256, desc: '文字の大きさ(px)' },
    color: { type: 'color', default: '#ffffff', desc: '色' },
    align: { type: 'enum', options: ['left', 'center', 'right'], default: 'left', desc: '揃え（位置が左端・中央・右端になる）' },
    font: { type: 'asset', kind: 'font', default: '', desc: 'フォントファイル（空なら標準のフォント）' },
    ...drawOrder,
  },
});

export const STD_COMPONENTS = [Transform, Sprite, Animator, Shape, Text];
