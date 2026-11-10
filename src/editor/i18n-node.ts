// サーバー側（Node）の言葉。エディタから来た依頼の言語（x-ages-lang）で、人に見せる文（Git の失敗の説明など）を訳す
import { EDITOR_LANGS, translate, type Dict, type EditorLang } from './i18n.ts';
import en from './locales/en.ts';
import zhHans from './locales/zh-Hans.ts';
import zhHant from './locales/zh-Hant.ts';
import de from './locales/de.ts';
import fr from './locales/fr.ts';

const DICTS: Record<EditorLang, Dict | undefined> = { ja: undefined, en, 'zh-Hans': zhHans, 'zh-Hant': zhHant, de, fr };

/** 訳す関数（鍵は日本語の元の文。差し込む値は {0} {1}…） */
export type Tr = (key: string, ...args: unknown[]) => string;

/** その言語で訳す関数。知らない言語は日本語のまま */
export function trFor(lang: string | undefined): Tr {
  const l = EDITOR_LANGS.includes(lang as EditorLang) ? (lang as EditorLang) : 'ja';
  const dicts = l === 'ja' ? [] : [DICTS[l], l === 'en' ? undefined : DICTS.en];
  return (key, ...args) => translate(dicts, key, args);
}

/** 訳さない（日本語のまま） */
export const noTr: Tr = (key, ...args) => translate([], key, args);
