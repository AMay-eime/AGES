// 日時。ゲームのコードは ctx.date で読む。
// 「同じ入力なら同じ結果」を崩さないように、実際の時計から取るのは始めた時刻だけにして、そこからはゲームの中の時間で進める。
// 画面なしの ages run は決まった日時で始める（--date で変える）。入力の記録には始めた日時が残る。

/** 始めた日時（ms: 1970-01-01 UTC からのミリ秒、tz: UTC からのずれ（分）） */
export interface DateStart {
  ms: number;
  tz: number;
}

export interface GameDate {
  year: number;
  /** 1〜12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 曜日（0=日 〜 6=土） */
  weekday: number;
  /** 1970-01-01 UTC からのミリ秒（経った時間の比べに） */
  ms: number;
}

/** 画面なしの実行（ages run など）で使う日時（--date で変える） */
export const RUN_DATE = '2026-01-01T12:00';

/** 今の実際の時計（ブラウザで遊ぶとき） */
export function realDate(): DateStart {
  return { ms: Date.now(), tz: -new Date().getTimezoneOffset() };
}

/**
 * '2026-12-25'・'2026-12-25T09:00'・'2026-12-25 09:00:30+09:00' の形を読む。
 * ずれ（+09:00・Z）を省くと、書いた日時がそのままゲームの日時になる
 */
export function parseDate(s: string): DateStart {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) throw new Error(`日時 "${s}" の書き方が違います（例 2026-12-25、2026-12-25T09:00、2026-12-25T09:00+09:00）`);
  const [y, mo, d, h, mi, se] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  const back = new Date(wall);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) throw new Error(`日時 "${s}" はありません`);
  let tz = 0;
  if (m[7] && m[7] !== 'Z') {
    const z = m[7].replace(':', '');
    tz = (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
  }
  return { ms: wall - tz * 60000, tz };
}

/** 始めた日時を、記録に残す形（2026-12-25T09:00:00+09:00） */
export function formatDate(st: DateStart): string {
  const d = new Date(st.ms + st.tz * 60000);
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${st.tz < 0 ? '-' : '+'}${p(Math.trunc(st.tz / 60))}:${p(st.tz % 60)}`;
}

/** 始めた日時から elapsed ミリ秒たったときの日時 */
export function dateAt(st: DateStart, elapsed: number): GameDate {
  const ms = st.ms + Math.round(elapsed);
  const d = new Date(ms + st.tz * 60000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay(), ms };
}
