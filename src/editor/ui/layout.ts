// ウインドウの配置。左・中央・下・右の4エリアにタブで並べる。
// タブはドラッグで別エリアへ移せ、境界線で大きさを変えられる。配置は .ages/layout.json に保存される。
// タブは閉じられ（＋ から開き直す）、タブが1つもないエリアは細く畳む。
// タブは別のウインドウにも出せる（↗・右クリック・エディタの外へドラッグ。popout.ts）。出しているかは保存しない（読み込み直すと元の場所）
import { h, menu, toast } from './dom.ts';
import { openPopout, type Popout } from './popout.ts';
import { T } from '../i18n.ts';

export type AreaName = 'left' | 'center' | 'bottom' | 'right';
const AREAS: AreaName[] = ['left', 'center', 'bottom', 'right'];
const AREA_LABEL: Record<AreaName, string> = { left: T('左'), center: T('中央'), bottom: T('下'), right: T('右') };
/** タブが1つもないエリアの細さ（＋ と、タブを落とす所だけ） */
const FOLDED = 30;

export interface Panel {
  id: string;
  title: string;
  el: HTMLElement;
  /** 中身を縦いっぱいに広げる */
  fill?: boolean;
  /** 表示されたとき・状態が変わったときに呼ばれる */
  render?(): void;
  /** 保存された配置にまだないとき、最初に置くエリア（既定: 下） */
  area?: AreaName;
  /** 閉じる・別のウインドウに出すことはできない（ゲームの画面） */
  fixed?: boolean;
}

export interface LayoutData {
  areas: Record<AreaName, string[]>;
  active: Partial<Record<AreaName, string>>;
  sizes: { left: number; right: number; bottom: number };
  /** 閉じたタブ（＋ から開き直す。前の版の layout.json にはない） */
  closed?: string[];
}

export const DEFAULT_LAYOUT: LayoutData = {
  areas: { left: ['hierarchy', 'project'], center: ['game', 'matrix', 'sprite', 'table', 'text'], bottom: ['assets', 'log', 'git', 'export'], right: ['inspector'] },
  active: { left: 'hierarchy', center: 'game', bottom: 'assets', right: 'inspector' },
  sizes: { left: 260, right: 360, bottom: 210 },
};

export class Layout {
  data: LayoutData;
  panels = new Map<string, Panel>();
  /** 別のウインドウに出しているタブ */
  private out = new Map<string, Popout>();
  private root: HTMLElement;
  private save: (d: LayoutData) => void;

  constructor(root: HTMLElement, data: LayoutData | null, save: (d: LayoutData) => void) {
    this.root = root;
    this.data = structuredClone(data ?? DEFAULT_LAYOUT);
    this.data.closed ??= [];
    this.save = save;
  }

  add(p: Panel): void {
    this.panels.set(p.id, p);
  }

  areaOf(id: string): AreaName | undefined {
    return AREAS.find((a) => this.data.areas[a].includes(id));
  }

  /** 見えているか（別のウインドウに出しているものも） */
  isVisible(id: string): boolean {
    if (this.out.has(id)) return true;
    const a = this.areaOf(id);
    return !!a && this.data.active[a] === id;
  }

  isOut(id: string): boolean {
    return this.out.has(id);
  }

  isClosed(id: string): boolean {
    return this.data.closed!.includes(id);
  }

  /** 前へ出す。閉じていれば開き直し、別のウインドウに出していればそのウインドウを前へ */
  show(id: string): void {
    const pop = this.out.get(id);
    if (pop) { pop.focus(); this.panels.get(id)?.render?.(); return; }
    if (this.isClosed(id)) return this.reopen(id);
    const a = this.areaOf(id);
    if (!a) return;
    this.data.active[a] = id;
    this.build();
    this.save(this.data);
  }

  move(id: string, to: AreaName): void {
    for (const a of AREAS) this.data.areas[a] = this.data.areas[a].filter((x) => x !== id);
    this.data.closed = this.data.closed!.filter((x) => x !== id);
    this.data.areas[to].push(id);
    if (!this.out.has(id)) this.data.active[to] = id;
    this.build();
    this.save(this.data);
  }

  /** タブを閉じる（＋ から開き直せる）。別のウインドウに出していれば、そのウインドウも閉じる */
  close(id: string): void {
    const p = this.panels.get(id);
    if (!p || p.fixed) return;
    const pop = this.out.get(id);
    for (const a of AREAS) this.data.areas[a] = this.data.areas[a].filter((x) => x !== id);
    if (!this.isClosed(id)) this.data.closed!.push(id);
    if (pop) pop.close(); // 戻ってきたときの build で、閉じた所には置かれない
    this.build();
    this.save(this.data);
  }

  /** 閉じたタブを開き直す（場所を言わなければ、そのタブの最初の場所） */
  reopen(id: string, to?: AreaName): void {
    const p = this.panels.get(id);
    if (!p) return;
    const home = to ?? AREAS.find((a) => DEFAULT_LAYOUT.areas[a].includes(id)) ?? p.area ?? 'bottom';
    this.move(id, home);
  }

  /** 別のウインドウに出す（at はドラッグで離した画面の位置） */
  popOut(id: string, at?: { x: number; y: number }): void {
    const p = this.panels.get(id);
    if (!p || p.fixed || this.out.has(id)) return;
    if (this.isClosed(id)) this.reopen(id);
    const pop = openPopout({
      id, title: p.title, el: p.el, at,
      onClose: () => { this.out.delete(id); this.build(); },
    });
    if (!pop) { toast(T('ブラウザが新しいウインドウを止めました。タブの ↗ を押してください'), 'warn', 6000); return; }
    this.out.set(id, pop);
    this.build();
    p.render?.();
  }

  build(): void {
    // 新しく増えたパネル（カスタムウインドウなど）は下のエリアへ。消えたパネルは外す。閉じられないパネルは閉じたままにしない
    const closed = this.data.closed!;
    const placed = new Set([...AREAS.flatMap((a) => this.data.areas[a]), ...closed]);
    for (const [id, p] of this.panels) if (!placed.has(id)) this.data.areas[p.area ?? 'bottom'].push(id);
    for (const id of closed.filter((x) => this.panels.get(x)?.fixed)) { closed.splice(closed.indexOf(id), 1); this.data.areas[this.panels.get(id)!.area ?? 'center'].push(id); }
    this.data.closed = closed.filter((id) => this.panels.has(id));
    for (const a of AREAS) {
      this.data.areas[a] = this.data.areas[a].filter((id) => this.panels.has(id));
      const here = this.data.areas[a].filter((id) => !this.out.has(id));
      if (!here.includes(this.data.active[a] ?? '')) this.data.active[a] = here[0];
    }
    const s = this.data.sizes;
    const size = (a: 'left' | 'right' | 'bottom') => (this.data.areas[a].length ? s[a] : FOLDED);
    this.root.style.setProperty('--left', `${size('left')}px`);
    this.root.style.setProperty('--right', `${size('right')}px`);
    this.root.style.setProperty('--bottom', `${size('bottom')}px`);
    this.root.replaceChildren(
      this.area('left'),
      this.splitter('v', 'left', 'grid-column:2'),
      this.area('center'),
      this.splitter('h', 'bottom', 'grid-row:2'),
      this.area('bottom'),
      this.splitter('v', 'right', 'grid-column:4'),
      this.area('right'),
    );
    for (const id of [...Object.values(this.data.active), ...this.out.keys()]) if (id) this.panels.get(id)?.render?.();
  }

  private area(name: AreaName): HTMLElement {
    const ids = this.data.areas[name];
    const closed = this.data.closed!;
    const tabs = h('div', { class: 'tabs' }, ids.map((id) => {
      const p = this.panels.get(id)!;
      const out = this.out.has(id);
      const active = this.data.active[name] === id;
      const items: [string, () => void][] = AREAS.filter((a) => a !== name).map((a): [string, () => void] => [T('{0}へ移動', AREA_LABEL[a]), () => this.move(id, a)]);
      if (!p.fixed && !out) items.push([T('別のウインドウで開く'), () => this.popOut(id)]);
      if (out) items.push([T('エディタに戻す'), () => this.out.get(id)?.close()]);
      if (!p.fixed) items.push([T('閉じる'), () => this.close(id)]);
      const btn = (label: string, title: string, fn: () => void) => h('span', { class: 'tab-btn', title, onclick: (e: MouseEvent) => { e.stopPropagation(); fn(); } }, label);
      return h('div', {
        class: `tab ${active ? 'active' : ''} ${out ? 'out' : ''}`,
        draggable: true,
        title: out ? T('別のウインドウに出しています（押すとそのウインドウへ）') : T('ドラッグで別の場所へ（エディタの外へ出すと別のウインドウ）/ 右クリックでメニュー'),
        onclick: () => this.show(id),
        ondragstart: (e: DragEvent) => e.dataTransfer!.setData('text/ages-panel', id),
        // エディタの外で離したら、別のウインドウに出す
        ondragend: (e: DragEvent) => {
          if (p.fixed || out || e.dataTransfer?.dropEffect !== 'none') return;
          const inside = e.screenX >= window.screenX && e.screenX <= window.screenX + window.outerWidth && e.screenY >= window.screenY && e.screenY <= window.screenY + window.outerHeight;
          if (!inside) this.popOut(id, { x: e.screenX, y: e.screenY });
        },
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); menu(e.clientX, e.clientY, items); },
      }, p.title, out ? h('span', { class: 'tab-mark' }, ' ↗') : null,
      p.fixed || out ? null : btn(' ↗', T('別のウインドウで開く'), () => this.popOut(id)),
      p.fixed ? null : btn(' ×', T('閉じる'), () => this.close(id)));
    }), closed.length ? h('span', {
      class: 'tab-add', title: T('閉じたタブを開く'),
      onclick: (e: MouseEvent) => menu(e.clientX, e.clientY, closed.map((id): [string, () => void] => [this.panels.get(id)!.title, () => this.reopen(id, name)])),
    }, '＋') : null);
    tabs.addEventListener('dragover', (e) => { e.preventDefault(); tabs.classList.add('drop'); });
    tabs.addEventListener('dragleave', () => tabs.classList.remove('drop'));
    tabs.addEventListener('drop', (e) => {
      tabs.classList.remove('drop');
      const id = e.dataTransfer?.getData('text/ages-panel');
      if (id) this.move(id, name);
    });
    const body = ids.filter((id) => !this.out.has(id)).map((id) => {
      const p = this.panels.get(id)!;
      p.el.classList.add('panel');
      p.el.classList.toggle('fill', !!p.fill);
      p.el.classList.toggle('active', this.data.active[name] === id);
      return p.el;
    });
    const empty = ids.length && !body.length ? h('div', { class: 'area-note' }, T('このエリアのタブは別のウインドウに出しています')) : null;
    return h('div', { class: `area ${ids.length ? '' : 'folded'}`, 'data-area': name }, tabs, body, empty);
  }

  private splitter(dir: 'v' | 'h', which: 'left' | 'right' | 'bottom', style: string): HTMLElement {
    const el = h('div', { class: `split ${dir} ${this.data.areas[which].length ? '' : 'folded'}`, style });
    el.addEventListener('mousedown', (down) => {
      if (!this.data.areas[which].length) return; // 畳んでいる間は動かさない
      down.preventDefault();
      const start = this.data.sizes[which];
      const move = (e: MouseEvent) => {
        const d = dir === 'v' ? e.clientX - down.clientX : e.clientY - down.clientY;
        const v = which === 'left' ? start + d : start - d;
        this.data.sizes[which] = Math.max(140, Math.min(900, v));
        this.root.style.setProperty(`--${which}`, `${this.data.sizes[which]}px`);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.save(this.data);
        window.dispatchEvent(new Event('resize'));
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    return el;
  }
}
