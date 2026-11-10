// 出来事のつながりの検証（動かさずに ages check で見つける）。
// `on` で受けている出来事を、コードのどこからも出していなければ ⚠（名前の書き間違い・出す所の書き忘れ）。
// 名前は文字なので型チェックでは見えず、動かしても「何も起きない」だけで気づきにくい。

/** 本体が出す出来事（ゲームのコードで出さなくてよい） */
export const STD_EVENTS = ['scene', 'ui.click'];

/** コードの中で出している出来事: ctx.emit('名前')・トゥイーンの emit: '名前'。名前を式で出している所は dynamic に */
export function codeEmits(files: Iterable<[string, string]>): { names: Map<string, string[]>; dynamic: string[] } {
  const names = new Map<string, string[]>();
  const dynamic: string[] = [];
  const add = (name: string, at: string) => names.set(name, [...(names.get(name) ?? []), at]);
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const m of line.matchAll(/\bemit\(\s*([^,)]*)/g)) {
        const lits = [...m[1].matchAll(/(['"`])([^'"`$]+)\1/g)].map((x) => x[2]);
        if (lits.length && !/\$\{/.test(m[1])) lits.forEach((n) => add(n, at));
        else if (m[1].trim()) dynamic.push(at);
      }
      for (const m of line.matchAll(/\bemit\s*:\s*(['"`])([^'"`$]+)\1/g)) add(m[2], at);
    });
  }
  return { names, dynamic };
}

/** 受けているのに、どこからも出していない出来事の ⚠ */
export function eventWarnings(systems: { name: string; on?: Record<string, unknown> }[], files: Iterable<[string, string]>, defs: Map<string, string> = new Map()): string[] {
  const { names, dynamic } = codeEmits(files);
  const out: string[] = [];
  for (const s of systems) {
    for (const ev of Object.keys(s.on ?? {})) {
      if (STD_EVENTS.includes(ev) || names.has(ev)) continue;
      const at = defs.get(`system:${s.name}`);
      const dyn = dynamic.length ? `。名前を式で出している emit が ${dynamic.length}か所（${dynamic.slice(0, 3).join(' ')}${dynamic.length > 3 ? ' …' : ''}）にあり、そこで出しているなら気にしなくてよい` : '';
      out.push(`出来事 ${ev} を ${s.name}${at ? `（${at}）` : ''}が受けているが、どこからも出していない（ctx.emit('${ev}') もトゥイーンの emit も見つからない）。名前の書き間違いか、出す所の書き忘れ${dyn}`);
    }
  }
  return out;
}
