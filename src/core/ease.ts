// 変わり方（イージング）。0〜1 の進み具合を、0〜1 の値にする（back・elastic は少しはみ出す）
const PI = Math.PI;
const outBounce = (t: number) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1;

export const EASES = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  inCubic: (t: number) => t ** 3,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  inQuart: (t: number) => t ** 4,
  outQuart: (t: number) => 1 - (1 - t) ** 4,
  inOutQuart: (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  inSine: (t: number) => 1 - Math.cos((t * PI) / 2),
  outSine: (t: number) => Math.sin((t * PI) / 2),
  inOutSine: (t: number) => -(Math.cos(PI * t) - 1) / 2,
  inExpo: (t: number) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  outExpo: (t: number) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutExpo: (t: number) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  inBack: (t: number) => c3 * t ** 3 - c1 * t * t,
  outBack: (t: number) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  inOutBack: (t: number) => (t < 0.5 ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2 : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  inElastic: (t: number) => (t === 0 || t === 1 ? t : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ((2 * PI) / 3))),
  outElastic: (t: number) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * PI) / 3)) + 1),
  inBounce: (t: number) => 1 - outBounce(1 - t),
  outBounce,
  inOutBounce: (t: number) => (t < 0.5 ? (1 - outBounce(1 - 2 * t)) / 2 : (1 + outBounce(2 * t - 1)) / 2),
  /** 最後に一気に変わる（点滅などに） */
  step: (t: number) => (t < 1 ? 0 : 1),
} satisfies Record<string, (t: number) => number>;

export type EaseName = keyof typeof EASES;
export const EASE_NAMES = Object.keys(EASES) as EaseName[];
