// Format-preserving fake values (placeholders) for PII, and the vault mapping them back to the real values.
// The side panel owns the only instance and keeps it in memory only: every text sent to the server goes
// through maskText/getFakeValue, and a fake the model types is resolved back to its real value only where
// that value belongs (resolve), right before execution. Real values stay on the device.
// Needs validators.js loaded first. Evaluating this file twice in the same world must not throw, hence no
// top-level class/let/const declarations.
globalThis.PIIMasker ??= class PIIMasker {
  // Clearly synthetic and unable to collide with real values. n is a fixed-width 4-digit counter, so no
  // fake is a prefix of another.
  static FORMATS = {
    aadhaar: (n) => `00000000${n}`,         // 12 digits; real Aadhaar numbers never start with 0
    card: (n) => `411111111111${n}`,        // 16 digits in the Visa test-card range 4111 1111 1111 ....
    phone: (n) => `900000${n}`,             // 10 digits starting 6-9
    pan: (n) => `ZZZZZ${n}Z`,               // AAAAA9999A; Z is not a valid PAN holder-type letter
    email: (n) => `user_${n}@example.com`,  // example.com is reserved for documentation (RFC 2606)
    upi: (n) => `user_${n}@fakebank`,       // VPA shape; "fakebank" is not a UPI handle
    ifsc: (n) => `ZZZZ000${n}`,             // AAAA0XXXXXX; ZZZZ is not a bank code
    otp: (n) => `OTP_${n}`,                 // never drawn (OTPs are black-boxed); keeps OTPs out of the task text
    name: (n) => `Test User ${n}`,
    password: (n) => `SECRET_${n}`,         // {{...}}-marked secrets in the task
    text: (n) => `[MOCKED_${n}]`,
  };

  static NUMERIC = new Set(['aadhaar', 'card', 'phone']);

  // Vault values shorter than this are only replaced where the user marked them ({{...}}); matching them
  // everywhere would rewrite unrelated words in every later message
  static MIN_REAL_LENGTH = 4;

  static escape(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  constructor() {
    this.clear();
  }

  // Forget every real value (end of a task, tab closed, Clear)
  clear() {
    this.vault = new Map();        // type + normalised real value -> canonical fake
    this.reverseVault = new Map(); // fake as shown (plus digits-only for numbers) -> real value
    this.bindings = new Map();     // fake -> {type, origins: Set of 'task' | 'page' | 'field:<fieldId>'}
    this.counters = {};
  }

  get size() {
    return this.reverseVault.size;
  }

  // The same real value always gets the same fake within a task; numbers keep the original's separators
  // ("2345 6789 0124" -> "0000 0000 0001", "9876543210" -> "9000000001"). origin records where the value
  // came from, which decides where resolve() may put it back.
  getFakeValue(realValue, type = 'text', origin = 'page') {
    const real = String(realValue);
    const digits = real.replace(/\D/g, '');
    const numeric = PIIMasker.NUMERIC.has(type);
    // One value, one fake: a mobile number with or without +91 / 0, a PAN in any letter case
    const normal = type === 'phone' ? digits.slice(-10) : type === 'pan' ? real.toUpperCase() : numeric ? digits : real;
    const key = `${type}:${normal}`;

    let canonical = this.vault.get(key);
    if (!canonical) {
      const count = (this.counters[type] || 0) + 1;
      // Fail closed rather than let the fixed-width numbering overflow into colliding fakes
      if (count > 9999) throw new Error(`Too many distinct ${type} values to mask in one task`);
      this.counters[type] = count;
      canonical = (PIIMasker.FORMATS[type] || PIIMasker.FORMATS.text)(String(count).padStart(4, '0'));
      this.vault.set(key, canonical);
    }

    // Digits are swapped in place only in a value that is nothing but digits and separators, so no other text
    // (an email in the same form field, a word) can ride along inside a fake
    let i = 0;
    const numberShaped = /^[\d\s()+.-]+$/.test(real);
    const fake = numeric && numberShaped && digits.length === canonical.length ? real.replace(/\d/g, () => canonical[i++]) : canonical;
    this.reverseVault.set(fake, real);
    if (fake !== canonical) this.reverseVault.set(canonical, digits);
    for (const shown of new Set([fake, canonical])) {
      const binding = this.bindings.get(shown) || { type, origins: new Set() };
      binding.origins.add(origin);
      this.bindings.set(shown, binding);
    }
    return fake;
  }

  // Outgoing text: {{...}}-marked secrets, fakes already present, newly detected (validated) PII and other values
  // already in the vault all become fakes, claimed in that order. Fakes are never faked again, and a validated
  // span wins over a shorter vault value inside it, so no part of a longer token is left behind.
  maskText(text, origin = 'page') {
    const src = String(text ?? '');
    const claims = [];
    const claim = (start, end, replace) => {
      if (end > start && !claims.some(([s, e]) => start < e && s < end)) claims.push([start, end, replace]);
    };
    const find = (regex, onMatch) => {
      for (const m of src.matchAll(regex)) onMatch(m);
    };
    const whole = (value) => new RegExp(`(?<![\\w])${PIIMasker.escape(value)}(?![\\w])`, 'g');

    // Marked secrets enter the vault first, so an unmarked repeat later in the same text is masked too
    find(/\{\{([^{}]+)\}\}/g, (m) => {
      const secret = m[1].trim();
      if (!secret) return;
      const fake = this.getFakeValue(secret, 'password', origin);
      claim(m.index, m.index + m[0].length, () => fake);
    });
    for (const fake of this.reverseVault.keys()) {
      find(whole(fake), (m) => claim(m.index, m.index + fake.length, () => fake));
    }
    for (const f of PrivagValidators.find(src)) {
      claim(f.start, f.end, () => this.getFakeValue(f.value, f.type, origin));
    }
    // People type their PAN in lowercase too; pages show it in capitals, so only outgoing text gets this pass
    find(/(?<![A-Za-z0-9])[A-Za-z]{5}\d{4}[A-Za-z](?![A-Za-z0-9])/g, (m) => {
      if (PrivagValidators.isPAN(m[0].toUpperCase())) claim(m.index, m.index + m[0].length, () => this.getFakeValue(m[0], 'pan', origin));
    });
    for (const [fake, real] of [...this.reverseVault].sort((a, b) => b[1].length - a[1].length)) {
      if (real.length < PIIMasker.MIN_REAL_LENGTH) continue;
      const type = this.bindings.get(fake)?.type || 'text';
      find(whole(real), (m) => claim(m.index, m.index + real.length, () => this.getFakeValue(real, type, origin)));
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

  // Text the model wants typed into `target` ({fieldId, fieldType}): each whole fake goes back to its real value
  // only where it belongs -- the field it was read from, or, for a value from the task or the page text, a
  // field whose detected purpose matches its type. A fake is recognised however the model retypes it: numbers
  // with any spaces or hyphens, letters in any case. Any other fake is reported in `blocked` and the caller must
  // not type at all (typing the fake would put a placeholder into a real form).
  resolve(text, target) {
    const src = String(text ?? '');
    const blocked = [];
    const claims = [];
    // Longest fakes first, so the spaced form of a number wins over its digits-only form
    for (const fake of [...this.bindings.keys()].sort((a, b) => b.length - a.length)) {
      const binding = this.bindings.get(fake);
      const pattern = PIIMasker.NUMERIC.has(binding.type)
        ? fake.replace(/\D/g, '').split('').join('[\\s-]?')
        : PIIMasker.escape(fake);
      for (const m of src.matchAll(new RegExp(`(?<![\\w])${pattern}(?![\\w])`, 'gi'))) {
        const [start, end] = [m.index, m.index + m[0].length];
        if (claims.some((c) => start < c.end && c.start < end)) continue;
        const fromField = target?.fieldId && binding.origins.has(`field:${target.fieldId}`);
        const freeValue = binding.origins.has('task') || binding.origins.has('page');
        if (fromField || (freeValue && target?.fieldType === binding.type)) {
          // A number retyped without separators is restored without them too
          const real = this.reverseVault.get(fake);
          const bare = PIIMasker.NUMERIC.has(binding.type) && !/[\s-]/.test(m[0]);
          claims.push({ start, end, text: bare ? real.replace(/\D/g, '') : real });
        } else {
          claims.push({ start, end, text: m[0] });
          blocked.push({ fake, type: binding.type });
        }
      }
    }
    claims.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const c of claims) {
      out += src.slice(pos, c.start) + c.text;
      pos = c.end;
    }
    return { text: out + src.slice(pos), blocked };
  }
};

// Export for Node-based tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.PIIMasker;
}
