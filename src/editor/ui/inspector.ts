// インスペクタ。コンポーネントの宣言（型・範囲・説明）から入力欄を自動で作る。
// 各フィールドに 🔒（AIが変更できないロック）を付けられる。人が触った値には ★ が付く。
import type { App } from '../app.ts';
import type { Field } from '../../core/schema.ts';
import { brief, defaultOf, matrixSize, typeOf, variantDefault, type ListField, type OneOfField, type StructField } from '../../core/schema.ts';
import { formatSub, getIn, setIn } from '../../core/docs.ts';
import type { Op } from '../../core/patch.ts';
import { h, clear, time, modal, toast } from './dom.ts';
import { findFrame, frameLabel, listFrames, type FrameRef, type SheetDef } from '../../core/sheet.ts';
import { buttonLabel } from '../../core/input.ts';
import { captureNext } from '../../input/devices.ts';
import { ASSET_MIME } from './assets.ts';
import { kindOf } from '../../core/assets.ts';
import type { Panel } from './layout.ts';

interface Live { path: string; comp: string; field: string; set(v: unknown): void; el: HTMLElement }

export function inspectorPanel(app: App): Panel {
  const el = h('div', {});
  let live: Live[] = [];
  // パラメータが多いとき用: ロックした値（もう人が決めた値）を隠す。設定で切り替える（人ごとにブラウザに記憶する）
  const setHide = (v: boolean) => { app.showLocked = !v; };

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
          h('input', { type: 'checkbox', checked: !app.showLocked, onchange: (e: Event) => setHide((e.target as HTMLInputElement).checked) }), `🔒を隠す${lockedHere ? `（${lockedHere}）` : ''}`)),
      h('div', { class: 'muted', style: 'margin-top:4px;font:var(--mono)' }, base, holder.tags?.length ? `  tags:${holder.tags.join(',')}` : '',
        playing ? '  ▶ 実行中（変更は停止時に保存するか選べます）' : ''));

    let hiddenCount = 0;
    const comps = Object.entries(holder.components).map(([cname, values]) => {
      const def = app.registry.components.get(cname);
      if (!def) return h('div', { class: 'comp' }, h('div', { class: 'head' }, cname, h('span', { class: 'desc', style: 'color:var(--bad)' }, '未定義のコンポーネント')));
      const entries = Object.entries(def.fields);
      const visible = !app.showLocked ? entries.filter(([fname]) => !app.state.locks[`${base}.${cname}.${fname}`]) : entries;
      hiddenCount += entries.length - visible.length;
      const rows = visible.map(([fname, f]) => {
        const path = `${base}.${cname}.${fname}`;
        const has = fname in values;
        const value = has ? values[fname] : defaultOf(f);
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
        const wctx = { comp: cname, field: fname, holder: holder!.components };
        // リスト・構造体・どれか1つ: 中まで並べて編集する。変更は中の場所ごとの操作で送る（操作ログが細かく残る）
        const nestedEmit = (op: NestedOp) => {
          if (playing) {
            const e = app.play!.game.world.get(sel.kind === 'scene' ? sel.id : '');
            if (!e?.c[cname]) return;
            e.c[cname][fname] = applyNested(e.c[cname][fname], op);
            if (savable) app.play!.edits.set(path, structuredClone(e.c[cname][fname]));
            render();
          } else app.patch([toOp(path, op)]);
        };
        const w = f.type === 'matrix'
          ? matrixWidget(app, path, value, f.cell ?? 'number')
          : isNested(f) ? { el: nestedWidget(app, f, value, path, [], nestedEmit, wctx), set: () => {} }
          : widget(app, f, value, commit, wctx);
        // ロックされた値は、ここでは見るだけ（変えるのはロックマネージャーで）
        if (lock) { w.el.setAttribute('inert', ''); w.el.classList.add('locked-value'); }
        const lockBtn = h('button', {
          class: `icon lockbtn ${lock ? 'on' : ''}`,
          title: lock ? `🔒 ロック中（${lock.who} ${time(lock.t)}）${lock.note ? '\n' + lock.note : ''}\nAI もエディタも変えられません。クリックでロックマネージャーを開く（外す・値を変える）` : 'ロックする（AI もエディタも変えられなくなります。外すのはロックマネージャーで）',
          disabled: !savable || (playing && !lock),
          onclick: () => (lock ? app.openLocks(path) : app.lock([path])),
        }, lock ? '🔒' : '🔓');
        const row = h('div', {
          class: `field ${isNested(f) ? 'wide' : ''} ${has ? '' : 'default'} ${touched ? 'touched' : ''} ${lock ? 'locked' : ''}`,
        }, h('label', { title: `${fname}: ${brief(f)}${f.desc ? '\n' + f.desc : ''}${touched ? `\n★ ${touched.who} が ${time(touched.t)} に調整` : ''}${has ? '' : '\n（省略中: 既定値）'}` }, fname), w.el, lockBtn);
        live.push({ path, comp: cname, field: fname, set: w.set, el: row });
        return row;
      });
      const allLocked = entries.length > 0 && visible.length === 0;
      return h('div', { class: 'comp' },
        h('div', { class: 'head' }, cname, h('span', { class: 'desc', title: def.desc }, allLocked ? '（すべて🔒）' : def.desc),
          cname === 'Sound' ? h('button', { class: 'icon', title: '今の設定で試しに鳴らす', onclick: () => app.previewSound(holder!.components.Sound as never) }, '▶') : null,
          !playing && savable && !entries.every(([fname]) => app.state.locks[`${base}.${cname}.${fname}`]) ? h('button', { class: 'icon', title: `${cname} の値をまとめてロックする（外すのはロックマネージャーで）`, onclick: () => app.lock(entries.map(([fname]) => `${base}.${cname}.${fname}`).filter((p2) => !app.state.locks[p2])) }, '🔓') : null,
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
  app.on('nestToggle', render);
  app.on('settings', render);
  app.on('play', render);
  return { id: 'inspector', title: 'インスペクタ', el, render };
}

export interface Ctx { comp: string; field: string; holder: Record<string, Record<string, unknown>> }

/** 同じ物の Sprite の画像に付いているスプライトシート */
function sheetOfHolder(app: App, holder: Ctx['holder']): { image: string; sheet: SheetDef; w: number; h: number } | null {
  const image = holder.Sprite?.image;
  if (typeof image !== 'string' || !image) return null;
  const sheet = app.registry.sheets.get(image);
  const info = app.state.assets.find((a) => a.path === image);
  if (!sheet || !info?.w || !info.h) return null;
  return { image, sheet, w: info.w, h: info.h };
}

export function widget(app: App, f: Field, value: unknown, commit: (v: unknown, final: boolean) => void, ctx: Ctx): { el: HTMLElement; set(v: unknown): void } {
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
      // 音量の区分を選ぶ欄は、AudioBus の付いたプレハブだけを出す
      const busOnly = (ctx.comp === 'Sound' && ctx.field === 'bus') || (ctx.comp === 'AudioBus' && ctx.field === 'parent');
      const prefabs = Object.values(app.state.prefabs).filter((p) => !busOnly || p.components.AudioBus).map((p) => p.name);
      const options = f.type === 'enum' ? f.options : [...(f.default === '' ? [''] : []), ...prefabs];
      if (f.type === 'prefab' && typeof value === 'string' && !options.includes(value)) options.push(value);
      const label = (o: string) => (o === '' ? (busOnly ? '（なし: 全体の直下）' : '（なし）') : o);
      const sel = h('select', {}, options.map((o) => h('option', { value: o, selected: o === value }, label(o)))) as HTMLSelectElement;
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
      // 名前を先に見せる（長い場所は欄に収まらないので）
      const label = (o: string) => (o.includes('/') ? `${o.slice(o.lastIndexOf('/') + 1)} — ${o.slice(0, o.lastIndexOf('/'))}` : o);
      const sel = h('select', { style: 'min-width:0;flex:1', title: cur }, options.map((o) => h('option', { value: o, selected: o === cur },
        o === '' ? '（なし）' : files.includes(o) ? label(o) : `${label(o)}（見つかりません）`))) as HTMLSelectElement;
      const thumb = h('img', { class: 'asset-thumb', alt: '' }) as HTMLImageElement;
      const show = (v: string) => {
        if (f.kind === 'image' && v && files.includes(v)) { thumb.src = app.assetUrl(v); thumb.style.display = ''; } else thumb.style.display = 'none';
      };
      show(cur);
      sel.addEventListener('change', () => { show(sel.value); commit(sel.value, true); });
      thumb.addEventListener('click', () => { if (sel.value) app.emit('openSprite', sel.value); });
      wrap.append(thumb, sel);
      // アセットの画面からドラッグして入れられる（種類が合うものだけ）
      wrap.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes(ASSET_MIME)) return;
        e.preventDefault();
        wrap.classList.add('drop-on');
      });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-on'));
      wrap.addEventListener('drop', (e) => {
        wrap.classList.remove('drop-on');
        const path = e.dataTransfer?.getData(ASSET_MIME);
        if (!path) return;
        e.preventDefault();
        if (kindOf(path) !== f.kind) return toast(`${path} は${({ image: '画像', sound: '音', font: 'フォント' })[f.kind]}ではありません`, 'bad');
        sel.value = path;
        show(path);
        commit(path, true);
      });
      wrap.append(h('button', { class: 'icon', title: 'アセットの画面で見る（使っている所・名前の変更・移動）', onclick: () => { if (sel.value) app.emit('revealAsset', sel.value); } }, '◎'));
      if (f.kind === 'image') wrap.append(h('button', { class: 'icon', title: 'この画像の切り方（コマ・基準点・動き）を開く', onclick: () => { if (sel.value) app.emit('openSprite', sel.value); } }, '✂'));
      if (f.kind === 'sound') {
        thumb.remove();
        const info = () => app.state.assets.find((a) => a.path === sel.value);
        wrap.append(h('button', { class: 'icon', title: 'このファイルを試しに鳴らす', onclick: () => { if (sel.value) app.previewSound({ ...(ctx.comp === 'Sound' ? ctx.holder.Sound : {}), clip: sel.value } as never); } }, '▶'),
          h('span', { class: 'muted', style: 'font-size:11px' }, info()?.sec !== undefined ? `${info()!.sec}s` : ''));
      }
      return { el: wrap, set: (v) => { sel.value = String(v ?? ''); show(String(v ?? '')); } };
    }
    case 'row': {
      // 表の行から選ぶ
      const ids = (app.registry.tableData.get(f.table)?.rows ?? []).map((r) => r.id);
      const cur = String(value ?? '');
      const options = [...(f.default === '' ? [''] : []), ...ids];
      if (!options.includes(cur)) options.push(cur);
      const sel = h('select', { title: `表 ${f.table} の行` }, options.map((o) => h('option', { value: o, selected: o === cur }, o === '' ? '（なし）' : ids.includes(o) ? o : `${o}（表にありません）`))) as HTMLSelectElement;
      sel.addEventListener('change', () => commit(sel.value, true));
      wrap.append(sel, h('button', { class: 'icon row-open', title: `表 ${f.table} を開く`, onclick: () => app.emit('openTable', { name: f.table, row: sel.value }) }, '▦'));
      return { el: wrap, set: (v) => { sel.value = String(v); } };
    }
    case 'scene': {
      const names = Object.keys(app.state.scenes);
      const cur = String(value ?? '');
      const options = [...(f.default === '' ? [''] : []), ...names];
      if (!options.includes(cur)) options.push(cur);
      const sel = h('select', { title: 'シーン' }, options.map((o) => h('option', { value: o, selected: o === cur }, o === '' ? '（なし）' : names.includes(o) ? o : `${o}（ありません）`))) as HTMLSelectElement;
      sel.addEventListener('change', () => commit(sel.value, true));
      wrap.append(sel);
      return { el: wrap, set: (v) => { sel.value = String(v); } };
    }
    case 'input': {
      // ボタン・軸の名前。「押して決める」で、次に押したキー・マウス・パッドのボタン（analog なら倒した軸）が入る
      const t = h('input', { type: 'text', value: String(value ?? ''), style: 'width:110px;font:var(--mono)', title: f.analog ? '軸の名前（例 Pad.LX）' : 'ボタンの名前（例 KeyZ, Space, Mouse0, Pad.A）' }) as HTMLInputElement;
      const label = h('span', { class: 'muted input-label' });
      const show = (v: string) => { label.textContent = v ? buttonLabel(v) : ''; label.style.display = v && buttonLabel(v) !== v ? '' : 'none'; };
      show(String(value ?? ''));
      t.addEventListener('change', () => { show(t.value.trim()); commit(t.value.trim(), true); });
      const pick = h('button', { class: 'icon', title: f.analog ? '倒して決める: 次に大きく倒したスティック・トリガーが入る' : '押して決める: 次に押したキー・マウス・パッドのボタンが入る', onclick: () => capture(!!f.analog, (code) => { t.value = code; show(code); commit(code, true); }) }, '⌨');
      wrap.append(t, label, pick);
      return { el: wrap, set: (v) => { t.value = String(v ?? ''); show(String(v ?? '')); } };
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

// ---------- リスト・構造体・どれか1つ ----------

/** 入れ子の値への操作（sub はフィールドの中の場所） */
export type NestedOp =
  | { kind: 'set'; sub: (string | number)[]; value: unknown }
  | { kind: 'insert'; sub: (string | number)[]; value?: unknown }
  | { kind: 'remove'; sub: (string | number)[] }
  | { kind: 'move'; sub: (string | number)[]; to: number };

export const isNested = (f: Field): f is ListField | StructField | OneOfField => f.type === 'list' || f.type === 'struct' || f.type === 'oneOf';

export function toOp(path: string, op: NestedOp): Op {
  const at = path + formatSub(op.sub);
  if (op.kind === 'set') return { op: 'set', path: at, value: op.value };
  if (op.kind === 'insert') return { op: 'insert', path: at, ...(op.value !== undefined ? { value: op.value } : {}) };
  if (op.kind === 'remove') return { op: 'removeItem', path: at };
  return { op: 'moveItem', path: at, to: op.to };
}

/** 実行中の値に、その場で操作を当てる */
export function applyNested(top: unknown, op: NestedOp): unknown {
  if (op.kind === 'set') return setIn(top, op.sub, op.value);
  if (op.kind === 'insert') return setIn(top, op.sub, [...((getIn(top, op.sub) as unknown[]) ?? []), op.value]);
  const listSub = op.sub.slice(0, -1), i = op.sub[op.sub.length - 1] as number;
  const list = [...((getIn(top, listSub) as unknown[]) ?? [])];
  const [item] = list.splice(i, 1);
  if (op.kind === 'move') list.splice(op.to, 0, item);
  return setIn(top, listSub, list);
}

/** 開いているリスト（描き直しても閉じないよう覚えておく） */
const opened = new Set<string>();

/** 表のセルなどに出す短い要約 */
export const valueSummary = (f: Field, v: unknown): string => {
  if (f.type === 'list') {
    const a = Array.isArray(v) ? v : [];
    // ボタンの割り当てなどの短いリストは、中身をそのまま見せる
    const text = f.of.type === 'input' ? a.map((x) => buttonLabel(String(x))).join(' / ')
      : ['string', 'number', 'int', 'enum', 'row', 'prefab', 'bool'].includes(f.of.type) ? a.map((x) => String(x)).join(', ') : '';
    if (!a.length) return '（なし）';
    return text && text.length <= 32 ? text : `${a.length}件`;
  }
  if (f.type === 'oneOf') return String((v as { kind?: string } | null)?.kind ?? '');
  if (f.type === 'struct') return '';
  const s = JSON.stringify(v) ?? '';
  return s.length > 24 ? s.slice(0, 22) + '…' : s;
};

/** リスト・構造体・どれか1つを、中まで編集する部品（入れ子にもなる） */
export function nestedWidget(app: App, f: Field, value: unknown, path: string, sub: (string | number)[], emit: (op: NestedOp) => void, ctx: Ctx): HTMLElement {
  const key = path + formatSub(sub);
  const leaf = (lf: Field, lv: unknown, lsub: (string | number)[]): HTMLElement => {
    if (isNested(lf)) return nestedWidget(app, lf, lv, path, lsub, emit, ctx);
    if (lf.type === 'matrix') return h('span', { class: 'muted' }, `行列${matrixSize(lv)}（JSON で編集）`);
    return widget(app, lf, lv, (v, final) => { if (final) emit({ kind: 'set', sub: lsub, value: v }); }, ctx).el;
  };
  const row = (label: string, title: string, el: HTMLElement, ...tools: (HTMLElement | null)[]) =>
    h('div', { class: 'nest-row' }, h('span', { class: 'nest-label', title }, label), h('div', { class: 'nest-val' }, el), ...tools);

  if (f.type === 'list') {
    const list = Array.isArray(value) ? value : [];
    const open = opened.has(key) || list.length <= 3;
    const toggle = h('button', { class: 'icon', title: open ? '閉じる' : '開く', onclick: () => { if (opened.has(key)) opened.delete(key); else opened.add(key); app.emit('nestToggle'); } }, open ? '▾' : '▸');
    const add = h('button', { class: 'icon', title: `最後に足す（${typeOf(f.of)}）`, disabled: f.max !== undefined && list.length >= f.max, onclick: () => emit({ kind: 'insert', sub, value: defaultOf(f.of) }) }, '＋');
    const items = open ? list.map((v, i) => row(`[${i}]`, `${key}[${i}]`, leaf(f.of, v, [...sub, i]),
      h('button', { class: 'icon tiny', title: '上へ', disabled: i === 0, onclick: () => emit({ kind: 'move', sub: [...sub, i], to: i - 1 }) }, '↑'),
      h('button', { class: 'icon tiny', title: '下へ', disabled: i === list.length - 1, onclick: () => emit({ kind: 'move', sub: [...sub, i], to: i + 1 }) }, '↓'),
      h('button', { class: 'icon tiny', title: '消す', disabled: f.min !== undefined && list.length <= f.min, onclick: () => emit({ kind: 'remove', sub: [...sub, i] }) }, '×'))) : [];
    const t = typeOf(f.of);
    return h('div', { class: 'nest' }, h('div', { class: 'nest-head', title: `${list.length}件 list<${t}>` }, toggle, h('span', { class: 'muted' }, `${list.length}件${t.length <= 20 ? ' ' + t : ''}`), add), items);
  }
  if (f.type === 'struct') {
    const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return h('div', { class: 'nest' }, Object.entries(f.fields).map(([k, sf]) => row(k, `${k}: ${typeOf(sf)}${sf.desc ? '\n' + sf.desc : ''}`, leaf(sf, k in obj ? obj[k] : defaultOf(sf), [...sub, k]))));
  }
  // どれか1つ: 種類を選ぶと、その種類の既定値に入れ替わる
  const o = f as OneOfField;
  const obj = (value && typeof value === 'object' ? value : defaultOf(o)) as Record<string, unknown>;
  const kind = String(obj.kind ?? Object.keys(o.variants)[0]);
  const pick = h('select', {}, Object.entries(o.variants).map(([k, v]) => h('option', { value: k, selected: k === kind, title: v.desc ?? '' }, k))) as HTMLSelectElement;
  pick.addEventListener('change', () => emit({ kind: 'set', sub, value: variantDefault(pick.value, o.variants[pick.value].fields) }));
  const fields = o.variants[kind]?.fields ?? {};
  return h('div', { class: 'nest' }, row('kind', o.variants[kind]?.desc ?? '種類', pick),
    Object.entries(fields).map(([k, sf]) => row(k, `${k}: ${typeOf(sf)}${sf.desc ? '\n' + sf.desc : ''}`, leaf(sf, k in obj ? obj[k] : defaultOf(sf), [...sub, k]))));
}

/** 「押して決める」の画面。次に押されたボタン（analog なら大きく倒した軸）を返す */
function capture(analog: boolean, done: (code: string) => void): void {
  modal((close) => {
    const area = h('div', { class: 'capture-area', tabindex: 0 }, analog ? 'スティックかトリガーを大きく倒してください' : 'キーかゲームパッドのボタンを押してください\n（この枠の中でクリックすると、マウスのボタン）');
    const stop = captureNext((code) => { close(); done(code); }, { analog, target: area, alive: () => area.isConnected });
    return h('div', {},
      h('h3', {}, analog ? '軸を決める' : 'ボタンを決める'),
      area,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' }, h('button', { onclick: () => { stop(); close(); } }, '取り消す')));
  });
}
