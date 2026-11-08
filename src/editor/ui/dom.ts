// 小さなDOMヘルパー（依存ゼロ）。

type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function toast(text: string, kind: '' | 'bad' | 'lock' = '', ms = 4000): void {
  const box = document.getElementById('toasts')!;
  const t = h('div', { class: `toast ${kind}` }, text);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** モーダル。中身を作る関数に close を渡す。 */
export function modal(build: (close: () => void) => Node): void {
  const bg = h('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  bg.appendChild(h('div', { class: 'modal' }, build(close)));
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.body.appendChild(bg);
}

/** 右クリックなどのメニュー */
export function menu(x: number, y: number, items: [string, () => void][]): void {
  document.querySelector('.menu')?.remove();
  const m = h('div', { class: 'menu', style: `left:${x}px;top:${y}px` }, items.map(([label, fn]) => h('div', { onclick: () => { m.remove(); fn(); } }, label)));
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!m.contains(e.target as Node)) { m.remove(); document.removeEventListener('mousedown', off); }
  }), 0);
}

export function time(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
