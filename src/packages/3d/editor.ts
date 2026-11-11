// エディタの「3D シーン」パネル（追加パッケージ 3d を入れたプロジェクトでだけ出る）。
// 自由な視点で回り込んで見る・クリックで選ぶ・ギズモで動かす／回す／大きさを変える・基本の形と光を足す。
// ゲームのカメラで見るのは今までの「ゲーム」パネル。こちらは作るための視点（Unity の Scene ビューにあたる）。
// 操作: 右ドラッグ（Alt+左ドラッグ）で回す・中ボタン（Shift+右ドラッグ）で平行移動・ホイールで寄る／引く・F で選んだ物へ・W/E/R で道具
import { h, menu, toast } from '../../editor/ui/dom.ts';
import { T } from '../../editor/i18n.ts';
import { ASSET_MIME } from '../../editor/ui/assets.ts';
import type { App } from '../../editor/app.ts';
import type { Panel } from '../../editor/ui/layout.ts';
import { Renderer } from '../../render/webgl.ts';
import type { World } from '../../core/world.ts';
import type { Op } from '../../core/patch.ts';
import * as m3 from './math.ts';
import type { Mat4, Vec3 } from './math.ts';
import { cameraFrom, matrixOf, screenRay, toScreen, worldMatrix, type CameraView3, type Pose3 } from './space.ts';
import { halfExtents, pickSolids, type Solid } from './pick.ts';
import type { Layer3D } from './render.ts';
import { shapeOf, wireOf } from './collide.ts';

type Tool = 'move' | 'rotate' | 'scale';
type Handle = { kind: Tool; axis: 0 | 1 | 2 | 3 };
const AXIS_COLOR = ['#ff5a5a', '#6ad36a', '#5a8cff', '#ffffff'];
const WORLD_AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
/** ギズモの長さ（画面の px） */
const GIZMO_PX = 84;
const FOV = 50;

export function mount(app: App): Panel {
  const canvas = h('canvas', { style: 'position:absolute;inset:0;width:100%;height:100%;display:block' }) as HTMLCanvasElement;
  const over = h('canvas', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' }) as HTMLCanvasElement;
  const wrap = h('div', { style: 'position:relative;flex:1;min-height:0;overflow:hidden;background:#000', tabindex: '0' }, canvas, over);
  const hint = h('span', { class: 'muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0' });
  let tool: Tool = 'move';
  const toolBtn = (t: Tool, label: string, title: string) => h('button', { class: 'icon', title, onclick: () => setTool(t) }, label);
  const tools: Record<Tool, HTMLElement> = {
    move: toolBtn('move', '✥', T('動かす（W）')),
    rotate: toolBtn('rotate', '⟳', T('回す（E）')),
    scale: toolBtn('scale', '⤢', T('大きさを変える（R）')),
  };
  const setTool = (t: Tool) => { tool = t; for (const k of Object.keys(tools) as Tool[]) tools[k].classList.toggle('on', k === t); };
  setTool('move');
  const bar = h('div', { class: 'toolbar' }, tools.move, tools.rotate, tools.scale,
    h('button', { title: T('形・光・カメラを足す'), onclick: (e: MouseEvent) => addMenu(e) }, T('＋ 足す')),
    h('button', { class: 'icon', title: T('選んだ物を真ん中に（F）'), onclick: () => frame() }, '⌖'),
    hint);
  const el = h('div', { style: 'display:flex;flex-direction:column;height:100%' }, bar, wrap);
  hint.textContent = T('右ドラッグ: 回す ／ 中ボタン・Shift+右ドラッグ: 平行移動 ／ ホイール: 寄る・引く ／ Ctrl: 刻みに合わせる');

  // ---- 視点（見ている点のまわりを回る） ----
  const view = { target: [0, 0.5, 0] as Vec3, yaw: 30, pitch: -25, dist: 14 };
  const camera = (): CameraView3 => {
    const back = m3.rotationAxes(view.pitch, view.yaw, 0)[2];
    const pos = m3.add(view.target, m3.scale(back, view.dist));
    return cameraFrom('', m3.compose(pos, [view.pitch, view.yaw, 0]), { fov: FOV, near: Math.max(0.02, view.dist / 500), far: Math.max(500, view.dist * 50) }, canvas.width / Math.max(1, canvas.height));
  };

  let renderer: Renderer | null = null;
  let glError = '';
  let cam: CameraView3 = camera();
  const world = (): World | null => app.play?.game.world ?? app.preview?.world ?? null;
  /** 3D の物だけ（2D の画像・UI は、この視点では描かない） */
  const only3D = (w: World): World => {
    const v = Object.create(w) as World;
    (v as { entities: World['entities'] }).entities = new Map([...w.entities].filter(([, e]) => e.c.Transform3D || e.c.Environment3D));
    return v;
  };
  const layer = (): Layer3D | undefined => renderer?.layers.find((l) => l.name === '3d') as Layer3D | undefined;
  const selected = (): string[] => (app.sel?.kind === 'scene' && app.sel.scene === app.scene ? app.selectedIds() : []);

  // ---- 描く ----
  let drawnAt = 0;
  const draw = () => {
    const win = el.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(draw);
    // パーティクルは実時間で動かす（選んだ物だけ、試しに出す）
    const now = win.performance.now(), dt = Math.min(0.1, drawnAt ? (now - drawnAt) / 1000 : 0);
    drawnAt = now;
    if (!el.isConnected || wrap.clientWidth < 2 || wrap.clientHeight < 2 || glError) return;
    const w = world();
    if (!w || !app.registry) return;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const W = Math.round(wrap.clientWidth * dpr), H = Math.round(wrap.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = over.width = W; canvas.height = over.height = H; }
    try {
      renderer ??= new Renderer(canvas, { urlOf: (p) => app.assetUrl(p), sheets: app.registry.sheets, filter: 'linear', shaders: app.registry.shaders });
      renderer.usePackages(app.registry.packages);
      cam = camera();
      show();
      renderer.draw(only3D(w), { background: app.state.config.view.background, post: false, particles: app.play ? { dt: app.play.paused || app.play.loading ? 0 : dt } : { dt, preview: selected() }, layers: { '3d': { camera: cam, grid: { center: view.target, half: Math.max(10, view.dist * 1.5) } } } });
    } catch (e) {
      glError = (e as Error).message;
      hint.textContent = glError;
      return;
    }
    overlay(w);
  };

  const px = (p: Vec3) => toScreen(cam, p, canvas.width, canvas.height);
  /** 画面で px の長さになる、世界での長さ（点 p のあたりで） */
  const unitAt = (p: Vec3, pixels: number): number => {
    const depth = Math.max(0.001, m3.dot(m3.sub(p, cam.pos), cam.dir));
    return (2 * depth * Math.tan((FOV * Math.PI) / 360) / canvas.height) * pixels;
  };

  interface Gizmo { id: string; origin: Vec3; axes: Vec3[]; len: number }
  let gizmo: Gizmo | null = null;
  let hot: Handle | null = null;

  /** いまのギズモ（選んでいる手前の物の位置に。再生中・画面の外ならなし）。描くとき・マウスのたびに求め直す */
  const gizmoNow = (): Gizmo | null => {
    const w = world(), id = selected()[0];
    const first = w && id ? w.get(id) : undefined;
    const fm = first && w ? matrixOf(w, first) : null;
    if (!fm || app.play) return null;
    const origin = m3.positionOf(fm);
    if (!px(origin)) return null;
    const k = canvas.width / Math.max(1, wrap.clientWidth);
    const local = [0, 1, 2].map((i) => m3.normalize([fm[i * 4], fm[i * 4 + 1], fm[i * 4 + 2]])) as Vec3[];
    return { id: first!.id, origin, axes: tool === 'scale' ? local : WORLD_AXES, len: unitAt(origin, GIZMO_PX * k) };
  };

  const overlay = (w: World) => {
    const g = over.getContext('2d')!;
    g.clearRect(0, 0, over.width, over.height);
    const k = over.width / Math.max(1, wrap.clientWidth);
    g.lineWidth = 1.5 * k;
    const line = (a: Vec3, b: Vec3, color: string, width = 1.5) => {
      const p = px(a), q = px(b);
      if (!p || !q) return;
      g.strokeStyle = color; g.lineWidth = width * k;
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    };
    // 形のない物（光・カメラ・空の物）は印で出す
    g.font = `${16 * k}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const e of w.entities.values()) {
      if (!e.c.Transform3D || e.c.Mesh3D || e.c.Model3D) continue;
      const m = matrixOf(w, e);
      const p = m && px(m3.positionOf(m));
      if (!m || !p) continue;
      const fwd = m3.normalize(m3.transformDirection(m, [0, 0, 1]));
      if (e.c.Light3D?.kind === 'sun') line(m3.positionOf(m), m3.add(m3.positionOf(m), m3.scale(fwd, unitAt(m3.positionOf(m), 40))), '#ffd75a', 2);
      if (e.c.Camera3D) line(m3.positionOf(m), m3.add(m3.positionOf(m), m3.scale(fwd, -unitAt(m3.positionOf(m), 40))), '#9fd0ff', 2);
      g.fillText(e.c.Camera3D ? '🎥' : e.c.Light3D ? (e.c.Light3D.kind === 'sun' ? '☀' : '💡') : e.c.Particles3D ? '✨' : '◇', p.x, p.y);
    }
    // 当たり判定の形（緑の線。選んでいる物は濃く）
    const sel = selected();
    for (const e of w.entities.values()) {
      const sh = e.c.Collider3D ? shapeOf(w, e) : null;
      if (!sh) continue;
      const color = sel.includes(e.id) ? '#5dff8a' : 'rgba(93,255,138,0.35)';
      for (const [a, b] of wireOf(sh)) line(a, b, color, sel.includes(e.id) ? 1.5 : 1);
    }
    // 選んでいる物の枠
    const drawn = new Map((layer()?.drawn ?? []).map((d) => [d.id, d]));
    for (const id of sel) {
      const d = drawn.get(id);
      if (!d) continue;
      const hx = halfExtents(d.shape, d.size);
      const c = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => m3.transformPoint(d.matrix, [i & 1 ? hx[0] : -hx[0], i & 2 ? hx[1] : -hx[1], i & 4 ? hx[2] : -hx[2]]));
      for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) line(c[a], c[b], id === sel[0] ? '#ffb02e' : '#b98a3a');
    }
    // ギズモ（手前の1つに）。再生中は出さない
    gizmo = gizmoNow();
    if (!gizmo) return;
    const origin = gizmo.origin;
    const on = (axis: number) => (hot?.axis === axis || drag?.handle.axis === axis ? 3.5 : 2);
    if (tool === 'rotate') {
      for (let i = 0; i < 3; i++) {
        const pts = ring(gizmo, i);
        g.strokeStyle = AXIS_COLOR[i]; g.lineWidth = on(i) * k;
        g.beginPath();
        let pen = false;
        for (const q of pts) { const s = px(q); if (!s) { pen = false; continue; } if (pen) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); pen = true; }
        g.stroke();
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const end = m3.add(origin, m3.scale(gizmo.axes[i], gizmo.len));
        line(origin, end, AXIS_COLOR[i], on(i));
        const s = px(end);
        if (!s) continue;
        g.fillStyle = AXIS_COLOR[i];
        const r = (tool === 'scale' ? 5 : 6) * k;
        if (tool === 'scale') g.fillRect(s.x - r, s.y - r, r * 2, r * 2);
        else { g.beginPath(); g.arc(s.x, s.y, r, 0, Math.PI * 2); g.fill(); }
      }
      if (tool === 'scale') { const s = px(origin)!; const r = (hot?.axis === 3 ? 8 : 6) * k; g.fillStyle = '#fff'; g.fillRect(s.x - r, s.y - r, r * 2, r * 2); }
    }
  };

  /** 回すギズモの輪（軸 i のまわり） */
  const ring = (gz: Gizmo, i: number): Vec3[] => {
    const u = gz.axes[(i + 1) % 3], v = gz.axes[(i + 2) % 3];
    return Array.from({ length: 49 }, (_, n) => { const t = (n / 48) * Math.PI * 2; return m3.add(gz.origin, m3.add(m3.scale(u, Math.cos(t) * gz.len), m3.scale(v, Math.sin(t) * gz.len))); });
  };

  // ---- マウス ----
  const at = (e: MouseEvent): [number, number] => { const r = canvas.getBoundingClientRect(); const k = canvas.width / Math.max(1, r.width); return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; };
  const segDist = (p: [number, number], a: { x: number; y: number }, b: { x: number; y: number }): number => {
    const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a.x) * vx + (p[1] - a.y) * vy) / l2));
    return Math.hypot(p[0] - a.x - vx * t, p[1] - a.y - vy * t);
  };
  const handleAt = (p: [number, number]): Handle | null => {
    cam = camera();
    gizmo = gizmoNow();
    if (!gizmo) return null;
    const k = canvas.width / Math.max(1, wrap.clientWidth), o = px(gizmo.origin);
    if (!o) return null;
    if (tool === 'scale' && Math.hypot(p[0] - o.x, p[1] - o.y) < 9 * k) return { kind: 'scale', axis: 3 };
    let best: Handle | null = null, bd = 9 * k;
    for (let i = 0; i < 3; i++) {
      let d = Infinity;
      if (tool === 'rotate') {
        const pts = ring(gizmo, i).map(px);
        for (let n = 0; n < pts.length - 1; n++) if (pts[n] && pts[n + 1]) d = Math.min(d, segDist(p, pts[n]!, pts[n + 1]!));
      } else {
        const e = px(m3.add(gizmo.origin, m3.scale(gizmo.axes[i], gizmo.len)));
        if (e) d = segDist(p, o, e);
      }
      if (d < bd) { bd = d; best = { kind: tool, axis: i as 0 | 1 | 2 }; }
    }
    return best;
  };
  /** 軸の線の上で、マウスの光線にいちばん近い所（origin からの長さ） */
  const alongAxis = (origin: Vec3, axis: Vec3, p: [number, number]): number | null => {
    const ray = screenRay(cam, p[0], p[1], canvas.width, canvas.height);
    const r = m3.sub(origin, ray.origin), ad = m3.dot(axis, ray.dir), den = 1 - ad * ad;
    return den < 1e-5 ? null : (ad * m3.dot(ray.dir, r) - m3.dot(axis, r)) / den;
  };

  interface Drag { handle: Handle; id: string; start: Pose3; cur: Pose3; world: Mat4; parent: Mat4 | null; origin: Vec3; axis: Vec3; len: number; u0: number; a0: number; x0: number; y0: number }
  let drag: Drag | null = null;
  let nav: { kind: 'orbit' | 'pan'; x: number; y: number } | null = null;
  let downAt: [number, number] | null = null;

  const pose = (t: Partial<Pose3>): Pose3 => ({ x: t.x ?? 0, y: t.y ?? 0, z: t.z ?? 0, rx: t.rx ?? 0, ry: t.ry ?? 0, rz: t.rz ?? 0, sx: t.sx ?? 1, sy: t.sy ?? 1, sz: t.sz ?? 1, parent: t.parent ?? null });
  const round = (v: number, d: number) => Math.round(v * d) / d || 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    wrap.focus();
    canvas.setPointerCapture(e.pointerId);
    const p = at(e);
    if (e.button === 1 || (e.button === 2 && e.shiftKey)) { nav = { kind: 'pan', x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button === 2 || (e.button === 0 && e.altKey)) { nav = { kind: 'orbit', x: e.clientX, y: e.clientY }; return; }
    if (e.button !== 0) return;
    const hd = handleAt(p), w = world();
    const ent = gizmo && w?.get(gizmo.id);
    if (hd && gizmo && ent && w) {
      const t = ent.c.Transform3D as Pose3;
      const locked = (['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const).some((f) => app.state.locks[`${app.scene}#${gizmo!.id}.Transform3D.${f}`]) || !!app.state.locks[`${app.scene}#${gizmo.id}`];
      if (locked) { toast(T('🔒 {0} はロックされています', `${app.scene}#${gizmo.id}.Transform3D`), 'lock'); return; }
      const axis = hd.axis === 3 ? cam.dir : gizmo.axes[hd.axis];
      const parent = t.parent ? matrixOf(w, t.parent) : null;
      const o = px(gizmo.origin)!;
      drag = { handle: hd, id: gizmo.id, start: pose(t), cur: pose(t), world: matrixOf(w, ent)!, parent, origin: gizmo.origin, axis, len: gizmo.len, u0: alongAxis(gizmo.origin, axis, p) ?? 0, a0: Math.atan2(p[1] - o.y, p[0] - o.x), x0: p[0], y0: p[1] };
      return;
    }
    downAt = p;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = at(e);
    if (nav) {
      const dx = e.clientX - nav.x, dy = e.clientY - nav.y;
      nav.x = e.clientX; nav.y = e.clientY;
      if (nav.kind === 'orbit') {
        view.yaw = m3.wrapAngle(view.yaw - dx * 0.35);
        view.pitch = Math.max(-89, Math.min(89, view.pitch - dy * 0.35));
      } else {
        const [right, up] = m3.rotationAxes(view.pitch, view.yaw, 0);
        const k = (2 * view.dist * Math.tan((FOV * Math.PI) / 360)) / Math.max(1, wrap.clientHeight);
        view.target = m3.add(view.target, m3.add(m3.scale(right, -dx * k), m3.scale(up, dy * k)));
      }
      return;
    }
    if (drag) { dragTo(p, e.ctrlKey || e.metaKey); return; }
    hot = handleAt(p);
    canvas.style.cursor = hot ? 'grab' : 'default';
  });
  const finish = (e: PointerEvent) => {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    nav = null;
    if (drag) { void commit(); return; }
    // 動かさずに離した: 選ぶ
    if (downAt && e.type === 'pointerup') {
      const p = at(e);
      if (Math.hypot(p[0] - downAt[0], p[1] - downAt[1]) < 5) click(p, e.shiftKey || e.ctrlKey || e.metaKey);
    }
    downAt = null;
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.dist = Math.max(0.3, Math.min(5000, view.dist * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });
  wrap.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') setTool('move'); else if (k === 'e') setTool('rotate'); else if (k === 'r') setTool('scale'); else if (k === 'f') frame(); else return;
    e.stopPropagation();
    e.preventDefault();
  });

  /** クリックした所の物を選ぶ（形のない物は印の近く。何もなければ選びを外す） */
  const click = (p: [number, number], add: boolean) => {
    const id = pickAt(p);
    if (id) app.select({ kind: 'scene', scene: app.scene, id }, { add });
    else if (!add) app.select(null);
  };
  const pickAt = (p: [number, number]): string | null => {
    cam = camera();
    const w = world();
    if (!w) return null;
    const k = canvas.width / Math.max(1, wrap.clientWidth);
    for (const e of w.entities.values()) {
      if (!e.c.Transform3D || e.c.Mesh3D || e.c.Model3D) continue;
      const m = matrixOf(w, e), s = m && px(m3.positionOf(m));
      if (s && Math.hypot(p[0] - s.x, p[1] - s.y) < 13 * k) return e.id;
    }
    const solids: Solid[] = layer()?.drawn ?? [];
    return pickSolids(screenRay(cam, p[0], p[1], canvas.width, canvas.height), solids)[0]?.id ?? null;
  };

  /** ドラッグの途中: 試しの世界の値をその場で変える（離したときに保存する） */
  const dragTo = (p: [number, number], snap: boolean) => {
    const d = drag!, t = d.cur;
    const inv = d.parent ? m3.invert(d.parent) : null;
    if (d.handle.kind === 'move') {
      const u = alongAxis(d.origin, d.axis, p);
      if (u === null) return;
      let delta = u - d.u0;
      if (snap) delta = Math.round(delta / 0.5) * 0.5;
      const wp = m3.add(d.origin, m3.scale(d.axis, delta));
      const lp = inv ? m3.transformPoint(inv, wp) : wp;
      t.x = round(lp[0], 1000); t.y = round(lp[1], 1000); t.z = round(lp[2], 1000);
    } else if (d.handle.kind === 'rotate') {
      const o = px(d.origin);
      if (!o) return;
      let deg = ((Math.atan2(p[1] - o.y, p[0] - o.x) - d.a0) * 180) / Math.PI * (m3.dot(d.axis, cam.dir) > 0 ? 1 : -1);
      if (snap) deg = Math.round(deg / 15) * 15;
      const turned = m3.multiply(m3.translation(d.origin), m3.multiply(m3.rotationAbout(d.axis, deg), m3.multiply(m3.translation(m3.scale(d.origin, -1)), d.world)));
      const r = m3.decompose(inv ? m3.multiply(inv, turned) : turned).rot;
      t.rx = round(r[0], 100); t.ry = round(r[1], 100); t.rz = round(r[2], 100);
    } else {
      let f: number;
      if (d.handle.axis === 3) f = Math.max(0.01, 1 + (p[0] - d.x0 - (p[1] - d.y0)) / (150 * (canvas.width / Math.max(1, wrap.clientWidth))));
      else { const u = alongAxis(d.origin, d.axis, p); if (u === null) return; f = Math.max(0.01, (d.len + u - d.u0) / d.len); }
      if (snap) f = Math.max(0.1, Math.round(f * 10) / 10);
      const s0 = [d.start.sx, d.start.sy, d.start.sz];
      const s = s0.map((v, i) => (d.handle.axis === 3 || d.handle.axis === i ? round(v * f, 1000) : v));
      t.sx = s[0]; t.sy = s[1]; t.sz = s[2];
    }
    show();
  };
  /** ドラッグ中の値を、試しの世界の物に写す（途中で読み込み直されても、動かしている値で描く） */
  const show = () => {
    const live = drag && (world()?.get(drag.id)?.c.Transform3D as Pose3 | undefined);
    if (live && drag) Object.assign(live, drag.cur);
  };
  /** 離した: 変わった値だけを1回の編集として保存する */
  const commit = async () => {
    const d = drag!, t = d.cur;
    drag = null;
    const ops: Op[] = [];
    for (const f of ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const) if (t[f] !== d.start[f]) ops.push({ op: 'set', path: `${app.scene}#${d.id}.Transform3D.${f}`, value: t[f] });
    if (!ops.length) return;
    const r = await app.patch(ops, 'scene3d');
    if (!r) app.rebuildPreview();
  };

  /** 選んだ物（なければ全部）が収まるように、視点を動かす */
  const frame = () => {
    const w = world();
    if (!w) return;
    const ids = selected();
    const pts: Vec3[] = [];
    let size = 1;
    for (const e of w.entities.values()) {
      if (!e.c.Transform3D || (ids.length && !ids.includes(e.id))) continue;
      const m = matrixOf(w, e);
      if (!m) continue;
      pts.push(m3.positionOf(m));
      const c = e.c.Mesh3D as { size?: Vec3 } | undefined;
      if (c && ids.length) size = Math.max(size, Math.hypot(...(c.size ?? [1, 1, 1])) * Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6])));
    }
    if (!pts.length) return;
    const min = pts.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])] as Vec3), max = pts.reduce((a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] as Vec3);
    view.target = m3.scale(m3.add(min, max), 0.5);
    view.dist = Math.max(2, (m3.distance(min, max) + size) * 1.4);
  };

  // アセットのパネルからモデル（.glb）を運んでくると、落とした所の地面に置く
  canvas.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes(ASSET_MIME)) e.preventDefault(); });
  canvas.addEventListener('drop', (e) => {
    const path = e.dataTransfer?.getData(ASSET_MIME);
    if (!path || !/\.glb$/i.test(path) || app.play) return;
    e.preventDefault();
    const scene = app.state.scenes[app.scene];
    if (!scene) return;
    cam = camera();
    const ray = screenRay(cam, ...at(e), canvas.width, canvas.height);
    // 地面（y = 0）との交わり。空を指していたら、見ている点
    const t = Math.abs(ray.dir[1]) > 1e-6 ? -ray.origin[1] / ray.dir[1] : -1;
    const p = t > 0 && t < 5000 ? m3.add(ray.origin, m3.scale(ray.dir, t)) : view.target;
    const base = (path.split('/').pop() ?? 'model').replace(/\.glb$/i, '').replace(/[^A-Za-z0-9_]/g, '_') || 'model';
    let id = base;
    for (let n = 2; scene.entities.some((x) => x.id === id); n++) id = `${base}${n}`;
    void app.patch([{ op: 'addEntity', scene: app.scene, entity: { id, name: id, components: { Transform3D: { x: round(p[0], 100), y: 0, z: round(p[2], 100) }, Model3D: { model: path } } } }], 'scene3d')
      .then((r) => { if (r) app.select({ kind: 'scene', scene: app.scene, id }); });
  });

  /** 選んだ物に、見た目に合う当たり判定を付ける（形はあとでインスペクタで直せる） */
  const fitCollider = async () => {
    const id = selected()[0], w = world();
    const e = id && w ? w.entities.get(id) : undefined;
    if (!e) return;
    const mesh = e.c.Mesh3D as { shape?: string; size?: Vec3 } | undefined, model = e.c.Model3D as { model?: string } | undefined;
    const info = model?.model ? app.state.assets.find((a) => a.path === model.model)?.model : undefined;
    let values: Record<string, unknown>;
    if (mesh) {
      const size = mesh.size ?? [1, 1, 1];
      values = mesh.shape === 'sphere' ? { shape: 'sphere', size: [size[0], size[0], size[0]] }
        : mesh.shape === 'capsule' ? { shape: 'capsule', size: [size[0], size[1], size[0]] }
        : mesh.shape === 'plane' ? { shape: 'box', size: [size[0], 0.2, size[2]], offset: [0, -0.1, 0] }
        : mesh.shape === 'cylinder' ? { shape: 'box', size: [size[0], size[1], size[0]] }
        : { shape: 'box', size };
    } else if (info) values = { shape: 'box', size: info.size.map((v) => round(v, 1000)), offset: info.center.map((v) => round(v, 1000)) };
    else values = { shape: 'box', size: [1, 1, 1] };
    const target = `${app.scene}#${id}`;
    await app.patch(e.c.Collider3D
      ? Object.entries(values).map(([k, v]) => ({ op: 'set' as const, path: `${target}.Collider3D.${k}`, value: v }))
      : [{ op: 'addComponent' as const, target, component: 'Collider3D', values }], 'scene3d');
  };

  /** 形・光・カメラを足す（見ている点に） */
  const addMenu = (e: MouseEvent) => {
    if (app.play) { toast(T('再生中は足せません（止めてから）'), 'warn'); return; }
    const scene = app.state.scenes[app.scene];
    if (!scene) return;
    const free = (base: string) => { let id = base; for (let n = 2; scene.entities.some((x) => x.id === id); n++) id = `${base}${n}`; return id; };
    const at3 = (y: number) => ({ x: round(view.target[0], 10), y, z: round(view.target[2], 10) });
    const add = (base: string, components: Record<string, Record<string, unknown>>) => async () => {
      const id = free(base);
      const r = await app.patch([{ op: 'addEntity', scene: app.scene, entity: { id, name: id, components } }], 'scene3d');
      if (r) app.select({ kind: 'scene', scene: app.scene, id });
    };
    const shape = (label: string, s: string, size: Vec3, y: number): [string, () => void] => [label, add(s, { Transform3D: at3(y), Mesh3D: { shape: s, size } })];
    menu(e.clientX, e.clientY, [
      shape(T('箱'), 'box', [1, 1, 1], 0.5),
      shape(T('球'), 'sphere', [1, 1, 1], 0.5),
      shape(T('円柱'), 'cylinder', [1, 2, 1], 1),
      shape(T('カプセル'), 'capsule', [0.8, 1.8, 0.8], 0.9),
      shape(T('板（床）'), 'plane', [20, 1, 20], 0),
      [T('太陽の光'), add('sun', { Transform3D: { ...at3(8), rx: 50, ry: -30 }, Light3D: { kind: 'sun' } })],
      [T('点の光'), add('lamp', { Transform3D: at3(2), Light3D: { kind: 'point' } })],
      [T('パーティクル（粒）'), add('fx', { Transform3D: at3(1), Particles3D: { rate: 30 } })],
      ...(selected().length ? [[T('当たり判定を、選んだ物の形に合わせて付ける'), fitCollider] as [string, () => void]] : []),
      [T('カメラ'), add('camera', { Transform3D: { x: round(cam.pos[0], 10), y: round(cam.pos[1], 10), z: round(cam.pos[2], 10), rx: round(view.pitch, 10), ry: round(view.yaw, 10) }, Camera3D: {} })],
    ]);
  };

  (el.ownerDocument.defaultView ?? window).requestAnimationFrame(draw);
  // 確かめ・拡張用（視点・クリックの位置の物・描いた物）
  const client = (p: { x: number; y: number } | null) => { if (!p) return null; const r = canvas.getBoundingClientRect(), k = canvas.width / Math.max(1, r.width); return { x: r.left + p.x / k, y: r.top + p.y / k }; };
  (app as unknown as { scene3d?: unknown }).scene3d = {
    view, camera: () => cam, pickAt, frame, setTool, worldMatrix, canvas, fitCollider,
    /** 物の位置が映っている所（ブラウザの窓の px） */
    screenOf: (id: string) => { cam = camera(); const w = world(), m = w && matrixOf(w, id); return m ? client(px(m3.positionOf(m))) : null; },
    /** ギズモの取っ手の先（軸 0〜2）。回す道具なら輪の上の点（t は 0〜1） */
    handleAt: (axis: number, t = 0.125) => ((cam = camera(), gizmo = gizmoNow()) ? client(px(tool === 'rotate' ? ring(gizmo, axis)[Math.round(t * 48)] : m3.add(gizmo.origin, m3.scale(gizmo.axes[axis], gizmo.len)))) : null),
  };
  return { id: 'scene3d', title: T('3D シーン'), el, fill: true, area: 'center' };
}
