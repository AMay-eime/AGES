// 位置の親子（Transform.parent）。子の x・y・rot・sx・sy は親から見た値で、画面（ワールド）の値はここで求める。
// 親の回転・倍率も子にかかる（Unity と同じ）。親が鏡写し（倍率が負）なら、子の回転は逆向きになる。
// 求め方はその場で親をたどるだけ（状態を持たない）。なので、どこで読んでも、そのときの親の位置に合う。

/** 位置・向き・大きさ（親から見た値か、画面の値） */
export interface Pose { x: number; y: number; rot: number; sx: number; sy: number }

/** 親子の深さの上限（輪になっていても止まる） */
export const MAX_DEPTH = 32;

/** 親の画面の値 p に、親から見た値 t を重ねて、画面の値にする */
export function compose(p: Pose, t: Pose): Pose {
  const rad = ((p.rot ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const psx = p.sx ?? 1, psy = p.sy ?? 1;
  const lx = (t.x ?? 0) * psx, ly = (t.y ?? 0) * psy;
  const flip = (psx < 0) !== (psy < 0);
  return {
    x: (p.x ?? 0) + lx * c - ly * s,
    y: (p.y ?? 0) + lx * s + ly * c,
    rot: (p.rot ?? 0) + (flip ? -(t.rot ?? 0) : (t.rot ?? 0)),
    sx: psx * (t.sx ?? 1),
    sy: psy * (t.sy ?? 1),
  };
}

/** 画面の値 w を、親（画面の値 p）から見た値にする（compose の逆） */
export function relativeTo(p: Pose, w: Pose): Pose {
  const rad = ((p.rot ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const psx = p.sx || 1, psy = p.sy || 1;
  const dx = (w.x ?? 0) - (p.x ?? 0), dy = (w.y ?? 0) - (p.y ?? 0);
  const flip = (psx < 0) !== (psy < 0);
  const dr = (w.rot ?? 0) - (p.rot ?? 0);
  return {
    x: (dx * c + dy * s) / psx,
    y: (-dx * s + dy * c) / psy,
    rot: flip ? -dr : dr,
    sx: (w.sx ?? 1) / psx,
    sy: (w.sy ?? 1) / psy,
  };
}

/** 画面の点 (x, y) を、親（画面の値 p）から見た点にする */
export function pointTo(p: Pose, x: number, y: number): [number, number] {
  const r = relativeTo(p, { x, y, rot: 0, sx: 1, sy: 1 });
  return [r.x, r.y];
}

/** 画面での動き (dx, dy) を、親（画面の値 p）から見た動きにする（回転・倍率を戻す） */
export function deltaTo(p: Pose, dx: number, dy: number): [number, number] {
  const rad = ((p.rot ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  return [(dx * c + dy * s) / (p.sx || 1), (-dx * s + dy * c) / (p.sy || 1)];
}

/**
 * 物の画面の値。親がない（見つからない）なら Transform そのもの（作り直さない。書き換えないこと）。
 * get は ID から Transform と親を引く関数（実行中の World でも、シーンのデータでも使えるように）
 */
export function poseOf(get: (id: string) => Pose & { parent?: string | null } | undefined, t: Pose & { parent?: string | null }, depth = 0): Pose {
  if (!t.parent || depth >= MAX_DEPTH) return t;
  const pt = get(t.parent);
  if (!pt || pt === t) return t;
  return compose(poseOf(get, pt, depth + 1), t);
}
