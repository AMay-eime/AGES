// ゲームコードから import { defineComponent, defineSystem } from 'ages' で使う公開API。
// ブラウザでもNodeでも動く部分だけをここに置く（node: で始まる機能は使わない）。
export { defineComponent, type ComponentDef, type Field } from './core/schema.ts';
export { defineSystem, type SystemDef, type GameModule } from './core/registry.ts';
export type { Ctx } from './core/game.ts';
export type { Entity } from './core/world.ts';
export { defineWindow, type EditorWindow, type EditorApi } from './editor/window-api.ts';
export { Transform, Sprite, Animator, Shape, Text, Camera } from './std/components.ts';
export { camerasOf, worldToScreen, screenToWorld, visibleCorners, fitView, type CameraView, type FitMode } from './core/camera.ts';
export type { SheetDef, ClipDef } from './core/sheet.ts';
