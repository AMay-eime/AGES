// カメラ。ワールドの座標と画面の座標の変換、画面の大きさへの合わせ方。
// 描画・エディタでのクリック・ゲームのコードが同じ計算を使う（描画は知らない純粋な計算だけ）。
import type { World } from './world.ts';

/**
 * 画面の大きさへの合わせ方（ages.project.json の view.fit）
 * - contain: 全体が入るように拡大し、余りは黒い帯（既定）
 * - cover:   画面いっぱいに拡大し、はみ出した所は切れる
 * - stretch: 縦横を別々に伸ばして画面いっぱいに（絵がゆがむ）
 * - expand:  拡大率は contain と同じで、画面が広い分だけ周りのワールドも見せる
 * - pixel:   整数倍だけで拡大（ドット絵がにじまない）。余りは黒い帯
 */
export type FitMode = 'contain' | 'cover' | 'stretch' | 'expand' | 'pixel';
export const FIT_MODES: FitMode[] = ['contain', 'cover', 'stretch', 'expand', 'pixel'];

export interface Fit {
  /** 描く大きさ（ゲームの画素）。expand のときだけ設計の大きさより大きくなる */
  viewW: number;
  viewH: number;
  /** 画面に出す位置と大きさ(px)。cover では画面からはみ出す */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 設計の大きさ（view.width/height）のゲームを、画面（幅・高さ）にどう出すか */
export function fitView(designW: number, designH: number, screenW: number, screenH: number, mode: FitMode = 'contain'): Fit {
  const sx = screenW / designW, sy = screenH / designH;
  const center = (w: number, h: number, viewW = designW, viewH = designH): Fit => ({ viewW, viewH, x: (screenW - w) / 2, y: (screenH - h) / 2, w, h });
  switch (mode) {
    case 'stretch': return center(screenW, screenH);
    case 'cover': { const s = Math.max(sx, sy); return center(designW * s, designH * s); }
    case 'pixel': { const s = Math.max(1, Math.floor(Math.min(sx, sy))); return center(designW * s, designH * s); }
    case 'expand': {
      const s = Math.min(sx, sy);
      return center(screenW, screenH, Math.round(screenW / s), Math.round(screenH / s));
    }
    default: { const s = Math.min(sx, sy); return center(designW * s, designH * s); }
  }
}

/** 決まったカメラ（描くときに使う） */
export interface CameraView {
  /** カメラのエンティティID。null は既定のカメラ（Camera を置いていないとき） */
  id: string | null;
  /** 見ている中心（揺れ込み・ワールド座標） */
  x: number;
  y: number;
  /** 回転（度） */
  rot: number;
  zoom: number;
  /** 描く先の中の範囲(px) */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  layerMin: number;
  layerMax: number;
  depth: number;
  /** この範囲を塗りつぶす色（null なら塗らない） */
  clear: string | null;
}

/**
 * ワールドにあるカメラを、描く順に並べる。Camera がなければ「画面全体をそのまま映す」既定のカメラを1つ返す。
 * canvasW/H は描く先の大きさ（ゲームの画素）、designW/H は設計の大きさ（既定のカメラの中心に使う）
 */
export function camerasOf(world: World, canvasW: number, canvasH: number, designW = canvasW, designH = canvasH): CameraView[] {
  const out: CameraView[] = [];
  for (const e of world.query('Camera', 'Transform')) {
    const c = e.c.Camera, t = e.c.Transform;
    if (c.enabled === false) continue;
    const [px, py] = c.viewPos ?? [0, 0];
    const [sw, sh] = c.viewSize ?? [1, 1];
    out.push({
      id: e.id,
      x: t.x + (c.shakeX ?? 0),
      y: t.y + (c.shakeY ?? 0),
      rot: t.rot ?? 0,
      zoom: c.zoom || 1,
      vx: px * canvasW, vy: py * canvasH, vw: sw * canvasW, vh: sh * canvasH,
      layerMin: c.layerMin ?? -Infinity,
      layerMax: c.layerMax ?? Infinity,
      depth: c.depth ?? 0,
      clear: c.clear ? c.background ?? '#000000' : null,
    });
  }
  if (!out.length) return [defaultCamera(canvasW, canvasH, designW, designH)];
  return out.sort((a, b) => a.depth - b.depth);
}

export function defaultCamera(canvasW: number, canvasH: number, designW = canvasW, designH = canvasH): CameraView {
  return { id: null, x: designW / 2, y: designH / 2, rot: 0, zoom: 1, vx: 0, vy: 0, vw: canvasW, vh: canvasH, layerMin: -Infinity, layerMax: Infinity, depth: 0, clear: null };
}

/** ワールドの座標 → 描く先の座標(px) */
export function worldToScreen(c: CameraView, x: number, y: number): [number, number] {
  const r = (-c.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = x - c.x, dy = y - c.y;
  return [c.vx + c.vw / 2 + (dx * cos - dy * sin) * c.zoom, c.vy + c.vh / 2 + (dx * sin + dy * cos) * c.zoom];
}

/** 描く先の座標(px) → ワールドの座標 */
export function screenToWorld(c: CameraView, sx: number, sy: number): [number, number] {
  const r = (c.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = (sx - c.vx - c.vw / 2) / c.zoom, dy = (sy - c.vy - c.vh / 2) / c.zoom;
  return [c.x + dx * cos - dy * sin, c.y + dx * sin + dy * cos];
}

/** カメラが映しているワールドの範囲（4つの角。左上・右上・右下・左下） */
export function visibleCorners(c: CameraView): [number, number, number, number, number, number, number, number] {
  const p = [[c.vx, c.vy], [c.vx + c.vw, c.vy], [c.vx + c.vw, c.vy + c.vh], [c.vx, c.vy + c.vh]].flatMap(([x, y]) => screenToWorld(c, x, y));
  return p as [number, number, number, number, number, number, number, number];
}

/** 揺れ用の、フレームとカメラごとに決まる -1〜1 の値（ゲームの乱数を使わない。見た目だけの揺れで、ゲームの結果を変えないため） */
export function shakeNoise(frame: number, id: string, axis: number): number {
  let h = 2166136261 ^ (frame * 374761393) ^ (axis * 668265263);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483647.5 - 1;
}
