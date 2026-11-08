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
    frame: { type: 'frame', default: 0, desc: 'スプライトシートのコマ。番号（0から）か名前。名前なら切り直してもずれない' },
    size: { type: 'vec2', default: [0, 0], desc: '表示する大きさ [幅, 高さ](px)。0なら画像（コマ）の大きさ' },
    anchor: { type: 'vec2', default: [0.5, 0.5], desc: '位置の基準点。[0,0]=左上、[0.5,0.5]=中央。シートのコマに基準点（pivot）があればそちらを使う' },
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

export const Camera = defineComponent({
  name: 'Camera',
  desc: 'カメラ（標準）。見る位置と回転は Transform。1つも置かなければ、画面全体をそのまま映す',
  fields: {
    enabled: { type: 'bool', default: true, desc: '使うか' },
    zoom: { type: 'number', default: 1, min: 0.05, max: 20, step: 0.05, desc: '拡大率（2 = 2倍に大きく見える）' },
    follow: { type: 'ref', default: null, desc: '追いかける相手のID（null なら動かない）' },
    offset: { type: 'vec2', default: [0, 0], desc: '追いかけるとき、相手からずらす量(px)' },
    lag: { type: 'number', default: 0, min: 0, max: 0.99, step: 0.01, desc: '追いかける遅れ（0 = ぴったり、0.9 = ゆっくり）' },
    deadzone: { type: 'vec2', default: [0, 0], desc: '相手が中心からこの範囲（幅・高さの半分, px）にいる間は動かない' },
    limit: { type: 'bool', default: false, desc: '見せる範囲を limitMin〜limitMax の四角の中に収める（ワールドの端を見せない）' },
    limitMin: { type: 'vec2', default: [0, 0], desc: '見せてよい範囲の左上（ワールドの座標）' },
    limitMax: { type: 'vec2', default: [0, 0], desc: '見せてよい範囲の右下（ワールドの座標）' },
    shakeMax: { type: 'number', default: 12, min: 0, max: 200, desc: '揺れの最大(px)。ctx.shake(強さ) で揺らす' },
    shakeRecover: { type: 'number', default: 1.5, min: 0, max: 20, step: 0.1, desc: '揺れが収まる速さ（1秒あたりに減る強さ）' },
    trauma: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, desc: '揺れの強さ 0〜1（自動で変化。ctx.shake で増える）' },
    shakeX: { type: 'number', default: 0, desc: '揺れによる横のずれ(px。自動で変化)' },
    shakeY: { type: 'number', default: 0, desc: '揺れによる縦のずれ(px。自動で変化)' },
    viewPos: { type: 'vec2', default: [0, 0], desc: '画面の中で映す位置（0〜1の割合。分割画面や小窓に）' },
    viewSize: { type: 'vec2', default: [1, 1], desc: '画面の中で映す大きさ（0〜1の割合）' },
    depth: { type: 'int', default: 0, min: -100, max: 100, desc: 'カメラが複数あるときの描く順番（小さい順。大きいほど手前）' },
    layerMin: { type: 'int', default: -100, min: -100, max: 100, desc: '映す層の下限（UI用のカメラを分けるとき）' },
    layerMax: { type: 'int', default: 100, min: -100, max: 100, desc: '映す層の上限' },
    clear: { type: 'bool', default: false, desc: '映す範囲を background の色で塗ってから描く（分割画面・小窓に）' },
    background: { type: 'color', default: '#000000', desc: 'clear のときの色' },
  },
});

export const STD_COMPONENTS = [Transform, Sprite, Animator, Shape, Text, Camera];
