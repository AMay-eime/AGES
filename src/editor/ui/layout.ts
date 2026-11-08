// ウインドウの配置。左・中央・下・右の4エリアにタブで並べる。
// タブはドラッグで別エリアへ移せ、境界線で大きさを変えられる。配置は .ages/layout.json に保存される。
import { h, menu } from './dom.ts';

export type AreaName = 'left' | 'center' | 'bottom' | 'right';
const AREAS: AreaName[] = ['left', 'center', 'bottom', 'right'];
const AREA_LABEL: Record<AreaName, string> = { left: '左', center: '中央', bottom: '下', right: '右' };

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
}

export interface LayoutData {
  areas: Record<AreaName, string[]>;
  active: Partial<Record<AreaName, string>>;
  sizes: { left: number; right: number; bottom: number };
}

export const DEFAULT_LAYOUT: LayoutData = {
  areas: { left: ['hierarchy', 'project'], center: ['game', 'matrix', 'sprite', 'table', 'text'], bottom: ['log', 'git'], right: ['inspector'] },
  active: { left: 'hierarchy', center: 'game', bottom: 'log', right: 'inspector' },
  sizes: { left: 260, right: 360, bottom: 210 },
};

export class Layout {
  data: LayoutData;
  panels = new Map<string, Panel>();
  private root: HTMLElement;
  private save: (d: LayoutData) => void;

  constructor(root: HTMLElement, data: LayoutData | null, save: (d: LayoutData) => void) {
    this.root = root;
    this.data = structuredClone(data ?? DEFAULT_LAYOUT);
    this.save = save;
  }

  add(p: Panel): void {
    this.panels.set(p.id, p);
  }

  areaOf(id: string): AreaName | undefined {
    return AREAS.find((a) => this.data.areas[a].includes(id));
  }

  isVisible(id: string): boolean {
    const a = this.areaOf(id);
    return !!a && this.data.active[a] === id;
  }

  show(id: string): void {
    const a = this.areaOf(id);
    if (!a) return;
    this.data.active[a] = id;
    this.build();
    this.save(this.data);
  }

  move(id: string, to: AreaName): void {
    for (const a of AREAS) this.data.areas[a] = this.data.areas[a].filter((x) => x !== id);
    this.data.areas[to].push(id);
    this.data.active[to] = id;
    for (const a of AREAS) if (!this.data.areas[a].includes(this.data.active[a] ?? '')) this.data.active[a] = this.data.areas[a][0];
    this.build();
    this.save(this.data);
  }

  build(): void {
    // 新しく増えたパネル（カスタムウインドウなど）は下のエリアへ。消えたパネルは外す
    const placed = new Set(AREAS.flatMap((a) => this.data.areas[a]));
    for (const [id, p] of this.panels) if (!placed.has(id)) this.data.areas[p.area ?? 'bottom'].push(id);
    for (const a of AREAS) {
      this.data.areas[a] = this.data.areas[a].filter((id) => this.panels.has(id));
      if (!this.data.areas[a].includes(this.data.active[a] ?? '')) this.data.active[a] = this.data.areas[a][0];
    }
    const s = this.data.sizes;
    this.root.style.setProperty('--left', `${s.left}px`);
    this.root.style.setProperty('--right', `${s.right}px`);
    this.root.style.setProperty('--bottom', `${s.bottom}px`);
    this.root.replaceChildren(
      this.area('left'),
      this.splitter('v', 'left', 'grid-column:2'),
      this.area('center'),
      this.splitter('h', 'bottom', 'grid-row:2'),
      this.area('bottom'),
      this.splitter('v', 'right', 'grid-column:4'),
      this.area('right'),
    );
    for (const id of Object.values(this.data.active)) if (id) this.panels.get(id)?.render?.();
  }

  private area(name: AreaName): HTMLElement {
    const ids = this.data.areas[name];
    const tabs = h('div', { class: 'tabs' }, ids.map((id) => {
      const p = this.panels.get(id)!;
      return h('div', {
        class: `tab ${this.data.active[name] === id ? 'active' : ''}`,
        draggable: true,
        title: 'ドラッグで別の場所へ移動 / 右クリックでメニュー',
        onclick: () => this.show(id),
        ondragstart: (e: DragEvent) => e.dataTransfer!.setData('text/ages-panel', id),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          menu(e.clientX, e.clientY, AREAS.filter((a) => a !== name).map((a) => [`${AREA_LABEL[a]}へ移動`, () => this.move(id, a)]));
        },
      }, p.title);
    }));
    tabs.addEventListener('dragover', (e) => { e.preventDefault(); tabs.classList.add('drop'); });
    tabs.addEventListener('dragleave', () => tabs.classList.remove('drop'));
    tabs.addEventListener('drop', (e) => {
      tabs.classList.remove('drop');
      const id = e.dataTransfer?.getData('text/ages-panel');
      if (id) this.move(id, name);
    });
    const body = ids.map((id) => {
      const p = this.panels.get(id)!;
      p.el.classList.add('panel');
      p.el.classList.toggle('fill', !!p.fill);
      p.el.classList.toggle('active', this.data.active[name] === id);
      return p.el;
    });
    return h('div', { class: 'area', 'data-area': name }, tabs, body);
  }

  private splitter(dir: 'v' | 'h', which: 'left' | 'right' | 'bottom', style: string): HTMLElement {
    const el = h('div', { class: `split ${dir}`, style });
    el.addEventListener('mousedown', (down) => {
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
