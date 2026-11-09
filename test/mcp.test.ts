import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url));

/** MCPサーバーを起動して、順にメッセージを送り、返事を集める */
async function talk(project: string, messages: object[]): Promise<any[]> {
  const home = await mkdtemp(join(tmpdir(), 'ages-home-'));
  const child = spawn(process.execPath, [SERVER, '--project', project], { env: { ...process.env, AGES_HOME: home, NODE_NO_WARNINGS: '1' } });
  const replies: any[] = [];
  let buf = '';
  const want = messages.filter((m: any) => m.id !== undefined).length;
  const done = new Promise<void>((ok) => {
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (replies.length === want) ok();
      }
    });
  });
  for (const m of messages) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  await done;
  child.kill();
  return replies;
}

test('MCP: 初期化で使い方の説明を渡し、道具の一覧と呼び出しができる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ages-mcp-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  const r = await talk(dir, [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'ages_map', arguments: {} } },
    { id: 4, method: 'tools/call', params: { name: 'ages_set', arguments: { address: 'main#spawner.Spawner.interval', value: 30 } } },
    { id: 5, method: 'tools/call', params: { name: 'ages_set', arguments: { address: 'main#spawner.Spawner.interval', value: -1 } } },
    { id: 6, method: 'tools/call', params: { name: 'ages_run', arguments: { frames: 120, twice: true } } },
    { id: 7, method: 'nope' },
    { id: 8, method: 'tools/call', params: { name: 'ages_find', arguments: { words: '体力' } } },
    { id: 9, method: 'tools/call', params: { name: 'ages_map', arguments: { section: 'tables' } } },
  ]);
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.match(by[1].result.instructions, /EDITOR-PLAN\.md/);
  assert.equal(by[1].result.serverInfo.name, 'ages');
  assert.ok(by[2].result.tools.some((t: any) => t.name === 'ages_patch'));
  assert.match(by[3].result.content[0].text, /## components/);
  assert.match(by[4].result.content[0].text, /45 → 30/);
  assert.equal(by[5].result.isError, true);
  assert.match(by[5].result.content[0].text, /最小値 1 未満/);
  assert.match(by[6].result.content[0].text, /再現性: OK/);
  assert.equal(by[7].error.code, -32601);
  assert.match(by[8].result.content[0].text, /^部品 Health — 体力/m);
  assert.match(by[9].result.content[0].text, /^## tables/);
});
