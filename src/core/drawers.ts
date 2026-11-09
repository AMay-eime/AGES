// エディタ拡張の欄の見せ方（fields）の match の決まり。エディタ（どの欄に使うか）・サーバー（拡張が変えてよい値か）・検証で同じものを使う。
// match の形: 型（'color'）・部品.フィールド（'Health.hp'）・$表.列（'$talks.face'）・住所（'main#player.Health.hp'）。
// 入れ子の中は、リストの項目を []、構造体・どれか1つの中を .名前 で書く（'Enemy.shotPatterns[].pattern'・'$talks.lines[].face'）。
import { formatSub, parseAddress } from './docs.ts';
import { suggest, typeOf, type Field } from './schema.ts';

/** match の細かさ（住所 3・部品.フィールド と $表.列 2・型 1） */
export function matchRank(m: string): number {
  return m.startsWith('$') ? 2 : m.includes('#') || m.startsWith('@') ? 3 : m.includes('.') ? 2 : 1;
}

/** 住所の中の番号を [] にした形（main#s.Spawner.waves[2].enemy → main#s.Spawner.waves[].enemy） */
export const anyIndex = (path: string): string => path.replace(/\[\d+\]/g, '[]');

/** 欄の key: match の「部品.フィールド」「$表.列」と比べる形（番号は []）。フィールドまで届かない住所なら null */
export function fieldKey(path: string): string | null {
  let a: ReturnType<typeof parseAddress>;
  try { a = parseAddress(path); } catch { return null; }
  if (!a.field) return null;
  return anyIndex(`${a.kind === 'table' ? '$' + a.doc : a.component}.${a.field}${formatSub(a.sub ?? [])}`);
}

/** match がちょうどこの欄に当たるか（key は fieldKey(path)） */
export function matchField(m: string, path: string, key: string | null, type: string): boolean {
  const r = matchRank(m);
  if (r === 3) return m === path || m === anyIndex(path);
  if (r === 2) return m === key;
  return m === type;
}

/** 見せ方の欄から、その値を変えてよいか: 当たる欄か、その中（types は欄の一番外から target までの型） */
export function matchWithin(m: string, target: string, types: string[]): boolean {
  const inside = (t: string | null) => !!t && (t === m || t.startsWith(m + '.') || t.startsWith(m + '['));
  const r = matchRank(m);
  if (r === 3) return inside(target) || inside(anyIndex(target));
  if (r === 2) return inside(fieldKey(target));
  return types.includes(m);
}

/** match を、頭（住所・部品.フィールド・$表.列）と入れ子の中（'[].pattern' など）に分ける */
export function splitMatch(m: string): { head: string; sub: string } {
  const parts = m.split(/(?=[.[])/);
  const n = matchRank(m) === 3 ? 3 : 2;
  return { head: parts.slice(0, n).join(''), sub: parts.slice(n).join('') };
}

/** 入れ子の中の場所（'[].pattern'・'.start.talk'）が型に合うか。合わなければ理由。番号（[2]）は住所の match だけ */
export function subProblem(f: Field, sub: string, at: string, allowIndex: boolean): string | null {
  const re = /\.([^.[\]\s]+)|\[(\d*)\]/y;
  let cur: Field = f, i = 0;
  while (i < sub.length) {
    re.lastIndex = i;
    const m = re.exec(sub);
    if (!m) return `入れ子の中は、リストの項目を []、構造体・どれか1つの中を .名前 で書きます（"${sub.slice(i)}" の所）`;
    i = re.lastIndex;
    if (m[2] !== undefined) {
      if (m[2] !== '' && !allowIndex) return `${at}${m[0]}: 番号は書かず [] にします（どの項目にも効く）`;
      if (cur.type !== 'list') return `${at} はリストではありません（${typeOf(cur)}）`;
      cur = cur.of;
    } else {
      const name = m[1];
      if (cur.type === 'params') return null; // シェーダーの値: 名前は選んだシェーダーで変わる
      if (cur.type === 'struct') {
        if (!cur.fields[name]) return `${at} に ${name} はありません${suggest(name, Object.keys(cur.fields))}`;
        cur = cur.fields[name];
      } else if (cur.type === 'oneOf') {
        const names = [...new Set(Object.values(cur.variants).flatMap((v) => Object.keys(v.fields)))];
        const hit = Object.values(cur.variants).find((v) => v.fields[name]);
        if (!hit) return `${at} のどの種類にも ${name} はありません${suggest(name, names)}${name === 'kind' ? '（kind は種類の選択で、見せ方は付けられません）' : ''}`;
        cur = hit.fields[name];
      } else return `${at} は構造体・どれか1つではありません（${typeOf(cur)}）`;
    }
    at += m[0];
  }
  return null;
}
