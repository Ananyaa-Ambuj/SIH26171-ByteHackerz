// Format-preserving fake values for PII found in the page (semantic_mock), and the vault mapping them back.
// The side panel owns the only instance: every text sent to the server (the fakes drawn into the image,
// element names, the task, the history) goes through maskText/getFakeValue, and fakes the model types are
// swapped back to the real values with unmaskText right before execution, so real values stay on-device.
// Also injected into pages ahead of content.js for the shared PATTERNS: evaluating it twice in the same
// world must not throw, hence no top-level class/let/const declarations.
globalThis.PIIMasker ??= class PIIMasker {
  // Exact-text patterns in priority order: longer numbers first, so a card number is never claimed as an
  // Aadhaar number, nor an Aadhaar number as a phone number
  static PATTERNS = {
    card: /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/g,
    aadhaar: /\d{4}[\s-]?\d{4}[\s-]?\d{4}/g,
    phone: /[6-9]\d{4}[\s-]?\d{5}/g,
    pan: /[A-Z]{5}\d{4}[A-Z]/g,
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  };

  // Clearly synthetic and unable to collide with real values. n is a fixed-width 4-digit counter, so no
  // fake is a prefix of another.
  static FORMATS = {
    aadhaar: (n) => `00000000${n}`,         // 12 digits; real Aadhaar numbers never start with 0
    card: (n) => `411111111111${n}`,        // 16 digits in the Visa test-card range 4111 1111 1111 ....
    phone: (n) => `900000${n}`,             // 10 digits starting 6-9
    pan: (n) => `ZZZZZ${n}Z`,               // AAAAA9999A; Z is not a valid PAN holder-type letter
    email: (n) => `user_${n}@example.com`,  // example.com is reserved for documentation (RFC 2606)
    password: (n) => `SECRET_${n}`,         // drawn as dots; the token only lets unmaskText restore it
    name: (n) => `User_${n}`,
    address: (n) => `${n} Sample St`,
    text: (n) => `[MOCKED_${n}]`,
  };

  static NUMERIC = new Set(['aadhaar', 'card', 'phone']);

  static escape(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // "aadhaar, phone" -> "aadhaar": joined types list the highest-priority match first
  static primaryType(type) {
    return String(type || 'text').split(',')[0].trim().toLowerCase();
  }

  constructor() {
    this.vault = new Map();        // type + normalised real value -> canonical fake
    this.reverseVault = new Map(); // fake as shown (plus digits-only for numbers) -> real value
    this.counters = {};
  }

  // The same real value always gets the same fake within a run; numbers keep the original's separators
  // ("9876 5432 1098" -> "0000 0000 0001", "9876543210" -> "9000000001")
  getFakeValue(realValue, type = 'text') {
    type = PIIMasker.primaryType(type);
    const real = String(realValue);
    const digits = real.replace(/\D/g, '');
    const numeric = PIIMasker.NUMERIC.has(type);
    const key = `${type}:${numeric ? digits : real}`;

    let canonical = this.vault.get(key);
    if (!canonical) {
      const count = (this.counters[type] || 0) + 1;
      // Fail closed rather than let the fixed-width numbering overflow into colliding fakes
      if (count > 9999) throw new Error(`Too many distinct ${type} values to mask in one run`);
      this.counters[type] = count;
      canonical = (PIIMasker.FORMATS[type] || PIIMasker.FORMATS.text)(String(count).padStart(4, '0'));
      this.vault.set(key, canonical);
    }

    let i = 0;
    const fake = numeric && digits.length === canonical.length ? real.replace(/\d/g, () => canonical[i++]) : canonical;
    this.reverseVault.set(fake, real);
    if (fake !== canonical) this.reverseVault.set(canonical, digits);
    return fake;
  }

  // Outgoing text: {{...}}-marked secrets (formats no pattern can recognise, like passwords), values already
  // in the vault, and newly detected PII all become fakes. Fakes already present are kept as they are, and
  // overlapping matches are resolved by priority, so nothing is faked twice or split between two types.
  maskText(text) {
    const src = String(text ?? '');
    const claims = [];
    const claim = (start, end, replace) => {
      if (end > start && !claims.some(([s, e]) => start < e && s < end)) claims.push([start, end, replace]);
    };
    const find = (regex, onMatch) => {
      for (const m of src.matchAll(regex)) onMatch(m);
    };

    find(/\{\{([^{}]+)\}\}/g, (m) => {
      const secret = m[1].trim();
      if (secret) claim(m.index, m.index + m[0].length, () => this.getFakeValue(secret, 'password'));
    });
    for (const [fake, real] of [...this.reverseVault].sort((a, b) => b[1].length - a[1].length)) {
      if (real) find(new RegExp(PIIMasker.escape(real), 'g'), (m) => claim(m.index, m.index + real.length, () => fake));
    }
    for (const fake of this.reverseVault.keys()) {
      find(new RegExp(PIIMasker.escape(fake), 'g'), (m) => claim(m.index, m.index + fake.length, () => fake));
    }
    for (const [type, regex] of Object.entries(PIIMasker.PATTERNS)) {
      find(regex, (m) => claim(m.index, m.index + m[0].length, () => this.getFakeValue(m[0], type)));
    }

    claims.sort((a, b) => a[0] - b[0]);
    let out = '';
    let pos = 0;
    for (const [start, end, replace] of claims) {
      out += src.slice(pos, start) + replace();
      pos = end;
    }
    return out + src.slice(pos);
  }

  // Incoming text (what the model wants typed): swap each whole fake back to its real value. Whole means not
  // part of a longer word; one pass, so a restored value is never rewritten again.
  unmaskText(text) {
    const src = String(text ?? '');
    if (this.reverseVault.size === 0) return src;
    const alternatives = [...this.reverseVault.keys()]
      .sort((a, b) => b.length - a.length)
      .map(PIIMasker.escape)
      .join('|');
    return src.replace(new RegExp(`(?<!\\w)(?:${alternatives})(?!\\w)`, 'g'), (fake) => this.reverseVault.get(fake));
  }
};

// Export for Node-based tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.PIIMasker;
}
