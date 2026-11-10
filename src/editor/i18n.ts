// エディタの言葉（日本語・英語・中国語の簡体字と繁体字・ドイツ語・フランス語）。
// 元の文（日本語）をそのまま鍵にする: T('保存') / T('{0}件の変更', n)（小文字の t はあちこちで変数の名前に使っているので、大文字）。訳は locales/<言語>.ts（ないものは英語、それもなければ日本語のまま）。
// 言語は、設定で選んだもの（localStorage の ages.editorLang）か、ブラウザの言語。変えたら読み込み直す（文は作るときに訳すので）

export const EDITOR_LANGS = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'de', 'fr'] as const;
export type EditorLang = (typeof EDITOR_LANGS)[number];
/** 言語の名前（その言語で） */
export const LANG_NAMES: Record<EditorLang, string> = { ja: '日本語', en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', de: 'Deutsch', fr: 'Français' };
export type Dict = Record<string, string>;
const KEY = 'ages.editorLang';

/** ブラウザの言語の名前（ja-JP・zh-TW など）から、エディタの言語を選ぶ。知らない言語は英語 */
export function pickLang(prefs: readonly string[]): EditorLang {
  for (const p of prefs) {
    const l = p.toLowerCase();
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh-Hans';
    if (l.startsWith('de')) return 'de';
    if (l.startsWith('fr')) return 'fr';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

/** 鍵（日本語の元の文）を訳し、{0} {1}… に値を差し込む */
export function translate(dicts: (Dict | undefined)[], key: string, args: unknown[]): string {
  let s = key;
  for (const d of dicts) {
    const v = d?.[key];
    if (v !== undefined) { s = v; break; }
  }
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s;
}

function storedLang(): EditorLang | null {
  try {
    // ?lang=…（エディタからロックマネージャーを開くとき。別のオリジンなので localStorage は別）か、設定で選んだもの
    const v = (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lang') : null) ?? globalThis.localStorage?.getItem(KEY);
    return EDITOR_LANGS.includes(v as EditorLang) ? (v as EditorLang) : null;
  } catch {
    return null;
  }
}

/** 今の言語（ブラウザでないとき・Node では日本語） */
export const lang: EditorLang = storedLang() ?? (typeof navigator !== 'undefined' ? pickLang(navigator.languages ?? [navigator.language]) : 'ja');

/** 言語を変える（読み込み直して、すべての文を訳し直す） */
export function setLang(l: EditorLang): void {
  try { localStorage.setItem(KEY, l); } catch { /* 覚えられなくても今回は変える */ }
  location.reload();
}

const load = async (l: EditorLang): Promise<Dict | undefined> => (l === 'ja' ? undefined : (await import(`./locales/${l}.ts`)).default as Dict);
// 文は作るときに訳すので、先に読んでおく（このファイルを読み込む所は、訳が読み終わるまで待つ）
const dicts: (Dict | undefined)[] = typeof window === 'undefined' || lang === 'ja' ? [] : [await load(lang), lang === 'en' ? undefined : await load('en')];
if (typeof document !== 'undefined') document.documentElement.lang = lang;

/** 訳す（鍵は日本語の元の文。差し込む値は {0} {1}…） */
export function T(key: string, ...args: unknown[]): string {
  return translate(dicts, key, args);
}

/** 説明を訳す（本体の標準の部品・表・シェーダーの説明。訳がなければそのまま: ゲームのプロジェクトが書いた説明はプロジェクトの言葉のまま） */
export function TD(text: string | undefined): string {
  if (!text) return '';
  for (const d of dicts) { const v = d?.[text]; if (v !== undefined) return v; }
  return text;
}
