// 表の形。中身は data/<名前>.table.json（エディタの「表」で編集できる）
import { defineTable } from 'ages';

export const enemies = defineTable({
  name: 'enemies',
  desc: '敵の種類',
  columns: {
    hp: { type: 'int', default: 2, min: 1, max: 100, desc: '体力' },
    speed: { type: 'number', default: 1, min: 0.1, max: 5, step: 0.05, desc: '落ちる速さの倍率（出す役の速さに掛ける）' },
    score: { type: 'int', default: 100, min: 0, max: 100000, desc: '倒したときの得点' },
    frame: { type: 'frame', default: 18, desc: 'ships.png のコマ' },
    tint: { type: 'color', default: '#ffffff', desc: '色をかける' },
  },
});
