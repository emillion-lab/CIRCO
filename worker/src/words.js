// Rude-word check for cIRCo. One place to tune it.
// Every entry is written plainly; skeleton() turns both the list and the message
// into the same Latin form, so "путка", "putka", "pu7ka" and "п.у.т.к.а" all match.
// level 1 = rude: the sender is asked "send anyway?" and a sent message counts as a strike.
// level 2 = slur: never sent, counts as a strike.

const CYR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "", ю: "iu", я: "ia", ѝ: "i", ё: "e", ы: "i", э: "e" };

// Bulgarian chat spelling (4 = ч, 6 = ш, w = в, q = я) and leetspeak
function letters(word) {
  return String(word).toLowerCase()
    .replace(/[а-яёѝыэ]/g, c => CYR[c] ?? c)
    .replace(/4/g, "ch").replace(/6/g, "sh").replace(/zh/g, "j")
    .replace(/w/g, "v").replace(/x/g, "h").replace(/q/g, "ia").replace(/y/g, "i")
    .replace(/0/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/@/g, "a").replace(/\$/g, "s").replace(/7/g, "t")
    .replace(/[^a-z]/g, "");
}
export const skeleton = word => letters(word).replace(/(.)\1+/g, "$1");

const sk = list => list.map(skeleton);

// Bulgarian verb family е*а: only at the start of a word, after a real prefix
const EB_PREFIXES = ["", "za", "na", "iz", "raz", "do", "pro", "pre", "po", "ot", "pod", "nad", "pri"];
const EB = sk(["еба", "ебе", "еби", "ебл", "ебн", "ебу", "ебц", "ебч"]);

// word starts with
const START = sk([
  "путк", "пичк", "курв", "шибан", "шибай", "шибал", "шибах", "шибня", "лайно", "лайна", "лайнар", "хуйн", "хуйов",
  "насра", "насран", "усра", "усран", "копеле", "тъпанар", "малоумн", "дебил", "кретен", "бляд",
  "fuck", "fuk", "fck", "bitch", "cunt", "asshole", "wanker", "bollock", "dickhead", "motherf", "cocksuck", "whore", "slut", "jackass"
]);
// whole word only (they collide with ordinary words when used as stems)
const EXACT = new Set(sk([
  "кур", "курът", "курове", "курче", "курчо", "хуй", "хуя", "хуят", "хуйове", "бля", "сука",
  "shit", "shits", "shitty", "shithead", "bullshit", "shitting", "prick", "twat", "dick", "dicks"
]));
// anywhere inside a word, also across spaced-out letters
const ANY = sk(["fuck", "putk", "pichk", "kurv", "cunt", "motherfuck"]);
// never sent. Matched without collapsing double letters, so "Niger" and "Nigeria" stay clean.
const SEVERE_START = ["nigger", "nigga", "faggot", "tranny"].map(letters);
const SEVERE_EXACT = new Set(["fag", "fags", "kike", "kikes", "spic", "spics"].map(letters));
// false friends: eBay, Ebenezer
const ALLOW = new Set(sk(["ebay", "ebenezer"]));

function levelOf(token) {
  const raw = letters(token), s = raw.replace(/(.)\1+/g, "$1");
  if (!s || ALLOW.has(s)) return 0;
  if (SEVERE_EXACT.has(raw) || SEVERE_START.some(p => raw.startsWith(p))) return 2;
  if (EXACT.has(s) || START.some(p => s.startsWith(p)) || ANY.some(p => s.includes(p))) return 1;
  if (EB_PREFIXES.some(p => s.startsWith(p) && EB.some(e => s.startsWith(p + e)))) return 1;
  return 0;
}

export function checkText(text) {
  const parts = String(text || "").split(/\s+/).filter(Boolean);
  // glue spaced-out letters back together: "f u c k", "е б а"
  const tokens = [];
  let run = "";
  for (const p of parts) {
    if (letters(p).length === 1) { run += p; continue; }
    if (run) { tokens.push(run); run = ""; }
    tokens.push(p);
  }
  if (run) tokens.push(run);
  let level = 0;
  const words = [];
  for (const tk of tokens) {
    const l = levelOf(tk);
    if (!l) continue;
    level = Math.max(level, l);
    words.push(tk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || tk);
  }
  // two-word phrases
  const flat = tokens.map(skeleton).join(" ");
  if (!level && /(^| )mamka ti( |$)/.test(flat)) { level = 1; words.push("мамка ти"); }
  return { level, words: [...new Set(words)].slice(0, 5) };
}
