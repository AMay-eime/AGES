// シーン・プレハブのデータ形式と、値のアドレス（住所）の扱い。

export interface EntityData {
  id: string;
  name: string;
  /**
   * プレハブのインスタンス（あれば、プレハブとつながる）。components にはプレハブと違う値だけを書き、
   * 使うときにプレハブと重ねる（プレハブを直すと伝わる。core/variant.ts の resolveEntity）
   */
  prefab?: string;
  /** プレハブの子の値を、置いた物ごとに変える（名前で重ねる。値を変えるだけで、足す・消すはしない） */
  children?: PrefabChild[];
  tags?: string[];
  /** インスタンスで、プレハブから外した部品 */
  remove?: string[];
  components: Record<string, Record<string, unknown>>;
}

export interface SceneDoc {
  name: string;
  /** 何のシーンか（1行。地図に出る） */
  desc?: string;
  entities: EntityData[];
}

/**
 * プレハブの子（Unity の子を持つプレハブ）。出すと、親と一緒に出る（ID は 親/名前、位置は親から見た値）。
 * prefab を書くと、そのプレハブを子にして components は変えた値だけ（children もその子の値を変えるだけ）。
 * 書かなければ、components がその子の中身そのもので、children がその子の子
 */
export interface PrefabChild {
  name: string;
  prefab?: string;
  /** prefab の子で、そのプレハブから外した部品 */
  remove?: string[];
  components: Record<string, Record<string, unknown>>;
  children?: PrefabChild[];
}

export interface PrefabDoc {
  name: string;
  /** 子（親と一緒に出る物）。派生では、元の子の値を変えるだけ（名前で重ねる。足す・消すはしない） */
  children?: PrefabChild[];
  /**
   * このプレハブにまつわる表の値（$表.行 か $表.行.列）。エディタでプレハブを選ぶと、ここに並べて直せる。
   * 書くのは AI（使用者に頼まれて足し引きする）。書いていなければ、このプレハブを指す表の行を出す。派生は書いていなければ元のものを使う
   */
  params?: string[];
  /** 派生の元（あれば、元を受け継いで components に書いた値だけを変える。core/variant.ts） */
  base?: string;
  desc?: string;
  tags?: string[];
  /** 派生で、元から外した部品 */
  remove?: string[];
  components: Record<string, Record<string, unknown>>;
}

export interface ProjectConfig {
  name: string;
  fps: number;
  seed: number;
  /**
   * width/height: ゲームの設計の大きさ。filter: 画像の拡大の仕方（nearest=ドット絵向け、linear=なめらか。既定）。
   * fit: 画面の大きさへの合わせ方（contain=全体を入れて余りは帯（既定）/ cover=はみ出しを切る / stretch=伸ばす / expand=広い分だけ周りも見せる / pixel=整数倍だけ）
   */
  view: { width: number; height: number; background: string; filter?: 'nearest' | 'linear'; fit?: import('./camera.ts').FitMode };
  startScene: string;
  game: string;
  editorWindows?: string[];
  /** 追加パッケージ（例 ["3d"]。書いたものだけ読み込む。一覧は ages schema <dir> guide:packages） */
  packages?: string[];
  /** 言語（$text の列。最初が既定の言語）。省くと ['ja']。名前は ja・en・zh_Hans・pt_BR の形 */
  languages?: string[];
  /** セーブ: settings='auto'（既定）なら、キーの割り当て・音量を変えたら自動で保存し、始めるときに戻す。'manual' なら自分で */
  save?: { settings?: 'auto' | 'manual' };
  /** 合わせてある AGES の版（compat＝互換の番号。docs/MIGRATIONS.md）。ages init と ages version --record が書く */
  engine?: { compat: number; version: string; commit?: string; recorded?: string };
}

/**
 * アドレス:
 *   main#player.Mover.speed  … シーン main / エンティティ player / コンポーネント Mover / フィールド speed
 *   @enemy.Mover.speed       … プレハブ enemy
 *   main#spawner.Spawner.waves[2].count … リストの 2 番目（0から）の count（構造体・どれか1つの中は .名前、リストの中は [番号]）
 *   $enemies.basic.hp        … 表 enemies の行 basic の列 hp
 * フィールドやコンポーネントは省略可（main#player, main#player.Mover, $enemies.basic）。
 */
export interface Address {
  kind: 'scene' | 'prefab' | 'table';
  doc: string;
  /** シーンのエンティティID、または表の行のID */
  entity?: string;
  /** コンポーネント（表では使わない） */
  component?: string;
  /** フィールド（表では列） */
  field?: string;
  /** フィールドの中の場所（リストの番号・構造体の項目名） */
  sub: (string | number)[];
  /** プレハブの子（@親/子/孫・シーン#置いた物/子 の 子・孫） */
  child?: string[];
}

const NAME = /^[^.#@$\[\]\s]+/;

/** ".a.b[2].c" を ['a','b',2,'c'] に */
function segments(text: string, whole: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /\.([^.\[\]\s]+)|\[(\d+)\]/y;
  let i = 0;
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new Error(`アドレスが不正です: "${whole}"（"${text.slice(i)}" の所）。リストの中は [番号]、構造体の中は .名前 で書きます。例: main#spawner.Spawner.waves[2].count`);
    out.push(m[1] !== undefined ? m[1] : Number(m[2]));
    i = re.lastIndex;
  }
  return out;
}

export function parseAddress(text: string): Address {
  const s = text.trim();
  const head = (t: string) => {
    const m = t.match(NAME);
    return m ? m[0] : '';
  };
  if (s.startsWith('$')) {
    const doc = head(s.slice(1));
    if (!doc) throw new Error(`アドレスが不正です: "${text}"。例: $enemies.basic.hp（表.行.列）`);
    const seg = segments(s.slice(1 + doc.length), text);
    if (seg.some((x, i) => i < 2 && typeof x === 'number')) throw new Error(`表のアドレスは $表.行.列 の形です: "${text}"`);
    const [entity, field, ...sub] = seg as [string?, string?, ...(string | number)[]];
    return { kind: 'table', doc, entity, field, sub };
  }
  let kind: Address['kind'], doc: string, entity: string | undefined, rest: string;
  if (s.startsWith('@')) {
    kind = 'prefab';
    doc = head(s.slice(1));
    if (!doc) throw new Error(`アドレスが不正です: "${text}"。例: @enemy.Mover.speed`);
    rest = s.slice(1 + doc.length);
    // @親/子/孫.部品.欄（子を持つプレハブ）
    if (doc.includes('/')) {
      const [name, ...child] = doc.split('/');
      if (!name || child.some((c) => !c)) throw new Error(`アドレスが不正です: "${text}"。子は @親/子.部品.欄（孫は @親/子/孫）`);
      const seg = segments(rest, text);
      const [component, field, ...sub] = seg as [string?, string?, ...(string | number)[]];
      return { kind, doc: name, child, component, field, sub };
    }
  } else {
    const hash = s.indexOf('#');
    if (hash <= 0) throw new Error(`アドレスが不正です: "${text}"。例: main#player.Mover.speed（シーン#エンティティ.コンポーネント.フィールド）、@enemy.Mover.speed、$enemies.basic.hp`);
    kind = 'scene';
    doc = s.slice(0, hash);
    entity = head(s.slice(hash + 1));
    if (!entity) throw new Error(`アドレスにエンティティIDがありません: "${text}"`);
    rest = s.slice(hash + 1 + entity.length);
    // シーン#置いた物/子.部品.欄（子を持つプレハブのインスタンスの子）
    if (entity.includes('/')) {
      const [id, ...child] = entity.split('/');
      if (!id || child.some((c) => !c)) throw new Error(`アドレスが不正です: "${text}"。子は main#boss/子.部品.欄`);
      const seg = segments(rest, text);
      const [component, field, ...sub] = seg as [string?, string?, ...(string | number)[]];
      return { kind, doc, entity: id, child, component, field, sub };
    }
  }
  const seg = segments(rest, text);
  if (seg.slice(0, 2).some((x) => typeof x === 'number')) throw new Error(`アドレスが不正です: "${text}"。[番号] はフィールドの後に書きます（例 main#spawner.Spawner.waves[2]）`);
  const [component, field, ...sub] = seg as [string?, string?, ...(string | number)[]];
  return { kind, doc, entity, component, field, sub };
}

export function formatSub(sub: (string | number)[]): string {
  return sub.map((x) => (typeof x === 'number' ? `[${x}]` : `.${x}`)).join('');
}

export function formatAddress(a: Address): string {
  const head = a.kind === 'prefab' ? `@${a.doc}${a.child?.length ? '/' + a.child.join('/') : ''}` : a.kind === 'table' ? `$${a.doc}` : `${a.doc}#${a.entity}${a.child?.length ? '/' + a.child.join('/') : ''}`;
  const mid = a.kind === 'table' ? [a.entity, a.field] : [a.component, a.field];
  return [head, ...mid.filter(Boolean)].join('.') + formatSub(a.sub);
}

/** 入れ子の場所の値を読む（無ければ undefined） */
export function getIn(v: unknown, sub: (string | number)[]): unknown {
  let cur = v;
  for (const seg of sub) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** 入れ子の場所に値を置いた、新しい値を返す（元の値は変えない） */
export function setIn(v: unknown, sub: (string | number)[], value: unknown): unknown {
  if (!sub.length) return value;
  const [seg, ...rest] = sub;
  if (typeof seg === 'number') {
    const arr = Array.isArray(v) ? [...v] : [];
    arr[seg] = setIn(arr[seg], rest, value);
    return arr;
  }
  const obj = v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
  obj[seg] = setIn(obj[seg], rest, value);
  return obj;
}

/** JSONを1行1項目で整形する（Gitの行単位の統合がほぼ値単位になる）。 */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
