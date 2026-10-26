/**
 * What to read when recording a voice on the Voices page, in the voice's own
 * language.
 *
 * A script is a short first line, a pause, then more speech, because that is
 * the layout the model needs (see lib/voiceReference.ts): the first line is
 * over by about 4 seconds and the model continues from the quiet after it.
 * The first line ends on a soft vowel: a reference whose prompt ended in "छ"
 * or "स्" made generated clips open with an echo of that sound (Oct 2026).
 * The pause is set to length after recording, so the reader only has to stop.
 */

export interface VoiceScript {
  /** About 4 seconds read at a normal pace, ending on a soft vowel. */
  first: string;
  /** About 20 seconds more: the sound of the voice and how it moves. */
  rest: string;
}

export interface ScriptGuide {
  /** How to record, shown above the script. */
  howTo: string;
  /** Shown between the two parts. */
  pause: string;
  /** Shown when the speaker reads their own words instead. */
  ownText: string;
  /** Placeholder for the transcript box. */
  transcriptPlaceholder: string;
  scripts: VoiceScript[];
}

const ENGLISH: ScriptGuide = {
  howTo:
    "Quiet room, your normal speaking voice. Press Record and start speaking straight away. Read the first line, stop for a moment, then read the rest.",
  pause: "Stop for a moment — count “one, two” in your head",
  ownText:
    "Read anything you like for 20–30 seconds, in your normal voice. Finish your first sentence after about 4 seconds and stop for a moment before going on. Type exactly what you read below.",
  transcriptPlaceholder: "Type exactly what is said in the clip.",
  scripts: [
    {
      first: "Thanks for watching, and I'll see you in the next video.",
      rest: "Today, let's learn something simple that keeps your accounts safe. Turn on two-step verification, and never share your password with anyone, not even a friend. Have you ever received a message asking you to click a link right away? Stop for a moment, check who sent it, and only then decide what to do.",
    },
    {
      first: "Hello everyone, and welcome back to the channel.",
      rest: "In this video we'll look at how online scams work, and the easy steps that keep you, your family and your business protected every day. Most scams start with a phone call or a message that sounds urgent. If someone asks for money or a code, call the person back on a number you already know.",
    },
    {
      first: "Let's take a few minutes to learn something new today.",
      rest: "Before we start, make sure your phone and computer are up to date. Updates fix the holes that attackers use, and they only take a minute to install. So why do so many people skip them? Usually because the reminder comes at a bad time. Set them to install overnight, and you will never have to think about it again.",
    },
  ],
};

const NEPALI: ScriptGuide = {
  howTo:
    "शान्त कोठामा, आफ्नो सामान्य बोलीमा पढ्नुहोस्। Record थिच्नासाथ बोल्न सुरु गर्नुहोस्। पहिलो लाइन पढेपछि एकछिन रोक्नुहोस्, अनि बाँकी पढ्नुहोस्।",
  pause: "एकछिन रोक्नुहोस् — मनमनै “एक, दुई” गन्नुहोस्",
  ownText:
    "आफूलाई मन लागेको कुरा २०–३० सेकेन्ड आफ्नो सामान्य बोलीमा पढ्नुहोस्। पहिलो वाक्य करिब ४ सेकेन्डमा सकेर एकछिन रोक्नुहोस्, अनि बाँकी पढ्नुहोस्। तल ठ्याक्कै पढेका शब्दहरू लेख्नुहोस्।",
  transcriptPlaceholder: "क्लिपमा बोलिएका शब्दहरू जस्ताको तस्तै लेख्नुहोस्।",
  scripts: [
    {
      first: "आजको भिडियो यहीँसम्म, अर्को भिडियोमा फेरि भेटौंला।",
      rest: "यो जानकारी तपाईंलाई पक्कै उपयोगी होला। आउनुहोस्, आज केही नयाँ कुरा सँगै सिकौं, र सुरु गर्नुअघि एकपटक यो कुरा राम्ररी बुझौं। के तपाईंलाई कहिल्यै अनौठो फोन वा म्यासेज आएको छ? यदि आएको छ भने, आजको भिडियो तपाईंका लागि नै हो।",
    },
    {
      first: "नमस्ते साथीहरू, आजको विषय तपाईंलाई पक्कै मन पर्ला।",
      rest: "आज हामी अनलाइन सुरक्षाको बारेमा कुरा गर्नेछौं। मोबाइलमा दुई चरणको प्रमाणीकरण अन गर्नुहोस्, र आफ्नो पासवर्ड कसैलाई पनि नभन्नुहोस्। आजकल ठगहरू निकै चलाख भएका छन्, त्यसैले हामी पनि उत्तिकै सचेत हुनुपर्छ।",
    },
    {
      first: "आउनुहोस्, आज केही नयाँ कुरा सँगै सिकौं।",
      rest: "अपरिचित नम्बरबाट आएको लिङ्कमा क्लिक नगर्नुहोस्। शंका लागेमा पहिले परिवार वा साथीलाई सोध्नुहोस्, अनि मात्र कुनै कदम चाल्नुहोस्। सानो सावधानीले ठूलो नोक्सानी जोगाउन सक्छ, होइन र?",
    },
  ],
};

/** The guide for a language. Languages without their own script read their own words. */
export function scriptGuide(language: string): ScriptGuide {
  if (language === "ne") return NEPALI;
  if (language === "en") return ENGLISH;
  return { ...ENGLISH, scripts: [] };
}

/** The transcript for a script, as it is read. */
export function scriptText(s: VoiceScript): string {
  return `${s.first} ${s.rest}`;
}

const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-z]/g;

/**
 * Nepali when a transcript is mostly Devanagari. A voice's language is the
 * default for every request that names none (the script splitter, the
 * language profile), so a Nepali voice saved as English gets English
 * handling; the Add form switches the language when the words say otherwise.
 */
export function looksNepali(text: string): boolean {
  const dev = text.match(DEVANAGARI)?.length ?? 0;
  const lat = text.match(LATIN)?.length ?? 0;
  return dev >= 8 && dev > lat * 2;
}
