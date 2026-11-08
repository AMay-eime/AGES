// インスペクタ。コンポーネントの宣言（型・範囲・説明）から入力欄を自動で作る。
// 各フィールドに 🔒（AIが変更できないロック）を付けられる。人が触った値には ★ が付く。
import type { App } from '../app.ts';
import type { Field } from '../../core/schema.ts';
import { brief } from '../../core/schema.ts';
import { h, clear, time } from './dom.ts';
import type { Panel } from './layout.ts';

interface Live { path: string; comp: string; field: string; set(v: unknown): void; el: HTMLElement }

export function inspectorPanel(app: App): Panel {
  const el = h('div', {});
  let live: Live[] = [];

  const render = () => {
    live = [];
    const sel = app.sel;
    if (!app.state || app.state.error || !app.registry) return clear(el, h('div', { class: 'pad muted' }, app.state?.error ?? '読み込み中…'));
    if (!sel) return clear(el, h('div', { class: 'pad muted' }, '階層・ゲーム画面・プロジェクトから選ぶと、ここに表示されます。'));

    const playing = !!app.play && sel.kind === 'scene';
    const base = sel.kind === 'scene' ? `${sel.scene}#${sel.id}` : `@${sel.name}`;
    let holder: { name?: string; tags?: string[]; components: Record<string, Record<string, unknown>> } | undefined;
    if (playing) {
      const e = app.play!.game.world.get(sel.id);
      holder = e ? { name: e.name, tags: e.tags, components: e.c } : undefined;
    } else if (sel.kind === 'scene') {
      holder = app.state.scenes[sel.scene]?.entities.find((e) => e.id === sel.id);
    } else {
      holder = app.state.prefabs[sel.name];
    }
    if (!holder) return clear(el, h('div', { class: 'pad muted' }, playing ? `${sel.kind === 'scene' ? sel.id : ''} はもう存在しません` : '見つかりません'));
    const savable = sel.kind === 'prefab' || !!app.state.scenes[sel.scene]?.entities.some((e) => e.id === sel.id);

    const nameInput = h('input', {
      type: 'text', value: holder.name ?? '', style: 'flex:1;font-weight:600', disabled: playing,
      onchange: () => app.patch([{ op: 'rename', target: base, name: nameInput.value }]),
    });
    const head = h('div', { class: 'pad', style: 'border-bottom:1px solid var(--line)' },
      h('div', { class: 'row' }, nameInput),
      h('div', { class: 'muted', style: 'margin-top:4px;font:var(--mono)' }, base, holder.tags?.length ? `  tags:${holder.tags.join(',')}` : '',
        playing ? '  ▶ 実行中（変更は停止時に保存するか選べます）' : ''));

    const comps = Object.entries(holder.components).map(([cname, values]) => {
      const def = app.registry.components.get(cname);
      if (!def) return h('div', { class: 'comp' }, h('div', { class: 'head' }, cname, h('span', { class: 'desc', style: 'color:var(--bad)' }, '未定義のコンポーネント')));
      const rows = Object.entries(def.fields).map(([fname, f]) => {
        const path = `${base}.${cname}.${fname}`;
        const has = fname in values;
        const value = has ? values[fname] : f.default;
        const lock = app.state.locks[path];
        const touched = app.state.touched[path];
        const commit = (v: unknown, final: boolean) => {
          if (playing) {
            const e = app.play!.game.world.get(sel.kind === 'scene' ? sel.id : '');
            if (e?.c[cname]) e.c[cname][fname] = v;
            if (final && savable) app.play!.edits.set(path, v);
          } else if (final) {
            app.patch([{ op: 'set', path, value: v }]);
          }
        };
        const w = widget(app, f, value, commit);
        const lockBtn = h('button', {
          class: `icon lockbtn ${lock ? 'on' : ''}`,
          title: lock ? `🔒 ロック中（${lock.who} ${time(lock.t)}）${lock.note ? '\n' + lock.note : ''}\nAIはこの値を変更できません。クリックで解除` : 'ロックする（AIが変更できなくなります）',
          disabled: !savable,
          onclick: () => app.setLock([path], !lock),
        }, lock ? '🔒' : '🔓');
        const row = h('div', {
          class: `field ${has ? '' : 'default'} ${touched ? 'touched' : ''} ${lock ? 'locked' : ''}`,
        }, h('label', { title: `${fname}: ${brief(f)}${f.desc ? '\n' + f.desc : ''}${touched ? `\n★ ${touched.who} が ${time(touched.t)} に調整` : ''}${has ? '' : '\n（省略中: 既定値）'}` }, fname), w.el, lockBtn);
        live.push({ path, comp: cname, field: fname, set: w.set, el: row });
        return row;
      });
      return h('div', { class: 'comp' },
        h('div', { class: 'head' }, cname, h('span', { class: 'desc', title: def.desc }, def.desc),
          !playing && h('button', { class: 'icon', title: `${cname} を外す`, onclick: () => app.patch([{ op: 'removeComponent', target: base, component: cname }]) }, '×')),
        rows);
    });

    const missing = [...app.registry.components.keys()].filter((n) => !(n in holder!.components));
    const add = !playing && missing.length
      ? h('div', { class: 'pad' }, h('select', {
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v) app.patch([{ op: 'addComponent', target: base, component: v }]);
        },
      }, h('option', { value: '' }, '＋ コンポーネントを追加…'), missing.map((n) => h('option', { value: n }, `${n} — ${app.registry.components.get(n)!.desc}`))))
      : null;

    clear(el, head, comps, add);
  };

  // 実行中は値を画面に流し込む（入力中の欄は触らない）
  setInterval(() => {
    if (!app.play || app.sel?.kind !== 'scene') return;
    const e = app.play.game.world.get(app.sel.id);
    if (!e) return;
    for (const l of live) {
      if (l.el.contains(document.activeElement)) continue;
      const v = e.c[l.comp]?.[l.field];
      if (v !== undefined) l.set(v);
    }
  }, 120);

  app.on('change', render);
  app.on('select', render);
  app.on('play', render);
  return { id: 'inspector', title: 'インスペクタ', el, render };
}

function widget(app: App, f: Field, value: unknown, commit: (v: unknown, final: boolean) => void): { el: HTMLElement; set(v: unknown): void } {
  const wrap = h('div', { class: 'ctl' });
  switch (f.type) {
    case 'number':
    case 'int': {
      const step = f.type === 'int' ? 1 : f.step ?? 'any';
      const num = h('input', { type: 'number', step: String(step), value: String(value), min: f.min ?? '', max: f.max ?? '' }) as HTMLInputElement;
      const parse = (s: string) => (f.type === 'int' ? Math.round(Number(s)) : Number(s));
      num.addEventListener('change', () => commit(parse(num.value), true));
      wrap.append(num);
      let range: HTMLInputElement | null = null;
      if (f.min !== undefined && f.max !== undefined) {
        range = h('input', { type: 'range', min: String(f.min), max: String(f.max), step: String(f.type === 'int' ? 1 : f.step ?? (f.max - f.min) / 200), value: String(value) }) as HTMLInputElement;
        range.addEventListener('input', () => { num.value = range!.value; commit(parse(range!.value), false); });
        range.addEventListener('change', () => commit(parse(range!.value), true));
        wrap.append(range);
      }
      return { el: wrap, set: (v) => { num.value = String(round(v as number)); if (range) range.value = String(v); } };
    }
    case 'bool': {
      const cb = h('input', { type: 'checkbox', checked: !!value }) as HTMLInputElement;
      cb.addEventListener('change', () => commit(cb.checked, true));
      wrap.append(cb);
      return { el: wrap, set: (v) => { cb.checked = !!v; } };
    }
    case 'enum':
    case 'prefab': {
      const options = f.type === 'enum' ? f.options : Object.keys(app.state.prefabs);
      const sel = h('select', {}, options.map((o) => h('option', { value: o, selected: o === value }, o))) as HTMLSelectElement;
      sel.addEventListener('change', () => commit(sel.value, true));
      wrap.append(sel);
      return { el: wrap, set: (v) => { sel.value = String(v); } };
    }
    case 'color': {
      const c = h('input', { type: 'color', value: String(value).slice(0, 7) }) as HTMLInputElement;
      const t = h('input', { type: 'text', value: String(value), style: 'width:84px;font:var(--mono)' }) as HTMLInputElement;
      c.addEventListener('input', () => { t.value = c.value; commit(c.value, false); });
      c.addEventListener('change', () => commit(c.value, true));
      t.addEventListener('change', () => commit(t.value, true));
      wrap.append(c, t);
      return { el: wrap, set: (v) => { t.value = String(v); c.value = String(v).slice(0, 7); } };
    }
    case 'vec2': {
      const [x, y] = (value as [number, number]) ?? [0, 0];
      const a = h('input', { type: 'number', step: 'any', value: String(x) }) as HTMLInputElement;
      const b = h('input', { type: 'number', step: 'any', value: String(y) }) as HTMLInputElement;
      const send = () => commit([Number(a.value), Number(b.value)], true);
      a.addEventListener('change', send);
      b.addEventListener('change', send);
      wrap.append(a, b);
      return { el: wrap, set: (v) => { const [p, q] = v as [number, number]; a.value = String(p); b.value = String(q); } };
    }
    default: {
      const t = h('input', { type: 'text', value: value === null ? '' : String(value) }) as HTMLInputElement;
      t.addEventListener('change', () => commit(f.type === 'ref' && t.value === '' ? null : t.value, true));
      wrap.append(t);
      return { el: wrap, set: (v) => { t.value = v === null ? '' : String(v); } };
    }
  }
}

const round = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000);
