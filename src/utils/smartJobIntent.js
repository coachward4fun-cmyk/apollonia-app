// Pure helpers backing the AI assistant's "smart create job" shortcut.
//
// Input phrasing examples:
//   "New roofing job for Shamrock this Thursday"
//   "Create an electrical job for Sam tomorrow"
//   "Add gutters job for Mary on friday"
//
// These functions are intentionally side-effect-free so they can be tested in
// isolation and reused outside the AI panel if needed.

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_PATTERN = `(?:today|tomorrow|(?:next|this)\\s+(?:${DAY_NAMES.join('|')})|${DAY_NAMES.join('|')})`;

export function parseSmartJobIntent(text) {
  if (!text) return null;
  // Trigger phrase: "new/create/add/start" + optional article + optional "new" +
  // optional 1-2 word type (e.g. "roofing", "home renovation") + literal "job".
  const intentMatch = text.match(/^\s*(?:new|create|add|start)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?(?:([a-z][\w-]*(?:\s+[a-z][\w-]*)?)\s+)?job\b(.*)$/i);
  if (!intentMatch) return null;
  let typeRaw = (intentMatch[1] || '').trim();
  const rest  = intentMatch[2] || '';

  // Strip a leading article that slipped past the early modifier
  // (e.g. "create an electrical job" → "electrical" not "an electrical").
  typeRaw = typeRaw.replace(/^(?:a|an|the)\s+/i, '').trim();

  // Discard a type capture that is really just a leftover modifier
  // (e.g. "create a new job" should not parse type="new").
  const typeHint = /^(new|a|an|another|the)$/i.test(typeRaw) ? null : (typeRaw || null);

  // Customer: "for X" up until the day phrase or end of string
  let customer = null;
  const forMatch = rest.match(new RegExp(`\\bfor\\s+(.+?)(?=\\s+(?:on|this\\s+|next\\s+|${DAY_NAMES.join('|')}|today|tomorrow)\\b|\\s*[.!?]?\\s*$)`, 'i'));
  if (forMatch) customer = forMatch[1].trim().replace(/[.,!?]+$/, '');

  // Day hint: today / tomorrow / "this <day>" / "next <day>" / bare <day>
  let dayHint = null;
  const dayMatch = rest.match(new RegExp(`\\b(${DAY_PATTERN})\\b`, 'i'));
  if (dayMatch) dayHint = dayMatch[1].toLowerCase().replace(/\s+/g, ' ');

  return { typeHint, customer, dayHint };
}

export function matchJobType(hint, jobTypes) {
  if (!hint) return null;
  const h = hint.toLowerCase().trim();
  const names = (jobTypes || [])
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean);
  const exact      = names.find((n) => n.toLowerCase() === h);
  if (exact) return exact;
  const startsWith = names.find((n) => n.toLowerCase().startsWith(h));
  if (startsWith) return startsWith;
  const contains   = names.find((n) => n.toLowerCase().includes(h) || h.includes(n.toLowerCase()));
  return contains || null;
}

export function resolveDayHint(hint, today = new Date()) {
  if (!hint) return null;
  const h = hint.toLowerCase().trim();
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);

  const fmt = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  if (h === 'today')    return fmt(d);
  if (h === 'tomorrow') { d.setDate(d.getDate() + 1); return fmt(d); }

  const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  let target;
  let forceNextWeek = false;
  if (h.startsWith('next ')) {
    forceNextWeek = true;
    target = dayMap[h.slice(5).trim()];
  } else if (h.startsWith('this ')) {
    target = dayMap[h.slice(5).trim()];
  } else {
    target = dayMap[h];
  }
  if (target === undefined) return null;

  const cur = d.getDay();
  let add = (target - cur + 7) % 7;
  if (add === 0) add = 7;                   // saying a day-name on that same day means the upcoming one
  if (forceNextWeek && add < 7) add += 7;
  d.setDate(d.getDate() + add);
  return fmt(d);
}

// Returns CONFIDENT matches only — caller must present the picker (with
// suggestCustomers) when this returns nothing or more than one.
export function matchCustomers(query, customers) {
  if (!query) return [];
  const q = query.toLowerCase().trim();
  const active = customers.filter((c) => !c.archived && c.name);

  // Tier 1: exact (case-insensitive)
  const exact = active.filter((c) => c.name.toLowerCase() === q);
  if (exact.length) return exact;

  // Tier 2: customer name starts with the full query
  const startsWith = active.filter((c) => c.name.toLowerCase().startsWith(q));
  if (startsWith.length) return startsWith;

  // Tier 3: every query token appears as a standalone name token (or a prefix
  // of one). Strict by design — the loose bidirectional substring match this
  // replaced was wrongly equating "Shamrock Construction" with anything that
  // had "construction" in the name.
  const qTokens = q.split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return [];
  const allTokensPresent = active.filter((c) => {
    const nameTokens = c.name.toLowerCase().split(/\s+/);
    return qTokens.every((t) =>
      nameTokens.some((nt) => nt === t || nt.startsWith(t))
    );
  });
  return allTokensPresent;
}

// Return the top N closest customer names by single-token-overlap score.
// Used ONLY for "did you mean?" suggestions when matchCustomers finds nothing
// confident — never as an automatic pick.
export function suggestCustomers(query, customers, limit = 3) {
  if (!query) return [];
  const q = query.toLowerCase().trim();
  const qTokens = q.split(/\s+/).filter(Boolean);
  if (!qTokens.length) return [];

  const active = customers.filter((c) => !c.archived && c.name);
  const scored = active.map((c) => {
    const nameTokens = c.name.toLowerCase().split(/\s+/);
    let score = 0;
    for (const t of qTokens) {
      if (nameTokens.some((nt) => nt === t || nt.startsWith(t) || t.startsWith(nt))) score++;
    }
    return { customer: c, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((x) => x.customer);
}

export function pickMostRecent(customers) {
  return [...customers].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
}

export function formatDateLabel(ymd) {
  if (!ymd) return '';
  const d = new Date(ymd + 'T00:00:00');
  if (isNaN(d)) return ymd;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}
