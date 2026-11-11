// 「AI」パネル: AI からの質問に答える・AI のいまの作業を見る・AI の変更を確かめる（✓ 見た / ↶ 戻す / 差分）・AI へ付箋を貼る。
// AI は ages talk（MCP の ages_talk）で作業を伝え、質問を出し、付箋に返事をする。中身は app.ai（ai.ts）
import { h, clear, time as longTime, toast } from './dom.ts';
import { T } from '../i18n.ts';
import type { App } from '../app.ts';
import type { Panel } from './layout.ts';
import type { AiItem, AiGroup, Ask, Note, Task } from '../ai.ts';

/** 今日なら時:分、ほかの日は月/日 時:分 */
const time = (iso: string): string => {
  const d = new Date(iso), now = new Date();
  return d.toDateString() === now.toDateString() ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : longTime(iso);
};
const short = (v: unknown, n = 48): string => {
  const s = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/** 今選んでいる物の住所（付箋を貼る先） */
export function selectedAddr(app: App): string {
  if (app.row) return `$${app.row.table}.${app.row.id}`;
  const s = app.sel;
  return !s ? '' : s.kind === 'prefab' ? `@${s.name}` : `${s.scene}#${s.id}`;
}

export function aiPanel(app: App): Panel {
  const ai = app.ai;
  // 答えの欄は描き直しても打った文字を残す
  const answers = new Map<string, HTMLInputElement>();
  const openDiffs = new Map<string, HTMLElement>();
  let showPast = false;

  // ---- 付箋を貼る所（描き直さない） ----
  const noteText = h('textarea', { rows: 2, placeholder: T('AI への付箋（例: 敵が硬すぎる。半分くらいに）'), style: 'width:100%;resize:vertical' }) as HTMLTextAreaElement;
  const attach = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const attachLabel = h('span', { class: 'muted' });
  const post = async () => {
    const text = noteText.value.trim();
    if (!text) return;
    await ai.note(text, attach.checked ? selectedAddr(app) || undefined : undefined);
    noteText.value = '';
  };
  noteText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void post(); } });
  const composer = h('div', { class: 'ai-compose' },
    noteText,
    h('div', { class: 'row', style: 'justify-content:space-between;gap:6px' },
      h('label', { class: 'row', style: 'gap:4px;min-width:0' }, attach, attachLabel),
      h('button', { class: 'primary', title: 'Ctrl+Enter', onclick: () => void post() }, T('📌 貼る'))));
  const renderAttach = () => {
    const a = selectedAddr(app);
    attach.disabled = !a;
    attachLabel.textContent = a ? T('選んでいる {0} に貼る', a) : T('（何も選んでいません。全体への付箋）');
  };

  const body = h('div', { class: 'ai-body' });
  const el = h('div', { class: 'ai-panel' }, body);

  const render = () => {
    renderAttach();
    const asks = ai.waitingAsks();
    const tasks = ai.activeTasks();
    const groups = ai.groups();
    const count = ai.unseen().length;
    const notes = ai.openNotes();
    clear(body,
      // AI からの質問（いちばん上。人が決めること）
      asks.length ? h('div', { class: 'ai-sec' }, h('div', { class: 'ai-head' }, T('❓ AI からの質問 {0}', asks.length)), asks.map(askCard)) : null,
      // いまの作業
      h('div', { class: 'ai-sec' }, h('div', { class: 'ai-head' }, T('🤖 いまの作業')),
        tasks.length ? tasks.map(taskCard) : h('div', { class: 'muted pad' }, T('AI は作業を伝えていません（AI が ages talk --task で伝えると、ここに出ます）'))),
      // AI の変更
      h('div', { class: 'ai-sec' },
        h('div', { class: 'ai-head row' }, h('span', { style: 'flex:1' }, T('AI の変更（確かめていない {0}）', count)),
          count ? h('button', { class: 'tiny', title: T('今あるものをすべて確かめたことにする'), onclick: () => void ai.ackAll() }, T('✓ すべて見た')) : null),
        groups.length ? groups.map(groupCard) : h('div', { class: 'muted pad' }, T('確かめていない変更はありません'))),
      // 付箋
      h('div', { class: 'ai-sec' }, h('div', { class: 'ai-head' }, T('📌 AI への付箋')), composer,
        notes.map((n) => noteRow(n, false))),
      // これまで（答えた質問・済んだ付箋・終わった作業）
      h('div', { class: 'ai-sec' },
        h('div', { class: 'ai-head row', style: 'cursor:pointer', onclick: () => { showPast = !showPast; render(); } }, `${showPast ? '▾' : '▸'} `, T('これまで')),
        showPast ? [
          ai.answeredAsks().slice(0, 20).map((a) => h('div', { class: 'ai-row muted' }, `❓ ${a.text} → `, h('b', {}, a.answer!.text), ` ${time(a.answer!.t)}`)),
          ai.doneNotes().slice(0, 20).map((n) => noteRow(n, true)),
          ai.doneTasks().slice(0, 20).map((k) => h('div', { class: 'ai-row muted' }, `✔ ${k.title}`, k.done?.text ? ` — ${k.done.text}` : '', ` ${time(k.done!.t)}`)),
        ] : null));
  };

  function askCard(a: Ask): HTMLElement {
    const input = answers.get(a.id) ?? (h('input', { type: 'text', placeholder: T('答え（自由に書く）'), style: 'flex:1' }) as HTMLInputElement);
    answers.set(a.id, input);
    const send = async (text: string) => { if (!text.trim()) return; await ai.answer(a.id, text.trim()); answers.delete(a.id); toast(T('答えました（AI は次の作業の区切りで読みます）')); };
    input.onkeydown = (e) => { if (e.key === 'Enter') void send(input.value); };
    const task = a.task ? ai.talk.tasks.find((k) => k.id === a.task) : undefined;
    return h('div', { class: 'ai-card ask' },
      h('div', {}, h('b', {}, a.text)),
      h('div', { class: 'muted' }, `${a.who} ${time(a.t)}`, task ? T(' ・作業: {0}', task.title) : '', a.about ? ' ・' : '', a.about ? addrLink(a.about) : null),
      a.choices.length ? h('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px;margin:4px 0' }, a.choices.map((c) => h('button', { onclick: () => void send(c) }, c))) : null,
      h('div', { class: 'row', style: 'gap:4px' }, input, h('button', { onclick: () => void send(input.value) }, T('答える')),
        h('button', { class: 'icon tiny', title: T('この質問を取り下げる（答えない）'), onclick: () => void ai.drop(a.id) }, '×')));
  }

  function taskCard(k: Task): HTMLElement {
    return h('div', { class: 'ai-card' },
      h('div', { class: 'row' }, h('b', { style: 'flex:1' }, k.title), h('span', { class: 'muted' }, `${k.who} ${time(k.t)}`)),
      k.steps.length ? h('ol', { class: 'ai-steps' }, k.steps.map((s, i) => h('li', { class: i + 1 < k.step ? 'done' : i + 1 === k.step ? 'now' : '' }, s))) : null,
      k.touch.length ? h('div', { class: 'row', style: 'flex-wrap:wrap;gap:4px' }, h('span', { class: 'muted' }, T('触る予定:')), k.touch.map(addrLink)) : null);
  }

  function groupCard(g: AiGroup): HTMLElement {
    const title = g.task ? g.task.title : T('（作業を伝えずにした変更）');
    const state = g.task ? (g.task.done ? T('終わった') : T('作業中')) : '';
    const undoable = g.items.some((x) => x.kind === 'edit' && x.tx);
    return h('div', { class: 'ai-card' },
      h('div', { class: 'row', style: 'gap:6px' },
        h('b', { style: 'flex:1' }, title), h('span', { class: 'muted' }, state),
        h('button', { class: 'tiny', title: T('この作業の変更をすべて確かめたことにする'), onclick: () => void ai.ack(g.items) }, T('✓ 見た')),
        undoable ? h('button', { class: 'tiny', title: T('この作業の変更をすべて元に戻す（新しい順に。その後で変えられた所があれば止まります。コードは戻りません）'), onclick: () => { if (confirm(T('「{0}」の変更を元に戻しますか？', title))) void ai.undo(g.items); } }, T('↶ 戻す')) : null),
      g.task?.done?.text ? h('div', { class: 'muted' }, T('結果: {0}', g.task.done.text)) : null,
      g.items.map(itemRow));
  }

  function itemRow(x: AiItem): HTMLElement {
    if (x.kind === 'code') {
      const c = x.change;
      const box = openDiffs.get(c.id);
      const toggle = async () => {
        if (openDiffs.has(c.id)) { openDiffs.delete(c.id); render(); return; }
        const pre = h('pre', { class: 'ai-diff' }, T('読み込み中…'));
        openDiffs.set(c.id, pre);
        render();
        try { fillDiff(pre, await ai.diff(c.id)); } catch (e) { pre.textContent = (e as Error).message; }
      };
      return h('div', {},
        h('div', { class: 'ai-row' },
          h('span', { class: 'muted' }, time(x.t)),
          h('span', { style: 'flex:1;min-width:0' }, '📄 ', h('a', { onclick: () => ai.reveal(c.path) }, c.path), ' ',
            h('span', { class: 'plus' }, `+${c.plus}`), ' ', h('span', { class: 'minus' }, `−${c.minus}`),
            c.added ? h('span', { class: 'muted' }, ' ', T('（新しく作った）')) : c.gone ? h('span', { class: 'muted' }, ' ', T('（消した）')) : null),
          h('button', { class: 'tiny', onclick: () => void toggle() }, box ? T('差分を閉じる') : T('差分')),
          h('button', { class: 'icon tiny', title: T('見た'), onclick: () => void ai.ack([x]) }, '✓')),
        box ?? null);
    }
    const first = x.entries.slice(0, 3);
    return h('div', { class: 'ai-row' },
      h('span', { class: 'muted' }, time(x.t)), ' ',
      h('span', { style: 'flex:1;min-width:0' }, first.map((e, i) => h('span', {}, i ? '、' : '', h('a', { onclick: () => ai.reveal(e.path) }, e.path), ' ',
        h('span', { class: 'muted' }, e.from !== undefined && typeof e.from !== 'object' ? `${short(e.from, 20)} → ` : ''), short(e.to, 28))),
        x.entries.length > 3 ? h('span', { class: 'muted' }, T(' ほか {0}件', x.entries.length - 3)) : null),
      h('button', { class: 'icon tiny', title: T('見た'), onclick: () => void ai.ack([x]) }, '✓'),
      x.tx ? h('button', { class: 'icon tiny', title: T('この編集を元に戻す（その後で変えられた所があれば止まります）'), onclick: () => void ai.undo([x]) }, '↶') : null);
  }

  function noteRow(n: Note, done: boolean): HTMLElement {
    return h('div', { class: `ai-row ${done ? 'muted' : ''}` },
      done ? '✔ ' : '📌 ', h('span', { style: 'flex:1;min-width:0' }, n.about ? [addrLink(n.about), ' '] : null, n.text,
        done && n.reply ? h('div', { class: 'ai-reply' }, `🤖 ${n.reply.text ?? T('済')}`) : null),
      h('span', { class: 'muted' }, ` ${time(done && n.reply ? n.reply.t : n.t)}`),
      done ? null : h('button', { class: 'icon tiny', title: T('この付箋を取り下げる'), onclick: () => void ai.drop(n.id) }, '×'));
  }

  function addrLink(a: string): HTMLElement {
    return h('a', { class: 'ai-addr', title: T('見せる'), onclick: () => ai.reveal(a) }, a);
  }

  function fillDiff(pre: HTMLElement, text: string): void {
    clear(pre, text.split('\n').map((l) => h('div', { class: l.startsWith('+') ? 'plus' : l.startsWith('-') ? 'minus' : l.startsWith('@@') ? 'muted' : '' }, l || ' ')));
  }

  app.on('ai', render);
  app.on('select', renderAttach);
  return { id: 'ai', title: T('AI'), el, render, area: 'right' };
}

/**
 * 印を付ける: data-ai="住所" の要素に、AI が変えて確かめていない（ai-unseen・来たばかりは ai-fresh）・AI が触る予定（ai-touch）・
 * 人の付箋（ai-note）の class。パネルは住所を書いておくだけでよい（描き直しを待たずに、AI の変化・描き直しのたびに付け直す）
 */
export function paintAi(app: App, root: ParentNode): void {
  const list = [...root.querySelectorAll<HTMLElement>('[data-ai]')];
  if ((root as HTMLElement).dataset?.ai) list.push(root as HTMLElement);
  for (const el of list) {
    const m = app.ai.mark(el.dataset.ai!);
    el.classList.toggle('ai-unseen', m.unseen);
    el.classList.toggle('ai-fresh', m.fresh);
    el.classList.toggle('ai-touch', m.touch);
    el.classList.toggle('ai-note', m.notes.length > 0);
    if (m.notes.length) el.dataset.aiNote = m.notes.map((n) => `📌 ${n.text}`).join('\n'); else delete el.dataset.aiNote;
  }
}

/** document（と別のウインドウ）の中の data-ai を、描き直し・AI の変化のたびに塗る */
export function watchAiMarks(app: App, doc: Document): void {
  // 描き直しでは、足された要素の中だけ塗る（ゲームの表示など、細かく変わる所で重くならないように）
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) paintAi(app, n as Element);
  }).observe(doc.body, { childList: true, subtree: true });
  // AI の変化では、全部を塗り直す
  const all = () => paintAi(app, doc);
  app.on('ai', all);
  all();
}
