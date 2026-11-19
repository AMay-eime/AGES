// まとめて描けるかの判定（WebGL に触らない純関数。テストから使う）

/** 効果つきで描くときの設定のうち、まとめて描けるかに関わるもの */
export interface MatKey {
  prog: unknown;
  params: Record<string, unknown>;
  /** コマの範囲 (u0, v0, u1, v1)。uniform なので、違えば別々に描く */
  rect: readonly number[];
}

/**
 * 同じ描き方か。同じシェーダー・同じ値・同じコマの範囲なら、物が違ってもまとめて描ける（issue #146）。
 * u_time・u_res は描くたびに同じ、u_texel は画像で決まり画像が変われば別に描くので、比べなくてよい
 */
export function sameMat(a: MatKey | null, b: MatKey | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.prog !== b.prog) return false;
  for (let i = 0; i < 4; i++) if (a.rect[i] !== b.rect[i]) return false;
  const ka = Object.keys(a.params), kb = Object.keys(b.params);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!(k in b.params)) return false;
    const x = a.params[k], y = b.params[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i])) continue;
    return false;
  }
  return true;
}
