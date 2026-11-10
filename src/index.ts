// ゲームコードから import { defineComponent, defineSystem } from 'ages' で使う公開API。
// ブラウザでもNodeでも動く部分だけをここに置く（node: で始まる機能は使わない）。
export { defineComponent, defaultOf, type ComponentDef, type Field } from './core/schema.ts';
export type { Op } from './core/patch.ts';
export { defineSystem, defineCheck, type SystemDef, type GameModule, type CheckDef, type CheckView } from './core/registry.ts';
export { defineTable, type TableDef, type TableView, type Row, type RowOf } from './core/table.ts';
export type { Ctx } from './core/game.ts';
export type { Pose } from './core/transform.ts';
export type { Entity } from './core/world.ts';
export { defineWindow, defineExtension, type EditorWindow, type EditorExtension, type EditorApi, type FieldDrawer, type FieldView, type ComponentDrawer, type ComponentView, type RowDrawer, type RowView, type StageOptions, type StageSummary, type StageHandle, type MenuItem } from './editor/window-api.ts';
export { Transform, Sprite, Animator, Shape, Text, Camera, Sound, AudioBus, Particles, Effect, PostEffect } from './std/components.ts';
export { STD_SHADER_CODE, parseShader, type ShaderDef } from './core/shader.ts';
export type { SoundApi, AudioCmd, BusDef } from './core/audio.ts';
export { EASES, EASE_NAMES, type EaseName } from './core/ease.ts';
export type { TweenOptions, TweenValue } from './core/tween.ts';
export type { ParticleApi } from './core/particles.ts';
export type { SaveApi, SaveStore } from './core/save.ts';
export { MemoryStore, LocalStore } from './core/save.ts';
export type { HitApi, UiApi } from './core/game.ts';
export type { GameDate } from './core/clock.ts';
export { camerasOf, worldToScreen, screenToWorld, visibleCorners, fitView, type CameraView, type FitMode } from './core/camera.ts';
export type { SheetDef, ClipDef } from './core/sheet.ts';
