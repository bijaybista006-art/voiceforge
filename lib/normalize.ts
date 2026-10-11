/**
 * Text normalization — runs before chunking. Turns written-form text into
 * speakable text so bad pronunciation is caught before burning GPU time.
 *
 * Pipeline: strip markdown → ASCII punctuation → expand currency / percent /
 * units / ordinals / numbers → expand abbreviations → collapse whitespace.
 */

// ---------------------------------------------------------------------------
// number → words
// ---------------------------------------------------------------------------

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety",
];
const SCALES: Array<[number, string]> = [
  [1_000_000_000_000, "trillion"],
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
];

function twoDigitsToWords(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const rest = n % 10;
  return rest ? `${tens}-${ONES[rest]}` : tens;
}

function threeDigitsToWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return twoDigitsToWords(rest);
  if (!rest) return `${ONES[hundreds]} hundred`;
  return `${ONES[hundreds]} hundred ${twoDigitsToWords(rest)}`;
}

/** Integer → English words. Handles 0 up to the trillions. */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `negative ${numberToWords(-n)}`;
  n = Math.floor(n);
  if (n < 1000) return threeDigitsToWords(n);
  const parts: string[] = [];
  for (const [value, name] of SCALES) {
    if (n >= value) {
      parts.push(`${threeDigitsToWords(Math.floor(n / value))} ${name}`);
      n %= value;
    }
  }
  if (n > 0) parts.push(threeDigitsToWords(n));
  return parts.join(" ");
}

/** 4-digit year → spoken form. 2026 → "twenty twenty-six", 1905 → "nineteen oh five". */
export function yearToWords(n: number): string {
  const high = Math.floor(n / 100);
  const low = n % 100;
  if (low === 0) {
    return high === 20 ? "two thousand" : `${twoDigitsToWords(high)} hundred`;
  }
  if (high === 20 && low < 10) return `two thousand ${ONES[low]}`;
  if (low < 10) return `${twoDigitsToWords(high)} oh ${ONES[low]}`;
  return `${twoDigitsToWords(high)} ${twoDigitsToWords(low)}`;
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth",
  eight: "eighth", nine: "ninth", twelve: "twelfth",
};

/** Integer → ordinal words. 21 → "twenty-first". */
export function ordinalToWords(n: number): string {
  const words = numberToWords(n);
  const parts = words.split(/([\s-])/); // keep separators
  const last = parts[parts.length - 1];
  if (ORDINAL_IRREGULAR[last]) {
    parts[parts.length - 1] = ORDINAL_IRREGULAR[last];
  } else if (last.endsWith("y")) {
    parts[parts.length - 1] = `${last.slice(0, -1)}ieth`;
  } else {
    parts[parts.length - 1] = `${last}th`;
  }
  return parts.join("");
}

function decimalToWords(intPart: string, fracPart: string): string {
  return `${numberToWords(Number(intPart))} point ${[...fracPart]
    .map((d) => ONES[Number(d)])
    .join(" ")}`;
}

// ---------------------------------------------------------------------------
// markdown stripping
// ---------------------------------------------------------------------------

export function stripMarkdown(input: string): string {
  let s = input;
  // code fences: drop the fence lines, keep the content
  s = s.replace(/^```[^\n]*$/gm, "");
  // images: keep alt text
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // links: keep the text, drop the URL
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // bare URLs read terribly — drop them
  s = s.replace(/https?:\/\/\S+/g, "");
  // headings
  s = s.replace(/^#{1,6}\s+/gm, "");
  // blockquotes
  s = s.replace(/^>\s?/gm, "");
  // bold / italic (paired markers only)
  s = s.replace(/(\*\*\*|___)(.+?)\1/g, "$2");
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/(^|\s)_([^_\n]+)_(?=\s|[.,;:!?]|$)/g, "$1$2");
  // inline code
  s = s.replace(/`([^`\n]*)`/g, "$1");
  // horizontal rules (--- is a chunk-break marker handled by the chunker,
  // which strips it before normalization; catch the other forms here)
  s = s.replace(/^[ \t]*(\*{3,}|_{3,})[ \t]*$/gm, "");
  // unordered list markers — keep the text
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  // table pipes
  s = s.replace(/^\|/gm, "").replace(/\|$/gm, "").replace(/\|/g, ", ");
  return s;
}

// ---------------------------------------------------------------------------
// punctuation → ASCII
// ---------------------------------------------------------------------------

export function asciiPunctuation(input: string): string {
  return input
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/…/g, "...")
    .replace(/[—―]/g, " - ") // em dash
    .replace(/–/g, " - ") // en dash
    .replace(/ /g, " ");
}

// ---------------------------------------------------------------------------
// numbers, currency, units
// ---------------------------------------------------------------------------

const UNIT_NAMES: Record<string, [string, string]> = {
  // [singular, plural]
  TB: ["terabyte", "terabytes"],
  GB: ["gigabyte", "gigabytes"],
  MB: ["megabyte", "megabytes"],
  KB: ["kilobyte", "kilobytes"],
  kb: ["kilobit", "kilobits"],
  GHz: ["gigahertz", "gigahertz"],
  MHz: ["megahertz", "megahertz"],
  kHz: ["kilohertz", "kilohertz"],
  Hz: ["hertz", "hertz"],
  km: ["kilometer", "kilometers"],
  cm: ["centimeter", "centimeters"],
  mm: ["millimeter", "millimeters"],
  kg: ["kilogram", "kilograms"],
  mg: ["milligram", "milligrams"],
  ml: ["milliliter", "milliliters"],
  ms: ["millisecond", "milliseconds"],
  mph: ["mile per hour", "miles per hour"],
  fps: ["frame per second", "frames per second"],
  wpm: ["word per minute", "words per minute"],
};

function numericToWords(numStr: string): string {
  const clean = numStr.replace(/,/g, "");
  if (clean.includes(".")) {
    const [i, f] = clean.split(".");
    return decimalToWords(i || "0", f);
  }
  return numberToWords(Number(clean));
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

export function expandNumbers(input: string): string {
  let s = input;

  // currency: $5 → five dollars, $5.50 → five dollars and fifty cents
  s = s.replace(new RegExp(String.raw`\$(${NUM})(?:\s*(million|billion|trillion|[kKmMbB]))?\b`, "g"),
    (_m, num: string, suffix?: string) => {
      const clean = num.replace(/,/g, "");
      if (suffix) {
        const scale =
          suffix === "million" || suffix === "billion" || suffix === "trillion"
            ? suffix
            : { k: "thousand", K: "thousand", m: "million", M: "million", b: "billion", B: "billion" }[suffix];
        return `${numericToWords(clean)} ${scale} dollars`;
      }
      if (clean.includes(".")) {
        const [d, c] = clean.split(".");
        const dollars = Number(d);
        const cents = Number((c + "0").slice(0, 2));
        const dw = `${numberToWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
        if (!cents) return dw;
        return `${dw} and ${numberToWords(cents)} ${cents === 1 ? "cent" : "cents"}`;
      }
      const dollars = Number(clean);
      return `${numberToWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
    });

  // percent: 3.5% → three point five percent
  s = s.replace(new RegExp(String.raw`(${NUM})\s*%`, "g"),
    (_m, num: string) => `${numericToWords(num)} percent`);

  // units: 15GB → fifteen gigabytes (case-sensitive unit match)
  const unitAlt = Object.keys(UNIT_NAMES)
    .sort((a, b) => b.length - a.length)
    .join("|");
  s = s.replace(new RegExp(String.raw`\b(${NUM})\s*(${unitAlt})\b`, "g"),
    (m, num: string, unit: string) => {
      const names = UNIT_NAMES[unit];
      if (!names) return m;
      const value = Number(num.replace(/,/g, ""));
      return `${numericToWords(num)} ${value === 1 ? names[0] : names[1]}`;
    });

  // ordinals: 21st → twenty-first
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/g, (_m, num: string) =>
    ordinalToWords(Number(num)));

  // times: 3:30 → three thirty, 3:05 → three oh five
  s = s.replace(/\b(\d{1,2}):([0-5]\d)\b/g, (_m, h: string, mm: string) => {
    const hour = numberToWords(Number(h));
    const mins = Number(mm);
    if (mins === 0) return `${hour} o'clock`;
    if (mins < 10) return `${hour} oh ${ONES[mins]}`;
    return `${hour} ${twoDigitsToWords(mins)}`;
  });

  // standalone 4-digit years (1100–2999): 2026 → twenty twenty-six
  s = s.replace(/\b(1[1-9]\d{2}|2\d{3})\b/g, (m, num: string) => {
    const n = Number(num);
    return n <= 2999 ? yearToWords(n) : m;
  });

  // remaining numbers, with or without thousands separators and decimals
  s = s.replace(new RegExp(String.raw`(?<!\w)(${NUM})(?!\w)`, "g"),
    (_m, num: string) => numericToWords(num));

  return s;
}

// ---------------------------------------------------------------------------
// abbreviations
// ---------------------------------------------------------------------------

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\betc\.(?=\s|$)/gi, "et cetera."],
  [/\betc\.,/gi, "et cetera,"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bDr\.(?=\s+[A-Z])/g, "Doctor"],
  [/\bMr\.(?=\s+[A-Z])/g, "Mister"],
  [/\bMrs\.(?=\s+[A-Z])/g, "Missus"],
  [/\bProf\.(?=\s+[A-Z])/g, "Professor"],
  [/\bJr\.(?=\s|,|$)/g, "Junior"],
  [/\bSr\.(?=\s|,|$)/g, "Senior"],
  [/\bapprox\.(?=\s)/gi, "approximately"],
  [/\bNo\.(?=\s*\d)/g, "number"],
  [/&/g, " and "],
];

export function expandAbbreviations(input: string): string {
  let s = input;
  for (const [re, replacement] of ABBREVIATIONS) {
    s = s.replace(re, replacement);
  }
  return s;
}

// ---------------------------------------------------------------------------
// spoken forms: acronyms and product numbers
// ---------------------------------------------------------------------------

/**
 * The multilingual model lowercases its input, so "AI" reaches it as "ai" and
 * "IT" as "it" — ordinary words, read as words. The capitals that marked them
 * as initials are gone before the model sees them, which is why no amount of
 * prompt wording upstream fixes it. The only reliable form is the letter
 * names written out.
 *
 * Deliberately a short list of initialisms that turn into a real word or a
 * mumble when lowercased. Ones the model already spells (CPU, USB, PDF) are
 * left alone, and so is anything that is said as a word (NASA, RAM).
 */
const LETTER_NAMES: Record<string, string> = {
  A: "ay", B: "bee", C: "see", D: "dee", E: "ee", F: "eff", G: "jee",
  H: "aitch", I: "eye", J: "jay", K: "kay", L: "el", M: "em", N: "en",
  O: "oh", P: "pee", Q: "cue", R: "ar", S: "ess", T: "tee", U: "you",
  V: "vee", W: "double-you", X: "ex", Y: "why", Z: "zee",
};

const SPELLED_INITIALISMS = ["AI", "IT", "IP", "UI", "UX", "OS"];

function spellLetters(letters: string): string {
  return [...letters].map((c) => LETTER_NAMES[c] ?? c).join(" ");
}

/** A word, and how it should be written for the model to say it right. */
export type Pronunciations = Record<string, string>;

/**
 * Words the model reads wrongly as written, respelled as ordinary English.
 *
 * "Copilot" reaches the model as "copilot" and comes out "cop-i-lot"; the
 * dictionary spelling "co-pilot" is read correctly. Keys are lowercase and
 * match in any case. Anything set in Admin → Settings overrides these.
 */
const BUILT_IN_PRONUNCIATIONS: Pronunciations = {
  copilot: "co-pilot",
  copilots: "co-pilots",
  autopilot: "auto-pilot",
  intune: "in-tune",
  ios: "eye oh ess",
  macos: "mac oh ess",
  ipados: "eye-pad oh ess",
};

export const MAX_PRONUNCIATIONS = 200;

/**
 * Read the "word = spoken form" list from Admin → Settings.
 *
 * One entry per line. Lines without "=" and entries with an empty side are
 * skipped, never an error — a half-typed line must not block saving.
 */
export function parsePronunciations(text: string): Pronunciations {
  const out: Pronunciations = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const word = line.slice(0, at).trim().slice(0, 40);
    const spoken = line.slice(at + 1).trim().slice(0, 80);
    if (!word || !spoken) continue;
    if (Object.keys(out).length >= MAX_PRONUNCIATIONS) break;
    out[word] = spoken;
  }
  return out;
}

export function formatPronunciations(map: Pronunciations | undefined): string {
  return Object.entries(map ?? {})
    .map(([word, spoken]) => `${word} = ${spoken}`)
    .join("\n");
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * "SharePoint" -> "Share Point".
 *
 * The model lowercases its input, so the capital that marked the second word
 * is gone and "sharepoint", "onedrive" or "powershell" arrive as one unknown
 * word. Splitting at the capital hands it two words it knows. Only a
 * lowercase letter followed by a capitalised syllable splits, so ordinary
 * words, ALL-CAPS and "iOS" are untouched, and "Mc" names are left alone.
 */
function splitCamelCase(word: string): string {
  if (!/[a-z][A-Z][a-z]/.test(word) || /^Mc[A-Z]/.test(word)) return word;
  return word.replace(/([a-z])(?=[A-Z][a-z])/g, "$1 ");
}

export function expandSpokenForms(input: string, custom: Pronunciations = {}): string {
  let s = input;

  // Respelled words are parked as private-use markers until the end, so the
  // rules below cannot re-read a spoken form as something else to expand.
  const held: string[] = [];
  const hold = (spoken: string) => {
    held.push(spoken);
    return `${held.length - 1}`;
  };

  // The user's list wins over the built-in one. A key written in capitals
  // ("IT") only matches in capitals, because the lowercase word is usually a
  // different word; anything else matches in any case.
  const entries = new Map<string, { key: string; spoken: string; exact: boolean }>();
  for (const [key, spoken] of Object.entries(BUILT_IN_PRONUNCIATIONS)) {
    entries.set(key, { key, spoken, exact: false });
  }
  for (const [rawKey, spoken] of Object.entries(custom)) {
    const key = rawKey.trim();
    if (!key || !spoken) continue;
    const exact = key === key.toUpperCase() && /[A-Z]/.test(key);
    entries.set(exact ? key : key.toLowerCase(), { key, spoken, exact });
  }
  const ordered = [...entries.values()].sort((a, b) => b.key.length - a.key.length);
  for (const { key, spoken, exact } of ordered) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(key)}(?![\\p{L}\\p{N}])`,
      exact ? "gu" : "giu"
    );
    s = s.replace(re, () => hold(spoken));
  }

  // "365" in a product name is said "three sixty-five", never "three hundred
  // sixty-five". Runs before number expansion, which would get there first.
  s = s.replace(/(Microsoft|Office|Dynamics|Outlook|)(\s+)365\b/g, "$1$2three sixty-five");
  s = s.replace(/\b([MO])365\b/g, (_m, letter: string) => `${LETTER_NAMES[letter]} three sixty-five`);

  // Dotted forms first ("A.I."), so the plain rule below never sees the dots.
  s = s.replace(/\b([A-Z])\.([A-Z])\.(?=\s|[,;:!?)]|$)/g, (_m, a: string, b: string) => spellLetters(a + b));

  // Case-sensitive on purpose: "it" and "os" are words, "IT" and "OS" are not.
  s = s.replace(new RegExp(String.raw`\b(${SPELLED_INITIALISMS.join("|")})(?=s\b|'s\b|\b)`, "g"),
    (_m, letters: string) => spellLetters(letters));

  s = s.replace(/[A-Za-z]+/g, splitCamelCase);

  return s.replace(/(\d+)/g, (_m, i: string) => held[Number(i)] ?? "");
}

// ---------------------------------------------------------------------------
// full pipeline
// ---------------------------------------------------------------------------

/**
 * Normalize one paragraph of script text into speakable form.
 * Terminal punctuation is enforced per-chunk by the chunker, not here.
 *
 * Number and abbreviation expansion produce ENGLISH words, so they only run
 * for English — for other languages (e.g. Hindi) digits are left for the
 * model to read in-language.
 */
/** Tone/pause directions for expressive narration — kept only on request. */
const PROSODY_TAG = /\[\s*(calm|excited|serious|pause)\s*\]/gi;

export interface NormalizeOptions {
  /**
   * Keep [calm] / [excited] / [serious] / [pause] for the backend instead of
   * stripping the brackets (which would leave the word to be spoken).
   */
  keepProsodyTags?: boolean;
  /** Extra "word -> spoken form" pairs from Admin → Settings. English only. */
  pronunciations?: Pronunciations;
}

export function normalizeText(
  input: string,
  language = "en",
  opts: NormalizeOptions = {}
): string {
  // Park the tags as private-use characters that every step below ignores,
  // then put them back at the end.
  let s = opts.keepProsodyTags
    ? input.replace(PROSODY_TAG, (_m, tag: string) => `\uE000${tag.toLowerCase()}\uE001`)
    : input;
  s = stripMarkdown(s);
  s = asciiPunctuation(s);
  if (language.startsWith("en")) {
    s = expandSpokenForms(s, opts.pronunciations); // before numbers so "M365" keeps its own reading
    s = expandAbbreviations(s); // before numbers so "No. 5" → "number 5" → words
    s = expandNumbers(s);
  }
  // strip characters neither model pronounces
  s = s.replace(/[#*_`~<>{}[\]|\\^]/g, " ");
  // collapse whitespace
  s = s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  if (opts.keepProsodyTags) s = s.replace(/\uE000([a-z]+)\uE001/g, "[$1]");
  return s;
}
