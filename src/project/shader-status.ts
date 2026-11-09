// エディタでシェーダーをコンパイルした結果（手元だけに置く。AI は ages check で読む）。
// コンパイルはブラウザ（WebGL）でしかできないので、エディタが開いていれば、ファイルが変わるたびに確かめてここへ書く。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { agesHome } from './seal.ts';
import { codeHash } from '../core/shader.ts';
import type { AssetInfo } from './assets.ts';

export interface ShaderResult {
  /** コンパイルした中身の指紋（今の中身と同じときだけ使う） */
  hash: string;
  error: string | null;
  t: string;
}

const file = (root: string) => join(agesHome(), 'shaders', createHash('sha1').update(resolve(root)).digest('hex') + '.json');

export async function readShaderResults(root: string): Promise<Record<string, ShaderResult>> {
  try { return JSON.parse(await readFile(file(root), 'utf8')); } catch { return {}; }
}

let queue = Promise.resolve();
export function writeShaderResult(root: string, path: string, hash: string, error: string | null): Promise<void> {
  queue = queue.then(async () => {
    const all = await readShaderResults(root);
    all[path] = { hash, error, t: new Date().toISOString() };
    await mkdir(dirname(file(root)), { recursive: true });
    await writeFile(file(root), JSON.stringify(all, null, 1));
  }).catch(() => {});
  return queue;
}

/** プロジェクトのシェーダーの、コンパイルの問題（エラー）と、まだ確かめていないもの */
export async function shaderReport(root: string, assets: AssetInfo[]): Promise<{ errors: string[]; unchecked: string[] }> {
  const results = await readShaderResults(root);
  const errors: string[] = [], unchecked: string[] = [];
  for (const a of assets) {
    if (!a.shader || a.shader.errors.length) continue;
    const r = results[a.path];
    if (!r || r.hash !== codeHash(a.shader.code)) { unchecked.push(a.path); continue; }
    if (r.error) errors.push(`${r.error}（エディタでコンパイルしたときのエラー）`);
  }
  return { errors, unchecked };
}
