// プロジェクト（フォルダ）の読み込みと保存。Node 側専用。
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { formatJson, type PrefabDoc, type ProjectConfig, type SceneDoc } from '../core/docs.ts';
import { Registry, type GameModule } from '../core/registry.ts';
import { applyOps, diffDocs, getValue, setValue, sheetRoot, splitItem, type Change, type Docs, type Op, type PatchResult } from '../core/patch.ts';
import { parseAddress } from '../core/docs.ts';
import { Game } from '../core/game.ts';
import { checkAt, suggest, visit, type Field } from '../core/schema.ts';
import { ROW_ID, type TableDoc } from '../core/table.ts';
import { appendLog, localTime, lockedHits, markTouched, readLocks as readLockFile, readLog, readTouched, writeLocks, type Actor, type LockMark } from './oplog.ts';
import { lockDiff, verifyLocks, type LockIntegrity } from './seal.ts';
import { scanAssets, type AssetInfo } from './assets.ts';
import { FIT_MODES } from '../core/camera.ts';
import { checkSheet, checkSheetImage, findFrame, frameCount, sheetPathOf, type SheetDef } from '../core/sheet.ts';

// ゲームコードの import ... from 'ages' を、どのフォルダにあるプロジェクトからでもこのエンジンに向ける
const AGES_INDEX = new URL('../index.ts', import.meta.url).href;
let hooked = false;
function hookAgesImport(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'ages') return { url: AGES_INDEX, shortCircuit: true };
      return next(specifier, context);
    },
  });
}

export class Project {
  readonly dir: string;
  config!: ProjectConfig;
  registry!: Registry;
  docs!: Docs;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  static async load(dir: string): Promise<Project> {
    const p = new Project(dir);
    await p.reload();
    return p;
  }

  async reload(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, 'ages.project.json'), 'utf8');
    } catch {
      throw new Error(`${this.dir} に ages.project.json がありません。AGESのプロジェクトフォルダを指定してください`);
    }
    this.config = JSON.parse(raw);
    const scan = await scanAssets(this.dir);
    this.docs = { ...(await readDocs(this.dir)), sheets: scan.sheets };
    const prefabs = this.docs.prefabs;
    hookAgesImport();
    const url = pathToFileURL(join(this.dir, this.config.game)).href;
    const mod = (await import(url)) as GameModule;
    this.registry = Registry.from(mod, []);
    this.registry.prefabs = prefabs;
    this.assets = scan.assets;
    this.assetIssues = scan.issues;
    this.registry.sheets = this.docs.sheets;
    this.registry.tableData = this.docs.tables;
    this.registry.images = new Map(scan.assets.filter((a) => a.w && a.h).map((a) => [a.path, { w: a.w!, h: a.h! }]));
    this.integrity = await verifyLocks(this.dir);
    this.lockReport = await this.enforceLocks();
    if (!this.integrity.ok) {
      const d = this.lockDiff();
      const detail = [d.removed.length ? `消されたロック ${d.removed.length}件` : '', d.added.length ? `増えたロック ${d.added.length}件` : '', d.changed.length ? `値が変わったロック ${d.changed.length}件` : ''].filter(Boolean).join('・');
      this.lockReport.unshift(`⚠ ${this.integrity.reason}${detail ? `（${detail}）` : ''}。人がエディタで確認するまで、AIからの編集はすべて止めます。最後に封印されたロックは引き続き有効です`);
    }
  }

  /** 画像・音・フォントの一覧（reload のたびに更新） */
  assets: AssetInfo[] = [];
  private assetIssues: string[] = [];

  /** ロックの記録が人の封印と一致しているか（reload のたびに更新） */
  integrity: LockIntegrity = { ok: true };

  /**
   * 効いているロック。記録が封印と一致しないときは、最後に封印された控えのロックも合わせて効かせる
   * （AIがロックの記録から項目を消しても、ロックは外れない）。
   */
  async effectiveLocks(): Promise<Record<string, LockMark>> {
    const current = await readLockFile(this.dir);
    if (this.integrity.ok) return current;
    return { ...current, ...((this.integrity.backup ?? {}) as Record<string, LockMark>) };
  }

  /** 現在の記録と、最後に封印された控えの違い */
  lockDiff() {
    return lockDiff(this.lockFileCache, this.integrity.backup);
  }
  private lockFileCache: Record<string, LockMark> = {};

  /** 人が「この内容で承認」する: 今のロックの記録をそのまま封印し直す */
  async approveLocks(actor: Actor): Promise<void> {
    await writeLocks(this.dir, actor, await readLockFile(this.dir));
    await appendLog(this.dir, actor, 'lock-approve', [{ path: '.ages/locks.json', to: 'approved' }]);
    await this.reload();
  }

  /** 人が「前の状態に戻す」: 最後に封印した控えに戻す */
  async restoreLocks(actor: Actor): Promise<void> {
    const backup = this.integrity.backup;
    if (!backup) throw new Error('戻せる控えがありません。「この内容で承認」するか、ロックを付け直してください');
    await writeLocks(this.dir, actor, backup as Record<string, LockMark>);
    await appendLog(this.dir, actor, 'lock-restore-backup', [{ path: '.ages/locks.json', to: 'restored' }]);
    await this.reload();
  }

  private requireIntegrity(): void {
    if (!this.integrity.ok) throw new Error(`ロックの記録の確認が必要です: ${this.integrity.reason}。エディタの「🔒⚠ ロックの記録を確認」から、承認するか前の状態に戻してください`);
  }

  /** 直近の読み込み時にロックの検査で見つかった問題（復元したもの・復元できないもの） */
  lockReport: string[] = [];

  /**
   * ロックされた値がファイル上で変わっていたら元に戻す。
   * （AIがファイルを直接書き換えた場合も、次にAGESが読み込んだ時点で必ず復元される）
   */
  async enforceLocks(): Promise<string[]> {
    this.lockFileCache = await readLockFile(this.dir);
    const locks = await this.effectiveLocks();
    const report: string[] = [];
    const restored: Change[] = [];
    const dirty = new Set<string>();
    for (const [path, mark] of Object.entries(locks)) {
      let current: unknown;
      try {
        current = getValue(this.docs, this.registry, path).value;
      } catch (e) {
        report.push(`ロック ${path} の対象が見つかりません（消された可能性があります）: ${(e as Error).message}`);
        continue;
      }
      if (JSON.stringify(current) === JSON.stringify(mark.value)) continue;
      if (path.startsWith('sheet:')) {
        const image = path.slice('sheet:'.length);
        if (mark.value === null) this.docs.sheets.delete(image);
        else this.docs.sheets.set(image, structuredClone(mark.value as SheetDef));
        restored.push({ path, from: current ? '変更された切り方' : null, to: mark.value ? 'ロック時の切り方' : null });
        dirty.add(path);
        report.push(`ロック ${path}（画像の切り方）が変えられていたので、ロックしたときの切り方に戻しました`);
        continue;
      }
      dirty.add(setValue(this.docs, this.registry, path, mark.value));
      restored.push({ path, from: current, to: mark.value });
      report.push(`ロック ${path} が ${JSON.stringify(current)} に変えられていたので ${JSON.stringify(mark.value)} に戻しました`);
    }
    if (restored.length) {
      await this.saveDirty(dirty);
      await appendLog(this.dir, { who: 'ages', kind: 'system', win: 'lock' }, 'lock-restore', restored);
    }
    return report;
  }

  /** 値をロックする（人だけ）。paths はフィールドまでのアドレス。 */
  async lock(paths: string[], actor: Actor, note?: string): Promise<void> {
    this.requireIntegrity();
    const locks = await readLockFile(this.dir);
    const t = new Date().toISOString();
    for (const path of paths) {
      if (path.startsWith('sheet:')) {
        if (sheetRoot(path) !== path) throw new Error(`画像の切り方のロックはシート全体です（例: sheet:assets/hero.png）: ${path}`);
      } else {
        const a = parseAddress(path);
        if (!a.field) throw new Error(`ロックは値（フィールド・表のセル）単位です（例: main#player.Player.speed、$enemies.basic.hp）: ${path}`);
        // リストの中の要素は、並べ替え・追加・削除で場所が変わるのでロックできない
        if (a.sub.some((x) => typeof x === 'number')) throw new Error(`リストの中の要素はロックできません（並べ替えで場所が変わるため）。リスト全体をロックするか、行に ID のある表にしてください: ${path}`);
      }
      const { value } = getValue(this.docs, this.registry, path);
      const mark: LockMark = { who: actor.who, t, value };
      if (note) mark.note = note;
      locks[path] = mark;
    }
    await writeLocks(this.dir, actor, locks);
    await appendLog(this.dir, actor, 'lock', paths.map((p) => ({ path: p, to: 'locked' })));
  }

  async unlock(paths: string[], actor: Actor): Promise<void> {
    this.requireIntegrity();
    const locks = await readLockFile(this.dir);
    for (const p of paths) delete locks[p];
    await writeLocks(this.dir, actor, locks);
    await appendLog(this.dir, actor, 'unlock', paths.map((p) => ({ path: p, to: 'unlocked' })));
  }

  scenePath(name: string): string {
    return join(this.dir, 'scenes', `${name}.scene.json`);
  }

  prefabPath(name: string): string {
    return join(this.dir, 'prefabs', `${name}.prefab.json`);
  }

  /** 値の中（リスト・構造体・どれか1つの中まで）の参照を確かめる: 表の行・プレハブ・ファイル */
  private checkNested(at: string, f: Field, v: unknown, errs: string[]): void {
    const assetPaths = new Set(this.assets.map((a) => a.path));
    visit(f, v, at, (lf, lv, lat) => {
      if (lf.type === 'row' && typeof lv === 'string' && lv) {
        if (!this.registry.tables.has(lf.table)) { errs.push(`${lat}: 表 ${lf.table} の形がありません${suggest(lf.table, [...this.registry.tables.keys()])}`); return; }
        const ids = (this.docs.tables.get(lf.table)?.rows ?? []).map((r) => r.id);
        if (!ids.includes(lv)) errs.push(`${lat}="${lv}": 表 ${lf.table} にその行はありません${suggest(lv, ids)}`);
      }
      if (lat === at) return; // フィールドそのものの prefab・asset は、下のこれまでの検証で見る
      if (lf.type === 'prefab' && typeof lv === 'string' && lv && !this.docs.prefabs.has(lv)) errs.push(`${lat}: プレハブ ${lv} はありません${suggest(lv, [...this.docs.prefabs.keys()])}`);
      if (lf.type === 'asset' && typeof lv === 'string' && lv && !assetPaths.has(lv)) errs.push(`${lat}: ファイル ${lv} がありません${suggest(lv, this.assets.filter((a) => a.kind === lf.kind).map((a) => a.path))}`);
    });
  }

  /** 全文書を検証する。問題の一覧を返す（空なら健全）。 */
  validate(): string[] {
    const errs: string[] = [];
    const assetPaths = new Map(this.assets.map((a) => [a.path, a]));
    const check = (where: string, comps: Record<string, Record<string, unknown>>) => {
      for (const [name, values] of Object.entries(comps)) {
        try { this.registry.build(name, values, where); } catch (e) { errs.push((e as Error).message); }
        const def = this.registry.components.get(name);
        if (!def) continue;
        for (const [k, f] of Object.entries(def.fields)) {
          if (k in values) this.checkNested(`${where}.${name}.${k}`, f, values[k], errs);
          if (f.type === 'prefab' && k in values && values[k] !== '' && !this.docs.prefabs.has(values[k] as string)) {
            errs.push(`${where}.${name}.${k}: プレハブ ${values[k]} はありません${suggest(String(values[k]), [...this.docs.prefabs.keys()])}`);
          }
          // 音量の区分を指す値は、AudioBus の付いたプレハブであること
          if ((name === 'Sound' && k === 'bus' || name === 'AudioBus' && k === 'parent') && typeof values[k] === 'string' && values[k] && this.docs.prefabs.has(values[k] as string) && !this.docs.prefabs.get(values[k] as string)!.components.AudioBus) {
            const buses = [...this.docs.prefabs.values()].filter((p) => p.components.AudioBus).map((p) => p.name);
            errs.push(`${where}.${name}.${k}="${values[k]}": 音量の区分は AudioBus の付いたプレハブです${buses.length ? `（ある区分: ${buses.join(', ')}）` : '（まだ区分がありません）'}`);
          }
          if (f.type === 'asset' && typeof values[k] === 'string' && values[k] && !assetPaths.has(values[k] as string)) {
            const same = this.assets.filter((a) => a.kind === f.kind).map((a) => a.path);
            errs.push(`${where}.${name}.${k}: ファイル ${values[k]} がありません${suggest(String(values[k]), same)}`);
          }
        }
      }
      // スプライトのコマとアニメーションの名前
      const sp = comps.Sprite as { image?: string; frame?: number | string } | undefined;
      if (sp?.image) {
        const sheet = this.docs.sheets.get(sp.image);
        const info = assetPaths.get(sp.image);
        if (sheet && info?.w && info.h && sp.frame !== undefined && !findFrame(sheet, info.w, info.h, sp.frame)) {
          const n = frameCount(sheet, info.w, info.h);
          const names = (sheet.frames ?? []).map((f) => f.name);
          errs.push(typeof sp.frame === 'number'
            ? `${where}.Sprite.frame=${sp.frame} は範囲外です（${sp.image} は ${n} コマ、0から数えます）`
            : `${where}.Sprite.frame="${sp.frame}" というコマは ${sp.image} にありません${names.length ? '' : '（格子のシートなので番号で指定します）'}${suggest(sp.frame, names)}`);
        } else if (!sheet && sp.frame) {
          errs.push(`${where}.Sprite.frame=${JSON.stringify(sp.frame)}: ${sp.image} にはスプライトシートの定義（${sheetPathOf(sp.image)}）がないので、コマは0だけです`);
        }
        const an = comps.Animator as { clip?: string } | undefined;
        if (an?.clip) {
          const clips = Object.keys(sheet?.clips ?? {});
          if (!clips.includes(an.clip)) errs.push(`${where}.Animator.clip="${an.clip}" は ${sheetPathOf(sp.image)} にありません${clips.length ? `（ある名前: ${clips.join(', ')}）` : '（clips が定義されていません）'}${suggest(an.clip, clips)}`);
        }
      }
    };
    for (const s of this.docs.scenes.values()) {
      const ids = new Set<string>();
      for (const e of s.entities) {
        if (ids.has(e.id)) errs.push(`${s.name}#${e.id}: IDが重複しています`);
        ids.add(e.id);
        check(`${s.name}#${e.id}`, e.components);
      }
      // 同じシーンの中のIDを指す値（例: Camera.follow）は、その相手がいること
      const all = s.entities.map((e) => e.id);
      for (const e of s.entities) {
        for (const [name, values] of Object.entries(e.components)) {
          const def = this.registry.components.get(name);
          for (const [k, f] of Object.entries(def?.fields ?? {})) {
            const v = values[k];
            if (f.type === 'ref' && typeof v === 'string' && v && !ids.has(v)) errs.push(`${s.name}#${e.id}.${name}.${k}="${v}": シーン ${s.name} にそのIDはありません${suggest(v, all)}`);
          }
        }
      }
    }
    // 表: 形があるか、ID、列の値、参照
    for (const [name, t] of this.docs.tables) {
      const def = this.registry.tables.get(name);
      if (!def) { errs.push(`data/${name}.table.json: 表 ${name} の形がゲームのコードにありません（defineTable で作り、game/index.ts の tables に入れる）${suggest(name, [...this.registry.tables.keys()])}`); continue; }
      const ids = new Set<string>();
      t.rows.forEach((r, i) => {
        if (typeof r.id !== 'string' || !ROW_ID.test(r.id)) errs.push(`$${name} の ${i} 行目: id "${r.id}" には英数字・_・- だけが使えます`);
        else if (ids.has(r.id)) errs.push(`$${name}.${r.id}: id が重複しています`);
        ids.add(r.id);
        for (const [k, v] of Object.entries(r)) {
          if (k === 'id') continue;
          const f = def.columns[k];
          if (!f) { errs.push(`$${name}.${r.id}: 列 ${k} はありません${suggest(k, Object.keys(def.columns))}`); continue; }
          const e = checkAt(`$${name}.${r.id}.${k}`, f, v);
          if (e) errs.push(e);
          else this.checkNested(`$${name}.${r.id}.${k}`, f, v, errs);
        }
      });
    }
    // 音量の区分の親子が輪になっていないこと
    for (const p of this.docs.prefabs.values()) {
      if (!p.components.AudioBus) continue;
      const seen = new Set<string>([p.name]);
      for (let cur = p.components.AudioBus.parent as string | undefined; cur; cur = this.docs.prefabs.get(cur)?.components.AudioBus?.parent as string | undefined) {
        if (seen.has(cur)) { errs.push(`@${p.name}.AudioBus.parent: 区分の親子が輪になっています（${[...seen, cur].join(' → ')}）`); break; }
        seen.add(cur);
      }
    }
    if (this.config.view.fit && !FIT_MODES.includes(this.config.view.fit)) {
      errs.push(`ages.project.json の view.fit="${this.config.view.fit}" は ${FIT_MODES.join(' | ')} のどれかです${suggest(this.config.view.fit, FIT_MODES)}`);
    }
    for (const p of this.docs.prefabs.values()) check(`@${p.name}`, p.components);
    if (!this.docs.scenes.has(this.config.startScene)) errs.push(`開始シーン ${this.config.startScene} がありません`);
    for (const [image, sheet] of this.docs.sheets) {
      const sp = sheetPathOf(image);
      const e = checkSheet(sp, sheet);
      errs.push(...e);
      const info = assetPaths.get(image);
      if (!e.length && info?.w && info.h) errs.push(...checkSheetImage(sp, sheet, info.w, info.h));
    }
    errs.push(...this.assetIssues);
    return errs;
  }

  /**
   * 操作を適用して保存し、ログに残す。
   * AIが人の調整した値を変えようとした場合は force がない限り止める。
   */
  async apply(ops: Op[], actor: Actor, opts: { force?: boolean } = {}): Promise<PatchResult> {
    const targetOf = (op: Op) =>
      op.op === 'set' || op.op === 'setCells' || op.op === 'insert' ? op.path
        : op.op === 'removeItem' || op.op === 'moveItem' ? splitItem(op.path).list
        : op.op === 'removeEntity' ? `${op.scene}#${op.id}`
        : op.op === 'removeComponent' ? `${op.target}.${op.component}`
        : op.op === 'setSheet' || op.op === 'setFrame' || op.op === 'setClip' ? `sheet:${op.image}`
        : op.op === 'removeRow' || op.op === 'renameRow' ? `$${op.table}.${op.id}`
        : null;
    if (actor.kind === 'ai' && !this.integrity.ok) {
      throw new Error(`🔒 ロックの記録が人の封印と一致しないため、AIからの編集を止めています（${this.integrity.reason}）。ユーザーにエディタでの確認を頼んでください`);
    }
    const locks = await this.effectiveLocks();
    if (actor.kind === 'human' && !this.integrity.ok) {
      const hits = ops.flatMap((op) => { const t = targetOf(op); return t ? lockedHits(locks, t) : []; });
      if (hits.length) this.requireIntegrity();
    }
    if (actor.kind === 'ai') {
      // ロックは --force でも越えられない
      const hits = ops.flatMap((op) => { const t = targetOf(op); return t ? lockedHits(locks, t) : []; });
      if (hits.length) {
        throw new Error(`🔒 ロックされた値は変更できません: ${hits.join(', ')}。この値は人が決めるものです。変えるべき理由があれば、ユーザーに提案してください`);
      }
    }
    if (actor.kind === 'ai' && !opts.force) {
      const touched = await readTouched(this.dir);
      const hits: string[] = [];
      for (const op of ops) {
        const target = targetOf(op);
        if (!target) continue;
        for (const [path, mark] of Object.entries(touched)) {
          if (related(path, target)) hits.push(`${path}（${mark.who} が ${localTime(mark.t)} に調整）`);
        }
      }
      if (hits.length) {
        throw new Error(`人が調整した値に触れようとしています: ${hits.join(', ')}。ユーザーに確認してから --force を付けて実行してください`);
      }
    }
    // 編集で新しい問題（ないファイル・ないアニメーション・範囲外のコマなど）が増えるなら、保存せずに止める
    const before = new Set(this.validate());
    const backup: Docs = { scenes: new Map(this.docs.scenes), prefabs: new Map(this.docs.prefabs), sheets: new Map(this.docs.sheets), tables: new Map(this.docs.tables) };
    const result = applyOps(this.docs, this.registry, ops);
    const rollback = (message: string): never => {
      this.docs.scenes = backup.scenes;
      this.docs.prefabs = backup.prefabs;
      this.docs.sheets = backup.sheets;
      this.docs.tables = backup.tables;
      this.registry.prefabs = backup.prefabs;
      this.registry.sheets = backup.sheets;
      this.registry.tableData = backup.tables;
      throw new Error(message);
    };
    // 操作の結果として連動して変わる値（コマの名前の変更で書き換わる参照など）にも、ロックは効く
    if (actor.kind === 'ai') {
      const hits = [...new Set(result.changes.flatMap((c) => lockedHits(locks, sheetRoot(c.path.replace(/\[\d+,\s*\d+\]$/, '')))))];
      if (hits.length) rollback(`🔒 この操作は、ロックされた値も変えてしまいます: ${hits.join(', ')}。この値は人が決めるものです。変えるべき理由があれば、ユーザーに提案してください`);
    }
    const introduced = this.validate().filter((e) => !before.has(e));
    if (introduced.length) rollback(introduced.join(' / '));
    await this.saveDirty(result.dirty);
    const opName = ops.length === 1 ? ops[0].op : 'batch';
    await appendLog(this.dir, actor, opName, result.changes);
    await markTouched(this.dir, actor, result.changes);
    if (actor.kind === 'human') {
      // 人がロック中の値を編集したら、ロックの値も新しい値にする。消したものはロックも外す。行の ID を変えたらロックも付け替える
      let changed = false;
      for (const c of result.changes) {
        const path = sheetRoot(c.path.replace(/\[\d+,\s*\d+\]$/, ''));
        const renamed = typeof c.to === 'string' && c.to.startsWith('renamed:') ? c.path.replace(/[^.]+$/, c.to.slice('renamed:'.length)) : null;
        for (const p of Object.keys(locks)) {
          if (renamed && (p === c.path || p.startsWith(c.path + '.'))) {
            locks[renamed + p.slice(c.path.length)] = locks[p];
            delete locks[p];
            changed = true;
          } else if (c.to === 'removed' && (p === path || isInside(p, path))) {
            delete locks[p];
            changed = true;
          } else if (p === path || isInside(path, p)) {
            locks[p].value = structuredClone(getValue(this.docs, this.registry, p).value);
            changed = true;
          }
        }
      }
      if (changed) await writeLocks(this.dir, actor, locks);
    }
    return result;
  }

  /** このプロセスが書いたファイルと内容（エディタが「外部からの編集」と区別するため） */
  written = new Map<string, string>();

  async saveDirty(dirty: Iterable<string>): Promise<void> {
    for (const key of dirty) {
      if (key.startsWith('table:')) {
        const name = key.slice('table:'.length);
        const path = join(this.dir, 'data', `${name}.table.json`);
        const t = this.docs.tables.get(name);
        await mkdir(join(this.dir, 'data'), { recursive: true });
        if (!t) { await rm(path, { force: true }); this.written.set(path, ''); continue; }
        const text = formatTable(t);
        await writeFile(path, text);
        this.written.set(path, text);
        continue;
      }
      if (key.startsWith('sheet:')) {
        const image = key.slice('sheet:'.length);
        const path = join(this.dir, sheetPathOf(image));
        const sheet = this.docs.sheets.get(image);
        if (!sheet) { await rm(path, { force: true }); this.written.set(path, ''); continue; }
        const text = formatSheet(sheet);
        await writeFile(path, text);
        this.written.set(path, text);
        continue;
      }
      const [kind, name] = key.split(':');
      const path = kind === 'scene' ? this.scenePath(name) : this.prefabPath(name);
      const text = formatJson(kind === 'scene' ? this.docs.scenes.get(name) : this.docs.prefabs.get(name));
      await mkdir(join(this.dir, kind === 'scene' ? 'scenes' : 'prefabs'), { recursive: true });
      await writeFile(path, text);
      this.written.set(path, text);
    }
  }

  /**
   * 人がテキストで文書を書き換えた後に呼ぶ。ロック中の値を人が変えていたら、ロックの値を新しい値にしてから読み直す
   * （人の編集が「ロックの復元」で消されないように）。変更点を返す。
   */
  async humanTextEdit(actor: Actor): Promise<Change[]> {
    const before = this.docs;
    const after: Docs = { ...(await readDocs(this.dir)), sheets: (await scanAssets(this.dir)).sheets };
    const changes = diffDocs(before, after);
    if (!this.integrity.ok && changes.some((c) => lockedHits(this.lockFileCache, sheetRoot(c.path.replace(/\[\d+,\s*\d+\]$/, ''))).length)) this.requireIntegrity();
    const locks = await readLockFile(this.dir);
    let touchedLock = false;
    for (const c of changes) {
      if (c.path.startsWith('sheet:')) {
        // 画像の切り方のロックは、人が書き換えた新しい切り方にする（消したらロックも外す）
        const root = sheetRoot(c.path);
        if (!locks[root]) continue;
        const v = after.sheets.get(root.slice('sheet:'.length));
        if (v) locks[root].value = structuredClone(v);
        else delete locks[root];
        touchedLock = true;
        continue;
      }
      if (locks[c.path] && c.to !== 'removed' && c.to !== 'added') { locks[c.path].value = structuredClone(c.to); touchedLock = true; }
      if (c.to === 'removed') for (const p of lockedHits(locks, c.path)) { delete locks[p]; touchedLock = true; }
    }
    if (touchedLock) await writeLocks(this.dir, actor, locks);
    await this.reload();
    await appendLog(this.dir, actor, 'text', changes);
    await markTouched(this.dir, actor, changes);
    return changes;
  }

  /** 誰が書いたか分からない外部の編集（別のエディタやAIによる直接編集）の後に呼ぶ。ロックは復元される。 */
  async externalEdit(): Promise<{ changes: Change[]; lockReport: string[] }> {
    const before = this.docs;
    await this.reload();
    // AGESのCLIなど、すでにログに残っている変更は二重に記録しない
    const recent = (await readLog(this.dir)).slice(-200).filter((e) => Date.now() - Date.parse(e.t) < 15000);
    const changes = diffDocs(before, this.docs).filter(
      (c) => !recent.some((e) => e.path === c.path && JSON.stringify(e.to) === JSON.stringify(c.to)),
    );
    await appendLog(this.dir, { who: 'external', kind: 'system', win: 'file' }, 'external', changes);
    return { changes, lockReport: this.lockReport };
  }

  newGame(scene = this.config.startScene, seed = this.config.seed): Game {
    const doc = this.docs.scenes.get(scene);
    if (!doc) throw new Error(`シーン ${scene} はありません${suggest(scene, [...this.docs.scenes.keys()])}`);
    return new Game(this.registry, this.config, doc, seed);
  }
}

/**
 * シートの書き出し。コマは1行1コマにする（Gitの行単位の統合がコマ単位になり、人が読んでも並びが分かる）
 */
export function formatSheet(sheet: SheetDef): string {
  const lines: string[] = ['{'];
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sheet)) {
    if (k === 'frames' && Array.isArray(v)) {
      parts.push(`  "frames": [\n${v.map((f) => `    ${JSON.stringify(f)}`).join(',\n')}\n  ]`);
    } else if (k === 'clips' && v && typeof v === 'object') {
      const cs = Object.entries(v as Record<string, unknown>).map(([n, c]) => `    ${JSON.stringify(n)}: ${JSON.stringify(c)}`);
      parts.push(`  "clips": {\n${cs.join(',\n')}\n  }`);
    } else parts.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  lines.push(parts.join(',\n'), '}');
  return lines.join('\n') + '\n';
}

/** 表の書き出し。1行1行（Gitの統合が行の単位になり、表計算ソフトのように見える） */
export function formatTable(t: TableDoc): string {
  return `{\n  "name": ${JSON.stringify(t.name)},\n  "rows": [${t.rows.length ? '\n' + t.rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n') + '\n  ' : ''}]\n}\n`;
}

/** 2つの住所の片方がもう片方の中にあるか（a が b の中） */
export function isInside(a: string, b: string): boolean {
  return a.startsWith(b + '.') || a.startsWith(b + '[');
}

/** 同じ値か、片方がもう片方の中（ロック・★の当たり判定に使う） */
export function related(a: string, b: string): boolean {
  return a === b || isInside(a, b) || isInside(b, a);
}

async function readDocs(dir: string): Promise<Omit<Docs, 'sheets'>> {
  const scenes = new Map<string, SceneDoc>();
  for (const f of await list(join(dir, 'scenes'), '.scene.json')) {
    const doc: SceneDoc = parseJson(await readFile(join(dir, 'scenes', f), 'utf8'), `scenes/${f}`);
    scenes.set(doc.name, doc);
  }
  const prefabs = new Map<string, PrefabDoc>();
  for (const f of await list(join(dir, 'prefabs'), '.prefab.json')) {
    const doc: PrefabDoc = parseJson(await readFile(join(dir, 'prefabs', f), 'utf8'), `prefabs/${f}`);
    prefabs.set(doc.name, doc);
  }
  const tables = new Map<string, TableDoc>();
  for (const f of await list(join(dir, 'data'), '.table.json')) {
    const doc: TableDoc = parseJson(await readFile(join(dir, 'data', f), 'utf8'), `data/${f}`);
    const name = f.slice(0, -'.table.json'.length);
    tables.set(name, { name, rows: Array.isArray(doc.rows) ? doc.rows : [] });
  }
  return { scenes, prefabs, tables };
}

function parseJson<T>(text: string, file: string): T {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} のJSONが壊れています: ${(e as Error).message}`);
  }
}

async function list(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
  } catch {
    return [];
  }
}
