// エディタ本体の拡張。プロジェクトの拡張（editor/*.ext.ts）と同じ API で書く（手本にもなる）
import type { EditorExtension } from '../window-api.ts';
import uiDock from './ui-dock.ts';
import animatorClip from './animator-clip.ts';
import tryout from './tryout.ts';
import entityMenu from './entity-menu.ts';

export const BUILTIN_EXTENSIONS: EditorExtension[] = [uiDock, animatorClip, tryout, entityMenu];
