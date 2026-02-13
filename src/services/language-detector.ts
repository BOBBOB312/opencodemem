const LANGUAGE_MAP: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  "zh-tw": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  ru: "Russian",
  ar: "Arabic",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  vi: "Vietnamese",
  id: "Indonesian",
  th: "Thai",
  hi: "Hindi",
  uk: "Ukrainian",
};

export function getLanguageName(code: string): string {
  return LANGUAGE_MAP[code] || "English";
}

export function detectLanguage(text: string): string {
  const chineseRegex = /[\u4e00-\u9fff]/;
  const japaneseRegex = /[\u3040-\u309f\u30a0-\u30ff]/;
  const koreanRegex = /[\uac00-\ud7af]/;
  const arabicRegex = /[\u0600-\u06ff]/;
  const cyrillicRegex = /[\u0400-\u04ff]/;

  if (chineseRegex.test(text)) return "zh";
  if (japaneseRegex.test(text)) return "ja";
  if (koreanRegex.test(text)) return "ko";
  if (arabicRegex.test(text)) return "ar";
  if (cyrillicRegex.test(text)) return "ru";

  return "en";
}
