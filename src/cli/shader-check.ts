// エディタを開いていなくても、シェーダーのコンパイルを確かめる（issue #148）。
// headless の Chrome（ages run --shot・export --check と同じもの）の WebGL2 でコンパイルし、エディタと同じ記録（shader-status）に書く。
// エラーの行番号は、包んだ行（#line 1）で元のファイルの行に合っている
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, findChrome, kill, waitFor } from './shot.ts';
import { codeHash, wrapShader, type ShaderDef } from '../core/shader.ts';
import { writeShaderResult } from '../project/shader-status.ts';

/** シェーダーをコンパイルして結果を書く。Chrome がなければ null（今までどおり「まだ確かめていない」） */
export async function compileShadersHeadless(root: string, defs: ShaderDef[], timeoutMs = 60_000): Promise<Map<string, string | null> | null> {
  if (!defs.length) return new Map();
  const chrome = findChrome();
  if (!chrome) return null;
  const profile = await mkdtemp(join(tmpdir(), 'ages-shader-'));
  const b = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-sandbox', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  b.stderr!.on('data', (d) => { err += d; });
  try {
    const ws = await waitFor<string>('Chrome', timeoutMs, async () => /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1]);
    const cdp = await Cdp.open(ws);
    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const src = defs.map((d) => ({ path: d.path, fs: wrapShader(d) }));
      const expression = `(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return { error: 'WebGL2 が使えません' };
        const out = {};
        for (const s of ${JSON.stringify(src)}) {
          const sh = gl.createShader(gl.FRAGMENT_SHADER);
          gl.shaderSource(sh, s.fs);
          gl.compileShader(sh);
          out[s.path] = gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? null : (gl.getShaderInfoLog(sh) || 'コンパイルできません');
          gl.deleteShader(sh);
        }
        return { out };
      })()`;
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      const v = r.result?.value as { error?: string; out?: Record<string, string | null> } | undefined;
      if (!v?.out) return null;
      const results = new Map<string, string | null>();
      for (const d of defs) {
        const log = v.out[d.path];
        const error = log ? shaderErrorText(d.path, log) : null;
        results.set(d.path, error);
        await writeShaderResult(root, d.path, codeHash(d.code), error);
      }
      return results;
    } finally {
      cdp.close();
    }
  } catch {
    return null;
  } finally {
    kill(b);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** コンパイルのエラーを「ファイル:行: 内容」に（エディタと同じ形） */
export function shaderErrorText(path: string, message: string): string {
  const lines = [...message.matchAll(/ERROR:\s*\d+:(\d+):\s*([^\n]*)/g)].map((m) => `${path}:${m[1]}: ${m[2].trim()}`);
  return lines.length ? lines.join('\n') : `${path}: ${message.trim()}`;
}
