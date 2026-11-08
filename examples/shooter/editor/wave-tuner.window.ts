// プロジェクト独自のエディタウインドウの例：敵の出方をまとめて調整し、その場で30秒の試し実行をする。
import { defineWindow, type EditorApi } from 'ages';

const KNOBS: { path: string; label: string; min: number; max: number; step: number }[] = [
  { path: 'main#spawner.Spawner.interval', label: '出現間隔(フレーム)', min: 5, max: 120, step: 1 },
  { path: 'main#spawner.Spawner.speedMin', label: '落下速度 最小', min: 0.5, max: 10, step: 0.1 },
  { path: 'main#spawner.Spawner.speedMax', label: '落下速度 最大', min: 0.5, max: 10, step: 0.1 },
  { path: '@enemy.Health.hp', label: '敵の体力', min: 1, max: 10, step: 1 },
];

// 自動操作: 撃ちながら左右に往復する
const AUTOPILOT = '0-1800:KeyZ;0-150:ArrowLeft;150-450:ArrowRight;450-750:ArrowLeft;750-1050:ArrowRight;1050-1350:ArrowLeft;1350-1650:ArrowRight';

export default defineWindow({
  id: 'wave-tuner',
  title: '敵の出方',
  mount(el, api: EditorApi) {
    const { h } = api;
    const result = h('pre', { style: 'padding:8px;margin:0' }, '「30秒を試す」で、自動操作のプレイを画面なしで一瞬で回します');
    const render = () => {
      const rows = KNOBS.map((k) => {
        const v = Number(api.get(k.path));
        const lock = api.state.locks[k.path];
        const out = h('span', { style: 'width:44px;text-align:right;font:var(--mono)' }, String(v));
        const range = h('input', { type: 'range', min: k.min, max: k.max, step: k.step, value: v, style: 'flex:1' }) as HTMLInputElement;
        range.addEventListener('input', () => { out.textContent = range.value; });
        range.addEventListener('change', () => api.patch([{ op: 'set', path: k.path, value: Number(range.value) }]));
        return h('div', { class: 'row', style: 'padding:3px 8px' },
          h('span', { style: 'width:140px', class: lock ? '' : 'muted', title: k.path }, (lock ? '🔒 ' : '') + k.label), range, out);
      });
      const run = () => {
        const r = api.simulate(1800, AUTOPILOT);
        const c = r.counts;
        result.textContent = `30秒（${r.frame}フレーム）を ${r.ms.toFixed(0)}ms で実行\n撃破 ${c.enemyKilled ?? 0} / 被弾 ${c.playerHit ?? 0} / ゲームオーバー ${c.gameOver ? 'あり' : 'なし'}`;
      };
      el.replaceChildren(h('div', { style: 'padding:6px 0' }, rows), h('div', { class: 'toolbar' }, h('button', { onclick: run }, '30秒を試す')), result);
    };
    render();
    return api.on('change', render);
  },
});
