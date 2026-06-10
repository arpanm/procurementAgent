/**
 * Multilingual prompt strings for the conversation layer (PROCURE_COPILOT_PLAN.md Epic 1
 * "multilingual prompts", target user: kirana/HoReCa owners using Hindi/Bengali/English mixed
 * register). Kept framework-free so both the UI and any voice read-back can share them.
 */

/** Languages the conversation UI offers prompts in. */
export type Lang = "en" | "hi" | "bn";

export const SUPPORTED_LANGS: readonly Lang[] = ["en", "hi", "bn"] as const;

/** The set of UI strings each language must provide. */
export interface ChatStrings {
  readonly title: string;
  /** Short brand tagline shown under the app name in the header. */
  readonly tagline: string;
  /** Example one-liners shown as tappable hints in the empty/hero state. */
  readonly heroExamples: readonly string[];
  readonly inputPlaceholder: string;
  readonly send: string;
  readonly micStart: string;
  readonly micStop: string;
  readonly listening: string;
  readonly parsedHeading: string;
  readonly emptyState: string;
  readonly noItemsFound: string;
  readonly lowConfidence: string;
  readonly qtyLabel: string;
  readonly unitLabel: string;
  readonly brandLabel: string;
  readonly variantLabel: string;
  readonly packSizeLabel: string;
  /** Short hint shown on optional refinement inputs, e.g. "optional". */
  readonly optionalHint: string;
  readonly remove: string;
  readonly addItem: string;
  readonly confirm: string;
  readonly parsing: string;
  readonly errorParsing: string;
}

const en: ChatStrings = {
  title: "Procure Copilot",
  tagline: "Save ₹ on every order",
  heroExamples: ["10kg onions, 5kg paneer", "2 carton refined oil", "20kg atta, 5kg sugar"],
  inputPlaceholder: "Type or speak your order",
  send: "Send",
  micStart: "Hold to speak",
  micStop: "Stop",
  listening: "Listening…",
  parsedHeading: "Your order",
  emptyState: "Say or type your order to get started.",
  noItemsFound: "We couldn't pick out any items. Try rephrasing your order.",
  lowConfidence: "We're not fully sure we got this right — please check and edit.",
  qtyLabel: "Qty",
  unitLabel: "Unit",
  brandLabel: "Brand",
  variantLabel: "Variant",
  packSizeLabel: "Pack size",
  optionalHint: "optional",
  remove: "Remove",
  addItem: "Add item",
  confirm: "Confirm order",
  parsing: "Understanding your order…",
  errorParsing: "Something went wrong reading your order. Please try again.",
};

const hi: ChatStrings = {
  title: "प्रोक्योर कोपायलट",
  tagline: "हर ऑर्डर पर ₹ बचाएँ",
  heroExamples: ["10 किलो प्याज़, 5 किलो पनीर", "2 कार्टन रिफाइंड तेल", "20 किलो आटा, 5 किलो चीनी"],
  inputPlaceholder: "अपना ऑर्डर लिखें या बोलें",
  send: "भेजें",
  micStart: "बोलने के लिए दबाएँ",
  micStop: "रोकें",
  listening: "सुन रहे हैं…",
  parsedHeading: "आपका ऑर्डर",
  emptyState: "शुरू करने के लिए अपना ऑर्डर बोलें या लिखें।",
  noItemsFound: "हम कोई आइटम नहीं समझ पाए। कृपया दोबारा कहें।",
  lowConfidence: "हमें पूरा भरोसा नहीं है कि हमने सही समझा — कृपया जाँचें और बदलें।",
  qtyLabel: "मात्रा",
  unitLabel: "इकाई",
  brandLabel: "ब्रांड",
  variantLabel: "किस्म",
  packSizeLabel: "पैक साइज़",
  optionalHint: "वैकल्पिक",
  remove: "हटाएँ",
  addItem: "आइटम जोड़ें",
  confirm: "ऑर्डर पक्का करें",
  parsing: "आपका ऑर्डर समझ रहे हैं…",
  errorParsing: "आपका ऑर्डर पढ़ने में दिक्कत हुई। कृपया फिर कोशिश करें।",
};

const bn: ChatStrings = {
  title: "প্রোকিওর কোপাইলট",
  tagline: "প্রতি অর্ডারে ₹ বাঁচান",
  heroExamples: ["১০ কেজি পেঁয়াজ, ৫ কেজি পনির", "২ কার্টন রিফাইন্ড তেল", "২০ কেজি আটা, ৫ কেজি চিনি"],
  inputPlaceholder: "আপনার অর্ডার লিখুন বা বলুন",
  send: "পাঠান",
  micStart: "বলতে চাপ দিন",
  micStop: "থামান",
  listening: "শুনছি…",
  parsedHeading: "আপনার অর্ডার",
  emptyState: "শুরু করতে আপনার অর্ডার বলুন বা লিখুন।",
  noItemsFound: "আমরা কোনো আইটেম বুঝতে পারিনি। অনুগ্রহ করে আবার বলুন।",
  lowConfidence: "আমরা পুরোপুরি নিশ্চিত নই যে ঠিক বুঝেছি — অনুগ্রহ করে দেখে নিন ও সম্পাদনা করুন।",
  qtyLabel: "পরিমাণ",
  unitLabel: "একক",
  brandLabel: "ব্র্যান্ড",
  variantLabel: "ধরন",
  packSizeLabel: "প্যাক সাইজ",
  optionalHint: "ঐচ্ছিক",
  remove: "সরান",
  addItem: "আইটেম যোগ করুন",
  confirm: "অর্ডার নিশ্চিত করুন",
  parsing: "আপনার অর্ডার বোঝা হচ্ছে…",
  errorParsing: "আপনার অর্ডার পড়তে সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।",
};

const STRINGS: Record<Lang, ChatStrings> = { en, hi, bn };

/** Maps a BCP-47-ish locale (e.g. "hi-IN") to a supported UI language, defaulting to English. */
export function langFromLocale(locale?: string): Lang {
  if (!locale) {
    return "en";
  }
  const primary = locale.toLowerCase().split("-")[0];
  return (SUPPORTED_LANGS as readonly string[]).includes(primary) ? (primary as Lang) : "en";
}

/** Returns the string bundle for a language. */
export function getStrings(lang: Lang): ChatStrings {
  return STRINGS[lang];
}
