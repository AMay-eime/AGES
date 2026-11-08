import { defineSystem, type Entity } from 'ages';

const overlap = (a: Entity, b: Entity) => {
  const at = a.c.Transform, as = a.c.Shape, bt = b.c.Transform, bs = b.c.Shape;
  return Math.abs(at.x - bt.x) * 2 < as.w + bs.w && Math.abs(at.y - bt.y) * 2 < as.h + bs.h;
};

export const playerControl = defineSystem({
  name: 'playerControl',
  desc: '矢印キーで自機を動かし、Z/スペースで弾を撃つ',
  reads: ['Player'],
  writes: ['Transform', 'Player'],
  update({ world, input, view, spawn }) {
    for (const e of world.query('Player', 'Transform')) {
      const p = e.c.Player, t = e.c.Transform;
      t.x = Math.min(view.width, Math.max(0, t.x + input.axis('ArrowLeft', 'ArrowRight') * p.speed));
      t.y = Math.min(view.height, Math.max(0, t.y + input.axis('ArrowUp', 'ArrowDown') * p.speed));
      if (p.cooldown > 0) p.cooldown--;
      if ((input.isDown('KeyZ') || input.isDown('Space')) && p.cooldown === 0) {
        spawn(p.bullet, { Transform: { x: t.x, y: t.y - 16 } });
        p.cooldown = p.fireInterval;
      }
    }
  },
});

export const spawner = defineSystem({
  name: 'spawner',
  desc: '一定間隔で画面上端に敵を出す',
  reads: ['Spawner'],
  update({ world, rng, frame, view, spawn }) {
    for (const e of world.query('Spawner')) {
      const s = e.c.Spawner;
      if (frame % s.interval !== 0) continue;
      spawn(s.prefab, {
        Transform: { x: rng.range(s.margin, view.width - s.margin), y: -20 },
        Velocity: { vy: rng.range(s.speedMin, Math.max(s.speedMin, s.speedMax)) },
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
  reads: ['Bullet', 'Enemy', 'Player', 'Shape'],
  writes: ['Health', 'Score'],
  update({ world, destroy, emit }) {
    const isAlive = (id: string) => world.isAlive(id);
    const enemies = world.query('Enemy', 'Health', 'Transform', 'Shape');
    const score = world.query('Score')[0]?.c.Score;
    for (const b of world.query('Bullet', 'Transform', 'Shape')) {
      if (b.c.Bullet.team !== 'player') continue;
      for (const en of enemies) {
        if (!isAlive(en.id) || !overlap(b, en)) continue;
        destroy(b.id);
        en.c.Health.hp -= b.c.Bullet.damage;
        if (en.c.Health.hp <= 0) {
          destroy(en.id);
          if (score) score.value += en.c.Enemy.score;
          emit('enemyKilled');
        }
        break;
      }
    }
    for (const pl of world.query('Player', 'Health', 'Transform', 'Shape')) {
      const h = pl.c.Health;
      if (h.invincible > 0) { h.invincible--; continue; }
      if (h.hp <= 0) continue;
      for (const en of enemies) {
        if (!isAlive(en.id) || !overlap(pl, en)) continue;
        destroy(en.id);
        h.hp--;
        h.invincible = h.invincibleOnHit;
        emit('playerHit', { hp: h.hp });
        if (h.hp <= 0) emit('gameOver');
        break;
      }
    }
  },
});

export const hud = defineSystem({
  name: 'hud',
  desc: '得点と体力を Text に書き出す',
  reads: ['Score', 'Health'],
  writes: ['Text'],
  update({ world }) {
    const hp = world.query('Player', 'Health')[0]?.c.Health.hp ?? 0;
    for (const e of world.query('Score', 'Text')) {
      e.c.Text.text = `SCORE ${e.c.Score.value}   HP ${hp}`;
    }
  },
});
