// 段階2-3: 音（命令・間引き・物に付いた音・音量の区分・検証・画面なしでの記録）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from '../src/project/project.ts';
import { wavSeconds } from '../src/project/assets.ts';
import { cmdRun } from '../src/cli/ages.ts';
import type { AudioCmd } from '../src/core/audio.ts';

process.env.AGES_HOME ??= await mkdtemp(join(tmpdir(), 'ages-home-'));
const ai = { who: 'ai', kind: 'ai' as const, win: 'cli' };

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ages-'));
  await cp(new URL('../examples/shooter', import.meta.url), dir, { recursive: true });
  await rm(join(dir, '.ages'), { recursive: true, force: true });
  return dir;
}

test('ctx.sound.play: プレハブの設定で鳴らし、回数を数える。間引きはフレームで数える', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  const cmds: AudioCmd[] = [];
  g.audioListeners.push((c) => cmds.push(c));
  g.step();
  assert.equal(g.ctx.sound.play('se_shot', { volume: 0.5, pitch: 2 }), true);
  const c = cmds.find((x) => x.t === 'play' && x.cue === 'se_shot');
  assert.deepEqual(c && c.t === 'play' && [c.clip, c.bus, c.volume, c.pitch, c.maxVoices], ['assets/sounds/shot.wav', 'se', 0.35 * 0.5, 2, 6]);
  // cooldown 0.05秒 = 3フレーム。同じフレームでもう一度は鳴らさない
  assert.equal(g.ctx.sound.play('se_shot'), false);
  g.step(); g.step();
  assert.equal(g.ctx.sound.play('se_shot'), false);
  g.step();
  assert.equal(g.ctx.sound.play('se_shot'), true);
  assert.equal(g.soundCounts.get('se_shot'), 2);
  // ファイルの場所でも鳴らせる（設定は既定）
  assert.equal(g.ctx.sound.play('assets/sounds/hit.wav'), true);
  // ない名前は鳴らさず、もしかして付きで記録する
  assert.equal(g.ctx.sound.play('se_shoot'), false);
  assert.match([...g.warnings].join(), /se_shoot.*もしかして: se_shot/);
});

test('物に付いた音: autoplay の物が現れたら鳴らし、消えたらその音のフェードで止める', async () => {
  const p = await Project.load(await fresh());
  await p.apply([{ op: 'addEntity', scene: 'main', entity: { id: 'engine', components: { Sound: { clip: 'assets/sounds/hit.wav', loop: true, autoplay: true, fadeOut: 0.3 } } } }], ai);
  const g = p.newGame();
  const cmds: AudioCmd[] = [];
  g.audioListeners.push((c) => cmds.push(c));
  g.step();
  const plays = cmds.filter((c) => c.t === 'play');
  assert.deepEqual(plays.map((c) => c.t === 'play' && [c.cue, c.owner, c.bus, c.loop]), [['bgm', 'bgm', 'bgm', true], ['engine', 'engine', 'se', true]]);
  g.step();
  assert.equal(cmds.filter((c) => c.t === 'play').length, 2, '鳴り続けている間は、もう一度鳴らさない');
  g.world.destroy('engine');
  g.world.flush();
  g.step();
  assert.deepEqual(cmds.at(-1), { t: 'stop', frame: 2, owner: 'engine', fade: 0.3 });
});

test('音量の区分: ctx.sound.volume はシーンの Mixer を変える。Mixer は1つだけ', async () => {
  const p = await Project.load(await fresh());
  const g = p.newGame();
  g.ctx.sound.volume('bgm', 1.5);
  assert.equal(g.world.get('mixer')!.c.Mixer.bgm, 1, '0〜1 に収める');
  await assert.rejects(p.apply([{ op: 'addEntity', scene: 'main', entity: { id: 'mixer2', components: { Mixer: {} } } }], ai), /Mixer が 2 個/);
  await assert.rejects(p.apply([{ op: 'set', path: '@se_hit.Sound.clip', value: 'assets/sounds/hitt.wav' }], ai), /もしかして: assets\/sounds\/hit\.wav/);
});

test('ages run: 何が何回鳴ったかと、見つからない音を要約に出す', async () => {
  const dir = await fresh();
  const out = await cmdRun(dir, { frames: '120', keys: '0-120:KeyZ' });
  assert.match(out, /sounds: .*♪se_shot×\d+.*♪bgm×1/);
  const p = await Project.load(dir);
  assert.deepEqual(p.validate(), []);
  // WAV の長さを地図に出す
  assert.equal(wavSeconds(await readFile(join(dir, 'assets/sounds/shot.wav'))), 1985 / 22050);
  assert.equal(p.assets.find((a) => a.path === 'assets/sounds/bgm.wav')!.sec, 6.4);
});
