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
    slice: { type: 'int', default: 0, min: 0, max: 512, desc: '9つに切って伸ばす（枠・吹き出し・ボタンの画像に）。四隅の大きさ(px)。0 なら切らない' },
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
  desc: '単色の図形を描く（標準）。四角・円・線。stroke で枠だけ（レーザー・予告線・ゲージの枠・リングに）',
  fields: {
    kind: { type: 'enum', options: ['rect', 'circle', 'line'], default: 'rect', desc: '形。line は物の位置から to まで' },
    w: { type: 'number', default: 16, min: 0, max: 4096, desc: '幅(px)。line では使わない' },
    h: { type: 'number', default: 16, min: 0, max: 4096, desc: '高さ(px)。line では使わない' },
    stroke: { type: 'number', default: 0, min: 0, max: 512, desc: '線の太さ(px)。rect・circle は 0 なら塗りつぶし、1以上なら枠だけ。line は線の太さ（0 なら 1）' },
    to: { type: 'vec2', default: [0, 0], desc: 'line の終わりの点（物の位置からのずれ(px)。回転・倍率がかかる）' },
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
    alpha: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, desc: '不透明度（トゥイーンで出す・消す）' },
    key: { type: 'string', default: '', desc: '言葉の表 $text の行の名前。書くと、今の言語の言葉を text に入れる（多言語）' },
    align: { type: 'enum', options: ['left', 'center', 'right'], default: 'left', desc: '揃え（位置が左端・中央・右端になる。UI の物なら四角の中で揃える）' },
    font: { type: 'asset', kind: 'font', default: '', desc: 'フォントファイル（空なら標準のフォント）' },
    wrap: { type: 'number', default: 0, min: 0, max: 4096, desc: 'この幅(px)で折り返す（0 なら折り返さない）' },
    lineHeight: { type: 'number', default: 1.25, min: 0.5, max: 4, step: 0.05, desc: '行の高さ（文字の大きさの倍）' },
    bold: { type: 'bool', default: false, desc: '太字' },
    outline: { type: 'number', default: 0, min: 0, max: 32, step: 0.5, desc: '縁取りの太さ(px)。0 なら縁取りなし。背景の上で読ませる文字（HUD・ダメージの数字）に。Effect の std:outline より軽い' },
    outlineColor: { type: 'color', default: '#000000', desc: '縁取りの色' },
    ...drawOrder,
  },
});

export const UI = defineComponent({
  name: 'UI',
  desc: '画面に固定する（標準）。カメラに関係なく、画面（または親の UI）の決めた所に置き、その四角に合わせて Sprite・Shape・Text・Gauge を描く。位置は設計の大きさで数える',
  fields: {
    anchor: { type: 'enum', options: ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'], default: 'center', desc: '画面（親）のどこに合わせるか。自分の同じ所がそこに来る（topRight なら右上の角どうし）。画面の端に付けるのは patch の dockUI' },
    x: { type: 'number', default: 0, desc: '置いた所からのずれ(px。右が正)' },
    y: { type: 'number', default: 0, desc: '置いた所からのずれ(px。下が正)' },
    w: { type: 'number', default: 120, min: 0, max: 4096, desc: '幅(px)' },
    h: { type: 'number', default: 40, min: 0, max: 4096, desc: '高さ(px)' },
    parent: { type: 'ref', default: null, desc: '親の UI（その四角の中に置く。親が隠れると一緒に隠れる）。null なら画面' },
    beside: { type: 'ref', default: null, desc: 'この UI の隣に接して置く（anchor の代わり。相手が動けば一緒に動き、重ならない）。付けるのは patch の attachUI' },
    side: { type: 'enum', options: ['right', 'left', 'below', 'above'], default: 'right', desc: 'beside の相手のどちら側に付けるか' },
    gap: { type: 'number', default: 0, min: -1000, max: 1000, desc: 'beside の相手との間(px。0 で接する)' },
    align: { type: 'enum', options: ['start', 'center', 'end'], default: 'start', desc: 'beside の相手と、どこを揃えるか（右・左に付けるなら上・中央・下、上・下に付けるなら左・中央・右）' },
    visible: { type: 'bool', default: true, desc: '見せるか（隠すと子も隠れ、押せなくなる）' },
    order: { type: 'int', default: 0, min: -10000, max: 10000, desc: '親の Layout の中の並び順（小さい順）' },
    modal: { type: 'bool', default: false, desc: '出ている間、この中の物しか押せない（ダイアログ）' },
    block: { type: 'bool', default: true, desc: 'この上で押したマウス・タッチをゲームに渡さない（ボタンでなくても）' },
  },
});

export const Layout = defineComponent({
  name: 'Layout',
  desc: '子の UI（parent がこの物）を順に並べる（標準。リスト・メニュー・ボタンの並び）。子の anchor・beside は使わず、order の順に並べる（子の x・y は並べた所からのずれ）',
  fields: {
    dir: { type: 'enum', options: ['vertical', 'horizontal'], default: 'vertical', desc: '並べる向き' },
    gap: { type: 'number', default: 8, min: 0, max: 1000, desc: '間(px)' },
    padding: { type: 'number', default: 0, min: 0, max: 1000, desc: '内側の余白(px)' },
    align: { type: 'enum', options: ['start', 'center', 'end'], default: 'center', desc: '並べる向きと直角の揃え' },
    justify: { type: 'enum', options: ['start', 'center', 'end'], default: 'start', desc: '並べる向きの揃え（全体を先頭・中央・末尾に寄せる）' },
  },
});

export const Button = defineComponent({
  name: 'Button',
  desc: 'ボタン（標準。UI と一緒に）。マウス・タッチで押すか、矢印で合わせて Enter・Pad.A。押されたら ctx.ui.clicked(ID) が true になる',
  fields: {
    enabled: { type: 'bool', default: true, desc: '押せるか' },
    normal: { type: 'color', default: '#d8d8d8', desc: 'ふだんの色（Sprite・Shape・Text の色にかける）' },
    hover: { type: 'color', default: '#ffffff', desc: 'マウスが上にあるときの色' },
    pressed: { type: 'color', default: '#a0a0a0', desc: '押しているときの色' },
    focus: { type: 'color', default: '#fff2b0', desc: '矢印で合わせているときの色' },
    disabled: { type: 'color', default: '#606060', desc: '押せないときの色' },
    state: { type: 'enum', options: ['normal', 'hover', 'pressed', 'focus', 'disabled'], default: 'normal', desc: '今の状態（自動で変化）' },
  },
});

export const Gauge = defineComponent({
  name: 'Gauge',
  desc: 'ゲージ（標準。体力・時間・読み込み）。drag にするとスライダー（音量など）。UI と一緒ならその四角に、なければ Transform の位置に w×h で描く',
  fields: {
    value: { type: 'number', default: 1, min: 0, desc: '今の値（0〜max）' },
    max: { type: 'number', default: 1, min: 0.000001, desc: '最大の値' },
    dir: { type: 'enum', options: ['leftToRight', 'rightToLeft', 'bottomToTop', 'topToBottom'], default: 'leftToRight', desc: '伸びる向き' },
    color: { type: 'color', default: '#5fd35f', desc: '中身の色' },
    back: { type: 'color', default: '#202630', desc: '背景の色' },
    backAlpha: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, desc: '背景の不透明度（0 で背景なし）' },
    w: { type: 'number', default: 64, min: 0, max: 4096, desc: '幅(px。UI がないとき)' },
    h: { type: 'number', default: 8, min: 0, max: 4096, desc: '高さ(px。UI がないとき)' },
    drag: { type: 'bool', default: false, desc: 'マウス・タッチや左右で値を変えられる（スライダー）。変わったら ctx.ui.changed(ID) が true' },
    step: { type: 'number', default: 0, min: 0, desc: '値の刻み（0 なら刻まない。左右では max の 1/10 ずつ）' },
    ...drawOrder,
  },
});

export const Collider = defineComponent({
  name: 'Collider',
  desc: '当たり判定の形（標準）。円か矩形で、Transform の位置・回転・倍率がかかる。重なりは ctx.hit で調べる（押し返しはしない）',
  fields: {
    shape: { type: 'enum', options: ['rect', 'circle'], default: 'rect', desc: '形' },
    w: { type: 'number', default: 16, min: 0, max: 4096, desc: '矩形の幅(px。倍率がかかる前)' },
    h: { type: 'number', default: 16, min: 0, max: 4096, desc: '矩形の高さ(px)' },
    r: { type: 'number', default: 8, min: 0, max: 4096, desc: '円の半径(px)' },
    offset: { type: 'vec2', default: [0, 0], desc: '中心のずれ [x, y](px。回転・倍率がかかる)' },
    group: { type: 'string', default: '', desc: 'グループの名前（例 player enemy bullet）。相手を絞るのに使う' },
    with: { type: 'list', of: { type: 'string', default: '' }, default: [], desc: 'このグループと重なり始めたら記録する（ctx.hit.entered。ages run の hits: に数が出る）' },
    enabled: { type: 'bool', default: true, desc: '判定するか' },
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

export const Sound = defineComponent({
  name: 'Sound',
  desc: '音（標準）。プレハブに付けると ctx.sound.play("プレハブ名") で鳴らせる。物に付けて playOnStart にすると、その物がいる間鳴る（BGM・環境音）',
  fields: {
    clip: { type: 'asset', kind: 'sound', default: '', desc: '音のファイル（例: assets/se/shot.wav）' },
    bus: { type: 'prefab', default: '', desc: '音量の区分（AudioBus の付いたプレハブの名前）。空なら全体の直下' },
    volume: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, desc: '音量' },
    pitch: { type: 'number', default: 1, min: 0.25, max: 4, step: 0.01, desc: '高さと速さ（2 = 1オクターブ上で2倍の速さ）' },
    pitchJitter: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, desc: '鳴らすたびに高さを ± この割合だけばらつかせる（同じ音の繰り返しを自然に）' },
    pan: { type: 'number', default: 0, min: -1, max: 1, step: 0.05, desc: '左右（-1 = 左、1 = 右）' },
    loop: { type: 'bool', default: false, desc: '繰り返す（止めるまで鳴り続ける）' },
    playOnStart: { type: 'bool', default: false, desc: '物が現れたとき（シーンが始まったとき・spawn されたとき）に鳴らし、物が消えたら止める（Unity の Play On Awake と同じ）' },
    fadeIn: { type: 'number', default: 0, min: 0, max: 10, step: 0.1, desc: '鳴り始めのフェード(秒)' },
    fadeOut: { type: 'number', default: 0, min: 0, max: 10, step: 0.1, desc: '止めるときのフェード(秒。「同時に1つだけ」の区分での切り替えにも使う)' },
    maxVoices: { type: 'int', default: 4, min: 1, max: 64, desc: 'この音を同時に鳴らす数の上限（超えたら古いものから止める）' },
    cooldown: { type: 'number', default: 0, min: 0, max: 5, step: 0.01, desc: 'この秒数より短い間隔では鳴らさない（連射の音が重なりすぎないように）' },
  },
});

export const AudioBus = defineComponent({
  name: 'AudioBus',
  desc: '音量の区分（標準）。プレハブに付けると、そのプレハブの名前が区分の名前になる（例 @bgm, @se）。どんな区分を作るかはプロジェクトで決める',
  fields: {
    volume: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, desc: 'この区分の音量' },
    parent: { type: 'prefab', default: '', desc: '親の区分（AudioBus のプレハブ）。親の音量も掛かる。空なら全体の直下' },
    exclusive: { type: 'bool', default: false, desc: '同時に1つだけ鳴らす。新しい音を鳴らすと、今の音がその音の fadeOut で消えながら切り替わる（普通のBGMに。重ねるBGMなら外す）' },
    maxVoices: { type: 'int', default: 0, min: 0, max: 128, desc: 'この区分で同時に鳴らす数の上限（0 = 制限なし。超えたら古いものから止める）' },
  },
});

export const Particles = defineComponent({
  name: 'Particles',
  desc: 'パーティクル（標準）。粒を出して動かすのは描く側（ゲームの結果には関わらない）。ctx.particles.burst(物) で一度に出す',
  fields: {
    burst: { type: 'int', default: 0, min: 0, max: 2000, desc: '現れたときに一度に出す数' },
    rate: { type: 'number', default: 0, min: 0, max: 2000, step: 1, desc: '1秒に出す数（出し続ける）' },
    playing: { type: 'bool', default: true, desc: '出し続けるか（ctx.particles.play / stop で変わる）' },
    duration: { type: 'number', default: -1, min: -1, max: 600, step: 0.1, desc: '出し続ける秒数（-1 で止めるまで）' },
    lifetime: { type: 'number', default: 0.6, min: 0.01, max: 30, step: 0.05, desc: '粒が消えるまでの秒数' },
    lifetimeJitter: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, desc: '消えるまでの秒数のばらつき（割合）' },
    speed: { type: 'number', default: 120, min: 0, max: 5000, desc: '出たときの速さ(px/秒)' },
    speedJitter: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.05, desc: '速さのばらつき（割合）' },
    angle: { type: 'number', default: -90, min: -360, max: 360, desc: '出る向き(度。-90 が上、0 が右)' },
    spread: { type: 'number', default: 360, min: 0, max: 360, desc: '向きの広がり(度。360 で全方向)' },
    radius: { type: 'number', default: 0, min: 0, max: 2000, desc: '出る場所の広がり(px。物の位置を中心にした円)' },
    gravity: { type: 'vec2', default: [0, 0], desc: '重力(px/秒²。[0, 300] で下へ落ちる)' },
    drag: { type: 'number', default: 0, min: 0, max: 20, step: 0.1, desc: '空気の抵抗（大きいほど早く止まる）' },
    sizeStart: { type: 'number', default: 6, min: 0, max: 500, desc: '出たときの大きさ(px)' },
    sizeEnd: { type: 'number', default: 0, min: 0, max: 500, desc: '消えるときの大きさ(px)' },
    colorStart: { type: 'color', default: '#ffffff', desc: '出たときの色' },
    colorEnd: { type: 'color', default: '#ffffff', desc: '消えるときの色' },
    alphaStart: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, desc: '出たときの不透明度' },
    alphaEnd: { type: 'number', default: 0, min: 0, max: 1, step: 0.05, desc: '消えるときの不透明度' },
    shape: { type: 'enum', options: ['circle', 'square', 'image'], default: 'circle', desc: '粒の形（image は image の画像）' },
    image: { type: 'asset', kind: 'image', default: '', desc: '粒の画像（shape が image のとき）' },
    frame: { type: 'frame', default: 0, desc: '粒の画像のコマ' },
    spin: { type: 'number', default: 0, min: -3600, max: 3600, desc: '回る速さ(度/秒)' },
    blend: { type: 'enum', options: ['normal', 'add', 'multiply', 'screen'], default: 'add', desc: '重ね方。add=光る（加算）' },
    world: { type: 'bool', default: true, desc: '出た粒はその場に残る（false なら物と一緒に動く）' },
    max: { type: 'int', default: 500, min: 1, max: 20000, desc: '同時に出ている粒の上限' },
    autoDestroy: { type: 'bool', default: false, desc: '出し終わって粒が消えたら、この物を消す（爆発の後片付けなど）' },
    ...drawOrder,
  },
});

export const Effect = defineComponent({
  name: 'Effect',
  desc: 'シェーダーの効果（標準）。同じ物の Sprite・Shape・Text・Particles の描き方を変える（光らせる・縁取り・溶かすなど）',
  fields: {
    shader: { type: 'asset', kind: 'shader', default: '', desc: 'シェーダー（.frag のファイルか、標準の std:flash std:outline std:dissolve std:desaturate）。空なら効果なし' },
    params: { type: 'params', of: 'shader', desc: 'シェーダーの調整できる値（uniform）。トゥイーンは "Effect.params.amount" のように' },
  },
});

export const PostEffect = defineComponent({
  name: 'PostEffect',
  desc: '画面全体の後処理（標準）。カメラで描き終えた画面に順にかける（端を暗く・ブラウン管ふう・色を抜くなど）',
  fields: {
    shader: { type: 'asset', kind: 'shader', default: '', desc: 'シェーダー（.frag のファイルか、標準の std:vignette std:crt std:desaturate std:flash）' },
    params: { type: 'params', of: 'shader', desc: 'シェーダーの調整できる値（uniform）' },
    enabled: { type: 'bool', default: true, desc: 'かけるかどうか' },
    order: { type: 'int', default: 0, min: -1000, max: 1000, desc: 'かける順番（小さい順）' },
    camera: { type: 'ref', default: null, desc: 'このカメラ（Camera の付いた物の ID）を描いた直後に、そのカメラの範囲にだけかける。後から描くカメラ（UI など）にはかからない。null なら全部のカメラを描いた後に、ゲームの画面全体へ' },
  },
});

export const Clip = defineComponent({
  name: 'Clip',
  desc: '切り抜き（標準）。同じ物の Sprite・Shape・Text・Particles を、決めた四角の中だけに描く（背景の切り替えの境目・巻物の一覧・現れる演出に）',
  fields: {
    enabled: { type: 'bool', default: true, desc: '切り抜くか' },
    min: { type: 'vec2', default: [0, 0], desc: '四角の左上（ワールドの座標(px)。UI の物は画面の座標）' },
    max: { type: 'vec2', default: [0, 0], desc: '四角の右下（同じ座標）。カメラが回っているときは、回った四角を囲む四角で切る' },
  },
});

export const STD_COMPONENTS = [Transform, Sprite, Animator, Shape, Text, Camera, Sound, AudioBus, Particles, Effect, PostEffect, UI, Layout, Button, Gauge, Collider, Clip];
