import { defineComponent } from 'ages';

// Transform・Sprite・Animator・Shape・Text は AGES の標準なので、ここでは定義しない

export const Hitbox = defineComponent({
  name: 'Hitbox',
  desc: '当たり判定の大きさ（Transform の位置が中心の矩形）',
  fields: {
    w: { type: 'number', default: 16, min: 0, max: 512, desc: '幅(px)' },
    h: { type: 'number', default: 16, min: 0, max: 512, desc: '高さ(px)' },
  },
});

export const Velocity = defineComponent({
  name: 'Velocity',
  desc: '毎フレームこの量だけ動く',
  fields: {
    vx: { type: 'number', default: 0, min: -50, max: 50, desc: '横の速さ(px/フレーム)' },
    vy: { type: 'number', default: 0, min: -50, max: 50, desc: '縦の速さ(px/フレーム)' },
  },
});

export const Player = defineComponent({
  name: 'Player',
  desc: '自機。矢印キーで移動、Z/スペースで射撃',
  fields: {
    speed: { type: 'number', default: 4.5, min: 0, max: 20, step: 0.1, desc: '移動の速さ(px/フレーム)' },
    fireInterval: { type: 'int', default: 8, min: 1, max: 60, desc: '射撃の間隔(フレーム)' },
    bullet: { type: 'prefab', default: 'bullet', desc: '撃つ弾のプレハブ' },
    cooldown: { type: 'int', default: 0, min: 0, desc: '次に撃てるまで(自動で変化)' },
  },
});

export const Health = defineComponent({
  name: 'Health',
  desc: '体力。0で倒れる',
  fields: {
    hp: { type: 'int', default: 3, min: 0, max: 999, desc: '体力' },
    invincible: { type: 'int', default: 0, min: 0, desc: '残りの無敵時間(フレーム、自動で変化)' },
    invincibleOnHit: { type: 'int', default: 60, min: 0, max: 600, desc: '被弾後の無敵時間(フレーム)' },
  },
});

export const Lifetime = defineComponent({
  name: 'Lifetime',
  desc: '指定フレーム後に消える',
  fields: {
    frames: { type: 'int', default: 60, min: 0, max: 36000, desc: '残りフレーム' },
  },
});

export const Bullet = defineComponent({
  name: 'Bullet',
  desc: '当たると相手の体力を減らす',
  fields: {
    team: { type: 'enum', options: ['player', 'enemy'], default: 'player', desc: '誰の弾か' },
    damage: { type: 'int', default: 1, min: 0, max: 99, desc: '与えるダメージ' },
  },
});

export const Enemy = defineComponent({
  name: 'Enemy',
  desc: '敵。自機に触れるとダメージ',
  fields: {
    score: { type: 'int', default: 100, min: 0, max: 100000, desc: '倒したときの得点' },
  },
});

export const Spawner = defineComponent({
  name: 'Spawner',
  desc: '画面上端から敵を出す',
  fields: {
    prefab: { type: 'prefab', default: 'enemy', desc: '出す敵のプレハブ' },
    interval: { type: 'int', default: 45, min: 1, max: 600, desc: '出す間隔(フレーム)' },
    speedMin: { type: 'number', default: 1.5, min: 0, max: 20, desc: '落ちる速さの最小(px/フレーム)' },
    speedMax: { type: 'number', default: 3, min: 0, max: 20, desc: '落ちる速さの最大(px/フレーム)' },
    margin: { type: 'number', default: 24, min: 0, max: 200, desc: '画面端からの余白(px)' },
    formation: {
      type: 'matrix', cell: 'int', min: 0, max: 1, cols: 8, default: [],
      desc: '出現パターン。行=波（上から順に繰り返す）、列=横の位置（8列）、1で敵を出す。空なら横位置はランダム',
    },
  },
});

export const Score = defineComponent({
  name: 'Score',
  desc: '得点の表示',
  fields: {
    value: { type: 'int', default: 0, min: 0, desc: '現在の得点(自動で変化)' },
  },
});
