/**
 * Sentences to read for training clips, per language.
 *
 * Written for this channel's real content — IT tips, security, everyday tech
 * — and weighted toward what the model gets wrong today: English loanwords
 * in Nepali (login, message, inbox, app, Wi-Fi), product names in English,
 * numbers, questions, and sentence endings. Plain, natural spelling: the
 * clip teaches how each word sounds, so the text must be the words exactly
 * as said.
 *
 * Ids are stable; recorded clips remember which prompt they read, so the
 * page can move on to the next one not yet recorded. Append new sentences at
 * the end rather than renumbering.
 */

import type { TrainingLanguage } from "./trainingChecks";

export interface TrainingPrompt {
  id: string;
  text: string;
}

const NE = [
  "नमस्ते साथीहरू, आजको भिडियोमा स्वागत छ।",
  "आज हामी अनलाइन सुरक्षाको बारेमा कुरा गर्नेछौं।",
  "आफ्नो पासवर्ड कसैलाई पनि नभन्नुहोस्।",
  "अपरिचित नम्बरबाट आएको लिङ्कमा क्लिक नगर्नुहोस्।",
  "आफ्नो इमेल इनबक्स नियमित रूपमा जाँच गर्नुहोस्।",
  "यो म्यासेज ध्यान दिएर पढ्नुहोस्, यो नक्कली हुन सक्छ।",
  "लगइन गर्नुअघि वेबसाइटको ठेगाना राम्ररी हेर्नुहोस्।",
  "मोबाइलमा दुई चरणको प्रमाणीकरण अन गर्नुहोस्।",
  "तपाईंको फोनमा अनावश्यक एपहरू छन् भने हटाउनुहोस्।",
  "वाइफाइ राउटरको पासवर्ड बेलाबेलामा परिवर्तन गर्नुहोस्।",
  "बच्चाको फोन अभिभावकले समय-समयमा जाँच गर्नुपर्छ।",
  "कुनै पनि अपरिचित व्यक्तिलाई पैसा नपठाउनुहोस्।",
  "बैंकले कहिल्यै फोनमा तपाईंको पिन नम्बर माग्दैन।",
  "यदि शंका लागेमा सिधै बैंकमा फोन गर्नुहोस्।",
  "कम्प्युटर र मोबाइल सधैं अपडेट राख्नुहोस्।",
  "पुरानो सफ्टवेयरमा धेरै सुरक्षा कमजोरी हुन्छन्।",
  "आफ्नो फोटो र फाइलको ब्याकअप हप्तामा एक पटक लिनुहोस्।",
  "सार्वजनिक वाइफाइमा बैंकिङ कारोबार नगर्नुहोस्।",
  "सामाजिक सञ्जालमा आफ्नो ठेगाना सार्वजनिक नगर्नुहोस्।",
  "नक्कली प्रोफाइलबाट आएको साथी अनुरोध स्वीकार नगर्नुहोस्।",
  "एपभित्रबाट मात्र क्वाइन किन्नुहोस्।",
  "आर्टिफिसियल इन्टेलिजेन्सले हाम्रो काम गर्ने तरिका बदल्दैछ।",
  "माइक्रोसफ्ट टिम्समा मिटिङ सुरु गर्न यो बटन थिच्नुहोस्।",
  "यो विकल्प खोल्न पहिले सेटिङ्स मेनुमा जानुहोस्।",
  "तपाईंलाई यो जानकारी उपयोगी लाग्यो भने लाइक गर्नुहोस्।",
  "थप यस्तै भिडियोका लागि हाम्रो च्यानल सब्सक्राइब गर्नुहोस्।",
  "आफ्नो प्रश्न कमेन्टमा लेख्नुहोस्, हामी जवाफ दिनेछौं।",
  "धन्यवाद, अर्को भिडियोमा भेटौंला।",
  "के तपाईंले आफ्नो पासवर्ड कहिल्यै परिवर्तन गर्नुभएको छ?",
  "के यो इमेल साँच्चै तपाईंको बैंकबाट आएको हो?",
  "यो समस्या किन हुन्छ, थाहा छ?",
  "पहिलो चरणमा, आफ्नो खातामा लगइन गर्नुहोस्।",
  "दोस्रो चरणमा, सुरक्षा विकल्प खोल्नुहोस्।",
  "तेस्रो चरणमा, परिवर्तन सेभ गर्नुहोस्।",
  "यो काम गर्न करिब पाँच मिनेट लाग्छ।",
  "हरेक दिन यस्ता ठगीका नयाँ तरिका देखिन्छन्।",
  "एक, दुई, तीन, चार, पाँच, छ, सात, आठ, नौ, दस।",
  "ओटीपी कोड छ अङ्कको हुन्छ, त्यसलाई कसैसँग साझा नगर्नुहोस्।",
  "आज बिहान मौसम निकै राम्रो थियो।",
  "काठमाडौंमा आज हल्का वर्षा हुने सम्भावना छ।",
  "हामी सबै मिलेर काम गर्यौं भने सफलता अवश्य मिल्छ।",
  "नयाँ कुरा सिक्न कहिल्यै ढिलो हुँदैन।",
  "यो एप डाउनलोड गर्नुअघि यसको रिभ्यु पढ्नुहोस्।",
  "फोनमा आउने हरेक नोटिफिकेसनमा विश्वास नगर्नुहोस्।",
  "ह्वाट्सएपमा आएको अनौठो लिङ्क नखोल्नुहोस्।",
  "फेसबुक खाता सुरक्षित राख्न बलियो पासवर्ड प्रयोग गर्नुहोस्।",
  "बलियो पासवर्डमा अक्षर, अङ्क र चिह्न हुनुपर्छ।",
  "एउटै पासवर्ड धेरै ठाउँमा प्रयोग नगर्नुहोस्।",
  "पासवर्ड म्यानेजरले तपाईंका सबै पासवर्ड सुरक्षित राख्छ।",
  "ल्यापटप छोडेर जाँदा स्क्रिन लक गर्न नबिर्सनुहोस्।",
  "अफिसको कम्प्युटरमा व्यक्तिगत फाइल नराख्नुहोस्।",
  "ग्राहकको जानकारी गोप्य राख्नु हाम्रो जिम्मेवारी हो।",
  "यदि तपाईंको खाता ह्याक भयो भने तुरुन्त पासवर्ड बदल्नुहोस्।",
  "त्यसपछि आफ्ना साथीहरूलाई पनि जानकारी दिनुहोस्।",
  "सानो सावधानीले ठूलो नोक्सानबाट बचाउन सक्छ।",
  "आजको टिप एकदमै सजिलो छ।",
  "यो भिडियो अन्त्यसम्म हेर्नुहोस्।",
  "तपाईंको इन्टरनेट किन ढिलो छ, आज हामी पत्ता लगाउँछौं।",
  "राउटरलाई घरको बीचमा राख्दा सिग्नल राम्रो आउँछ।",
  "पुराना इमेलहरू मेटाएर इनबक्स सफा राख्नुहोस्।",
  "क्लाउड स्टोरेजमा फाइल राख्दा पनि सावधानी चाहिन्छ।",
  "कसैले उपहार जितेको भन्दै म्यासेज पठायो भने विश्वास नगर्नुहोस्।",
  "सरकारी कार्यालयले कहिल्यै शुल्क तिर्न लिङ्क पठाउँदैन।",
  "आमाबुबालाई पनि यी कुरा सिकाउनुहोस्।",
  "प्रविधि सजिलो छ, बस अलिकति अभ्यास चाहिन्छ।",
  "आज हामीले तीन महत्त्वपूर्ण कुरा सिक्यौं।",
  "पहिलो, पासवर्ड बलियो बनाउनुहोस्।",
  "दोस्रो, सफ्टवेयर अपडेट राख्नुहोस्।",
  "तेस्रो, अपरिचित लिङ्कमा क्लिक नगर्नुहोस्।",
  "यदि यो भिडियो मन पर्यो भने साथीहरूसँग सेयर गर्नुहोस्।",
  "मेरो नाम बिजय हो, म आईटी क्षेत्रमा काम गर्छु।",
  "हामी हरेक हप्ता नयाँ प्रविधि सम्बन्धी जानकारी ल्याउँछौं।",
  "यो कुरा सुन्दा अचम्म लाग्न सक्छ, तर साँचो हो।",
  "ध्यान दिनुहोस्, यो चरण छुटाउनु हुँदैन।",
  "अब स्क्रिनको दायाँ कुनामा रहेको आइकन थिच्नुहोस्।",
  "केही सेकेन्ड पर्खनुहोस्, प्रक्रिया पूरा हुँदैछ।",
  "बधाई छ, तपाईंको खाता अब सुरक्षित छ।",
  "के तपाईं तयार हुनुहुन्छ? सुरु गरौं।",
  "अर्को भिडियोमा फेरि भेटौंला, नमस्ते।",
];

const EN = [
  "Hi, I'm Bijay from IT Gateway, and today we're fixing a common problem.",
  "Turn on multi-factor authentication before you do anything else.",
  "Most phishing emails look urgent, so slow down and check the sender.",
  "Never share the six digit code that arrives by text message.",
  "Your Wi-Fi router probably still uses the default admin password.",
  "Microsoft 365 has a security setting most people never open.",
  "Copilot can summarise a long email thread in a few seconds.",
  "AI tools are useful, but don't paste confidential data into them.",
  "Open the Intune admin centre and select Devices.",
  "Conditional Access lets you block sign-ins from risky locations.",
  "Keep Windows and your apps updated, every single month.",
  "Back up your photos to two different places.",
  "A password manager remembers every password so you don't have to.",
  "If a deal looks too good to be true, it usually is.",
  "Check the web address carefully before you log in.",
  "Ransomware can lock every file on your network overnight.",
  "Here's the quick fix, and it takes less than two minutes.",
  "First, open Settings. Second, tap Privacy. Third, switch it off.",
  "Did you know your browser saves passwords in plain sight?",
  "Would you spot the fake? Look closely at the logo.",
  "Comment yes if you've seen this scam before.",
  "Thanks for watching, and I'll see you in the next one.",
  "Follow IT Gateway for more practical tech tips.",
  "The quick brown fox jumps over the lazy dog near the riverbank.",
  "She sells seashells by the seashore every summer morning.",
  "Please call Stella and ask her to bring these things from the store.",
  "The rain in Sydney fell softly on the empty streets.",
  "Six thick thistle sticks were stacked beside the shed.",
  "We measured the results on Tuesday, Wednesday and Thursday.",
  "The meeting starts at nine thirty, so please join a few minutes early.",
  "Your account has been locked after five failed attempts.",
  "Is this message really from your bank, or is it a scam?",
  "Why does your laptop slow down after lunch?",
  "Let's walk through it step by step.",
  "Right-click the file and choose Properties.",
  "Press Control, Alt and Delete at the same time.",
  "The firewall blocked the connection, which is exactly what we wanted.",
  "CrowdStrike flagged the file as suspicious and quarantined it.",
  "ThreatLocker only lets approved applications run.",
  "Exchange Online uses SPF, DKIM and DMARC to stop spoofing.",
  "Entra ID is the new name for Azure Active Directory.",
  "PowerShell can automate that task in a single line.",
  "UniFi access points are easy to manage from one dashboard.",
  "Remember, security is a habit, not a one-time task.",
  "It's not you, it's the default setting.",
  "Stop clicking remind me later on Windows updates.",
  "The printer is offline again, and nobody knows why.",
  "Restart the router, wait thirty seconds, then try again.",
  "If something feels wrong, trust that feeling and check first.",
  "Every small business is a target, no matter how small.",
  "Your supplier didn't send this invoice. Someone else did.",
  "Hover over the link to see where it really goes.",
  "A strong password is long, unique and hard to guess.",
  "Passkeys are replacing passwords on many popular sites.",
  "Don't use the same password for email and banking.",
  "Teams notifications can be muted for an hour or a whole day.",
  "OneDrive keeps old versions of your files for thirty days.",
  "SharePoint permissions decide who can see each document.",
  "That's it for today. Stay safe online.",
];

function numbered(lang: string, list: string[]): TrainingPrompt[] {
  return list.map((text, i) => ({ id: `${lang}-${String(i + 1).padStart(3, "0")}`, text }));
}

export const TRAINING_PROMPTS: Record<TrainingLanguage, TrainingPrompt[]> = {
  ne: numbered("ne", NE),
  en: numbered("en", EN),
};

/** The first prompt not yet recorded, starting after `after` when given. */
export function nextPrompt(
  language: TrainingLanguage,
  recorded: Set<string>,
  after?: string
): TrainingPrompt | null {
  const list = TRAINING_PROMPTS[language];
  const start = after ? list.findIndex((p) => p.id === after) + 1 : 0;
  for (let k = 0; k < list.length; k++) {
    const p = list[(start + k) % list.length];
    if (!recorded.has(p.id) && p.id !== after) return p;
  }
  return null;
}
