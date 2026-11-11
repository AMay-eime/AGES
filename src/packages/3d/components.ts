// 追加パッケージ 3d のコンポーネント
import { defineComponent } from '../../core/schema.ts';

export const Transform3D = defineComponent({
  name: 'Transform3D',
  desc: '3D の位置・向き・大きさ（3d）。Y が上・単位は m。物の前は +Z、カメラが見る向きは −Z',
  fields: {
    x: { type: 'number', default: 0, step: 0.1, desc: '位置 x（m。右が正。parent があれば親から見た位置）' },
    y: { type: 'number', default: 0, step: 0.1, desc: '位置 y（m。上が正）' },
    z: { type: 'number', default: 0, step: 0.1, desc: '位置 z（m。手前が正。カメラは −z の方を見る）' },
    rx: { type: 'number', default: 0, min: -360, max: 360, desc: '上下の回転（度。x 軸まわり。カメラは正で上を向く）' },
    ry: { type: 'number', default: 0, min: -360, max: 360, desc: '左右の回転（度。y 軸まわり。上から見て反時計回りが正）' },
    rz: { type: 'number', default: 0, min: -360, max: 360, desc: '傾き（度。z 軸まわり）' },
    sx: { type: 'number', default: 1, min: -100, max: 100, step: 0.05, desc: '倍率 x' },
    sy: { type: 'number', default: 1, min: -100, max: 100, step: 0.05, desc: '倍率 y' },
    sz: { type: 'number', default: 1, min: -100, max: 100, step: 0.05, desc: '倍率 z' },
    parent: { type: 'ref', default: null, desc: '位置の親。あると位置・回転・倍率は親から見た値になり、親と一緒に動く・回る。親が消えると一緒に消える' },
  },
});

export const Camera3D = defineComponent({
  name: 'Camera3D',
  desc: '3D のカメラ（3d）。位置と向きは Transform3D。1つも置かなければ、少し上から原点を見る',
  fields: {
    enabled: { type: 'bool', default: true, desc: '使うか（使うものが複数あれば、最初の1つ）' },
    projection: { type: 'enum', default: 'perspective', options: ['perspective', 'ortho'], desc: '映し方。perspective=遠近あり / ortho=遠近なし（見下ろしのゲームなど）' },
    fov: { type: 'number', default: 60, min: 10, max: 120, desc: '縦に見える角度（度。perspective のとき）' },
    size: { type: 'number', default: 5, min: 0.1, max: 1000, step: 0.1, desc: '縦に見える半分の長さ（m。ortho のとき）' },
    near: { type: 'number', default: 0.1, min: 0.001, max: 100, step: 0.01, desc: 'これより近い物は映らない（m）' },
    far: { type: 'number', default: 200, min: 1, max: 100000, desc: 'これより遠い物は映らない（m）' },
    follow: { type: 'ref', default: null, desc: '追いかける相手の ID（null なら動かない）' },
    offset: { type: 'vec3', default: [0, 3, 6], desc: '追いかけるとき、相手からずらす量（m。世界の向き。[0, 3, 6] は後ろ上から）' },
    lag: { type: 'number', default: 0, min: 0, max: 0.99, step: 0.01, desc: '追いかける遅れ（0 = ぴったり、0.9 = ゆっくり）' },
    look: { type: 'bool', default: true, desc: '追いかける相手の方を向く（lookHeight だけ上を見る）' },
    lookHeight: { type: 'number', default: 1, min: -100, max: 100, step: 0.1, desc: '相手の位置からこれだけ上を見る（m。キャラクターの頭のあたり）' },
  },
});

export const Mesh3D = defineComponent({
  name: 'Mesh3D',
  desc: '基本の形を描く（3d）。箱・球・円柱・カプセル・板。位置と向きは Transform3D',
  fields: {
    shape: { type: 'enum', default: 'box', options: ['box', 'sphere', 'cylinder', 'capsule', 'plane'], desc: '形。box=箱 / sphere=球 / cylinder=円柱 / capsule=カプセル（キャラクターの仮の形）/ plane=上向きの板（床）' },
    size: { type: 'vec3', default: [1, 1, 1], desc: '大きさ（m）。箱は幅・高さ・奥行き、球・円柱・カプセルは 太さ(x)・高さ(y)、板は 幅(x)・奥行き(z)' },
    color: { type: 'color', default: '#ffffff', desc: '色（texture があれば掛け合わせる）' },
    texture: { type: 'asset', kind: 'image', default: '', desc: '表面に貼る画像（空なら色だけ）' },
    tile: { type: 'vec2', default: [1, 1], desc: '画像をくり返す回数（横・縦。床に 10x10 で貼るなど）' },
    roughness: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.05, desc: 'ざらつき（0 = つるつるで光を強く返す、1 = つや消し）' },
    unlit: { type: 'bool', default: false, desc: '光の影響を受けない（色・画像をそのまま出す）' },
    doubleSided: { type: 'bool', default: false, desc: '裏側の面も描く（球・箱の内側から見る空など）' },
    fog: { type: 'bool', default: true, desc: '霧をかけるか（空に使う形は false）' },
    alpha: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, desc: '不透明度（1 より小さいと透ける）' },
    visible: { type: 'bool', default: true, desc: '描くか' },
    shadow: { type: 'bool', default: true, desc: '影を落とすか（太陽の影。受けるのは常に）' },
  },
});

export const Model3D = defineComponent({
  name: 'Model3D',
  desc: 'モデル（.glb）を描く（3d）。位置と向きと大きさは Transform3D',
  fields: {
    model: { type: 'asset', kind: 'model', default: '', desc: 'モデルのファイル（.glb）。大きさ・中心・動きの名前は ages assets で見る' },
    color: { type: 'color', default: '#ffffff', desc: '掛け合わせる色（白でそのまま。当たったときに赤くするなど）' },
    alpha: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, desc: '不透明度（1 より小さいと透ける）' },
    visible: { type: 'bool', default: true, desc: '描くか' },
    shadow: { type: 'bool', default: true, desc: '影を落とすか（太陽の影。受けるのは常に）' },
    clip: { type: 'string', default: '', desc: '再生する動きの名前（モデルの中の名前。ages assets で見る。空なら元の姿勢）。書き換えると、前の動きから fade 秒でなめらかに切り替わる' },
    speed: { type: 'number', default: 1, min: -10, max: 10, step: 0.05, desc: '動きの速さ（1 でそのまま、0 で止まる）' },
    loop: { type: 'bool', default: true, desc: 'くり返す（false なら最後の姿勢で止まる）' },
    fade: { type: 'number', default: 0.15, min: 0, max: 5, step: 0.05, desc: '動きを切り替えるときに混ぜる秒数' },
    time: { type: 'number', default: 0, desc: '動きの中の時刻（秒。自動で変化。初めに書いておけば、その時刻から始まる）' },
    done: { type: 'bool', default: false, desc: 'くり返さない動き（loop が false）が最後まで行った（自動で変化。次の動きへ移る合図に）' },
    playing: { type: 'string', default: '', desc: 'いま再生している動き（自動で変化）' },
    prevClip: { type: 'string', default: '', desc: '切り替える前の動き（自動で変化）' },
    prevTime: { type: 'number', default: 0, desc: '切り替える前の動きの時刻（自動で変化）' },
    fadeLeft: { type: 'number', default: 0, desc: '切り替えの残りの秒数（自動で変化）' },
  },
});

export const Light3D = defineComponent({
  name: 'Light3D',
  desc: '3D の光（3d）。位置と向きは Transform3D。1つも置かなければ、斜め上からの既定の太陽の光',
  fields: {
    kind: { type: 'enum', default: 'sun', options: ['sun', 'point'], desc: 'sun=太陽（全体を同じ向きに照らす。向きは物の前 +Z。rx を正にすると下向き）/ point=点の光（位置からまわりを照らす。8 つまで）' },
    color: { type: 'color', default: '#ffffff', desc: '光の色' },
    intensity: { type: 'number', default: 1, min: 0, max: 20, step: 0.05, desc: '強さ' },
    range: { type: 'number', default: 10, min: 0.1, max: 1000, step: 0.5, desc: '届く距離（m。point のとき）' },
    enabled: { type: 'bool', default: true, desc: '点けるか' },
    shadow: { type: 'bool', default: true, desc: '影を落とすか（sun だけ。point の光は影を落とさない）' },
    shadowRange: { type: 'number', default: 30, min: 1, max: 500, step: 1, desc: '影が出る距離（カメラから m。小さいほど影がくっきり、大きいほど遠くまで出るがぼやける）' },
  },
});

export const Environment3D = defineComponent({
  name: 'Environment3D',
  desc: '3D の全体の明るさと霧（3d）。シーンに1つ（どの物に付けてもよい）。なければ既定の明るさで、霧なし',
  fields: {
    sky: { type: 'color', default: '#b8c4d8', desc: '上からの明るさの色（影の中の、上を向いた面の色）' },
    ground: { type: 'color', default: '#5a5348', desc: '下からの明るさの色（下を向いた面の色）' },
    ambient: { type: 'number', default: 0.6, min: 0, max: 5, step: 0.05, desc: '全体の明るさの強さ' },
    fog: { type: 'bool', default: false, desc: '遠くを霧で霞ませる（色は画面の背景の色）' },
    fogNear: { type: 'number', default: 20, min: 0, max: 100000, desc: '霧が始まる距離（m）' },
    fogFar: { type: 'number', default: 80, min: 0.1, max: 100000, desc: '完全に霞む距離（m）' },
  },
});

export const Collider3D = defineComponent({
  name: 'Collider3D',
  desc: '3D の当たり判定の形（3d）。箱・球・カプセルで、Transform3D の位置・回転・倍率がかかる。重なり・線は ages/3d の hit3 で調べる（押し返しはしない）',
  fields: {
    shape: { type: 'enum', default: 'box', options: ['box', 'sphere', 'capsule'], desc: '形。box=箱 / sphere=球 / capsule=カプセル（キャラクター。縦が高さ）' },
    size: { type: 'vec3', default: [1, 1, 1], desc: '大きさ（m。Mesh3D と同じ書き方）。箱は幅・高さ・奥行き、球・カプセルは 太さ(x)・高さ(y)' },
    offset: { type: 'vec3', default: [0, 0, 0], desc: '中心のずれ（m。回転・倍率がかかる。足元が原点のモデルなら、高さの半分だけ上へ）' },
    group: { type: 'string', default: '', desc: 'グループの名前（例 player wall coin）。相手を絞るのに使う' },
    with: { type: 'list', of: { type: 'string', default: '' }, default: [], desc: 'このグループとの重なりを毎フレーム記録する（touching・entered に入る）' },
    enabled: { type: 'bool', default: true, desc: '判定するか' },
    touching: { type: 'list', of: { type: 'string', default: '' }, default: [], desc: 'いま重なっている相手の ID（with のグループ。自動で変化）' },
    entered: { type: 'list', of: { type: 'string', default: '' }, default: [], desc: 'このフレームに重なり始めた相手の ID（自動で変化。hit3.entered で読む）' },
  },
});

export const Particles3D = defineComponent({
  name: 'Particles3D',
  desc: '3D のパーティクル（3d）。粒はカメラを向く板。粒を出して動かすのは描く側（ゲームの結果には関わらない）。一度に出すのは ages/3d の burst3(ctx.world, 物)',
  fields: {
    burst: { type: 'int', default: 0, min: 0, max: 2000, desc: '現れたとき・burst3 で一度に出す数' },
    rate: { type: 'number', default: 0, min: 0, max: 2000, step: 1, desc: '1秒に出す数（出し続ける）' },
    playing: { type: 'bool', default: true, desc: '出し続けるか（ゲームのコードで切り替える）' },
    duration: { type: 'number', default: -1, min: -1, max: 600, step: 0.1, desc: '出し続ける秒数（-1 で止めるまで）' },
    lifetime: { type: 'number', default: 0.8, min: 0.01, max: 30, step: 0.05, desc: '粒が消えるまでの秒数' },
    lifetimeJitter: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, desc: '消えるまでの秒数のばらつき（割合）' },
    speed: { type: 'number', default: 2, min: 0, max: 200, step: 0.1, desc: '出たときの速さ（m/秒）' },
    speedJitter: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.05, desc: '速さのばらつき（割合）' },
    direction: { type: 'vec3', default: [0, 1, 0], desc: '出る向き（物から見た向き。[0,1,0] が上）' },
    spread: { type: 'number', default: 360, min: 0, max: 360, desc: '向きの広がり（度。direction を軸にした円すい。360 で全方向）' },
    radius: { type: 'number', default: 0, min: 0, max: 100, step: 0.05, desc: '出る場所の広がり（m。物の位置を中心にした球）' },
    gravity: { type: 'vec3', default: [0, 0, 0], desc: '重力（m/秒²。[0, -9.8, 0] で下へ落ちる。煙なら少し上向き）' },
    drag: { type: 'number', default: 0, min: 0, max: 20, step: 0.1, desc: '空気の抵抗（大きいほど早く止まる）' },
    sizeStart: { type: 'number', default: 0.2, min: 0, max: 50, step: 0.01, desc: '出たときの大きさ（m）' },
    sizeEnd: { type: 'number', default: 0, min: 0, max: 50, step: 0.01, desc: '消えるときの大きさ（m）' },
    colorStart: { type: 'color', default: '#ffffff', desc: '出たときの色' },
    colorEnd: { type: 'color', default: '#ffffff', desc: '消えるときの色' },
    alphaStart: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, desc: '出たときの不透明度' },
    alphaEnd: { type: 'number', default: 0, min: 0, max: 1, step: 0.05, desc: '消えるときの不透明度' },
    shape: { type: 'enum', options: ['circle', 'square', 'image'], default: 'circle', desc: '粒の形（circle はふちのやわらかい丸。image は image の画像）' },
    image: { type: 'asset', kind: 'image', default: '', desc: '粒の画像（shape が image のとき）' },
    spin: { type: 'number', default: 0, min: -3600, max: 3600, desc: '回る速さ（度/秒）' },
    blend: { type: 'enum', options: ['add', 'normal'], default: 'add', desc: '重ね方。add=光る（火花・炎）/ normal=普通に重ねる（煙・ほこり）' },
    world: { type: 'bool', default: true, desc: '出た粒はその場に残る（false なら物と一緒に動く）' },
    max: { type: 'int', default: 500, min: 1, max: 20000, desc: '同時に出ている粒の上限' },
    autoDestroy: { type: 'bool', default: false, desc: '出し終わって粒が消えたら、この物を消す（爆発の後片付けなど）' },
    bursts: { type: 'int', default: 0, desc: '一度に出した回数（自動で変化。burst3 で増える）' },
    burstCount: { type: 'int', default: 0, desc: '次に一度に出す数（自動で変化。0 なら burst の数）' },
    since: { type: 'int', default: 9999, desc: '最後に一度に出してからのフレーム数（自動で変化）' },
    age: { type: 'int', default: 0, desc: '現れてからのフレーム数（自動で変化）' },
  },
});

export const COMPONENTS_3D = [Transform3D, Camera3D, Mesh3D, Model3D, Light3D, Environment3D, Collider3D, Particles3D];
