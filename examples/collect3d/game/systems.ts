// collect3d のシステム。3D の「壁で止まる・地面に立つ・落ちる」は本体にないので、ここに短く書いてある（手本）。
// 当たり判定は重なりと線の問い合わせだけ（ages/3d の hit3）: 動かしてみて、重なったら戻す。足元へ線を下ろして、当たった高さに立つ
import { defineSystem } from 'ages';
import { hit3, math3 } from 'ages/3d';

/** 歩く・跳ぶ・落ちる・向きと動き（アニメーション）を決める */
export const playerMove = defineSystem({
  name: 'playerMove',
  desc: 'キャラクターを操作する（歩く・跳ぶ・壁で止まる・地面に立つ・落ちたら戻る）',
  reads: ['Player'],
  writes: ['Transform3D', 'Model3D'],
  update(ctx) {
    for (const e of ctx.world.entities.values()) {
      const p = e.c.Player, t = e.c.Transform3D, m = e.c.Model3D;
      if (!p || !t) continue;
      // ---- 横の動き: カメラは −Z を見ているので、右が +X、手前が +Z
      let dx = ctx.input.value('move_x'), dz = ctx.input.value('move_y');
      const len = Math.hypot(dx, dz);
      if (len > 1) { dx /= len; dz /= len; }
      const moving = len > 0.1;
      // x と z を別々に試す（片方が壁でも、もう片方へは進めるので、壁に沿って滑る）
      t.x += dx * p.speed * ctx.dt;
      if (hit3.overlaps(ctx.world, e.id, 'wall').length) t.x -= dx * p.speed * ctx.dt;
      t.z += dz * p.speed * ctx.dt;
      if (hit3.overlaps(ctx.world, e.id, 'wall').length) t.z -= dz * p.speed * ctx.dt;
      // 進む向きへ、少しずつ向く（物の前は +Z）
      if (moving) {
        const want = (Math.atan2(dx, dz) * 180) / Math.PI;
        const diff = math3.wrapAngle(want - t.ry), step = p.turn * ctx.dt;
        t.ry = math3.wrapAngle(t.ry + Math.max(-step, Math.min(step, diff)));
      }
      // ---- 縦の動き: 跳ぶ・落ちる
      if (p.grounded && ctx.input.pressed('jump')) { p.vy = p.jump; p.grounded = false; ctx.sound.play('se_jump'); }
      p.vy -= p.gravity * ctx.dt;
      t.y += p.vy * ctx.dt;
      // 足元の地面: ひざの高さから、足の少し下まで線を下ろす（上がっている間は調べない）
      const fall = p.vy;
      const ground = p.vy <= 0 ? hit3.ray(ctx.world, [t.x, t.y + 0.5, t.z], [t.x, t.y - 0.05, t.z], ['ground', 'wall']) : null;
      if (ground) { t.y = ground.point[1]; p.vy = 0; p.grounded = true; if (fall < -3) ctx.sound.play('se_land'); }
      else p.grounded = false;
      // 落ちたら、始めの場所へ
      if (t.y < p.fallY) { [t.x, t.y, t.z] = p.start; p.vy = 0; ctx.sound.play('se_fall'); }
      // ---- 動き（アニメーション）: 名前を書くだけで、前の動きからなめらかに切り替わる
      if (m) { m.clip = !p.grounded ? 'jump' : moving ? 'walk' : 'idle'; m.loop = p.grounded; }
    }
  },
});

/** 触れたコインを拾う（Collider3D.with に coin を書いてあるので、重なり始めた相手が hit3.entered で分かる） */
export const collect = defineSystem({
  name: 'collect',
  desc: 'キャラクターが触れたコインを拾う',
  reads: ['Player'],
  writes: ['Player'],
  update(ctx) {
    for (const e of ctx.world.entities.values()) {
      if (!e.c.Player) continue;
      for (const id of hit3.entered(ctx.world, e.id, 'coin')) {
        ctx.destroy(id);
        e.c.Player.coins++;
        ctx.sound.play('se_coin');
        ctx.emit('coin', { id });
      }
    }
  },
});

/** その場で回る */
export const spin = defineSystem({
  name: 'spin',
  desc: 'Spin の付いた物を回す',
  reads: ['Spin'],
  writes: ['Transform3D'],
  update(ctx) {
    for (const e of ctx.world.entities.values()) if (e.c.Spin && e.c.Transform3D) e.c.Transform3D.ry = math3.wrapAngle(e.c.Transform3D.ry + e.c.Spin.speed * ctx.dt);
  },
});

/** 画面の文字（集めた数。全部集めたら「クリア」） */
export const hud = defineSystem({
  name: 'hud',
  desc: 'コインの数を画面に出す。全部集めたらクリアの文字を出す',
  reads: ['Player', 'Spin'],
  writes: ['Text', 'UI'],
  update(ctx) {
    const player = ctx.world.entities.get('player'), count = ctx.world.entities.get('count'), clear = ctx.world.entities.get('clear');
    if (!player?.c.Player) return;
    const left = [...ctx.world.entities.values()].filter((e) => e.c.Spin).length;
    if (count?.c.Text) count.c.Text.text = `コイン ${player.c.Player.coins} / ${player.c.Player.coins + left}`;
    if (clear?.c.UI) clear.c.UI.visible = left === 0;
  },
});
