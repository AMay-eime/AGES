// プレハブの編集画面（仮のシーン @名前。親が $root、子が $root/子）での編集を、プレハブの子の操作に直す。
// 階層の＋・削除・複製（Ctrl+D・Delete）、アセット・プレハブを落として置く、が仮のシーンへの操作として来るので、
// サーバーへ送る前に addChild・removeChild・renameChild へ置き換える（issue #135）
import type { Op } from '../core/patch.ts';
import type { PrefabChild, PrefabDoc, SceneDoc } from '../core/docs.ts';
import { CHILD_NAME, resolvePrefab } from '../core/variant.ts';
import { relativeTo } from '../core/transform.ts';
import { docPose, freshId } from './edit-ops.ts';
import { T } from './i18n.ts';

/** 仮のシーンの親の ID（app.ts の STAGE_ROOT と同じ） */
const ROOT = '$root';

/** 仮のシーンの物の ID → 書くときの住所（@名前 / @名前/子/孫） */
export const stagePath = (name: string, id: string) => (id === ROOT ? `@${name}` : `@${name}/${id.slice(ROOT.length + 1)}`);

/** 仮のシーンの子の ID の、名前の並び（$root/a/b → [a, b]） */
const segs = (id: string) => (id === ROOT ? [] : id.slice(ROOT.length + 1).split('/'));

/**
 * プレハブ（name）が決めている子をたどる。途中か最後が別のプレハブを子にした所なら、inside にそのプレハブの名前
 * （その中の子は、そのプレハブで足し引きする）
 */
export function stageNode(prefabs: Record<string, PrefabDoc>, name: string, id: string): { node?: PrefabChild; list: PrefabChild[]; inside?: string; ref?: string } {
  let list = prefabs[name]?.children ?? [];
  let node: PrefabChild | undefined;
  const path = segs(id);
  for (const [i, seg] of path.entries()) {
    node = list.find((c) => c.name === seg);
    if (!node) return { list: [] };
    if (node.prefab && i < path.length - 1) return { list: [], inside: node.prefab };
    if (i < path.length - 1) list = node.children ?? [];
  }
  return { node, list, ref: node?.prefab };
}

/** 名前を子の名前に使える形に（使えない文字は _） */
const childName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'child';

/** 仮のシーンへの操作を、プレハブの子の操作に直す。できない操作は Error（エディタが知らせる） */
export function stageOps(ops: Op[], name: string, prefabs: Record<string, PrefabDoc>, view: SceneDoc | undefined): Op[] {
  const stage = `@${name}`;
  const removing = new Set(ops.flatMap((o) => (o.op === 'removeEntity' && o.scene === stage ? [o.id] : [])));
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op === 'addEntity' && op.scene === stage) {
      const comps = structuredClone(op.entity.components ?? {});
      const key = comps.Transform3D ? 'Transform3D' : 'Transform';
      const t = comps[key] as Record<string, unknown> | undefined;
      let parent = ROOT;
      if (t && typeof t.parent === 'string') { parent = t.parent; delete t.parent; }
      else if (t && key === 'Transform' && view) {
        // 落とした所（絵の上の位置）を、親（プレハブ本体）から見た位置に
        const pp = docPose(view, ROOT);
        if (pp) { const l = relativeTo(pp, { x: Number(t.x ?? 0), y: Number(t.y ?? 0), rot: 0, sx: 1, sy: 1 }); t.x = Math.round(l.x); t.y = Math.round(l.y); }
      }
      const id = op.entity.id;
      let n = childName(id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id);
      // 兄弟と重なる名前は番号を付ける（enemy → enemy_2）
      const sib = parent === ROOT ? prefabs[name]?.children ?? [] : stageNode(prefabs, name, parent).node?.children ?? [];
      const taken = new Set(sib.map((c) => c.name));
      if (taken.has(n)) n = freshId(n, taken);
      const child: PrefabChild = { name: n, ...(op.entity.prefab ? { prefab: op.entity.prefab } : {}), components: comps };
      out.push({ op: 'addChild', parent: stagePath(name, parent), child });
      continue;
    }
    if (op.op === 'removeEntity' && op.scene === stage) {
      if (op.id === ROOT) throw new Error(T('プレハブ本体（{0}）は、ここでは消せません（アセットの画面で消す）', stage));
      // 親も一緒に消すなら、子は親と一緒に消える
      if ([...removing].some((r) => r !== op.id && op.id.startsWith(r + '/'))) continue;
      out.push({ op: 'removeChild', path: stagePath(name, op.id) });
      continue;
    }
    if (op.op === 'rename' && op.target.startsWith(stage + '/')) {
      out.push({ op: 'renameChild', path: op.target, to: op.name });
      continue;
    }
    // 見るためのカメラ（@名前#$camera）など、仮のシーンにしかない物への操作は送らない
    if ((op as { scene?: string }).scene === stage || JSON.stringify(op).includes(`"${stage}#`)) throw new Error(T('プレハブの編集画面では、この操作はできません（{0}）', op.op));
    out.push(op);
  }
  return out;
}

/** プレハブの編集画面で子を複製する（中の子も一緒に。すぐ後ろに並べ、少しずらす）。作った子の ID も返す */
export function stageDuplicate(prefabs: Record<string, PrefabDoc>, name: string, ids: string[], offset = 16): { ops: Op[]; ids: string[] } {
  const ops: Op[] = [];
  const made: string[] = [];
  const taken = new Map<string, Set<string>>();
  for (const id of ids) {
    if (id === ROOT || ids.some((o) => o !== id && id.startsWith(o + '/'))) continue;
    const at = stageNode(prefabs, name, id);
    if (!at.node) throw new Error(at.inside ? T('{0} の中の子は、@{1} を開いて足し引きする（@{1} を使っている所すべてに出ます）', id.slice(ROOT.length + 1), at.inside) : T('{0} はありません', id));
    const parentId = id.slice(0, id.lastIndexOf('/'));
    const names = taken.get(parentId) ?? new Set(at.list.map((c) => c.name));
    taken.set(parentId, names);
    const copy = structuredClone(at.node);
    copy.name = freshId(at.node.name, names);
    names.add(copy.name);
    const tf = (copy.components.Transform ??= {}) as Record<string, unknown>;
    const pose = stageTransform(prefabs, name, id);
    tf.x = pose.x + offset;
    tf.y = pose.y + offset;
    ops.push({ op: 'addChild', parent: stagePath(name, parentId), child: copy, index: at.list.indexOf(at.node) + 1 + ops.filter((o) => o.op === 'addChild' && o.parent === stagePath(name, parentId)).length });
    made.push(`${parentId}/${copy.name}`);
  }
  return { ops, ids: made };
}

/** 子の位置（親から見た値）。子にしたプレハブの値を変えていなければ、そのプレハブの値 */
function stageTransform(prefabs: Record<string, PrefabDoc>, name: string, id: string): { x: number; y: number } {
  const { node } = stageNode(prefabs, name, id);
  const own = node?.components.Transform as { x?: number; y?: number } | undefined;
  let ref: { x?: number; y?: number } | undefined;
  if (node?.prefab) { try { ref = resolvePrefab(new Map(Object.entries(prefabs)), node.prefab).components.Transform as typeof ref; } catch { /* ないプレハブ */ } }
  return { x: Number(own?.x ?? ref?.x ?? 0), y: Number(own?.y ?? ref?.y ?? 0) };
}

/** 子の名前として使えるか（名前の変更の入力を確かめる） */
export const validChildName = (s: string) => CHILD_NAME.test(s);
