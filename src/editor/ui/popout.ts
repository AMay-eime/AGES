// タブを別のウインドウに出す。パネルの要素をそのまま新しいウインドウへ移すだけなので、動かしているのは元のエディタのまま
// （選んでいる物・再生・元に戻す・拡張の API・ファイルの変更の知らせが、そのままつながる。別のエディタを開くのではない）。
// 閉じると元の場所へ戻る。エディタを読み込み直すと閉じる（開き直すのは人の操作で。ブラウザは操作なしにウインドウを開けない）。
//
// 別のウインドウで起きたことを、元のエディタのコードが同じように受け取れるようにする:
// - メニュー・ダイアログ・知らせ・confirm は、人が操作しているウインドウに出す（dom.ts の here）
// - mousemove・mouseup・キー・大きさの変更は、元の document・window にも送る（ドラッグ・Ctrl+Z などが同じに動く）
// - document.activeElement は、人が操作しているウインドウのもの（「入力中の欄は書き換えない」を確かめる拡張のため）
// - 見た目（style・link）は写し、後から足された拡張の css も写す
// - 元のウインドウが隠れている間の requestAnimationFrame は、見えている別のウインドウの間合いで回す
import { h, here, setHere } from './dom.ts';
import { T } from '../i18n.ts';

export interface Popout {
  win: Window;
  focus(): void;
  /** ウインドウを閉じて元に戻す */
  close(): void;
}

interface Geometry { x: number; y: number; w: number; h: number }

const opened = new Set<Window>();
const hooks: ((w: Window) => void)[] = [];
/** 別のウインドウを開くたびに呼ぶ（元のエディタのコードが、そのウインドウの document でも待てるように） */
export function onPopout(fn: (w: Window) => void): void { hooks.push(fn); }
/** 元の head の style・link と、別のウインドウに写したもの */
const copies = new Map<Node, Node[]>();
let installed = false;

/** パネルの要素を新しいウインドウに移す。ブラウザに止められたら null */
export function openPopout(o: { id: string; title: string; el: HTMLElement; onClose: () => void; at?: { x: number; y: number } }): Popout | null {
  install();
  const g = geometry(o.id, o.el, o.at);
  const opened0 = window.open('', `ages-pop-${o.id}`, `popup,width=${g.w},height=${g.h},left=${g.x},top=${g.y}`);
  if (!opened0) return null;
  const w: Window = opened0;
  const d = w.document;
  d.head.replaceChildren();
  d.body.replaceChildren();
  d.title = `${o.title} — AGES`;
  d.documentElement.lang = document.documentElement.lang;
  d.head.append(h('meta', { charset: 'utf-8' }));
  for (const n of document.head.querySelectorAll('style, link[rel=stylesheet]')) copyStyle(n, d);
  syncAttrs(d);
  const back = () => close();
  const work = h('div', { id: 'work' });
  d.body.append(
    h('div', { id: 'app' },
      h('div', { id: 'top' }, h('span', { class: 'title' }, 'AGES', h('small', {}, o.title)), h('span', { class: 'spacer' }),
        h('button', { title: T('このウインドウを閉じても、タブはエディタに戻ります'), onclick: back }, T('↩ エディタに戻す'))),
      work),
    h('div', { id: 'toasts' }));
  o.el.classList.add('active');
  work.append(o.el);
  track(w);
  forward(w);
  opened.add(w);
  for (const fn of hooks) fn(w);
  setHere(w);

  let done = false;
  let last = g;
  const remember = () => { try { if (!w.closed) last = { x: w.screenX, y: w.screenY, w: w.innerWidth, h: w.innerHeight }; } catch { /* 閉じかけ */ } };
  w.addEventListener('resize', remember);
  function close(): void {
    if (done) return;
    done = true;
    remember();
    clearInterval(poll);
    opened.delete(w);
    for (const [n, list] of copies) copies.set(n, list.filter((c) => c.ownerDocument !== d));
    try { localStorage.setItem(`ages.popout.${o.id}`, JSON.stringify(last)); } catch { /* 保存できなくても困らない */ }
    if (here.win === w) setHere(window);
    o.onClose();
    if (!w.closed) w.close();
  }
  w.addEventListener('pagehide', close);
  // pagehide が来ない閉じ方の控え
  const poll = setInterval(() => { if (w.closed) close(); }, 1000);
  return { win: w, focus: () => w.focus(), close };
}

/** 前に出したときの位置と大きさ。なければ今の大きさで、元のウインドウから少しずらす。ドラッグで出したら、その場所 */
function geometry(id: string, el: HTMLElement, at?: { x: number; y: number }): Geometry {
  let g: Geometry | null = null;
  try { g = JSON.parse(localStorage.getItem(`ages.popout.${id}`) ?? 'null'); } catch { g = null; }
  const r = el.getBoundingClientRect();
  const w = Math.round(g?.w ?? Math.max(520, r.width)), hh = Math.round(g?.h ?? Math.max(420, r.height + 36));
  if (at) return { x: Math.round(at.x - 60), y: Math.round(at.y - 16), w, h: hh };
  return { x: Math.round(g?.x ?? window.screenX + 80), y: Math.round(g?.y ?? window.screenY + 80), w, h: hh };
}

function install(): void {
  if (installed) return;
  installed = true;
  track(window);
  // 確かめのダイアログは、人が操作しているウインドウに出す
  for (const k of ['confirm', 'alert', 'prompt'] as const) {
    const orig = (window[k] as (...a: unknown[]) => unknown).bind(window);
    (window as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => (here.win !== window && !here.win.closed ? (here.win[k] as (...a: unknown[]) => unknown)(...a) : orig(...a));
  }
  // 元のウインドウが隠れている（別のウインドウで覆った・最小化した）間も、別のウインドウに出したパネルの絵が止まらないように、
  // 見えている別のウインドウの間合いで回す（時刻は元のウインドウの時計に直す）
  const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  const borrowed = new Map<number, [Window, number]>();
  let nextId = -1;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const w = document.visibilityState === 'hidden' ? [...opened].find((x) => !x.closed && x.document.visibilityState === 'visible') : undefined;
    if (!w) return raf(cb);
    const id = nextId--;
    const shift = w.performance.timeOrigin - performance.timeOrigin;
    borrowed.set(id, [w, w.requestAnimationFrame((t) => { borrowed.delete(id); cb(t + shift); })]);
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    const b = borrowed.get(id);
    if (!b) return caf(id);
    borrowed.delete(id);
    if (!b[0].closed) b[0].cancelAnimationFrame(b[1]);
  };
  // 入力中の欄は、人が操作しているウインドウのもの
  const active = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
  if (active?.get) {
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => (here.win !== window && !here.win.closed ? here.doc.activeElement : active.get!.call(document)),
    });
  }
  // 拡張の css など、後から head に足された見た目も写す（消されたら写しも消す）
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.addedNodes) if (isStyle(n)) for (const w of opened) copyStyle(n, w.document);
      for (const n of m.removedNodes) { for (const c of copies.get(n) ?? []) (c as ChildNode).remove(); copies.delete(n); }
    }
  }).observe(document.head, { childList: true });
  new MutationObserver(() => { for (const w of opened) syncAttrs(w.document); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  new MutationObserver(() => { for (const w of opened) syncAttrs(w.document); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'lang'] });
  // 読み込み直す・閉じるときは、出しているウインドウも閉じる（中身は元のエディタが動かしているので、残すと動かない）
  window.addEventListener('pagehide', () => { for (const w of [...opened]) w.close(); });
}

const isStyle = (n: Node): n is Element => n instanceof HTMLStyleElement || (n instanceof HTMLLinkElement && n.rel === 'stylesheet');

function copyStyle(n: Element, d: Document): void {
  const c = n.cloneNode(true) as Element;
  if (c instanceof HTMLLinkElement) c.href = (n as HTMLLinkElement).href; // 場所は元のページから見たもの
  d.head.append(c);
  copies.set(n, [...(copies.get(n) ?? []), c]);
}

/** html・body の class と style（設定で切り替わる見た目）をそろえる。body には solo を足す（パネル1つの並べ方） */
function syncAttrs(d: Document): void {
  d.documentElement.className = document.documentElement.className;
  d.documentElement.setAttribute('style', document.documentElement.getAttribute('style') ?? '');
  d.documentElement.lang = document.documentElement.lang;
  d.body.className = `${document.body.className} solo popout`.trim();
  d.body.setAttribute('style', document.body.getAttribute('style') ?? '');
}

/** どのウインドウで操作しているかを覚える */
function track(w: Window): void {
  // 送り直した出来事（isTrusted でない）は数えない（別のウインドウのキーで元のウインドウに戻らないように）
  const mark = (e: Event) => { if (e.isTrusted) setHere(w); };
  for (const t of ['pointerdown', 'keydown', 'focusin', 'wheel']) w.addEventListener(t, mark, { capture: true, passive: true });
  w.addEventListener('focus', mark);
}

/** 別のウインドウに来た出来事を、元の document にも送る（元のエディタのコードが document・window で待っているもの。document から window へ上がる） */
function forward(w: Window): void {
  for (const type of ['mousemove', 'mouseup', 'pointermove', 'pointerup', 'pointercancel']) {
    w.addEventListener(type, (e) => {
      const m = e as PointerEvent;
      const init: PointerEventInit = {
        bubbles: true, cancelable: true, clientX: m.clientX, clientY: m.clientY, screenX: m.screenX, screenY: m.screenY, button: m.button, buttons: m.buttons,
        ctrlKey: m.ctrlKey, shiftKey: m.shiftKey, altKey: m.altKey, metaKey: m.metaKey,
      };
      document.dispatchEvent(type.startsWith('pointer')
        ? new PointerEvent(type, { ...init, pointerId: m.pointerId, pointerType: m.pointerType, isPrimary: m.isPrimary, pressure: m.pressure })
        : new MouseEvent(type, init));
    });
  }
  for (const type of ['keydown', 'keyup']) {
    w.addEventListener(type, (e) => {
      const k = e as KeyboardEvent;
      const t = k.target as HTMLElement | null;
      // 入力中の欄・拡張のパネル・ダイアログの中のキーは、元のエディタでも本体の操作に使わない
      if (t?.isContentEditable || t?.closest?.('input, textarea, select, .ext-panel, .modal-bg') || w.document.querySelector('.modal-bg')) return;
      const ok = document.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true, cancelable: true, key: k.key, code: k.code, location: k.location, repeat: k.repeat,
        ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey,
      }));
      if (!ok) k.preventDefault();
    });
  }
  w.addEventListener('resize', () => window.dispatchEvent(new Event('resize')));
}
