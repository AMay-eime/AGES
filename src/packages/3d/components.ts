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
    alpha: { type: 'number', default: 1, min: 0, max: 1, step: 0.05, desc: '不透明度（1 より小さいと透ける）' },
    visible: { type: 'bool', default: true, desc: '描くか' },
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

export const COMPONENTS_3D = [Transform3D, Camera3D, Mesh3D, Model3D, Light3D, Environment3D];
