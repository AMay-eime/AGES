// 試しの舞台（api.stage）とゲームの画面の、重ねて描くもの: 拡張の描き込み（g.circle など）・当たり判定・画面の枠と、視点の計算。
// DOM を使わない（描き先の 2D の文脈を受け取る。Node のテストでは記録するだけの物を渡す）。
import { screenToWorld, visibleCorners, worldToScreen, type CameraView } from '../core/camera.ts';
import { shapeOf } from '../core/collide.ts';
import type { World } from '../core/world.ts';
import type { DrawStyle, StageDraw } from './window-api.ts';

type Ctx2D = CanvasRenderingContext2D;

/** 自由な視点: 設計の画面全体が W×H に入る大きさを 1 として zoom 倍。真ん中は (x, y)（省くと画面の真ん中） */
export function freeView(design: { width: number; height: number }, W: number, H: number, v: { zoom?: number; x?: number; y?: number } = {}): CameraView {
  const fit = Math.min(W / design.width, H / design.height);
  return { id: null, x: v.x ?? design.width / 2, y: v.y ?? design.height / 2, rot: 0, zoom: fit * (v.zoom ?? 1), vx: 0, vy: 0, vw: W, vh: H, layerMin: -Infinity, layerMax: Infinity, depth: 0, clear: null };
}

/** w×h を、縦横比を保って box に入れた大きさ */
export function fitBox(w: number, h: number, boxW: number, boxH: number): { w: number; h: number } {
  const s = Math.min(boxW / w, boxH / h);
  return { w: w * s, h: h * s };
}

/** 点 (px, py)（キャンバスの px）を映しているカメラ（手前から。なければ最初のカメラ） */
export function cameraAt(cams: CameraView[], px: number, py: number): CameraView | undefined {
  return [...cams].reverse().find((c) => px >= c.vx && py >= c.vy && px <= c.vx + c.vw && py <= c.vy + c.vh) ?? cams[0];
}

/** キャンバスの点（左上からの割合 u・v）→ ワールドの座標 */
export function canvasToWorld(cams: CameraView[], W: number, H: number, u: number, v: number): [number, number] | null {
  const px = u * W, py = v * H;
  const cam = cameraAt(cams, px, py);
  return cam ? screenToWorld(cam, px, py) : null;
}

/** カメラが映しているワールドの範囲（回転していれば囲む四角） */
export function visibleRect(c: CameraView): { x: number; y: number; w: number; h: number } {
  const q = visibleCorners(c);
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const LINE = 'rgba(255,255,255,0.9)';

/**
 * 拡張の描き込み。cam はキャンバスの視点、k はキャンバスの px → 描き先の px、unit は画面（CSS）の px → 描き先の px
 */
export function makeDraw(og: Ctx2D, cam: CameraView, k: number, unit: number): StageDraw {
  const at = (x: number, y: number): [number, number] => {
    const [sx, sy] = worldToScreen(cam, x, y);
    return [sx * k, sy * k];
  };
  /** ワールドの長さ → 描き先の px */
  const len = (n: number, s: DrawStyle) => (s.px ? n * unit : n * cam.zoom * k);
  const begin = (s: DrawStyle) => {
    og.save();
    og.globalAlpha = Math.max(0, Math.min(1, s.alpha ?? 1));
    og.lineWidth = (s.width ?? 1.5) * unit;
    og.setLineDash((s.dash ?? []).map((d) => d * unit));
    og.strokeStyle = s.color && s.color !== 'none' ? s.color : LINE;
    if (s.fill) og.fillStyle = s.fill;
    og.beginPath();
  };
  const end = (s: DrawStyle) => {
    if (s.fill) og.fill();
    if (s.color !== 'none') og.stroke();
    og.restore();
  };
  return {
    circle(x, y, r, s = {}) {
      begin(s);
      const [cx, cy] = at(x, y);
      og.arc(cx, cy, Math.max(0, len(r, s)), 0, Math.PI * 2);
      end(s);
    },
    rect(x, y, w, h, s = {}) {
      begin(s);
      if (s.px || cam.rot === 0) {
        // 回っていない（か画面の大きさの）四角は、そのまま
        let [x0, y0] = at(x, y);
        const pw = len(w, s), ph = len(h, s);
        if (s.center) { x0 -= pw / 2; y0 -= ph / 2; }
        og.rect(x0, y0, pw, ph);
      } else {
        const ox = s.center ? -w / 2 : 0, oy = s.center ? -h / 2 : 0;
        const q = [[x + ox, y + oy], [x + ox + w, y + oy], [x + ox + w, y + oy + h], [x + ox, y + oy + h]].map(([a, b]) => at(a, b));
        og.moveTo(q[0][0], q[0][1]);
        for (const p of q.slice(1)) og.lineTo(p[0], p[1]);
        og.closePath();
      }
      end(s);
    },
    line(x1, y1, x2, y2, s = {}) {
      begin(s);
      const a = at(x1, y1), b = at(x2, y2);
      og.moveTo(a[0], a[1]);
      og.lineTo(b[0], b[1]);
      end({ ...s, fill: undefined });
    },
    polyline(points, s = {}) {
      if (points.length < 4) return;
      begin(s);
      for (let i = 0; i + 1 < points.length; i += 2) {
        const p = at(points[i], points[i + 1]);
        if (i === 0) og.moveTo(p[0], p[1]); else og.lineTo(p[0], p[1]);
      }
      if (s.closed) og.closePath();
      end(s.closed ? s : { ...s, fill: undefined });
    },
    text(x, y, text, s = {}) {
      og.save();
      og.globalAlpha = Math.max(0, Math.min(1, s.alpha ?? 1));
      og.font = `${(s.size ?? 11) * unit}px ui-monospace, monospace`;
      og.textAlign = s.align ?? 'left';
      og.textBaseline = 'middle';
      const [px, py] = at(x, y);
      // 下の絵に埋もれないように、暗い縁を付ける
      og.lineWidth = 3 * unit;
      og.strokeStyle = 'rgba(0,0,0,0.65)';
      og.strokeText(text, px, py);
      og.fillStyle = s.color && s.color !== 'none' ? s.color : LINE;
      og.fillText(text, px, py);
      og.restore();
    },
  };
}

/** 当たり判定のグループごとの色 */
export function hitColor(g: string): string {
  let n = 0;
  for (const ch of g) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsla(${n % 360}, 90%, 62%, 0.9)`;
}

/** 当たり判定（Collider）の形を、カメラごとにその範囲の中だけ描く（ゲームの画面と舞台で同じ）。k はキャンバスの px → 描き先の px */
export function drawColliders(og: Ctx2D, world: World, cams: CameraView[], k = 1, unit = 1): void {
  og.save();
  og.lineWidth = unit;
  og.setLineDash([]);
  for (const cam of cams) {
    og.save();
    og.beginPath();
    og.rect(cam.vx * k, cam.vy * k, cam.vw * k, cam.vh * k);
    og.clip();
    const at = (x: number, y: number) => { const [sx, sy] = worldToScreen(cam, x, y); return [sx * k, sy * k]; };
    for (const e of world.entities.values()) {
      if (e.c.UI || (e.c.Sprite?.layer ?? 0) < cam.layerMin || (e.c.Sprite?.layer ?? 0) > cam.layerMax) continue;
      const sh = shapeOf(e);
      if (!sh) continue;
      og.strokeStyle = hitColor(String(e.c.Collider.group ?? ''));
      og.beginPath();
      if (sh.kind === 'circle') {
        const [x, y] = at(sh.x, sh.y);
        og.arc(x, y, sh.r * cam.zoom * k, 0, Math.PI * 2);
      } else {
        const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => at(sh.x + a * sh.hw * sh.cos - b * sh.hh * sh.sin, sh.y + a * sh.hw * sh.sin + b * sh.hh * sh.cos));
        og.moveTo(q[0][0], q[0][1]);
        for (const p of q.slice(1)) og.lineTo(p[0], p[1]);
        og.closePath();
      }
      og.stroke();
    }
    og.restore();
  }
  og.restore();
}

/** プレイヤーに見える画面の枠（ワールドの角）を点線で。k・unit は makeDraw と同じ */
export function drawScreens(og: Ctx2D, cam: CameraView, screens: number[][], k: number, unit: number): void {
  og.save();
  og.lineWidth = unit;
  og.setLineDash([6 * unit, 4 * unit]);
  og.strokeStyle = 'rgba(126,231,135,0.85)';
  for (const q of screens) {
    og.beginPath();
    for (let i = 0; i < q.length; i += 2) {
      const [sx, sy] = worldToScreen(cam, q[i], q[i + 1]);
      if (i === 0) og.moveTo(sx * k, sy * k); else og.lineTo(sx * k, sy * k);
    }
    og.closePath();
    og.stroke();
  }
  og.restore();
}
