// 追加パッケージの一覧と読み込み（ブラウザでも Node でも動く）。
// 読み込むのは、プロジェクトが packages に書いたものだけ。行き先を式で組み立てるのは、書き出し（ages export）が
// import をたどって本体を写すとき、使っていないパッケージまで写さないため（使うものは export.ts が名前で足す）
import type { PackageDef } from '../core/packages.ts';

/** 名前 → 何ができるか（入れていないプロジェクトにも、ages schema guide:packages で見せる1行） */
export const PACKAGE_LIST: Record<string, string> = {
  '3d': '3D（位置・回転、モデル、光と影、カメラ、当たり判定、エディタの3Dの視点）',
};

/** 名前の確かめ（知らない名前は直し方つきのエラー） */
export function checkPackageNames(names: unknown): string[] {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new Error('ages.project.json の packages は名前の配列で書きます（例 ["3d"]）');
  for (const n of names as string[]) if (!(n in PACKAGE_LIST)) throw new Error(`追加パッケージ ${n} はありません（ages.project.json の packages。使えるのは ${Object.keys(PACKAGE_LIST).join(' ')}）`);
  return [...new Set(names as string[])];
}

const EXT = import.meta.url.endsWith('.js') ? 'js' : 'ts';

export async function loadPackages(names: unknown): Promise<PackageDef[]> {
  const out: PackageDef[] = [];
  for (const n of checkPackageNames(names)) {
    const mod = (await import(new URL(`./${n}/index.${EXT}`, import.meta.url).href)) as { default: PackageDef };
    out.push(mod.default);
  }
  return out;
}
