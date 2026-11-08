// 標準のシステム。ゲームのシステムの後に、この順で動く。
import { defineSystem } from '../core/registry.ts';
import { shakeNoise } from '../core/camera.ts';

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
      const sheet = world.registry.sheets.get(s.image);
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

/** カメラ: 追いかける・範囲に収める・揺れ。ゲームのシステムの後に動く（そのフレームで動いた相手に追いつく） */
export const camera = defineSystem({
  name: 'std.camera',
  desc: 'Camera の追いかけ・範囲の制限・揺れ（標準）',
  reads: ['Camera', 'Transform'],
  writes: ['Camera', 'Transform'],
  update({ world, dt, frame, view }) {
    for (const e of world.query('Camera', 'Transform')) {
      const c = e.c.Camera, t = e.c.Transform;
      if (c.enabled === false) continue;
      const target = c.follow ? world.get(c.follow)?.c.Transform : undefined;
      if (target) {
        const keep = c.lag ?? 0;
        for (const [k, i] of [['x', 0], ['y', 1]] as const) {
          const want = target[k] + (c.offset?.[i] ?? 0);
          const d = want - t[k], dz = c.deadzone?.[i] ?? 0;
          // 範囲の外に出た分だけ追う
          const goal = Math.abs(d) > dz ? t[k] + d - Math.sign(d) * dz : t[k];
          t[k] += (goal - t[k]) * (1 - keep);
        }
      }
      if (c.limit) {
        // 見せる範囲の半分（ゲームの設計の大きさで計算する。画面の大きさでゲームの結果が変わらないように）
        const zoom = c.zoom || 1;
        for (const [k, i, size] of [['x', 0, view.width], ['y', 1, view.height]] as const) {
          const half = (size * (c.viewSize?.[i] ?? 1)) / 2 / zoom;
          const lo = c.limitMin[i] + half, hi = c.limitMax[i] - half;
          t[k] = lo > hi ? (c.limitMin[i] + c.limitMax[i]) / 2 : Math.max(lo, Math.min(hi, t[k]));
        }
      }
      c.trauma = Math.max(0, (c.trauma ?? 0) - (c.shakeRecover ?? 0) * dt);
      const s = (c.shakeMax ?? 0) * c.trauma * c.trauma;
      c.shakeX = s ? s * shakeNoise(frame, e.id, 0) : 0;
      c.shakeY = s ? s * shakeNoise(frame, e.id, 1) : 0;
    }
  },
});

export const STD_SYSTEMS = [animator, camera];
