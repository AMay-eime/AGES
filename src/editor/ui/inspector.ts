// インスペクタ。コンポーネントの宣言（型・範囲・説明）から入力欄を自動で作る。
// 各フィールドに 🔒（AIが変更できないロック）を付けられる。人が触った値には ★ が付く。
import type { App } from '../app.ts';
import type { Field } from '../../core/schema.ts';
import { brief, matrixSize } from '../../core/schema.ts';
import { h, clear, time, modal } from './dom.ts';
import { findFrame, frameLabel, listFrames, type FrameRef, type SheetDef } from '../../core/sheet.ts';
import type { Panel } from './layout.ts';

interface Live { path: string; comp: string; field: string; set(v: unknown): void; el: HTMLElement }

export function inspectorPanel(app: App): Panel {
  const el = h('div', {});
  let live: Live[] = [];
  // パラメータが多いとき用: ロックした値（もう人が決めた値）を隠す。人ごとにブラウザに記憶する
  let hideLocked = localStorage.getItem('ages.hideLocked') === '1';
  const setHide = (v: boolean) => { hideLocked = v; localStorage.setItem('ages.hideLocked', v ? '1' : '0'); render(); };

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
    const lockedHere = Object.keys(app.state.locks).filter((k) => k.startsWith(base + '.')).length;
    const head = h('div', { class: 'pad', style: 'border-bottom:1px solid var(--line)' },
      h('div', { class: 'row' }, nameInput,
        h('label', { class: 'row muted', style: 'gap:4px;white-space:nowrap', title: 'ロックした値を表示しない（人が決め終えた値を画面から外して、残りに集中する）' },
          h('input', { type: 'checkbox', checked: hideLocked, onchange: (e: Event) => setHide((e.target as HTMLInputElement).checked) }), `🔒を隠す${lockedHere ? `（${lockedHere}）` : ''}`)),
      h('div', { class: 'muted', style: 'margin-top:4px;font:var(--mono)' }, base, holder.tags?.length ? `  tags:${holder.tags.join(',')}` : '',
        playing ? '  ▶ 実行中（変更は停止時に保存するか選べます）' : ''));

    let hiddenCount = 0;
    const comps = Object.entries(holder.components).map(([cname, values]) => {
      const def = app.registry.components.get(cname);
      if (!def) return h('div', { class: 'comp' }, h('div', { class: 'head' }, cname, h('span', { class: 'desc', style: 'color:var(--bad)' }, '未定義のコンポーネント')));
      const entries = Object.entries(def.fields);
      const visible = hideLocked ? entries.filter(([fname]) => !app.state.locks[`${base}.${cname}.${fname}`]) : entries;
      hiddenCount += entries.length - visible.length;
      const rows = visible.map(([fname, f]) => {
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
        const w = f.type === 'matrix'
          ? matrixWidget(app, path, value, f.cell ?? 'number')
          : widget(app, f, value, commit, { comp: cname, field: fname, holder: holder!.components });
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
      const allLocked = entries.length > 0 && visible.length === 0;
      return h('div', { class: 'comp' },
        h('div', { class: 'head' }, cname, h('span', { class: 'desc', title: def.desc }, allLocked ? '（すべて🔒）' : def.desc),
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

    const note = hiddenCount
      ? h('div', { class: 'pad muted', style: 'font-size:12px;cursor:pointer', onclick: () => setHide(false) }, `🔒 ロック中の ${hiddenCount} 項目を隠しています（クリックで表示）`)
      : null;
    clear(el, head, note, comps, add);
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

interface Ctx { comp: string; field: string; holder: Record<string, Record<string, unknown>> }

/** 同じ物の Sprite の画像に付いているスプライトシート */
function sheetOfHolder(app: App, holder: Ctx['holder']): { image: string; sheet: SheetDef; w: number; h: number } | null {
  const image = holder.Sprite?.image;
  if (typeof image !== 'string' || !image) return null;
  const sheet = app.registry.sheets.get(image);
  const info = app.state.assets.find((a) => a.path === image);
  if (!sheet || !info?.w || !info.h) return null;
  return { image, sheet, w: info.w, h: info.h };
}

function widget(app: App, f: Field, value: unknown, commit: (v: unknown, final: boolean) => void, ctx: Ctx): { el: HTMLElement; set(v: unknown): void } {
  // 標準の Sprite.frame はシートの絵から選べる。Animator.clip はシートの動き一覧から選べる
  if (ctx.comp === 'Sprite' && ctx.field === 'frame') {
    const s = sheetOfHolder(app, ctx.holder);
    if (s) return frameWidget(app, s, value as FrameRef, commit);
  }
  if (ctx.comp === 'Animator' && ctx.field === 'clip') {
    const s = sheetOfHolder(app, ctx.holder);
    const clips = Object.keys(s?.sheet.clips ?? {});
    if (clips.length) {
      const wrap = h('div', { class: 'ctl' });
      const options = clips.includes(String(value)) ? clips : [String(value), ...clips];
      const sel = h('select', {}, options.map((o) => h('option', { value: o, selected: o === value }, clips.includes(o) ? `${o}（${s!.sheet.clips![o].frames.length}コマ ${s!.sheet.clips![o].fps}fps）` : `${o}（シートにありません）`))) as HTMLSelectElement;
      sel.addEventListener('change', () => commit(sel.value, true));
      wrap.append(sel);
      return { el: wrap, set: (v) => { sel.value = String(v); } };
    }
  }
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
    case 'asset': {
      // そのプロジェクトにある、種類の合うファイルから選ぶ。画像なら小さく表示する
      const files = app.state.assets.filter((a) => a.kind === f.kind).map((a) => a.path);
      const cur = String(value ?? '');
      const options = ['', ...files];
      if (cur && !files.includes(cur)) options.splice(1, 0, cur);
      const sel = h('select', { style: 'min-width:0;flex:1' }, options.map((o) => h('option', { value: o, selected: o === cur },
        o === '' ? '（なし）' : files.includes(o) ? o : `${o}（見つかりません）`))) as HTMLSelectElement;
      const thumb = h('img', { class: 'asset-thumb', alt: '' }) as HTMLImageElement;
      const show = (v: string) => {
        if (f.kind === 'image' && v && files.includes(v)) { thumb.src = app.assetUrl(v); thumb.style.display = ''; } else thumb.style.display = 'none';
      };
      show(cur);
      sel.addEventListener('change', () => { show(sel.value); commit(sel.value, true); });
      thumb.addEventListener('click', () => { if (sel.value) app.emit('openSprite', sel.value); });
      wrap.append(thumb, sel);
      if (f.kind === 'image') wrap.append(h('button', { class: 'icon', title: 'この画像の切り方（コマ・基準点・動き）を開く', onclick: () => { if (sel.value) app.emit('openSprite', sel.value); } }, '✂'));
      return { el: wrap, set: (v) => { sel.value = String(v ?? ''); show(String(v ?? '')); } };
    }
    case 'frame': {
      // シートがない画像: 番号か名前を直接入れる。切り方の画面へも行ける
      const t = h('input', { type: 'text', value: String(value ?? 0), style: 'width:80px' }) as HTMLInputElement;
      t.addEventListener('change', () => commit(/^\d+$/.test(t.value.trim()) ? Number(t.value) : t.value.trim(), true));
      const image = ctx.holder.Sprite?.image;
      wrap.append(t);
      if (typeof image === 'string' && image) wrap.append(h('button', { title: 'この画像をコマに切る', onclick: () => app.emit('openSprite', image) }, '✂ 切る'));
      return { el: wrap, set: (v) => { t.value = String(v); } };
    }
    default: {
      const t = h('input', { type: 'text', value: value === null ? '' : String(value) }) as HTMLInputElement;
      t.addEventListener('change', () => commit(f.type === 'ref' && t.value === '' ? null : t.value, true));
      wrap.append(t);
      return { el: wrap, set: (v) => { t.value = v === null ? '' : String(v); } };
    }
  }
}

/** 行列はインスペクタに直接並べず、大きさだけ表示して専用の行列エディタで開く */
function matrixWidget(app: App, path: string, value: unknown, cell: string): { el: HTMLElement; set(v: unknown): void } {
  const size = h('span', { class: 'muted', style: 'font:var(--mono)' }, `${matrixSize(value)} ${cell}`);
  const wrap = h('div', { class: 'ctl' }, size,
    h('button', { onclick: () => app.emit('openMatrix', path), title: '行列エディタで確認・編集' }, '開く'),
    h('button', { class: 'icon', title: '別のウインドウで開く', onclick: () => window.open(`/?solo=matrix&path=${encodeURIComponent(path)}`, `ages-matrix-${path}`, 'width=900,height=640') }, '↗'));
  return { el: wrap, set: (v) => { size.textContent = `${matrixSize(v)} ${cell}`; } };
}

/** スプライトシートのコマ。番号か名前を入れられるし、絵を見てクリックでも選べる（名前のあるコマは名前で入る） */
function frameWidget(app: App, s: { image: string; sheet: SheetDef; w: number; h: number }, value: FrameRef, commit: (v: unknown, final: boolean) => void): { el: HTMLElement; set(v: unknown): void } {
  const all = listFrames(s.sheet, s.w, s.h);
  const count = all.length;
  const num = h('input', { type: 'text', value: String(value ?? 0), style: 'width:90px;font:var(--mono)', title: '番号（0から）か名前' }) as HTMLInputElement;
  const preview = h('canvas', { width: 28, height: 28, class: 'asset-thumb', title: 'クリックで絵から選ぶ' }) as HTMLCanvasElement;
  const img = new Image();
  img.src = app.assetUrl(s.image);
  const parse = (t: string): FrameRef => (/^\d+$/.test(t.trim()) ? Number(t) : t.trim());
  const paint = (ref: FrameRef) => {
    const g = preview.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 28, 28);
    const f = findFrame(s.sheet, s.w, s.h, ref);
    if (!img.complete || !img.naturalWidth || !f) return;
    const k = Math.min(28 / f.w, 28 / f.h);
    g.drawImage(img, f.x, f.y, f.w, f.h, (28 - f.w * k) / 2, (28 - f.h * k) / 2, f.w * k, f.h * k);
  };
  img.onload = () => paint(parse(num.value));
  num.addEventListener('change', () => { const v = parse(num.value); paint(v); commit(v, true); });
  const pick = () => modal((close) => {
    const zoom = Math.max(1, Math.min(4, Math.floor(560 / s.w)));
    const cur = findFrame(s.sheet, s.w, s.h, parse(num.value));
    const grid = h('div', { class: 'frame-grid', style: `position:relative;width:${s.w * zoom}px;height:${s.h * zoom}px;background:url("${app.assetUrl(s.image)}") 0 0 / ${s.w * zoom}px ${s.h * zoom}px no-repeat` });
    for (const f of all) {
      grid.append(h('button', {
        class: `frame-cell ${f.index === cur?.index ? 'on' : ''}`,
        title: frameLabel(f),
        style: `left:${f.x * zoom}px;top:${f.y * zoom}px;width:${f.w * zoom}px;height:${f.h * zoom}px`,
        onclick: () => { const v = f.name ?? f.index; num.value = String(v); paint(v); commit(v, true); close(); },
      }));
    }
    const clips = Object.entries(s.sheet.clips ?? {}).map(([n, c]) => `${n}: ${c.frames.join(',')}`).join('  ');
    const kind = s.sheet.frames ? '自由な矩形' : `格子 ${s.sheet.frame!.join('x')}px`;
    return h('div', {}, h('h3', {}, `コマを選ぶ — ${s.image}`),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, `${count}コマ（${kind}）${clips ? `　動き ${clips}` : ''}`),
      h('div', { style: 'overflow:auto;max-height:60vh' }, grid),
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' },
        h('button', { onclick: () => { close(); app.emit('openSprite', s.image); } }, '✂ 切り方を編集'),
        h('button', { onclick: close }, '閉じる')));
  });
  preview.addEventListener('click', pick);
  const wrap = h('div', { class: 'ctl' }, preview, num, h('button', { onclick: pick, title: '絵を見て選ぶ' }, '選ぶ'), h('span', { class: 'muted' }, `/${count}`));
  return { el: wrap, set: (v) => { num.value = String(v); paint(v as FrameRef); } };
}

const round = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000);
