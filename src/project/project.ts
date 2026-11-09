// プロジェクト（フォルダ）の読み込みと保存。Node 側専用。
import { readFile, writeFile, readdir, mkdir, rm, rename, copyFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { formatJson, type PrefabDoc, type ProjectConfig, type SceneDoc } from '../core/docs.ts';
import { Registry, type CheckView, type GameModule } from '../core/registry.ts';
import { applyOps, diffDocs, getValue, setValue, sheetRoot, splitItem, type Change, type Docs, type Op, type PatchResult } from '../core/patch.ts';
import { formatAddress, parseAddress } from '../core/docs.ts';
import { Game } from '../core/game.ts';
import { RUN_DATE, parseDate, type DateStart } from '../core/clock.ts';
import { FIELD_TYPES, brief, checkAt, fieldAt, suggest, visit, type Field } from '../core/schema.ts';
import { ROW_ID, type TableDoc } from '../core/table.ts';
import { appendLog, localTime, lockedHits, markTouched, movePrefixTouched, moveTouched, readLocks as readLockFile, readLog, readTouched, writeLocks, type Actor, type LockMark } from './oplog.ts';
import { agesHome, lockDiff, verifyLocks, type LockIntegrity } from './seal.ts';
import { scanAssets, type AssetInfo } from './assets.ts';
import { assetRefs, codePrefabRefs, codeRefs, codeSceneRefs, isUnder } from '../core/assets.ts';
import { resolveEntity, resolvePrefab } from '../core/variant.ts';
import { allowedByDrawers, checkKept, checkWindows, loadWindows, prefabTags, tagCounts, tagEdit, unlistedWindows, windowAllows, windowTargets, type WindowInfo } from './windows.ts';
import { Journal, inverseFiles, type DocState, type FileMove, type TxRecord } from './journal.ts';
import { revert as revertValue, same } from '../core/revert.ts';
import { FIT_MODES } from '../core/camera.ts';
import { KNOWN_AXES, KNOWN_BUTTONS } from '../core/input.ts';
import { checkSheet, checkSheetImage, findFrame, frameCount, sheetPathOf, type SheetDef } from '../core/sheet.ts';
import { shaderMap } from '../core/shader.ts';
import { besideLoop } from '../core/ui.ts';
import type { SaveStore } from '../core/save.ts';
import { LANG_RE, codeTextRefs, languagesOf, missingText } from '../core/i18n.ts';

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
    this.docs = { ...(await readDocs(this.dir)), sheets: scan.sheets, files: new Set(scan.files), config: this.config };
    const prefabs = this.docs.prefabs;
    hookAgesImport();
    const url = pathToFileURL(join(this.dir, this.config.game)).href;
    const mod = (await import(url)) as GameModule;
    this.registry = Registry.from(mod, []);
    this.registry.setLanguages(languagesOf(this.config));
    this.registry.prefabs = prefabs;
    this.registry.scenes = this.docs.scenes;
    this.assets = scan.assets;
    this.assetIssues = scan.issues;
    this.registry.sheets = this.docs.sheets;
    this.registry.tableData = this.docs.tables;
    this.setAssetMaps(scan.assets);
    this.saves = await readSaves(this.dir);
    this.windowCache = null;
    this.integrity = await verifyLocks(this.dir);
    this.lockReport = await this.enforceLocks();
    if (!this.integrity.ok) {
      const d = this.lockDiff();
      const detail = [d.removed.length ? `消されたロック ${d.removed.length}件` : '', d.added.length ? `増えたロック ${d.added.length}件` : '', d.changed.length ? `値が変わったロック ${d.changed.length}件` : ''].filter(Boolean).join('・');
      this.lockReport.unshift(`⚠ ${this.integrity.reason}${detail ? `（${detail}）` : ''}。人がロックマネージャーで確認するまで、AIからの編集はすべて止めます。最後に封印されたロックは引き続き有効です`);
    }
  }

  /** 保存データのファイル（saves/*.save.json。ages run --save・エディタの「この保存データで始める」で使う） */
  saves = new Map<string, { data?: Record<string, unknown>; error?: string }>();

  /** アセットの一覧から、画像の大きさとシェーダーの宣言を登録簿へ */
  private setAssetMaps(assets: AssetInfo[]): void {
    this.registry.images = imagesOf(assets);
    this.registry.shaders = shadersOf(assets);
  }

  private windowCache: Promise<WindowInfo[]> | null = null;
  /** プロジェクト独自のエディタウインドウの宣言（id・名前・説明・変える値） */
  windows(): Promise<WindowInfo[]> {
    hookAgesImport();
    return (this.windowCache ??= loadWindows(this.dir, this.config.editorWindows ?? []));
  }

  /** ウインドウの宣言の問題と、登録し忘れたウインドウ（warns に ⚠: まだプレハブのない @[タグ]） */
  async checkWindows(warns: string[] = []): Promise<string[]> {
    const listed = this.config.editorWindows ?? [];
    const part = (c: string, f?: string) => {
      const def = this.registry.components.get(c);
      if (!def) return `部品 ${c} はありません${suggest(c, [...this.registry.components.keys()])}`;
      return f === undefined || def.fields[f] ? null : `${c} に ${f} はありません${suggest(f, Object.keys(def.fields))}`;
    };
    const types = [...new Set([...this.registry.components.values()].flatMap((d) => Object.values(d.fields).map((f) => f.type)).concat(FIELD_TYPES))];
    // 欄の見せ方の match の頭（住所・部品.フィールド・$表.列）の型
    const fieldOf = (head: string): Field | string => {
      if (head.startsWith('$')) {
        const [t, col] = head.slice(1).split('.');
        const def = this.registry.tables.get(t);
        if (!def) return `表 ${t} はありません${suggest(t, [...this.registry.tables.keys()])}`;
        if (!col) return `列がありません（$表.列 の形。行は書かず、どの行にも効く）`;
        return def.columns[col] ?? `表 ${t} に列 ${col} はありません${suggest(col, Object.keys(def.columns))}`;
      }
      if (head.includes('#') || head.startsWith('@')) {
        const bad = this.addressProblem(head);
        if (bad) return bad;
        const a = parseAddress(head);
        return (a.component && a.field ? this.registry.components.get(a.component)?.fields[a.field] : undefined) ?? `${head} はフィールドの住所ではありません（例 main#player.Health.hp）`;
      }
      const dot = head.indexOf('.');
      if (dot <= 0 || /[[\]]/.test(head)) return `部品.フィールド の形で書きます（例 Health.hp・Enemy.shotPatterns[].pattern）`;
      return part(head.slice(0, dot), head.slice(dot + 1)) ?? this.registry.components.get(head.slice(0, dot))!.fields[head.slice(dot + 1)];
    };
    const errs = checkWindows(await this.windows(), (a) => this.addressProblem(a), part, types, tagCounts(this.docs.prefabs), warns, fieldOf);
    for (const p of await unlistedWindows(this.dir, listed)) errs.push(`${p}: ages.project.json の editorWindows に書いていないので、エディタに出ません`);
    return errs;
  }

  /** 住所が指すものがあるか（ない理由を返す。あれば null） */
  addressProblem(address: string): string | null {
    if (address.startsWith('sheet:')) {
      const img = address.slice('sheet:'.length).split('|')[0];
      return this.docs.sheets.has(img) || this.assets.some((a) => a.path === img) ? null : `画像 ${img} がありません${suggest(img, this.assets.filter((a) => a.kind === 'image').map((a) => a.path))}`;
    }
    try {
      const a = parseAddress(address);
      if (a.kind === 'table') {
        if (!this.registry.tables.has(a.doc)) return `表 ${a.doc} はありません${suggest(a.doc, [...this.registry.tables.keys()])}`;
        if (a.entity && !this.docs.tables.get(a.doc)?.rows.some((r) => r.id === a.entity)) return `表 ${a.doc} に行 ${a.entity} はありません`;
        if (a.field && !(a.field in this.registry.tables.get(a.doc)!.columns)) return `表 ${a.doc} に列 ${a.field} はありません${suggest(a.field, Object.keys(this.registry.tables.get(a.doc)!.columns))}`;
        return null;
      }
      if (a.field) { getValue(this.docs, this.registry, address); return null; }
      const sc = a.kind === 'scene' ? this.docs.scenes.get(a.doc) : undefined;
      const holder = a.kind === 'prefab' ? this.registry.findPrefab(a.doc) : sc && this.resolvedScene(sc).entities.find((e) => e.id === a.entity);
      if (!holder) return a.kind === 'prefab' ? `プレハブ ${a.doc} はありません${suggest(a.doc, [...this.docs.prefabs.keys()])}` : `シーン ${a.doc} に ${a.entity} はありません`;
      if (a.component && !holder.components[a.component]) return `${address.split('.')[0]} に ${a.component} は付いていません${suggest(a.component, Object.keys(holder.components))}`;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** 元に戻す・やり直しの記録 */
  get journal(): Journal { return (this.journalCache ??= new Journal(this.dir)); }
  private journalCache: Journal | null = null;

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
    this.requireKeeper(actor, 'ロックの記録の承認');
    await writeLocks(this.dir, actor, await readLockFile(this.dir));
    await appendLog(this.dir, actor, 'lock-approve', [{ path: '.ages/locks.json', to: 'approved' }]);
    await this.reload();
  }

  /** 人が「前の状態に戻す」: 最後に封印した控えに戻す */
  async restoreLocks(actor: Actor): Promise<void> {
    this.requireKeeper(actor, 'ロックの記録を戻すの');
    const backup = this.integrity.backup;
    if (!backup) throw new Error('戻せる控えがありません。「この内容で承認」するか、ロックを付け直してください');
    await writeLocks(this.dir, actor, backup as Record<string, LockMark>);
    await appendLog(this.dir, actor, 'lock-restore-backup', [{ path: '.ages/locks.json', to: 'restored' }]);
    await this.reload();
  }

  private requireIntegrity(): void {
    if (!this.integrity.ok) throw new Error(`ロックの記録の確認が必要です: ${this.integrity.reason}。ロックマネージャー（エディタの「🔒⚠ ロックの記録を確認」から開く）で、承認するか前の状態に戻してください`);
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
    let filesRestored = false;
    for (const [path, mark] of Object.entries(locks)) {
      if (path.startsWith('file:')) {
        // ファイルそのもののロック: 中身が変わっていたら、手元の控えから戻す
        const rel = path.slice('file:'.length);
        const want = (mark.value as { sha256?: string } | null)?.sha256;
        const now = await fileHash(join(this.dir, rel));
        if (!want || now === want) continue;
        const copy = lockedCopy(this.dir, want);
        if (await readFile(copy).then(() => true, () => false)) {
          await mkdir(dirname(join(this.dir, rel)), { recursive: true });
          await copyFile(copy, join(this.dir, rel));
          filesRestored = true;
          restored.push({ path, from: now ? '変えられた中身' : '消された', to: 'ロックしたときの中身' });
          report.push(`ロック ${rel}（ファイル）が${now ? '書き換えられて' : '消されて'}いたので、ロックしたときの中身に戻しました`);
        } else {
          report.push(`ロック ${rel}（ファイル）が${now ? '書き換えられて' : '消されて'}いますが、この端末には控えがないので戻せません。ロックマネージャーで確かめて、付け直してください`);
        }
        continue;
      }
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
    if (filesRestored) {
      const scan = await scanAssets(this.dir);
      this.assets = scan.assets;
      this.setAssetMaps(scan.assets);
      this.docs.files = new Set(scan.files);
    }
    return report;
  }

  /** ロックされたファイルの中身を差し替える（ロックマネージャーから）。ロックの控えも新しい中身にする */
  async replaceLockedFile(rel: string, data: Buffer, actor: Actor): Promise<void> {
    this.requireKeeper(actor, 'ロックされたファイルの差し替え');
    this.requireIntegrity();
    const locks = await readLockFile(this.dir);
    const key = `file:${rel}`;
    if (!locks[key]) throw new Error(`${rel} はロックされていません（ふつうに取り込めます）`);
    const abs = join(this.dir, rel);
    await writeFile(abs, data);
    const sha256 = createHash('sha256').update(data).digest('hex');
    await mkdir(dirname(lockedCopy(this.dir, sha256)), { recursive: true });
    await writeFile(lockedCopy(this.dir, sha256), data);
    locks[key] = { ...locks[key], value: { sha256, bytes: data.length } };
    await writeLocks(this.dir, actor, locks);
    await appendLog(this.dir, actor, 'upload', [{ path: key, to: 'replaced' }]);
    await this.reload();
  }

  /** 住所が指すものの今の値と型（ロックマネージャーの表示用）。ロック中なら印も */
  async describe(path: string): Promise<{ path: string; kind: 'value' | 'sheet' | 'file'; value?: unknown; type?: string; problem?: string; lock?: LockMark; asset?: AssetInfo }> {
    const locks = await this.effectiveLocks();
    const lock = locks[path];
    if (path.startsWith('file:')) {
      const asset = this.assets.find((a) => a.path === path.slice(5));
      return { path, kind: 'file', asset, lock, problem: asset ? undefined : `ファイル ${path.slice(5)} はありません${suggest(path.slice(5), this.assets.map((a) => a.path))}` };
    }
    if (path.startsWith('sheet:')) {
      const img = path.slice(6);
      const problem = this.assets.some((a) => a.path === img && a.kind === 'image') ? undefined : `画像 ${img} はありません${suggest(img, this.assets.filter((a) => a.kind === 'image').map((a) => a.path))}`;
      return { path, kind: 'sheet', value: this.docs.sheets.get(img) ?? null, type: '画像の切り方', lock, problem };
    }
    try {
      const a = parseAddress(path);
      if (!a.field) return { path, kind: 'value', lock, problem: 'ロックは値（フィールド・表のセル）単位です（例: main#player.Player.speed）' };
      const { value } = getValue(this.docs, this.registry, path);
      const def = a.kind === 'table' ? this.registry.tables.get(a.doc)?.columns[a.field] : this.registry.components.get(a.component!)?.fields[a.field];
      return { path, kind: 'value', value, type: def ? brief(def) : undefined, lock };
    } catch (e) {
      return { path, kind: 'value', lock, problem: (e as Error).message };
    }
  }

  /** シーンの物を、プレハブのインスタンスはプレハブと重ねた中身にしたもの（読むだけ。プレハブがない物はそのまま） */
  /** ゲーム独自の検証（defineCheck）の ⚠。編集は止めない（validate と違い、patch の前後で比べない） */
  projectChecks(): string[] {
    if (!this.registry.checks.length) return [];
    const reg = this.registry;
    const view: CheckView = {
      table: (name) => reg.tableView(name),
      prefab: (name) => reg.findPrefab(name),
      prefabs: (tag) => reg.allPrefabs().filter((p) => !tag || (p.tags ?? []).includes(tag)),
      scene: (name) => { const s = this.docs.scenes.get(name); return s ? this.resolvedScene(s) : undefined; },
      scenes: [...this.docs.scenes.keys()],
    };
    const out: string[] = [];
    for (const c of reg.checks) {
      try {
        for (const m of c.run(view) ?? []) out.push(`${c.name}: ${m}`);
      } catch (e) {
        out.push(`${c.name}: 確かめの途中でエラー: ${(e as Error).message}`);
      }
    }
    return out;
  }

  resolvedScene(s: SceneDoc): SceneDoc {
    return { ...s, entities: s.entities.map((e) => { try { return resolveEntity(this.docs.prefabs, e); } catch { return e; } }) };
  }

  /** ロックできる住所の候補（ロックマネージャーで打つときの補完）。text を含むものを最大 limit 件 */
  lockCandidates(text: string, limit = 40): string[] {
    const out: string[] = [];
    const q = text.trim().toLowerCase();
    const push = (a: string) => { if (out.length < limit && (!q || a.toLowerCase().includes(q))) out.push(a); };
    const holder = (base: string, comps: Record<string, Record<string, unknown>>) => {
      for (const cname of Object.keys(comps)) for (const f of Object.keys(this.registry.components.get(cname)?.fields ?? {})) push(`${base}.${cname}.${f}`);
    };
    for (const sc of this.docs.scenes.values()) for (const e of this.resolvedScene(sc).entities) holder(`${sc.name}#${e.id}`, e.components);
    for (const pf of this.registry.allPrefabs()) holder(`@${pf.name}`, pf.components);
    for (const t of this.docs.tables.values()) for (const r of t.rows) for (const c of Object.keys(this.registry.tables.get(t.name)?.columns ?? {})) push(`$${t.name}.${r.id}.${c}`);
    for (const a of this.assets) { if (a.kind === 'image') push(`sheet:${a.path}`); push(`file:${a.path}`); }
    return out;
  }

  /** ロックマネージャーの一覧: すべてのロックと、今の値・型・問題 */
  async lockState() {
    const locks = await this.effectiveLocks();
    const items = await Promise.all(Object.keys(locks).sort().map((k) => this.describe(k)));
    return { items, integrity: { ok: this.integrity.ok, reason: this.integrity.reason, diff: this.lockDiff(), hasBackup: !!this.integrity.backup }, lockReport: this.lockReport, project: this.config.name };
  }

  /** ロックマネージャー（人だけが使う専用の画面）からの操作でなければ止める */
  private requireKeeper(actor: Actor, what: string): void {
    if (!isKeeper(actor)) throw new Error(`🔒 ${what}は、ロックマネージャーでだけできます（エディタの 🔒 を押すと開きます）。AI と独自のウインドウからはできません`);
  }

  /** 値をロックする（人だけ）。paths はフィールドまでのアドレス。 */
  async lock(paths: string[], actor: Actor, note?: string): Promise<void> {
    // ロックを「かける」のは、人ならエディタからもできる（安全側の操作で、開発が進む操作なので軽く）。外すのはロックマネージャーからだけ
    if (actor.kind !== 'human' || actor.win?.startsWith('window:')) throw new Error('🔒 ロックをかけるのは人だけです（エディタの 🔓 か、ロックマネージャーで）。AI と独自のウインドウからはできません');
    this.requireIntegrity();
    const locks = await readLockFile(this.dir);
    const t = new Date().toISOString();
    for (const path of paths) {
      if (path.startsWith('file:')) {
        // ファイルそのもののロック。中身の控えを、プロジェクトの外（この端末の使用者のフォルダ）に取る
        const rel = path.slice('file:'.length);
        if (!this.assets.some((a) => a.path === rel)) throw new Error(`ファイル ${rel} はありません${suggest(rel, this.assets.map((a) => a.path))}（ロックできるのは画像・音・フォント）`);
        const abs = join(this.dir, rel);
        const sha256 = (await fileHash(abs))!;
        await mkdir(dirname(lockedCopy(this.dir, sha256)), { recursive: true });
        await copyFile(abs, lockedCopy(this.dir, sha256));
        const mark: LockMark = { who: actor.who, t, value: { sha256, bytes: (await readFile(abs)).length } };
        if (note) mark.note = note;
        locks[path] = mark;
        continue;
      }
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
    this.requireKeeper(actor, 'ロックを外すの');
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
    // アセットの場所・表の行の名前は、検証の1回のあいだ作り置く（大きなプロジェクトでは、呼ぶたびに作ると検証が数秒かかる）
    const c = (this.nestedCache ??= { assets: new Set(this.assets.map((a) => a.path)), rows: new Map() });
    const assetPaths = c.assets;
    visit(f, v, at, (lf, lv, lat) => {
      if (lf.type === 'row' && typeof lv === 'string' && lv) {
        if (!this.registry.tables.has(lf.table)) { errs.push(`${lat}: 表 ${lf.table} の形がありません${suggest(lf.table, [...this.registry.tables.keys()])}`); return; }
        let ids = c.rows.get(lf.table);
        if (!ids) c.rows.set(lf.table, (ids = new Set((this.docs.tables.get(lf.table)?.rows ?? []).map((r) => r.id))));
        if (!ids.has(lv)) errs.push(`${lat}="${lv}": 表 ${lf.table} にその行はありません${suggest(lv, [...ids])}`);
      }
      if (lf.type === 'input' && typeof lv === 'string') {
        const known = lf.analog ? KNOWN_AXES : KNOWN_BUTTONS;
        if (!known.includes(lv)) errs.push(`${lat}="${lv}": ${lf.analog ? '軸' : 'ボタン'}の名前ではありません${suggest(lv, known)}（例 ${lf.analog ? 'Pad.LX' : 'KeyZ, Space, Pad.A, Mouse0'}）`);
      }
      if (lf.type === 'scene' && typeof lv === 'string' && lv && !this.docs.scenes.has(lv)) errs.push(`${lat}="${lv}": シーン ${lv} はありません${suggest(lv, [...this.docs.scenes.keys()])}`);
      if (lat === at) return; // フィールドそのものの prefab・asset は、下のこれまでの検証で見る
      if (lf.type === 'prefab' && typeof lv === 'string' && lv && !this.docs.prefabs.has(lv)) errs.push(`${lat}: プレハブ ${lv} はありません${suggest(lv, [...this.docs.prefabs.keys()])}`);
      if (lf.type === 'asset' && typeof lv === 'string' && lv && !assetPaths.has(lv)) errs.push(`${lat}: ファイル ${lv} がありません${suggest(lv, this.assets.filter((a) => a.kind === lf.kind).map((a) => a.path))}`);
    });
  }

  private nestedCache: { assets: Set<string>; rows: Map<string, Set<string>> } | null = null;

  /** 全文書を検証する。問題の一覧を返す（空なら健全）。 */
  validate(): string[] {
    this.nestedCache = null;
    try { return this.validateAll(); } finally { this.nestedCache = null; }
  }

  private validateAll(): string[] {
    const errs: string[] = [];
    const assetPaths = new Map(this.assets.map((a) => [a.path, a]));
    const check = (where: string, comps: Record<string, Record<string, unknown>>) => {
      for (const [name, values] of Object.entries(comps)) {
        errs.push(...this.registry.problems(name, values, where));
        const def = this.registry.components.get(name);
        if (!def) continue;
        for (const [k, f] of Object.entries(def.fields)) {
          if (k in values) this.checkNested(`${where}.${name}.${k}`, f.type === 'params' ? (this.registry.shaderParams(values[f.of]) ?? f) : f, values[k], errs);
          if (f.type === 'prefab' && k in values && values[k] !== '' && !this.docs.prefabs.has(values[k] as string)) {
            errs.push(`${where}.${name}.${k}: プレハブ ${values[k]} はありません${suggest(String(values[k]), [...this.docs.prefabs.keys()])}`);
          }
          // 音量の区分を指す値は、AudioBus の付いたプレハブであること
          if ((name === 'Sound' && k === 'bus' || name === 'AudioBus' && k === 'parent') && typeof values[k] === 'string' && values[k] && this.docs.prefabs.has(values[k] as string) && !this.registry.findPrefab(values[k] as string)?.components.AudioBus) {
            const buses = this.registry.allPrefabs().filter((p) => p.components.AudioBus).map((p) => p.name);
            errs.push(`${where}.${name}.${k}="${values[k]}": 音量の区分は AudioBus の付いたプレハブです${buses.length ? `（ある区分: ${buses.join(', ')}）` : '（まだ区分がありません）'}`);
          }
          if (f.type === 'asset' && typeof values[k] === 'string' && values[k] && !assetPaths.has(values[k] as string) && !(f.kind === 'shader' && this.registry.shaders.has(values[k] as string))) {
            const same = f.kind === 'shader' ? [...this.registry.shaders.keys()] : this.assets.filter((a) => a.kind === f.kind).map((a) => a.path);
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
    for (const raw of this.docs.scenes.values()) {
      // プレハブのインスタンスは、プレハブと重ねた中身で検べる（つながるプレハブがあること・外した部品がプレハブにあること）
      for (const e of raw.entities) {
        if (!e.prefab) continue;
        if (!this.docs.prefabs.has(e.prefab)) { errs.push(`${raw.name}#${e.id}.prefab: プレハブ ${e.prefab} はありません${suggest(e.prefab, [...this.docs.prefabs.keys()])}`); continue; }
        const base = this.registry.findPrefab(e.prefab);
        for (const c of e.remove ?? []) if (!base?.components[c]) errs.push(`${raw.name}#${e.id}.remove: プレハブ @${e.prefab} に部品 ${c} はありません${suggest(c, Object.keys(base?.components ?? {}))}`);
      }
      const s = this.resolvedScene(raw);
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
            // 隣に付ける相手は UI の物で、たどって自分に戻らないこと
            if (name === 'UI' && k === 'beside' && typeof v === 'string' && v && ids.has(v)) {
              const other = s.entities.find((x) => x.id === v)!;
              if (!other.components.UI) errs.push(`${s.name}#${e.id}.UI.beside="${v}": ${v} に UI が付いていません`);
              else if (besideLoop((id) => s.entities.find((x) => x.id === id)?.components.UI, e.id)) errs.push(`${s.name}#${e.id}.UI.beside="${v}": 隣に付ける相手をたどると自分に戻ります（輪になっています）`);
            }
            // 後処理をかけるカメラは、Camera の付いた物
            if (name === 'PostEffect' && k === 'camera' && typeof v === 'string' && v && ids.has(v) && !s.entities.find((x) => x.id === v)!.components.Camera) {
              errs.push(`${s.name}#${e.id}.PostEffect.camera="${v}": ${v} に Camera が付いていません（カメラ: ${s.entities.filter((x) => x.components.Camera).map((x) => x.id).join(', ') || 'なし'}）`);
            }
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
          const rf = f.type === 'params' ? (this.registry.shaderParams(r[f.of]) ?? f) : f;
          const e = checkAt(`$${name}.${r.id}.${k}`, rf, v);
          if (e) errs.push(e);
          else this.checkNested(`$${name}.${r.id}.${k}`, rf, v, errs);
        }
      });
    }
    // 音量の区分の親子が輪になっていないこと
    for (const p of this.registry.allPrefabs()) {
      if (!p.components.AudioBus) continue;
      const seen = new Set<string>([p.name]);
      for (let cur = p.components.AudioBus.parent as string | undefined; cur; cur = this.registry.findPrefab(cur)?.components.AudioBus?.parent as string | undefined) {
        if (seen.has(cur)) { errs.push(`@${p.name}.AudioBus.parent: 区分の親子が輪になっています（${[...seen, cur].join(' → ')}）`); break; }
        seen.add(cur);
      }
    }
    if (this.config.view.fit && !FIT_MODES.includes(this.config.view.fit)) {
      errs.push(`ages.project.json の view.fit="${this.config.view.fit}" は ${FIT_MODES.join(' | ')} のどれかです${suggest(this.config.view.fit, FIT_MODES)}`);
    }
    for (const p of this.docs.prefabs.values()) {
      if (!p.base) { check(`@${p.name}`, p.components); continue; }
      // 派生: 元がたどれること・外した部品が元にあること。値は、書いた部品を元と重ねた形で確かめる
      let r: PrefabDoc;
      try { r = resolvePrefab(this.docs.prefabs, p.name); } catch (e) { errs.push((e as Error).message); continue; }
      const base = this.registry.findPrefab(p.base);
      for (const c of p.remove ?? []) if (!base?.components[c]) errs.push(`@${p.name}.remove: 元 @${p.base} に部品 ${c} はありません${suggest(c, Object.keys(base?.components ?? {}))}`);
      check(`@${p.name}`, Object.fromEntries(Object.keys(p.components ?? {}).map((c) => [c, r.components[c] ?? p.components[c]])));
    }
    if (!this.docs.scenes.has(this.config.startScene)) errs.push(`開始シーン ${this.config.startScene} がありません`);
    for (const [image, sheet] of this.docs.sheets) {
      const sp = sheetPathOf(image);
      const e = checkSheet(sp, sheet);
      errs.push(...e);
      const info = assetPaths.get(image);
      if (!e.length && info?.w && info.h) errs.push(...checkSheetImage(sp, sheet, info.w, info.h));
    }
    errs.push(...this.assetIssues);
    // 多言語: 言語の名前と、Text.key が表 $text の行を指していること
    {
      const langs = languagesOf(this.config);
      for (const l of langs) if (!LANG_RE.test(l)) errs.push(`ages.project.json: languages の "${l}" は言語の名前として使えません（ja・en・zh_Hans・pt_BR の形。表 $text の列の名前になる）`);
      if (new Set(langs).size !== langs.length) errs.push('ages.project.json: languages に同じ言語が2回あります');
      const keys = new Set(this.docs.tables.get('text')?.rows.map((r) => String(r.id)) ?? []);
      const checkKey = (where: string, tx?: Record<string, unknown>) => {
        const k = tx?.key;
        if (typeof k === 'string' && k && !keys.has(k)) errs.push(`${where}.Text.key: 表 $text に "${k}" の行がありません${suggest(k, [...keys])}（行を足すなら addRow{table:"text",row:{id:"${k}",${langs[0]}:"…"}}）`);
      };
      for (const pf of this.docs.prefabs.values()) checkKey(`@${pf.name}`, pf.components.Text);
      for (const sc of this.docs.scenes.values()) for (const e of this.resolvedScene(sc).entities) checkKey(`${sc.name}#${e.id}`, e.components.Text);
    }
    // 保存データのファイル: 形と、物の保存（saveWorld）の中のコンポーネント
    for (const [path, sv] of this.saves) {
      if (sv.error) { errs.push(`${path}: ${sv.error}`); continue; }
      for (const [key, v] of Object.entries(sv.data ?? {})) {
        const w = v as { $world?: number; entities?: { id: string; c?: Record<string, unknown> }[] };
        if (w?.$world !== 1) continue;
        for (const e of w.entities ?? []) for (const name of Object.keys(e.c ?? {})) {
          if (!this.registry.components.has(name)) errs.push(`${path}: ${key} の ${e.id} の ${name} はないコンポーネントです${suggest(name, [...this.registry.components.keys()])}（読み込むときは捨てられます）`);
        }
      }
    }
    // 当たり判定: with に書いたグループの Collider があること（名前の書き間違い）
    {
      const groups = new Set<string>();
      const withs: [string, string][] = [];
      const scan = (where: string, c?: Record<string, unknown>) => {
        if (!c) return;
        if (c.group) groups.add(String(c.group));
        for (const w of (c.with as string[] | undefined) ?? []) withs.push([where, w]);
      };
      for (const pf of this.docs.prefabs.values()) scan(`@${pf.name}`, pf.components.Collider);
      for (const sc of this.docs.scenes.values()) for (const e of this.resolvedScene(sc).entities) scan(`${sc.name}#${e.id}`, e.components.Collider);
      for (const [where, w] of withs) if (!groups.has(w)) errs.push(`${where}.Collider.with: グループ "${w}" の Collider がありません${suggest(w, [...groups])}（ある名前: ${[...groups].join(', ') || 'なし'}）`);
    }
    for (const a of this.assets) {
      if (!a.shader) continue;
      errs.push(...a.shader.errors);
      // 画像の値（sampler2D）の既定値のファイルがあること
      for (const [k, f] of Object.entries(a.shader.uniforms)) {
        if (f.type === 'asset' && f.default && !assetPaths.has(f.default)) errs.push(`${a.path}: ${k} の既定値のファイル ${f.default} がありません${suggest(f.default, this.assets.filter((x) => x.kind === 'image').map((x) => x.path))}`);
      }
    }
    return errs;
  }

  /**
   * 操作を適用して保存し、ログに残す。
   * AIが人の調整した値を変えようとした場合は force がない限り止める。
   */
  async apply(ops: Op[], actor: Actor, opts: { force?: boolean; tx?: Partial<TxRecord> } = {}): Promise<PatchResult> {
    const targetOf = (op: Op) =>
      op.op === 'set' || op.op === 'setCells' || op.op === 'insert' ? op.path
        : op.op === 'removeItem' || op.op === 'moveItem' ? splitItem(op.path).list
        : op.op === 'removeEntity' ? `${op.scene}#${op.id}`
        : op.op === 'removeComponent' ? `${op.target}.${op.component}`
        : op.op === 'setSheet' || op.op === 'setFrame' || op.op === 'setClip' ? `sheet:${op.image}`
        : op.op === 'removeRow' || op.op === 'renameRow' ? `$${op.table}.${op.id}`
        : op.op === 'dockUI' || op.op === 'attachUI' ? `${op.target}.UI`
        : op.op === 'removePrefab' ? `@${op.name}`
        : op.op === 'revert' ? op.path
        : null;
    // シーン・プレハブを消す・名前を変えると、その中のロック・★の住所も変わる
    const sceneKeys = (op: Op, rec: Record<string, unknown>) => { const pre = docPrefix(op); return pre ? Object.keys(rec).filter((k) => k.startsWith(pre)) : []; };
    // アセットの移動・削除で一緒に動く画像の切り方（sheet:<画像>）と、ロックされたファイル（file:<場所>）
    const assetSheets = (op: Op) => {
      if (op.op !== 'moveAsset' && op.op !== 'removeAsset') return [];
      const from = (op.op === 'moveAsset' ? op.from : op.path).replace(/\/+$/, '');
      const files = Object.keys(locks).filter((k) => k.startsWith('file:') && (k.slice(5) === from || isUnder(k.slice(5), from)));
      return [...[...this.docs.sheets.keys()].filter((img) => img === from || isUnder(img, from)).map((img) => `sheet:${img}`), ...files];
    };
    const keeper = isKeeper(actor);
    // 人がエディタで行っても、ロックの住所が付いて動くだけで値の意味は変わらない操作（名前の変更・場所の変更）
    const STRUCTURAL = new Set(['renameRow', 'renameScene', 'renamePrefab', 'moveAsset']);
    if (actor.kind === 'ai' && !this.integrity.ok) {
      throw new Error(`🔒 ロックの記録が人の封印と一致しないため、AIからの編集を止めています（${this.integrity.reason}）。ユーザーにロックマネージャーでの確認を頼んでください`);
    }
    const locks = await this.effectiveLocks();
    // 人（ロックマネージャー以外）: ロックされた値を変える・ロックされたものを消すことはできない（独自のウインドウは下でもっと厳しく）
    const fromWindow = actor.win?.startsWith('window:');
    if (actor.kind === 'human' && !keeper && !fromWindow) {
      const hits = ops.filter((op) => !STRUCTURAL.has(op.op)).flatMap((op) => { const t = targetOf(op); return [...(t ? lockedHits(locks, t) : []), ...assetSheets(op).filter((k) => locks[k]), ...sceneKeys(op, locks)]; });
      if (hits.length) throw new Error(`🔒 ロックされています: ${[...new Set(hits)].join(', ')}。変えるならロックマネージャーで（🔒 を押すと開きます）`);
      const files = ops.flatMap((op) => (op.op === 'moveAsset' ? assetSheets(op).filter((k) => k.startsWith('file:') && locks[k]) : []));
      if (files.length) throw new Error(`🔒 ロックされたファイルは動かせません: ${files.join(', ')}。動かすならロックマネージャーで外してから`);
    }
    if (actor.kind === 'human' && !this.integrity.ok) {
      const hits = ops.flatMap((op) => { const t = targetOf(op); return t ? lockedHits(locks, t) : []; });
      if (hits.length) this.requireIntegrity();
    }
    if (actor.kind === 'ai') {
      // ロックは --force でも越えられない（ロックされた切り方の画像は、場所も変えられない）
      const hits = ops.flatMap((op) => { const t = targetOf(op); return [...(t ? lockedHits(locks, t) : []), ...assetSheets(op).filter((k) => locks[k]), ...sceneKeys(op, locks)]; });
      if (hits.length) {
        throw new Error(`🔒 ロックされた値は変更できません: ${hits.join(', ')}。この値は人が決めるものです。変えるべき理由があれば、ユーザーに提案してください`);
      }
    }
    // 独自のウインドウ（AIが書いたコード）からの変更: ロックされた値は変えられない。edits に書いた値だけを変えられる
    const viaWindow = actor.win?.startsWith('window:') ? actor.win.slice('window:'.length) : null;
    let windowEdits: string[] | undefined;
    const keepTags: { name: string; tags: string[] }[] = [];
    if (viaWindow) {
      const hits = ops.flatMap((op) => { const t = targetOf(op); return [...(t ? lockedHits(locks, t) : []), ...assetSheets(op).filter((k) => locks[k]), ...sceneKeys(op, locks)]; });
      if (hits.length) throw new Error(`🔒 ロックされた値は、ウインドウ ${viaWindow} からは変えられません: ${hits.join(', ')}。変えるならインスペクタで`);
      // パネルの edits と、見せている欄・部品・行（fields・components・rows）だけを変えられる
      const ext = (await this.windows()).find((w) => w.id === viaWindow);
      windowEdits = ext ? ext.edits ?? [] : undefined;
      if (windowEdits) {
        const info = (await this.windows()).find((w) => w.id === viaWindow)!;
        // 値のフィールド（列）の一番外から、その値までの型（型で選ぶ欄の見せ方のため。どれか1つの中は今の値の種類で）
        const typesAt = (t: string): string[] => {
          try {
            const a = parseAddress(t);
            const f = !a.field ? undefined : a.kind === 'table' ? this.registry.tables.get(a.doc)?.columns[a.field] : this.registry.components.get(a.component ?? '')?.fields[a.field];
            if (!f) return [];
            let top: unknown;
            try { top = getValue(this.docs, this.registry, formatAddress({ ...a, sub: [] })).value; } catch { top = undefined; }
            const out: string[] = [];
            for (let i = 0; i <= (a.sub?.length ?? 0); i++) { const sf = fieldAt(f, a.sub!.slice(0, i), top); if (!sf) break; out.push(sf.type); }
            return out;
          } catch { return []; }
        };
        // @[タグ]: 変える前のタグで通し、変えた後もタグを持つかは keepTags で確かめる（下の「タグの外へ出ない」）
        const tagsBefore = windowEdits.some((e) => tagEdit(e)) ? prefabTags(this.docs.prefabs) : new Map<string, string[]>();
        const outside = ops.flatMap((op) => windowTargets(op, targetOf)).filter((t) => !allowedByDrawers(info, t, typesAt) && !windowAllows(windowEdits!, t, tagsBefore, keepTags));
        if (outside.length) throw new Error(`ウインドウ ${viaWindow} は、宣言（edits）にない値を変えようとしています: ${[...new Set(outside)].join(', ')}。変えるなら ${viaWindow} の edits に足してください（地図に出ます）${outside.some((t) => t.startsWith('@')) && windowEdits.some((e) => tagEdit(e)) ? '。@[タグ] で変えられるのは、変える前からそのタグを持つプレハブと、新しく作るプレハブ' : ''}`);
      }
    }
    if (actor.kind === 'ai' && !opts.force) {
      const touched = await readTouched(this.dir);
      const hits: string[] = [];
      for (const op of ops) {
        if (op.op === 'removeScene') for (const k of sceneKeys(op, touched)) hits.push(`${k}（${touched[k].who} が ${localTime(touched[k].t)} に調整）`);
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
    const backup: Docs = { scenes: new Map(this.docs.scenes), prefabs: new Map(this.docs.prefabs), sheets: new Map(this.docs.sheets), tables: new Map(this.docs.tables), files: new Set(this.docs.files), config: structuredClone(this.config) };
    const backupAssets = this.assets;
    // コードの中で場所を書いているアセットは、消すと動かなくなる
    const code = ops.some((o) => o.op === 'moveAsset' || o.op === 'removeAsset') ? await this.codeRefs() : new Map<string, string[]>();
    const codeScenes = ops.some((o) => o.op === 'removeScene' || o.op === 'renameScene') ? codeSceneRefs(await this.codeFiles()) : new Map<string, string[]>();
    const codePrefabs = ops.some((o) => o.op === 'removePrefab' || o.op === 'renamePrefab') ? codePrefabRefs(await this.codeFiles()) : new Map<string, string[]>();
    const result = applyOps(this.docs, this.registry, ops);
    const rollback = (message: string): never => {
      this.docs.scenes = backup.scenes;
      this.docs.prefabs = backup.prefabs;
      this.docs.sheets = backup.sheets;
      this.docs.tables = backup.tables;
      this.docs.files = backup.files;
      Object.assign(this.config, backup.config);
      this.registry.prefabs = backup.prefabs;
      this.registry.scenes = backup.scenes;
      this.registry.sheets = backup.sheets;
      this.registry.tableData = backup.tables;
      this.assets = backupAssets;
      this.setAssetMaps(backupAssets);
      throw new Error(message);
    };
    // ファイルの移動・削除を、検証の前に一覧へ反映する（ファイルそのものは検証が通ってから動かす）
    const warnings: string[] = [];
    for (const op of ops) {
      if (op.op !== 'removeScene' && op.op !== 'renameScene') continue;
      const at = codeScenes.get(op.name);
      if (!at) continue;
      if (op.op === 'removeScene') rollback(`シーン ${op.name} はコードの中で使われているので消せません: ${at.join(', ')}。先にコードを直してください`);
      else warnings.push(`シーン ${op.name} はコードの中にも書かれています（${at.join(', ')}）。コードは直していないので、${op.to} に書き換えてください`);
    }
    for (const op of ops) {
      if (op.op !== 'removePrefab' && op.op !== 'renamePrefab') continue;
      const at = codePrefabs.get(op.name);
      if (!at) continue;
      if (op.op === 'removePrefab') rollback(`プレハブ ${op.name} はコードの中で使われているので消せません: ${at.join(', ')}。先にコードを直してください`);
      else warnings.push(`プレハブ ${op.name} はコードの中にも書かれています（${at.join(', ')}）。コードは直していないので、${op.to} に書き換えてください`);
    }
    if (result.files.length) {
      const moved = (path: string): string | null | undefined => {
        let p: string | null = path;
        for (const f of result.files) {
          if (p === null) break;
          if (p === f.from || (f.dir && isUnder(p, f.from))) p = f.to === null ? null : f.to + p.slice(f.from.length);
        }
        return p === path ? undefined : p;
      };
      this.assets = this.assets.flatMap((a) => { const to = moved(a.path); return to === null ? [] : to === undefined ? [a] : [{ ...a, path: to }]; });
      this.setAssetMaps(this.assets);
      for (const [asset, at] of code) {
        const to = moved(asset);
        if (to === undefined) continue;
        if (to === null) rollback(`${asset} はコードの中で使われているので消せません: ${at.join(', ')}。先にコードを直してください`);
        warnings.push(`${asset} はコードの中にも書かれています（${at.join(', ')}）。コードは直していないので、${to} に書き換えてください`);
      }
    }
    // 操作の結果として連動して変わる値（コマの名前の変更で書き換わる参照など）にも、ロックは効く。
    // 人（ロックマネージャー以外）は、意味を保つための自動の直し（場所の変更に合わせた参照など）だけを通す
    if (actor.kind === 'human' && !keeper && !fromWindow) {
      const moved = (c: Change) => (typeof c.to === 'string' && c.to.startsWith('renamed:')) || /^(file|scene|prefab):|^config\./.test(c.path);
      // 派生が受け継いでいる値（via）は、元を変えると一緒に変わるので、自動の直しでもロックが効く
      const hits = [...new Set(result.changes.filter((c) => (!c.auto || c.via) && !moved(c)).flatMap((c) => lockedHits(locks, sheetRoot(c.path.replace(/\[\d+,\s*\d+\]$/, '')))))];
      if (hits.length) rollback(`🔒 ロックされています: ${hits.join(', ')}。変えるならロックマネージャーで（🔒 を押すと開きます）`);
    }
    if (actor.kind === 'ai' || viaWindow) {
      const hits = [...new Set(result.changes.flatMap((c) => lockedHits(locks, sheetRoot(c.path.replace(/\[\d+,\s*\d+\]$/, '')))))];
      if (hits.length) rollback(`🔒 この操作は、ロックされた値も変えてしまいます: ${hits.join(', ')}。この値は人が決めるものです。変えるべき理由があれば、ユーザーに提案してください`);
    }
    // タグの外へ出ない: edits の @[タグ] で変えたプレハブは、変えた後もそのタグを持つこと（作ったもの・名前を変えたもの・元を変えたものも）
    if (keepTags.length) {
      const gone = checkKept(keepTags, prefabTags(this.docs.prefabs));
      if (gone.length) rollback(`ウインドウ ${viaWindow} の変更で、edits の @[タグ] の外へ出るプレハブがあります: ${gone.join(', ')}。タグを残すか、作るときに tags を書いてください`);
    }
    const introduced = this.validate().filter((e) => !before.has(e));
    if (introduced.length) rollback(introduced.join(' / '));
    const fileMoves: FileMove[] = [];
    for (const f of result.files) {
      try {
        const from = join(this.dir, f.from);
        if (f.to === null) {
          // 消すファイルは、元に戻せるように控えを取っておく（この端末の使用者のフォルダ）
          fileMoves.push({ kind: 'delete', path: f.from, dir: f.dir, trash: await this.journal.keep(from, f.dir) });
          await rm(from, { recursive: f.dir, force: true });
        } else {
          await mkdir(dirname(join(this.dir, f.to)), { recursive: true });
          await rename(from, join(this.dir, f.to));
          fileMoves.push({ kind: 'move', from: f.from, to: f.to, dir: f.dir });
        }
      } catch (e) {
        rollback(`ファイルを${f.to === null ? '消せません' : '動かせません'}（${f.from}）: ${(e as Error).message}`);
      }
    }
    await this.saveDirty(result.dirty);
    const opName = opts.tx?.undoOf ? 'undo' : opts.tx?.redoOf ? 'redo' : ops.length === 1 ? ops[0].op : 'batch';
    const tx = this.journal.newId();
    if (result.changes.length || fileMoves.length) {
      const docs: Record<string, DocState> = {};
      for (const key of result.dirty) docs[key] = { before: docOf(backup, key), after: docOf(this.docs, key) };
      const structural = ops.every((o) => STRUCTURAL.has(o.op));
      await this.journal.append({
        id: tx, t: new Date().toISOString(), who: actor.who, kind: actor.kind, win: actor.win, label: describeTx(result.changes),
        docs, files: fileMoves.length ? fileMoves : undefined,
        ...(structural ? { ops, inverse: [...ops].reverse().map(inverseOp) } : {}),
        ...opts.tx,
      });
    }
    await appendLog(this.dir, actor, opName, result.changes, tx);
    await markTouched(this.dir, actor, result.changes);
    if (actor.kind === 'human') {
      // 人がロック中の値を編集したら、ロックの値も新しい値にする。消したものはロックも外す。行の ID を変えたらロックも付け替える
      let changed = false;
      for (const c of result.changes) {
        const path = sheetRoot(c.path.replace(/\[\d+,\s*\d+\]$/, ''));
        if (c.path.startsWith('file:') || c.path.startsWith('scene:') || c.path.startsWith('config.')) continue;
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
      // シーン・プレハブの名前を変えたら、その中のロックも付け替える。消したらロックも外す
      for (const op of ops) {
        const pre = docPrefix(op);
        if (!pre) continue;
        const to = docPrefix(op, true);
        for (const k of Object.keys(locks)) {
          if (!k.startsWith(pre)) continue;
          if (to) locks[to + k.slice(pre.length)] = locks[k];
          delete locks[k];
          changed = true;
        }
      }
      // 動かした画像の切り方のロックも付け替える
      for (const f of result.files) {
        for (const k of Object.keys(locks)) {
          if (k.startsWith('file:')) {
            const p = k.slice('file:'.length);
            if (p !== f.from && !(f.dir && isUnder(p, f.from))) continue;
            if (f.to !== null) locks['file:' + f.to + p.slice(f.from.length)] = locks[k];
            delete locks[k];
            changed = true;
            continue;
          }
          const img = k.startsWith('sheet:') ? k.slice('sheet:'.length).split('|')[0] : null;
          if (!img || !(img === f.from || (f.dir && isUnder(img, f.from)))) continue;
          if (f.to !== null) locks['sheet:' + f.to + k.slice('sheet:'.length + f.from.length)] = locks[k];
          delete locks[k];
          changed = true;
        }
      }
      if (changed) await writeLocks(this.dir, actor, locks);
    }
    if (result.files.length) await moveTouched(this.dir, result.files);
    for (const op of ops) { const pre = docPrefix(op); if (pre) await movePrefixTouched(this.dir, pre, docPrefix(op, true)); }
    if (warnings.length) result.warnings = warnings;
    return result;
  }

  /** コードの中で、アセットの場所を文字列で書いている所 */
  async codeRefs(): Promise<Map<string, string[]>> {
    return codeRefs(await this.codeFiles(), this.assets.map((a) => a.path));
  }

  /** 言語ごとの未訳（訳が空の行） */
  missingText(): Map<string, string[]> {
    return missingText(this.registry.tableView('text').rows as never, languagesOf(this.config));
  }

  /** コードの中の goto('名前') が、ないシーンを指していないか */
  async checkCode(): Promise<string[]> {
    const errs: string[] = [];
    const files = await this.codeFiles();
    for (const [name, at] of codeSceneRefs(files)) {
      if (!this.docs.scenes.has(name)) errs.push(`${at.join(', ')}: goto('${name}') のシーン ${name} はありません${suggest(name, [...this.docs.scenes.keys()])}`);
    }
    // spawn('名前')・sound.play('名前') がプレハブを指していること
    for (const [name, at] of codePrefabRefs(files)) {
      if (!this.docs.prefabs.has(name)) errs.push(`${at.join(', ')}: プレハブ ${name} はありません${suggest(name, [...this.docs.prefabs.keys()])}`);
    }
    // t('名前') が表 $text の行を指していること
    const keys = new Set(this.docs.tables.get('text')?.rows.map((r) => String(r.id)) ?? []);
    for (const [key, at] of codeTextRefs(files)) {
      if (!keys.has(key)) errs.push(`${at.join(', ')}: t('${key}') の行が表 $text にありません${suggest(key, [...keys])}`);
    }
    return errs;
  }

  /** ゲームとエディタのコード（場所と中身） */
  async codeFiles(): Promise<[string, string][]> {
    const files: [string, string][] = [];
    const walk = async (rel: string): Promise<void> => {
      let names: import('node:fs').Dirent[];
      try { names = await readdir(join(this.dir, rel), { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        const r = `${rel}/${d.name}`;
        if (d.isDirectory()) await walk(r);
        else if (/\.(ts|js|mjs)$/.test(d.name)) files.push([r, await readFile(join(this.dir, r), 'utf8')]);
      }
    };
    await walk('game');
    await walk('editor');
    return files;
  }

  /**
   * 元に戻す（redo ならやり直す）。tx を省くと、その人（actor）の直前の編集。
   * その後で同じ所が別の値に変えられていたら、戻さずに知らせる。ロック・★の決まりはふつうの編集と同じ
   */
  async undo(actor: Actor, opts: { tx?: string; redo?: boolean; force?: boolean } = {}): Promise<PatchResult & { label: string }> {
    const all = await this.journal.read();
    const st = Journal.status(all);
    let target: TxRecord | undefined;
    if (opts.tx) {
      target = all.find((r) => r.id === opts.tx);
      if (!target) throw new Error(`編集 ${opts.tx} の記録がありません（この端末で行った、最近${300}件までの編集を戻せます）`);
      if (!opts.redo && st.get(target.id) !== 'done') throw new Error(`編集 ${opts.tx} はもう戻してあります`);
      if (opts.redo && st.get(target.id) !== 'undone') throw new Error(`編集 ${opts.tx} は戻していないので、やり直せません`);
    } else {
      const n = Journal.next(all, actor.who, actor.kind);
      target = opts.redo ? n.redo : n.undo;
      if (!target) throw new Error(opts.redo ? 'やり直せる編集はありません' : '元に戻せる編集はありません（この端末で行った、あなたの編集だけを戻せます）');
    }
    if (target.undoOf) throw new Error('「元に戻す」そのものは戻せません。やり直すなら redo で');
    const meta: Partial<TxRecord> = opts.redo ? { redoOf: target.id, label: target.label } : { undoOf: target.id, label: `元に戻す: ${target.label}` };
    const ops = opts.redo ? target.ops : target.inverse;
    const r = ops
      ? await this.apply(ops, actor, { force: opts.force, tx: meta })
      : await this.restoreDocs(target, !!opts.redo, actor, meta, !!opts.force);
    return { ...r, label: target.label };
  }

  /** 文書を、ある編集の前（redo なら後）に戻す。その後で変わった所はそのまま、ぶつかれば止める */
  private async restoreDocs(target: TxRecord, redo: boolean, actor: Actor, meta: Partial<TxRecord>, force: boolean): Promise<PatchResult> {
    const conflicts: string[] = [];
    const next = new Map<string, unknown>();
    for (const [key, d] of Object.entries(target.docs)) {
      const from = redo ? d.before : d.after, to = redo ? d.after : d.before;
      const r = revertValue(docOf(this.docs, key) ?? undefined, from ?? undefined, to ?? undefined, docLabel(key));
      conflicts.push(...r.conflicts);
      next.set(key, r.value ?? null);
    }
    if (conflicts.length) throw new Error(`${redo ? 'やり直せません' : '元に戻せません'}。その後で変えられています: ${conflicts.slice(0, 6).join(', ')}${conflicts.length > 6 ? ` ほか${conflicts.length - 6}か所` : ''}`);
    const files = redo ? target.files ?? [] : inverseFiles(target.files ?? []);
    // ロック・★の決まりは、ふつうの編集と同じ
    const before: Docs = { scenes: new Map(this.docs.scenes), prefabs: new Map(this.docs.prefabs), sheets: new Map(this.docs.sheets), tables: new Map(this.docs.tables), files: new Set(this.docs.files), config: structuredClone(this.config) };
    const after: Docs = { scenes: new Map(before.scenes), prefabs: new Map(before.prefabs), sheets: new Map(before.sheets), tables: new Map(before.tables), files: before.files, config: structuredClone(this.config) };
    for (const [key, v] of next) setDoc(after, key, v);
    const changes = diffDocs(before, after);
    if (before.config!.startScene !== after.config!.startScene) changes.push({ path: 'config.startScene', from: before.config!.startScene, to: after.config!.startScene });
    for (const f of files) changes.push(f.kind === 'move' ? { path: `file:${f.from}`, from: f.from, to: f.to } : { path: `file:${f.path}`, to: f.kind === 'delete' ? 'removed' : f.kind === 'create' ? 'added' : 'replaced' });
    const locks = await this.effectiveLocks();
    if (!isKeeper(actor)) {
      const hits = [...new Set([
        ...changes.filter((c) => !c.path.startsWith('file:')).flatMap((c) => lockedHits(locks, sheetRoot(c.path.replace(/\[\d+,\s*\d+\]$/, '')))),
        ...files.flatMap((f) => { const p = f.kind === 'move' ? f.from : f.path; return Object.keys(locks).filter((k) => k === `file:${p}` || (k.startsWith('file:') && isUnder(k.slice(5), p))); }),
      ])];
      if (hits.length) throw new Error(`🔒 ロックされた値に関わるので、${meta.redoOf ? 'やり直せません' : '元に戻せません'}: ${hits.join(', ')}${actor.kind === 'human' ? '。変えるならロックマネージャーで' : ''}`);
    }
    // AI が人の編集を戻すときは、人が調整した値に触れるなら確認が要る（自分の編集を戻すだけなら、前の値に戻るだけなので要らない）
    if (actor.kind === 'ai' && !force && (target.who !== actor.who || target.kind !== actor.kind)) {
      const touched = await readTouched(this.dir);
      const hits = changes.flatMap((c) => Object.keys(touched).filter((t) => related(t, c.path) && touched[t].who !== actor.who));
      if (hits.length) throw new Error(`人が調整した値に触れます: ${[...new Set(hits)].join(', ')}。ユーザーに確認してから --force を付けて実行してください`);
    }
    // 使われているファイルは、取り込みを戻して消すことはできない
    const refs = assetRefs(after, this.registry);
    for (const f of files) if (f.kind === 'delete' && refs.has(f.path)) throw new Error(`${f.path} は使われているので、取り込みを戻せません: ${refs.get(f.path)!.slice(0, 3).join(', ')}`);
    // ファイルを動かしてから、文書を置き換えて検証する。問題が増えたら全部戻す
    const done: FileMove[] = [];
    const runFile = async (f: FileMove) => {
      const abs = (p: string) => join(this.dir, p);
      if (f.kind === 'move') {
        if (existsSync(abs(f.to))) throw new Error(`${f.to} がすでにあります`);
        await mkdir(dirname(abs(f.to)), { recursive: true });
        await rename(abs(f.from), abs(f.to));
      } else if (f.kind === 'delete') {
        await rm(abs(f.path), { recursive: f.dir, force: true });
      } else if (f.kind === 'create') {
        if (existsSync(abs(f.path))) throw new Error(`${f.path} がすでにあります`);
        await mkdir(dirname(abs(f.path)), { recursive: true });
        await cp(this.journal.trashPath(f.trash), abs(f.path), { recursive: f.dir });
      } else {
        await copyFile(this.journal.trashPath(f.newTrash), abs(f.path));
      }
    };
    const problemsBefore = new Set(this.validate());
    try {
      for (const f of files) { await runFile(f); done.push(f); }
    } catch (e) {
      for (const f of inverseFiles(done)) await runFile(f).catch(() => {});
      throw new Error(`ファイルを戻せません: ${(e as Error).message}`);
    }
    const keep = { docs: this.docs, assets: this.assets, images: this.registry.images, config: structuredClone(this.config) };
    const scan = files.length ? await scanAssets(this.dir) : null;
    this.docs = { ...after, files: scan ? new Set(scan.files) : this.docs.files, config: this.config, sheets: after.sheets };
    Object.assign(this.config, after.config);
    if (scan) { this.assets = scan.assets; this.setAssetMaps(scan.assets); }
    this.registry.prefabs = this.docs.prefabs;
    this.registry.scenes = this.docs.scenes;
    this.registry.sheets = this.docs.sheets;
    this.registry.tableData = this.docs.tables;
    const introduced = this.validate().filter((e) => !problemsBefore.has(e));
    if (introduced.length) {
      this.docs = keep.docs;
      this.assets = keep.assets;
      this.setAssetMaps(keep.assets);
      Object.assign(this.config, keep.config);
      this.registry.prefabs = this.docs.prefabs;
      this.registry.scenes = this.docs.scenes;
      this.registry.sheets = this.docs.sheets;
      this.registry.tableData = this.docs.tables;
      for (const f of inverseFiles(done)) await runFile(f).catch(() => {});
      throw new Error(`${meta.redoOf ? 'やり直す' : '元に戻す'}と問題が出るので止めました: ${introduced.join(' / ')}`);
    }
    const dirty = new Set<string>([...next.keys()]);
    await this.saveDirty(dirty);
    const tx = this.journal.newId();
    const docs: Record<string, DocState> = {};
    for (const key of next.keys()) docs[key] = { before: docOf(before, key), after: docOf(this.docs, key) };
    await this.journal.append({ id: tx, t: new Date().toISOString(), who: actor.who, kind: actor.kind, win: actor.win, label: meta.label ?? describeTx(changes), docs, files: files.length ? files : undefined, ...meta });
    await appendLog(this.dir, actor, meta.redoOf ? 'redo' : 'undo', changes, tx);
    await markTouched(this.dir, actor, changes);
    return { changes, dirty, files: [] };
  }

  /** 次に「元に戻す」「やり直す」と何が起きるか（エディタのボタンの説明） */
  async undoState(actor: Actor): Promise<{ undo?: { id: string; label: string }; redo?: { id: string; label: string } }> {
    const n = Journal.next(await this.journal.read(), actor.who, actor.kind);
    return { undo: n.undo && { id: n.undo.id, label: n.undo.label }, redo: n.redo && { id: n.redo.id, label: n.redo.label } };
  }

  /**
   * ファイルを取り込む（エディタから）。同じ名前があれば差し替え。元に戻せるように、前の中身と新しい中身の控えを取る
   * ロックされたファイルは差し替えられない（ロックマネージャーで）
   */
  async upload(rel: string, data: Buffer, actor: Actor): Promise<{ replaced: boolean }> {
    const abs = join(this.dir, rel);
    const had = existsSync(abs);
    if (had && !isKeeper(actor) && (await this.effectiveLocks())[`file:${rel}`]) throw new Error(`🔒 ${rel} はロックされたファイルです。差し替えるならロックマネージャーで`);
    const oldTrash = had ? await this.journal.keep(abs, false) : null;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
    const newTrash = await this.journal.keep(abs, false);
    const tx = this.journal.newId();
    const change: Change = { path: `file:${rel}`, to: had ? 'replaced' : 'added' };
    await this.journal.append({ id: tx, t: new Date().toISOString(), who: actor.who, kind: actor.kind, win: actor.win, label: `${rel} を${had ? '差し替え' : '取り込み'}`, docs: {},
      files: [oldTrash ? { kind: 'replace', path: rel, oldTrash, newTrash } : { kind: 'create', path: rel, dir: false, trash: newTrash }] });
    await appendLog(this.dir, actor, 'upload', [change], tx);
    const scan = await scanAssets(this.dir);
    this.assets = scan.assets;
    this.setAssetMaps(scan.assets);
    this.docs.files = new Set(scan.files);
    return { replaced: had };
  }

  /** このプロセスが書いたファイルと内容（エディタが「外部からの編集」と区別するため） */
  written = new Map<string, string>();

  /**
   * ファイルを書きかえる（いったん .ages/tmp に書いてから置きかえる）。
   * 書いている途中で止まっても、別の書き込みと重なっても、半分だけ書かれたファイルを残さない
   */
  private async writeAtomic(path: string, text: string): Promise<void> {
    const dir = join(this.dir, '.ages', 'tmp');
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${process.pid}-${++this.tmpSeq}.tmp`);
    await writeFile(tmp, text);
    try {
      await rename(tmp, path);
    } catch {
      // 置きかえられない場所（別のドライブなど）では、そのまま書く
      await rm(tmp, { force: true });
      await writeFile(path, text);
    }
  }
  private tmpSeq = 0;

  async saveDirty(dirty: Iterable<string>): Promise<void> {
    for (const key of dirty) {
      if (key === 'config') {
        const path = join(this.dir, 'ages.project.json');
        const text = JSON.stringify(this.config, null, 2) + '\n';
        await this.writeAtomic(path, text);
        this.written.set(path, text);
        continue;
      }
      if (key.startsWith('table:')) {
        const name = key.slice('table:'.length);
        const path = join(this.dir, 'data', `${name}.table.json`);
        const t = this.docs.tables.get(name);
        await mkdir(join(this.dir, 'data'), { recursive: true });
        if (!t) { await rm(path, { force: true }); this.written.set(path, ''); continue; }
        const text = formatTable(t);
        await this.writeAtomic(path, text);
        this.written.set(path, text);
        continue;
      }
      if (key.startsWith('sheet:')) {
        const image = key.slice('sheet:'.length);
        const path = join(this.dir, sheetPathOf(image));
        const sheet = this.docs.sheets.get(image);
        if (!sheet) { await rm(path, { force: true }); this.written.set(path, ''); continue; }
        const text = formatSheet(sheet);
        await this.writeAtomic(path, text);
        this.written.set(path, text);
        continue;
      }
      const [kind, name] = key.split(':');
      const path = kind === 'scene' ? this.scenePath(name) : this.prefabPath(name);
      const doc = kind === 'scene' ? this.docs.scenes.get(name) : this.docs.prefabs.get(name);
      if (!doc) { await rm(path, { force: true }); this.written.set(path, ''); continue; }
      const text = formatJson(doc);
      await mkdir(join(this.dir, kind === 'scene' ? 'scenes' : 'prefabs'), { recursive: true });
      await this.writeAtomic(path, text);
      this.written.set(path, text);
    }
  }

  /**
   * 人がエディタのテキストで文書を書き換えた後に呼ぶ。変更点を返す。
   * ロックされた値は、人でもテキストからは変えられない（ロックマネージャーで変える）。変えていたら元に戻す
   */
  async humanTextEdit(actor: Actor): Promise<Change[]> {
    const before = this.docs;
    await this.reload(); // ロックされた値はここで元に戻る（lockReport に出る）
    const changes = diffDocs(before, this.docs);
    const tx = this.journal.newId();
    const docs: Record<string, DocState> = {};
    for (const key of docKeys(before, this.docs)) {
      const a = docOf(before, key), b = docOf(this.docs, key);
      if (!same(a, b)) docs[key] = { before: a, after: b };
    }
    if (Object.keys(docs).length) await this.journal.append({ id: tx, t: new Date().toISOString(), who: actor.who, kind: actor.kind, win: actor.win, label: `テキストで ${describeTx(changes)}`, docs });
    await appendLog(this.dir, actor, 'text', changes, tx);
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

  /** ゲームを作る。doc を渡すと、そのシーン（試しのシーンなど）で始める */
  /** 画面なしで動かすゲーム。日時は date（省くと決まった日時 RUN_DATE。毎回同じ結果になるように） */
  newGame(scene = this.config.startScene, seed = this.config.seed, store?: SaveStore, lang?: string, sceneDoc?: SceneDoc, params?: Record<string, unknown>, date?: DateStart): Game {
    const doc = sceneDoc ?? this.docs.scenes.get(scene);
    if (!doc) throw new Error(`シーン ${scene} はありません${suggest(scene, [...this.docs.scenes.keys()])}`);
    const langs = languagesOf(this.config);
    if (lang && !langs.includes(lang)) throw new Error(`言語 ${lang} はありません${suggest(lang, langs)}（ages.project.json の languages: ${langs.join(', ')}）`);
    return new Game(this.registry, this.config, doc, seed, { store, lang, params, date: date ?? parseDate(RUN_DATE) });
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

const imagesOf = (assets: AssetInfo[]) => new Map(assets.filter((a) => a.w && a.h).map((a) => [a.path, { w: a.w!, h: a.h! }]));
/** プロジェクトのシェーダー（標準のものと合わせる）。場所はアセットの今の場所 */
const shadersOf = (assets: AssetInfo[]) => shaderMap(assets.flatMap((a) => (a.shader ? [{ ...a.shader, path: a.path }] : [])));

/** ロックマネージャー（人だけが使う専用の画面）からの操作か。ロックを付ける・外す・ロックされた値を変えるのは、ここからだけ */
export const isKeeper = (a: Actor) => a.kind === 'human' && a.win === 'lock-manager';

async function fileHash(abs: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(abs)).digest('hex'); } catch { return null; }
}

/** ロックしたファイルの控えの場所（この端末の使用者のフォルダ。Git では共有しない） */
const lockedCopy = (root: string, sha256: string) => join(agesHome(), 'locked-files', createHash('sha1').update(resolve(root)).digest('hex'), sha256);

/** 文書の鍵（"scene:main" など）の中身。無ければ null */
function docOf(d: Docs, key: string): unknown {
  if (key === 'config') return d.config ? structuredClone(d.config) : null;
  const i = key.indexOf(':');
  const kind = key.slice(0, i), name = key.slice(i + 1);
  const v = kind === 'scene' ? d.scenes.get(name) : kind === 'prefab' ? d.prefabs.get(name) : kind === 'table' ? d.tables.get(name) : kind === 'sheet' ? d.sheets.get(name) : undefined;
  return v === undefined ? null : structuredClone(v);
}

function setDoc(d: Docs, key: string, v: unknown): void {
  if (key === 'config') { if (v) d.config = structuredClone(v) as ProjectConfig; return; }
  const i = key.indexOf(':');
  const kind = key.slice(0, i), name = key.slice(i + 1);
  const map = (kind === 'scene' ? d.scenes : kind === 'prefab' ? d.prefabs : kind === 'table' ? d.tables : d.sheets) as Map<string, unknown>;
  if (v === null || v === undefined) map.delete(name); else map.set(name, structuredClone(v));
}

function docKeys(a: Docs, b: Docs): string[] {
  const keys = new Set<string>();
  for (const d of [a, b]) {
    for (const n of d.scenes.keys()) keys.add(`scene:${n}`);
    for (const n of d.prefabs.keys()) keys.add(`prefab:${n}`);
    for (const n of d.tables.keys()) keys.add(`table:${n}`);
    for (const n of d.sheets.keys()) keys.add(`sheet:${n}`);
  }
  return [...keys];
}

/** ぶつかりの知らせに使う、文書の名前 */
function docLabel(key: string): string {
  if (key.startsWith('prefab:')) return '@' + key.slice(7);
  if (key.startsWith('table:')) return '$' + key.slice(6);
  return key;
}

/** シーン・プレハブを消す・名前を変える操作なら、その中の住所の頭（main# / @enemy.）。after なら変えた後の頭（消したなら null） */
function docPrefix(op: Op, after = false): string | null {
  if (op.op === 'removeScene' || op.op === 'renameScene') return after ? (op.op === 'renameScene' ? op.to + '#' : null) : op.name + '#';
  if (op.op === 'removePrefab' || op.op === 'renamePrefab') return after ? (op.op === 'renamePrefab' ? `@${op.to}.` : null) : `@${op.name}.`;
  return null;
}

/** 名前の変更・場所の変更の、逆の操作 */
function inverseOp(op: Op): Op {
  if (op.op === 'renameRow') return { op: 'renameRow', table: op.table, id: op.to, to: op.id };
  if (op.op === 'renameScene') return { op: 'renameScene', name: op.to, to: op.name };
  if (op.op === 'renamePrefab') return { op: 'renamePrefab', name: op.to, to: op.name };
  if (op.op === 'moveAsset') return { op: 'moveAsset', from: op.to, to: op.from };
  throw new Error(`${op.op} の逆の操作はありません`);
}

/** 編集の短い説明（「元に戻す: main#player.Player.speed 4.5→6」のように出る） */
function describeTx(changes: Change[]): string {
  const main = changes.filter((c) => !c.auto);
  const first = main[0] ?? changes[0];
  if (!first) return '編集';
  const v = (x: unknown) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return s && s.length > 24 ? s.slice(0, 21) + '…' : s; };
  const what = typeof first.to === 'string' && /^(added|removed|replaced)$/.test(first.to) ? ({ added: '追加', removed: '削除', replaced: '差し替え' } as Record<string, string>)[first.to]
    : typeof first.to === 'string' && first.to.startsWith('renamed:') ? `→ ${first.to.slice(8)}`
    : first.from !== undefined && typeof first.from !== 'object' && typeof first.to !== 'object' ? `${v(first.from)}→${v(first.to)}` : '変更';
  return `${first.path} ${what}${main.length > 1 ? ` ほか${main.length - 1}件` : ''}`;
}

/** saves/ の保存データのファイルを読む */
async function readSaves(dir: string): Promise<Map<string, { data?: Record<string, unknown>; error?: string }>> {
  const out = new Map<string, { data?: Record<string, unknown>; error?: string }>();
  let names: string[] = [];
  try { names = (await readdir(join(dir, 'saves'))).filter((n) => n.endsWith('.save.json')).sort(); } catch { return out; }
  for (const n of names) {
    const path = `saves/${n}`;
    try {
      const v = JSON.parse(await readFile(join(dir, path), 'utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) out.set(path, { error: '保存データは { キー: 値 } の形です' });
      else out.set(path, { data: v });
    } catch (e) {
      out.set(path, { error: `JSON として読めません（${(e as Error).message}）` });
    }
  }
  return out;
}
