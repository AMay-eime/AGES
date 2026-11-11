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

export const COMPONENTS_3D = [Transform3D, Camera3D];
