// collect3d: 3人称で物を集める見本（追加パッケージ 3d）。components と systems（実行順）を export する
import type { GameModule } from 'ages';
import * as C from './components.ts';
import * as S from './systems.ts';

export const components: GameModule['components'] = Object.values(C);

export const systems: GameModule['systems'] = [S.playerMove, S.collect, S.spin, S.hud];
