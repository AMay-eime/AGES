// シーン・プレハブのデータ形式と、値のアドレス（住所）の扱い。

export interface EntityData {
  id: string;
  name: string;
  tags?: string[];
  components: Record<string, Record<string, unknown>>;
}

export interface SceneDoc {
  name: string;
  entities: EntityData[];
}

export interface PrefabDoc {
  name: string;
  desc?: string;
  tags?: string[];
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
}

/**
 * アドレス:
 *   main#player.Mover.speed  … シーン main / エンティティ player / コンポーネント Mover / フィールド speed
 *   @enemy.Mover.speed       … プレハブ enemy
 * フィールドやコンポーネントは省略可（main#player, main#player.Mover）。
 */
export interface Address {
  kind: 'scene' | 'prefab';
  doc: string;
  entity?: string;
  component?: string;
  field?: string;
}

export function parseAddress(text: string): Address {
  const s = text.trim();
  if (s.startsWith('@')) {
    const [doc, component, field] = s.slice(1).split('.');
    if (!doc) throw new Error(`アドレスが不正です: "${text}"。例: @enemy.Mover.speed`);
    return { kind: 'prefab', doc, component, field };
  }
  const hash = s.indexOf('#');
  if (hash <= 0) throw new Error(`アドレスが不正です: "${text}"。例: main#player.Mover.speed（シーン#エンティティ.コンポーネント.フィールド）または @enemy.Mover.speed`);
  const doc = s.slice(0, hash);
  const [entity, component, field] = s.slice(hash + 1).split('.');
  if (!entity) throw new Error(`アドレスにエンティティIDがありません: "${text}"`);
  return { kind: 'scene', doc, entity, component, field };
}

export function formatAddress(a: Address): string {
  const head = a.kind === 'prefab' ? `@${a.doc}` : `${a.doc}#${a.entity}`;
  return [head, a.component, a.field].filter(Boolean).join('.');
}

/** JSONを1行1項目で整形する（Gitの行単位の統合がほぼ値単位になる）。 */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
