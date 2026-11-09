import { enemies } from './tables.ts';
import { defineSystem, type Entity } from 'ages';

const overlap = (a: Entity, b: Entity) => {
  const at = a.c.Transform, ah = a.c.Hitbox, bt = b.c.Transform, bh = b.c.Hitbox;
  return Math.abs(at.x - bt.x) * 2 < ah.w + bh.w && Math.abs(at.y - bt.y) * 2 < ah.h + bh.h;
};

export const playerControl = defineSystem({
  name: 'playerControl',
  desc: '操作 move_x・move_y で自機を動かし、fire で弾を撃つ（割り当ては $actions）',
  reads: ['Player'],
  writes: ['Transform', 'Player'],
  update({ world, input, view, spawn, sound }) {
    for (const e of world.query('Player', 'Transform')) {
      const p = e.c.Player, t = e.c.Transform;
      // 操作の名前で読む（割り当ては表 $actions。キーコンフィグで変えられる）
      t.x = Math.min(view.width, Math.max(0, t.x + input.value('move_x') * p.speed));
      t.y = Math.min(view.height, Math.max(0, t.y + input.value('move_y') * p.speed));
      if (p.cooldown > 0) p.cooldown--;
      if (input.isDown('fire') && p.cooldown === 0) {
        spawn(p.bullet, { Transform: { x: t.x, y: t.y - 16 } });
        sound.play('se_shot');
        p.cooldown = p.fireInterval;
      }
    }
  },
});

export const spawner = defineSystem({
  name: 'spawner',
  desc: '一定間隔で画面上端に敵を出す（出現パターンの行列があればその通りに。種類は表 enemies）',
  reads: ['Spawner'],
  update({ world, rng, frame, view, spawn, table }) {
    for (const e of world.query('Spawner')) {
      const s = e.c.Spawner;
      if (frame % s.interval !== 0) continue;
      const wave = frame / s.interval;
      // 敵の種類は表 enemies から（波ごとに kinds を順番に）
      const kind = table(enemies).get(s.kinds[wave % s.kinds.length]);
      const vy = () => rng.range(s.speedMin, Math.max(s.speedMin, s.speedMax)) * kind.speed;
      const stats = (vy: number) => ({ Velocity: { vy }, Health: { hp: kind.hp }, Enemy: { score: kind.score }, Sprite: { frame: kind.frame, tint: kind.tint } });
      const rows: number[][] = s.formation;
      if (!rows.length) {
        spawn(s.prefab, { Transform: { x: rng.range(s.margin, view.width - s.margin), y: -20 }, ...stats(vy()) });
        continue;
      }
      // 出現パターン: 波ごとに1行ずつ使い、1の列に敵を出す
      const row = rows[wave % rows.length];
      const speed = vy();
      row.forEach((on, col) => {
        if (!on) return;
        const x = s.margin + ((view.width - s.margin * 2) * (col + 0.5)) / row.length;
        spawn(s.prefab, { Transform: { x, y: -20 }, ...stats(speed) });
      });
    }
  },
});

export const movement = defineSystem({
  name: 'movement',
  desc: 'Velocity の分だけ動かす',
  reads: ['Velocity'],
  writes: ['Transform'],
  update({ world }) {
    for (const e of world.query('Transform', 'Velocity')) {
      e.c.Transform.x += e.c.Velocity.vx;
      e.c.Transform.y += e.c.Velocity.vy;
    }
  },
});

export const lifetime = defineSystem({
  name: 'lifetime',
  desc: '寿命が尽きたもの・画面外に出たものを消す',
  reads: ['Lifetime', 'Velocity'],
  writes: ['Lifetime'],
  update({ world, view, destroy }) {
    for (const e of world.query('Lifetime')) {
      if (--e.c.Lifetime.frames <= 0) destroy(e.id);
    }
    for (const e of world.query('Transform', 'Velocity')) {
      const { x, y } = e.c.Transform;
      if (y < -60 || y > view.height + 60 || x < -60 || x > view.width + 60) destroy(e.id);
    }
  },
});

export const combat = defineSystem({
  name: 'combat',
  desc: '弾と敵、敵と自機の当たりを処理する',
  reads: ['Bullet', 'Enemy', 'Player', 'Hitbox'],
  writes: ['Health', 'Score', 'Camera'],
  update({ world, destroy, emit, spawn, shake, sound, tween }) {
    const isAlive = (id: string) => world.isAlive(id);
    // 爆発のプレハブには Particles が付いていて、出たときに火花を出す（標準の std.particles）
    const boom = (e: Entity) => spawn('explosion', { Transform: { x: e.c.Transform.x, y: e.c.Transform.y } });
    const enemies = world.query('Enemy', 'Health', 'Transform', 'Hitbox');
    const scorer = world.query('Score')[0];
    const score = scorer?.c.Score;
    for (const b of world.query('Bullet', 'Transform', 'Hitbox')) {
      if (b.c.Bullet.team !== 'player') continue;
      for (const en of enemies) {
        if (!isAlive(en.id) || !overlap(b, en)) continue;
        destroy(b.id);
        en.c.Health.hp -= b.c.Bullet.damage;
        // 手触りは表 $tweens の行（hitFlash・scorePop）で決める
        // 敵のプレハブの Effect（std:flash）で白く光らせて戻す
        if (en.c.Health.hp > 0) tween(en.id, { 'Effect.params.amount': 0 }, { preset: 'hitFlash', from: { 'Effect.params.amount': 1 } });
        if (en.c.Health.hp <= 0) {
          destroy(en.id);
          boom(en);
          if (score) {
            score.value += en.c.Enemy.score;
            tween(scorer.id, { 'Transform.sx': 1, 'Transform.sy': 1 }, { preset: 'scorePop', from: { 'Transform.sx': 1.4, 'Transform.sy': 1.4 } });
          }
          emit('enemyKilled');
          sound.play('se_explosion');
        }
        break;
      }
    }
    for (const pl of world.query('Player', 'Health', 'Transform', 'Hitbox')) {
      const h = pl.c.Health;
      if (h.invincible > 0) { h.invincible--; continue; }
      if (h.hp <= 0) continue;
      for (const en of enemies) {
        if (!isAlive(en.id) || !overlap(pl, en)) continue;
        destroy(en.id);
        boom(en);
        h.hp--;
        h.invincible = h.invincibleOnHit;
        emit('playerHit', { hp: h.hp });
        shake(0.6); // 被弾したら画面を揺らす（標準の Camera）
        sound.play('se_hit');
        if (h.hp <= 0) emit('gameOver');
        break;
      }
    }
  },
});

export const hud = defineSystem({
  name: 'hud',
  desc: '得点と体力を Text と体力のゲージ（hpGauge）に書き出す',
  reads: ['Score', 'Health'],
  writes: ['Text', 'Gauge'],
  update({ world }) {
    const hp = world.query('Player', 'Health')[0]?.c.Health.hp ?? 0;
    for (const e of world.query('Score', 'Text')) {
      e.c.Text.text = `SCORE ${e.c.Score.value}   HP ${hp}`;
    }
    const gauge = world.get('hpGauge')?.c.Gauge;
    if (gauge) gauge.value = hp;
  },
});

export const toResult = defineSystem({
  name: 'toResult',
  desc: '自機の体力が尽きたら、得点を持って結果のシーンへ（フェードで）',
  reads: ['Player', 'Health', 'Score'],
  scenes: ['main'],
  update({ world, scene }) {
    const hp = world.query('Player', 'Health')[0]?.c.Health.hp ?? 1;
    if (hp > 0) return;
    const score = world.query('Score')[0]?.c.Score.value ?? 0;
    scene.goto('result', { fade: 0.6, params: { score } }); // 切り替えの途中に何度呼んでも1回だけ
  },
});

export const resultScreen = defineSystem({
  name: 'resultScreen',
  desc: '結果のシーン: 得点を出し、「もう一度」のボタンか fire でもう一度（main へ）',
  writes: ['Text'],
  scenes: ['result'],
  start({ world, scene }) {
    const t = world.get('score')?.c.Text;
    if (t) t.text = `SCORE ${Number(scene.params.score ?? 0)}`;
  },
  update({ input, scene, ui }) {
    // 入ってすぐの押しっぱなしで飛ばないように、少し待つ（ボタンの上で押したマウスは fire にならない）
    if (scene.frame > 30 && !scene.transition && (input.pressed('fire') || ui.clicked('retry'))) scene.goto('main', { fade: 0.3 });
  },
});
