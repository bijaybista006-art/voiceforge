/**
 * English words inside Nepali text, written the way Nepali writes them.
 *
 * The Nepali checkpoint reads Devanagari. A Latin word in the middle of a
 * sentence — "मेरो laptop को password" — is outside what it was trained on,
 * and comes out as a gap, a mumble or an invented word.
 *
 * Two fixes were tried before this one and both sounded worse:
 *   - leaving the word alone, which produced the gaps;
 *   - voicing each English word with the English model and splicing it in.
 *     On ordinary tech prose that shatters a sentence into one- and two-word
 *     fragments, and neither model can speak a single word cleanly.
 *
 * So the sentence stays whole and goes through one model once. English words
 * are respelled in Devanagari first — which is simply how Nepali newspapers
 * print them (ल्यापटप, पासवर्ड) — and the model reads a normal Nepali line.
 *
 * Order per word: the caller's lexicon, the built-in one, initials spelled as
 * letters, then a phonetic approximation. The approximation is rough, since
 * English spelling is, but a slightly-off word spoken fluently beats a hole
 * in the sentence. Anything it gets wrong belongs in the lexicon.
 */

/**
 * Trailing halant on purpose: without it the model adds a vowel and says
 * "accounta". Same convention as the backend's fallback lexicon.
 */
export const NEPALI_LOANWORDS: Record<string, string> = {
  // accounts and security
  account: "एकाउन्ट्", accounts: "एकाउन्ट्स्", password: "पासवर्ड्",
  passwords: "पासवर्ड्स्", login: "लगइन्", logout: "लगआउट्", signin: "साइनइन्",
  username: "युजरनेम्", user: "युजर्", users: "युजर्स्", security: "सेक्युरिटी",
  privacy: "प्राइभेसी", verification: "भेरिफिकेसन्", verify: "भेरिफाइ",
  "two-step": "टु-स्टेप्", step: "स्टेप्", code: "कोड्", otp: "ओटीपी",
  hacker: "ह्याकर्", hackers: "ह्याकर्स्", hack: "ह्याक्", scam: "स्क्याम्",
  scammer: "स्क्यामर्", fraud: "फ्रड्", phishing: "फिसिङ्", virus: "भाइरस्",
  antivirus: "एन्टिभाइरस्", malware: "मालवेयर्", backup: "ब्याकअप्",
  strong: "स्ट्रोङ्", weak: "विक्", safe: "सेफ्", secure: "सेक्युर्",
  lock: "लक्", unlock: "अनलक्", block: "ब्लक्", report: "रिपोर्ट्",
  // devices
  laptop: "ल्यापटप्", laptops: "ल्यापटप्स्", phone: "फोन्", mobile: "मोबाइल्",
  computer: "कम्प्युटर्", desktop: "डेस्कटप्", tablet: "ट्याब्लेट्",
  device: "डिभाइस्", devices: "डिभाइसेस्", screen: "स्क्रिन्", keyboard: "किबोर्ड्",
  mouse: "माउस्", printer: "प्रिन्टर्", camera: "क्यामेरा", battery: "ब्याट्री",
  charger: "चार्जर्", router: "राउटर्", server: "सर्भर्", cloud: "क्लाउड्",
  // network
  internet: "इन्टरनेट्", online: "अनलाइन्", offline: "अफलाइन्", "wi-fi": "वाइफाइ",
  wifi: "वाइफाइ", network: "नेटवर्क्", data: "डाटा", address: "एड्रेस्",
  website: "वेबसाइट्", browser: "ब्राउजर्", link: "लिङ्क्", links: "लिङ्क्स्",
  email: "इमेल्", emails: "इमेल्स्", message: "मेसेज्", messages: "मेसेजेस्",
  call: "कल्", video: "भिडियो", videos: "भिडियोज्", audio: "अडियो",
  photo: "फोटो", photos: "फोटोज्", file: "फाइल्", files: "फाइल्स्",
  folder: "फोल्डर्", download: "डाउनलोड्", upload: "अपलोड्", share: "सेयर्",
  // software
  app: "एप्", apps: "एप्स्", software: "सफ्टवेयर्", system: "सिस्टम्",
  settings: "सेटिङ्स्", setting: "सेटिङ्", option: "अप्सन्", options: "अप्सन्स्",
  update: "अपडेट्", updates: "अपडेट्स्", install: "इन्स्टल्", restart: "रिस्टार्ट्",
  reset: "रिसेट्", click: "क्लिक्", tap: "ट्याप्", search: "सर्च्", menu: "मेनु",
  button: "बटन्", profile: "प्रोफाइल्", notification: "नोटिफिकेसन्",
  notifications: "नोटिफिकेसन्स्", feature: "फिचर्", features: "फिचर्स्",
  version: "भर्सन्", license: "लाइसेन्स्", licence: "लाइसेन्स्",
  subscription: "सब्स्क्रिप्सन्", free: "फ्री", premium: "प्रिमियम्",
  on: "अन्", off: "अफ्", check: "चेक्", change: "चेन्ज्", use: "युज्",
  tip: "टिप्", tips: "टिप्स्", trick: "ट्रिक्", tricks: "ट्रिक्स्",
  // brands
  whatsapp: "ह्वाट्सएप्", facebook: "फेसबुक्", tiktok: "टिकटक्", google: "गुगल्",
  youtube: "युट्युब्", viber: "भाइबर्", messenger: "मेसेन्जर्",
  instagram: "इन्स्टाग्राम्", gmail: "जीमेल्", android: "एन्ड्रोइड्",
  iphone: "आइफोन्", windows: "विन्डोज्", microsoft: "माइक्रोसफ्ट्",
  office: "अफिस्", outlook: "आउटलुक्", teams: "टिम्स्", copilot: "कोपाइलट्",
  chatgpt: "च्याटजीपीटी", chrome: "क्रोम्", apple: "एप्पल्", samsung: "सामसुङ्",
  esewa: "इसेवा", khalti: "खल्ती", zoom: "जुम्", excel: "एक्सेल्", word: "वर्ड्",
  // everyday
  thank: "थ्याङ्क्", thanks: "थ्याङ्क्स्", you: "यु", and: "एन्ड्", stay: "स्टे",
  hello: "हेलो", hi: "हाइ", ok: "ओके", okay: "ओके", please: "प्लिज्",
  sorry: "सरी", welcome: "वेलकम्", subscribe: "सब्स्क्राइब्", like: "लाइक्",
  comment: "कमेन्ट्", channel: "च्यानल्", follow: "फलो", team: "टिम्",
  business: "बिजनेस्", customer: "कस्टमर्",
  service: "सर्भिस्", support: "सपोर्ट्", problem: "प्रोब्लम्", solution: "सोलुसन्",
  simple: "सिम्पल्", easy: "इजी", fast: "फास्ट्", slow: "स्लो", new: "न्यु",
  time: "टाइम्", day: "डे", today: "टुडे", great: "ग्रेट्", best: "बेस्ट्",
};

const LETTERS: Record<string, string> = {
  A: "ए", B: "बी", C: "सी", D: "डी", E: "ई", F: "एफ्", G: "जी", H: "एच्",
  I: "आई", J: "जे", K: "के", L: "एल्", M: "एम्", N: "एन्", O: "ओ", P: "पी",
  Q: "क्यु", R: "आर्", S: "एस्", T: "टी", U: "यु", V: "भी", W: "डब्लु",
  X: "एक्स्", Y: "वाई", Z: "जेड्",
};

const HALANT = "्";

type Unit =
  | { kind: "c"; text: string }
  /** `full` starts a word or follows a vowel; `sign` attaches to a consonant. */
  | { kind: "v"; full: string; sign: string };

const C = (text: string): Unit => ({ kind: "c", text });
const V = (full: string, sign: string): Unit => ({ kind: "v", full, sign });

/** Longest match first. A consonant entry may be a cluster already joined. */
const CONSONANTS: Array<[string, string]> = [
  ["tch", "च"], ["sch", "स्क"], ["sh", "श"], ["ch", "च"], ["th", "थ"],
  ["ph", "फ"], ["gh", "ग"], ["wh", "ह्व"], ["ck", "क"], ["qu", "क्व"],
  ["ng", "ङ"], ["b", "ब"], ["c", "क"], ["d", "ड"], ["f", "फ"], ["g", "ग"],
  ["h", "ह"], ["j", "ज"], ["k", "क"], ["l", "ल"], ["m", "म"], ["n", "न"],
  ["p", "प"], ["q", "क"], ["r", "र"], ["s", "स"], ["t", "ट"], ["v", "भ"],
  ["w", "व"], ["x", "क्स"], ["z", "ज"],
];

const VOWELS: Array<[string, Unit]> = [
  ["igh", V("आइ", "ाइ")],
  ["ee", V("ई", "ी")], ["ea", V("ई", "ी")], ["oo", V("ऊ", "ू")],
  ["ou", V("आउ", "ाउ")], ["ow", V("आउ", "ाउ")], ["ai", V("ए", "े")],
  ["ay", V("ए", "े")], ["ei", V("ए", "े")], ["ey", V("ए", "े")],
  ["oa", V("ओ", "ो")], ["au", V("अ", "")], ["aw", V("अ", "")],
  ["oi", V("ओइ", "ोइ")], ["oy", V("ओइ", "ोइ")], ["io", V("इयो", "ियो")],
  ["ia", V("इया", "िया")], ["ie", V("ई", "ी")], ["ue", V("यु", "ु")],
  ["a", V("आ", "ा")], ["e", V("ए", "े")], ["i", V("इ", "ि")],
  ["o", V("ओ", "ो")], ["u", V("अ", "")], ["y", V("ई", "ी")],
];

/** What a single vowel becomes before consonant + silent e ("safe", "like"). */
const LONG_BEFORE_SILENT_E: Record<string, Unit> = {
  a: V("ए", "े"), i: V("आइ", "ाइ"), o: V("ओ", "ो"), u: V("यु", "ु"), e: V("ई", "ी"),
};

const SUFFIXES: Array<[RegExp, Unit[]]> = [
  [/tion$/, [C("स"), V("अ", ""), C("न")]],
  [/sion$/, [C("स"), V("अ", ""), C("न")]],
  [/ture$/, [C("च"), V("अ", ""), C("र")]],
];

const isVowelLetter = (ch: string | undefined) => !!ch && "aeiou".includes(ch);

function toUnits(word: string): Unit[] {
  let w = word.toLowerCase();
  const tail: Unit[] = [];
  for (const [re, units] of SUFFIXES) {
    if (re.test(w) && w.length > 5) {
      w = w.replace(re, "");
      tail.push(...units);
      break;
    }
  }

  // "simple", "people": a closing consonant + "le" is said "al".
  if (!tail.length && w.length > 3 && w.endsWith("le") && !isVowelLetter(w[w.length - 3])) {
    w = w.slice(0, -2);
    tail.push(V("अ", ""), C("ल"));
  }
  // "price", "office": c before a silent e is soft.
  if (!tail.length && w.endsWith("ce")) w = w.slice(0, -2) + "se";

  // consonant + single vowel + consonant + final e: the e is silent and the
  // vowel before it is long.
  let longAt = -1;
  if (!tail.length && w.length >= 3 && w.endsWith("e")) {
    const c = w[w.length - 2];
    const v = w[w.length - 3];
    if (!isVowelLetter(c) && c !== "y" && isVowelLetter(v) && !isVowelLetter(w[w.length - 4])) {
      longAt = w.length - 3;
      w = w.slice(0, -1);
    }
  }

  const out: Unit[] = [];
  let i = 0;
  while (i < w.length) {
    const ch = w[i];
    const next = w[i + 1];

    if (i === longAt) {
      out.push(LONG_BEFORE_SILENT_E[ch]);
      i += 1;
      continue;
    }
    // y is a consonant only when it opens a syllable.
    if (ch === "y" && isVowelLetter(next) && (i === 0 || isVowelLetter(w[i - 1]))) {
      out.push(C("य"));
      i += 1;
      continue;
    }
    // "science": sc before a front vowel is just s.
    if (ch === "s" && next === "c" && "eiy".includes(w[i + 2] ?? "")) {
      out.push(C("स"));
      i += 2;
      continue;
    }
    // Soft c.
    if (ch === "c" && (next === "e" || next === "i" || next === "y")) {
      out.push(C("स"));
      i += 1;
      continue;
    }
    // A final "er" / "or" is said "ar": server, router, doctor.
    if ((ch === "e" || ch === "o") && next === "r" && i + 2 === w.length && i > 0 && !tail.length) {
      out.push(V("अ", ""), C("र"));
      i += 2;
      continue;
    }
    // "ow" closing a word is "o": window, follow.
    if (ch === "o" && next === "w" && i + 2 === w.length && i > 0) {
      out.push(V("ओ", "ो"));
      i += 2;
      continue;
    }

    const vowel = VOWELS.find(([p]) => w.startsWith(p, i));
    if (vowel && (isVowelLetter(ch) || ch === "y")) {
      out.push(vowel[1]);
      i += vowel[0].length;
      continue;
    }
    const cons = CONSONANTS.find(([p]) => w.startsWith(p, i));
    if (cons) {
      out.push(C(cons[1]));
      i += cons[0].length;
      // A doubled letter is one sound.
      if (cons[0].length === 1 && w[i] === cons[0]) i += 1;
      continue;
    }
    i += 1; // apostrophes and anything else unpronounceable
  }
  return [...out, ...tail];
}

function render(units: Unit[]): string {
  let s = "";
  units.forEach((u, idx) => {
    const prev = units[idx - 1];
    if (u.kind === "v") {
      s += prev?.kind === "c" ? u.sign : u.full;
      return;
    }
    if (prev?.kind === "c") s += HALANT;
    s += u.text;
  });
  if (units[units.length - 1]?.kind === "c") s += HALANT;
  return s;
}

/** A rough Devanagari spelling of an English word nothing else knew. */
export function approximateInDevanagari(word: string): string {
  return render(toUnits(word));
}

const ACRONYM = /^[A-Z]{2,6}s?$/;

function respell(word: string, lexicon: Record<string, string>): string {
  const known = lexicon[word.toLowerCase()];
  if (known) return known;

  if (ACRONYM.test(word)) {
    const plural = word.endsWith("s");
    const letters = plural ? word.slice(0, -1) : word;
    return [...letters].map((c) => LETTERS[c] ?? c).join(" ") + (plural ? "स्" : "");
  }

  // "M365", "Web3": letters and digits are said separately; the backend
  // turns the digits into Nepali number words.
  if (/\d/.test(word)) {
    return word
      .split(/(\d+)/)
      .filter(Boolean)
      .map((part) =>
        /^\d+$/.test(part)
          ? part
          : /^[A-Z]+$/.test(part)
            ? [...part].map((c) => LETTERS[c] ?? c).join(" ")
            : respell(part, lexicon)
      )
      .join(" ");
  }

  if (word.includes("-")) {
    return word
      .split("-")
      .filter(Boolean)
      .map((part) => respell(part, lexicon))
      .join("-");
  }

  return approximateInDevanagari(word) || word;
}

/**
 * Respell every Latin word in `text` in Devanagari.
 *
 * Text with no Devanagari at all is returned untouched: that is an English
 * line, and it is the caller's job to send it to a model that reads English.
 */
export function transliterateForNepali(
  text: string,
  lexicon?: Record<string, string> | null
): string {
  if (!/[ऀ-ॿ]/.test(text) || !/[A-Za-z]/.test(text)) return text;
  const lex: Record<string, string> = { ...NEPALI_LOANWORDS };
  for (const [k, v] of Object.entries(lexicon ?? {})) {
    if (typeof v === "string" && v) lex[k.toLowerCase()] = v;
  }
  return text.replace(/[A-Za-z][A-Za-z0-9'-]*/g, (word) => respell(word.replace(/'s$/, ""), lex));
}
