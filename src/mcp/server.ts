// AGES の MCP サーバー（依存ゼロ）。
// 使用者のPC上で、AIのアプリ（Claude Code など）がこのプログラムを起動し、標準入出力でやりとりする。ネット上のサーバーは要らない。
//   node <AGES>/src/mcp/server.ts --project <プロジェクトのフォルダ>
// 道具（tools）は CLI と同じ関数を呼ぶだけ。使い方の説明（instructions）も一緒に渡すので、AIは最初から手順を知っている。
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeInstructions, makeTools, type Tool } from './tools.ts';
import { packageCommands, useActiveTask, withTalkNotice } from '../cli/ages.ts';

process.removeAllListeners('warning');

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const defaultProject = resolve(flag('project') ?? process.env.AGES_PROJECT ?? process.cwd());
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;

const BASE = makeTools(defaultProject);
/** 道具の一覧（本体のもの + そのプロジェクトが入れている追加パッケージの命令。入れていなければ増えない） */
async function tools(dir = defaultProject): Promise<Tool[]> {
  const extra = (await packageCommands(dir)).map((c): Tool => ({
    name: `ages_${c.name}`,
    description: c.desc,
    inputSchema: { type: 'object', properties: { dir: { type: 'string' }, ...c.props } },
    run: (a, d) => c.run(d, Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== 'dir' && v !== undefined && v !== false).map(([k, v]) => [k, v === true ? true : Array.isArray(v) ? v.join(',') : String(v)]))),
  }));
  return [...BASE, ...extra];
}

// ---------- JSON-RPC（1行に1メッセージ） ----------
const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };

async function handle(msg: { id?: number | string; method: string; params?: any }): Promise<void> {
  const reply = (result: unknown): void => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); };
  const fail = (code: number, message: string): void => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code, message } }); };
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ages', version: VERSION },
        instructions: makeInstructions(defaultProject),
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: (await tools()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const a = msg.params?.arguments ?? {};
      const TOOLS = await tools(resolve(a.dir ?? defaultProject));
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `道具 ${msg.params?.name} はありません。使えるのは ${TOOLS.map((t) => t.name).join(' / ')}`);
      try {
        const dir = resolve(a.dir ?? defaultProject);
        await useActiveTask(dir);
        const text = await withTalkNotice(dir, tool.name === 'ages_talk' ? 'talk' : tool.name, await tool.run(a, dir));
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        // 道具のエラーは「失敗した結果」として返す（AIが読んで直せるように）
        return reply({ content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `未知のメソッド ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSONとして読めません' } }); return; }
  queue = queue.then(() => handle(msg)).catch((e) => console.error(e));
});
