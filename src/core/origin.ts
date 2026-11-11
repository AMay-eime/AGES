// アセットの出どころの記録の形（自作・AI 生成・配布や購入の素材・人に頼んだ）。読み書きは project/origin.ts（ここはブラウザでも使う）

export const ORIGIN_BY = ['own', 'ai', 'stock', 'commission'] as const;
export type OriginBy = (typeof ORIGIN_BY)[number];
export const BY_JA: Record<OriginBy, string> = { own: '自作', ai: 'AI 生成', stock: '配布・購入の素材', commission: '人に頼んだ' };

export interface Origin {
  by: OriginBy;
  /** 使った道具（AI 生成なら、その AI の名前） */
  tool?: string;
  license?: string;
  /** 入手元（作者・配布元・URL） */
  from?: string;
  note?: string;
  /** 誰が書いたか（人が書いたものを、AI は --force なしで変えない） */
  who: 'human' | 'ai';
}
/** 場所（ファイル・`フォルダ/`・`$text.言語`）→ 出どころ */
export type Origins = Record<string, Origin>;

/** そのファイルの出どころ（そのものの記録がなければ、いちばん近いフォルダの記録）。key はどの記録か */
export function originOf(o: Origins, path: string): { origin: Origin; key: string } | undefined {
  if (o[path]) return { origin: o[path], key: path };
  let dir = path;
  for (;;) {
    const i = dir.lastIndexOf('/', dir.length - 2);
    if (i < 0) return undefined;
    dir = dir.slice(0, i + 1);
    if (o[dir]) return { origin: o[dir], key: dir };
  }
}

export interface OriginInput { by?: string; tool?: string; license?: string; from?: string; note?: string }

export function describeOrigin(x: Origin): string {
  return [BY_JA[x.by], x.tool, x.license, x.from, x.note].filter(Boolean).join('・');
}
