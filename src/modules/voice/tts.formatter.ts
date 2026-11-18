import type { SupportedLang } from '../../types/express.d.js';

const UZ_ONES = ['', 'bir', 'ikki', 'uch', "to'rt", 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz"];
const UZ_TENS = [
  '',
  "o'n",
  'yigirma',
  "o'ttiz",
  'qirq',
  'ellik',
  'oltmish',
  'yetmish',
  'sakson',
  "to'qson",
];

const RU_ONES = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const RU_ONES_FEM = [
  '',
  'одна',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
];
const RU_TEENS = [
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
];
const RU_TENS = [
  '',
  '',
  'двадцать',
  'тридцать',
  'сорок',
  'пятьдесят',
  'шестьдесят',
  'семьдесят',
  'восемьдесят',
  'девяносто',
];
const RU_HUNDREDS = [
  '',
  'сто',
  'двести',
  'триста',
  'четыреста',
  'пятьсот',
  'шестьсот',
  'семьсот',
  'восемьсот',
  'девятьсот',
];

function chunkToUz(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h > 0) parts.push(`${UZ_ONES[h]} yuz`);
  if (t > 0) parts.push(UZ_TENS[t]!);
  if (o > 0) parts.push(UZ_ONES[o]!);
  return parts.join(' ').trim();
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function chunkToRu(n: number, feminine = false): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rem = n % 100;
  if (h > 0) parts.push(RU_HUNDREDS[h]!);
  if (rem >= 10 && rem <= 19) {
    parts.push(RU_TEENS[rem - 10]!);
  } else {
    const t = Math.floor(rem / 10);
    const o = rem % 10;
    if (t > 0) parts.push(RU_TENS[t]!);
    if (o > 0) parts.push((feminine ? RU_ONES_FEM : RU_ONES)[o]!);
  }
  return parts.join(' ').trim();
}

export function numberToWords(value: number, lang: SupportedLang): string {
  const abs = Math.trunc(Math.abs(value));
  if (abs === 0) return lang === 'ru' ? 'ноль' : lang === 'en' ? 'zero' : 'nol';
  if (lang === 'en') return String(value);

  const prefix = value < 0 ? (lang === 'ru' ? 'минус ' : 'minus ') : '';
  const billions = Math.floor(abs / 1_000_000_000);
  const millions = Math.floor((abs % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((abs % 1_000_000) / 1_000);
  const rest = abs % 1_000;

  const parts: string[] = [];
  if (lang === 'ru') {
    if (billions) parts.push(`${chunkToRu(billions)} ${ruPlural(billions, 'миллиард', 'миллиарда', 'миллиардов')}`);
    if (millions) parts.push(`${chunkToRu(millions)} ${ruPlural(millions, 'миллион', 'миллиона', 'миллионов')}`);
    if (thousands) parts.push(`${chunkToRu(thousands, true)} ${ruPlural(thousands, 'тысяча', 'тысячи', 'тысяч')}`);
    if (rest) parts.push(chunkToRu(rest));
  } else {
    if (billions) parts.push(`${chunkToUz(billions)} milliard`);
    if (millions) parts.push(`${chunkToUz(millions)} million`);
    if (thousands) parts.push(`${chunkToUz(thousands)} ming`);
    if (rest) parts.push(chunkToUz(rest));
  }

  return (prefix + parts.join(' ')).trim();
}

/**
 * Strips Markdown formatting and expands numbers into spoken words for crisp TTS playback.
 */
export function prepareTtsText(rawText: string, lang: SupportedLang): string {
  let text = rawText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Replace spaced large integers (e.g. "4 200 000") and standalone integers >= 1000
  text = text.replace(/\b(\d{1,3}(?: \d{3})+|\d{4,12})\b/g, (match) => {
    const num = Number(match.replace(/\s+/g, ''));
    if (!Number.isFinite(num) || num > 999_999_999_999) return match;
    return numberToWords(num, lang);
  });

  // Replace percentage sign cleanly
  if (lang === 'ru') {
    text = text.replace(/(\d+(?:[.,]\d+)?)\s*%/g, '$1 процентов');
  } else if (lang === 'uz') {
    text = text.replace(/(\d+(?:[.,]\d+)?)\s*%/g, '$1 foiz');
  }

  return text.replace(/\s+/g, ' ').trim();
}
