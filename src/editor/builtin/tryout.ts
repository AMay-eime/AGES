// 本体の拡張: 試しの窓。選んだプレハブだけを小さな窓でくり返し動かす（値を変えるとすぐ反映）。
// プロジェクトの拡張と同じ API（パネルと api.stage）で書いている。AI は同じことを ages run --spawn で確かめられる
import { defineExtension, type StageSummary } from '../window-api.ts';
import { T } from '../i18n.ts';

const SPEEDS = [0.25, 0.5, 1, 2];
const ZOOMS = [1, 2, 3, 4];

export default defineExtension({
  id: 'tryout',
  title: T('試し'),
  desc: T('選んだプレハブだけを小さな窓でくり返し動かす（値を変えるとすぐ反映。鳴った音・出した粒の数も出す）'),
  edits: [],
  panel: {
    title: T('試し'),
    area: 'bottom',
    mount(el, api) {
      const { h } = api;
      const saved = (k: string, d: string) => localStorage.getItem(`ages.tryout.${k}`) ?? d;
      const keep = (k: string, v: string) => localStorage.setItem(`ages.tryout.${k}`, v);
      const fromSel = () => (api.selection?.startsWith('@') ? api.selection.slice(1) : '');
      let prefab = fromSel() || saved('prefab', '');
      if (prefab && !api.state.prefabs[prefab]) prefab = '';
      const pick = h('select', { title: T('試すプレハブ') }) as HTMLSelectElement;
      const fill = () => {
        const names = Object.keys(api.state.prefabs);
        pick.replaceChildren(h('option', { value: '' }, T('（プレハブを選ぶ）')), ...names.map((n) => h('option', { value: n, selected: n === prefab }, '@' + n)));
      };
      const followSel = h('input', { type: 'checkbox', checked: saved('followSel', '1') === '1' }) as HTMLInputElement;
      const speed = h('select', { title: T('速さ') }, SPEEDS.map((v) => h('option', { value: String(v), selected: String(v) === saved('speed', '1') }, `×${v}`))) as HTMLSelectElement;
      const zoom = h('select', { title: T('拡大') }, ZOOMS.map((v) => h('option', { value: String(v), selected: String(v) === saved('zoom', '2') }, T('拡大{0}', v)))) as HTMLSelectElement;
      const seconds = h('input', { type: 'number', min: '0.5', max: '60', step: '0.5', value: saved('seconds', '3'), style: 'width:56px', title: T('1回の長さ（秒）。出した物がすべて消えたら、その時点で次の回へ') }) as HTMLInputElement;
      const follow = h('input', { type: 'checkbox', checked: saved('follow', '0') === '1' }) as HTMLInputElement;
      const keys = h('input', { type: 'text', value: saved('keys', ''), placeholder: T('入力（例 0-60:@fire）'), style: 'width:140px', title: T('ages run --keys と同じ書き方。フレームは回ごとに 0 から') }) as HTMLInputElement;
      const info = h('div', { class: 'muted', style: 'font:var(--mono);white-space:pre-wrap;flex:1;min-width:0' });
      const view = h('div', {});
      const text = (s: StageSummary) => {
        if (s.error) return `⚠ ${s.error}`;
        const list = (r: Record<string, number>, mark: string) => Object.entries(r).map(([k, v]) => `${mark}${k}×${v}`).join(' ');
        return [
          T('{0}秒（{1}フレーム）{2}', (s.frames / api.state.config.fps).toFixed(2), s.frames, s.gone ? T('で消えた') : T('たった')),
          Object.keys(s.sounds).length ? T('音: {0}', list(s.sounds, '♪')) : '',
          Object.keys(s.particles).length ? T('粒: {0}', list(s.particles, '✦')) : '',
          Object.keys(s.events).length ? T('出来事: {0}', list(s.events, '')) : '',
          ...s.warnings.map((w) => `⚠ ${w}`),
        ].filter(Boolean).join('\n');
      };
      const opts = () => ({ spawn: prefab ? [{ prefab }] : [], speed: Number(speed.value), zoom: Number(zoom.value), seconds: Number(seconds.value) || 3, follow: follow.checked, keys: keys.value });
      const stage = api.stage(view, { ...opts(), onCycle: (s) => { info.textContent = text(s); } });
      const apply = () => {
        keep('prefab', prefab); keep('speed', speed.value); keep('zoom', zoom.value); keep('seconds', seconds.value); keep('follow', follow.checked ? '1' : '0'); keep('keys', keys.value); keep('followSel', followSel.checked ? '1' : '0');
        stage.set(opts());
        stage.restart();
        if (!prefab) info.textContent = T('プレハブを選ぶと、ここでくり返し動きます（インスペクタで値を変えると、すぐ新しい値で動きます）');
      };
      pick.addEventListener('change', () => { prefab = pick.value; apply(); });
      for (const c of [speed, zoom, seconds, follow, keys, followSel]) c.addEventListener('change', apply);
      fill();
      const offSel = api.on('select', () => {
        const n = fromSel();
        if (followSel.checked && n && n !== prefab) { prefab = n; fill(); apply(); }
      });
      const offChange = api.on('change', fill);
      el.replaceChildren(
        h('div', { class: 'toolbar', style: 'flex-wrap:wrap;gap:6px' }, pick,
          h('label', { class: 'row muted', style: 'gap:3px', title: T('インスペクタで選んだプレハブを、ここで試す') }, followSel, T('選んだもの')),
          speed, zoom, seconds, h('span', { class: 'muted' }, T('秒')),
          h('label', { class: 'row muted', style: 'gap:3px', title: T('カメラで追いかける（動いて画面から出ていく物）') }, follow, T('追う')),
          keys, h('button', { title: T('最初から'), onclick: () => stage.restart() }, '↻')),
        h('div', { style: 'display:flex;gap:10px;align-items:flex-start;padding:4px 8px' }, view, info));
      apply();
      return () => { offSel(); offChange(); stage.destroy(); };
    },
  },
});
