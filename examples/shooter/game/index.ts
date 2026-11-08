// AGES のゲームコードの入口。components と systems（実行順）を export する。
import type { GameModule } from 'ages';
import * as C from './components.ts';
import * as S from './systems.ts';
import * as T from './tables.ts';

export const components: GameModule['components'] = Object.values(C);

export const systems: GameModule['systems'] = [S.playerControl, S.spawner, S.movement, S.lifetime, S.combat, S.hud];

export const tables: GameModule['tables'] = Object.values(T);
