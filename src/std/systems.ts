// 標準のシステム。ゲームのシステムの後に、この順で動く。
import { defineSystem } from '../core/registry.ts';
import { sheetPathOf } from '../core/sheet.ts';

/** Animator の再生。毎フレーム Sprite.frame を進める */
export const animator = defineSystem({
  name: 'std.animator',
  desc: 'Animator のアニメーションを進め、Sprite.frame を書き換える（標準）',
  reads: ['Animator'],
  writes: ['Sprite', 'Animator'],
  update({ world, dt, destroy }) {
    for (const e of world.query('Animator', 'Sprite')) {
      const a = e.c.Animator, s = e.c.Sprite;
      if (a.current !== a.clip) { a.current = a.clip; a.time = 0; a.playing = true; }
      if (!a.clip || !a.playing) continue;
      const sheet = world.registry.sheets.get(sheetPathOf(s.image));
      const clip = sheet?.clips?.[a.clip];
      if (!clip) continue; // 検証（ages check）で知らせる
      a.time += dt * a.speed;
      const n = Math.floor(a.time * clip.fps);
      if (clip.loop === false && n >= clip.frames.length) {
        s.frame = clip.frames[clip.frames.length - 1];
        a.playing = false;
        if (a.destroyOnEnd) destroy(e.id);
        continue;
      }
      s.frame = clip.frames[n % clip.frames.length];
    }
  },
});

export const STD_SYSTEMS = [animator];
