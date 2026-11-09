// コードの中の宣言の場所（defineSystem・defineComponent・defineTable の name）。地図と ages find で「どのファイルの何行目か」を出す。
// AIがシステムの名前から grep で探し回らずに、直接そこを開けるようにする。

/** `system:名前` / `component:名前` / `table:名前` → `game/systems.ts:120` */
export function codeDefs(files: [string, string][]): Map<string, string> {
  const out = new Map<string, string>();
  const re = /define(System|Component|Table)\(\s*\{\s*name:\s*['"`]([^'"`]+)['"`]/g;
  for (const [path, text] of files) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.set(`${m[1].toLowerCase()}:${m[2]}`, `${path.replace(/^\/+/, '')}:${line}`);
    }
  }
  return out;
}
