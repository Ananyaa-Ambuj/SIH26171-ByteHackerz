// PII validators shared by the content script, the side panel, the vision worker and the Node tests.
// A candidate pattern only proposes a span; the type's validator (checksum or structure) decides whether it
// is PII. A regex match alone never triggers a mask.
// Injected into pages more than once (re-injection), so no top-level let/const/class declarations.
globalThis.PrivagValidators ??= (() => {
  // Verhoeff dihedral-group tables (multiplication d and permutation p), used by the Aadhaar check digit
  const D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];

  const digitsOf = (s) => String(s).replace(/\D/g, '');

  // True when the digit string (check digit last) passes the Verhoeff check
  function verhoeff(value) {
    const d = digitsOf(value);
    if (!d) return false;
    let c = 0;
    for (let i = 0; i < d.length; i++) c = D[c][P[i % 8][Number(d[d.length - 1 - i])]];
    return c === 0;
  }

  // True when the digit string (check digit last) passes the Luhn mod-10 check
  function luhn(value) {
    const d = digitsOf(value);
    if (!d) return false;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2 === 1) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    return sum % 10 === 0;
  }

  // Aadhaar: 12 digits, never starting with 0 or 1, last digit a Verhoeff check digit
  const isAadhaar = (s) => /^\d{4}[ -]?\d{4}[ -]?\d{4}$/.test(String(s).trim()) && /^[2-9]/.test(digitsOf(s)) && verhoeff(s);

  // Payment card: 13-19 digits passing Luhn (a run of one repeated digit is not a card)
  const isCard = (s) => {
    const d = digitsOf(s);
    return /^\d(?:[ -]?\d){12,18}$/.test(String(s).trim()) && !/^(\d)\1+$/.test(d) && luhn(d);
  };

  // PAN: AAAAA9999A where the 4th letter is a holder type (P person, C company, H HUF, F firm, A AOP,
  // T trust, B BOI, L local authority, J artificial juridical person, G government)
  const isPAN = (s) => /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(String(s).trim());

  // Indian mobile: optional +91 / 91 / 0 prefix, then 10 digits starting 6-9
  const isPhone = (s) => {
    const t = String(s).trim();
    if (!/^(?:\+?91[ -]?|0)?[6-9](?:[ -]?\d){9}$/.test(t)) return false;
    const d = digitsOf(t);
    const national = d.length === 12 ? d.slice(2) : d.length === 11 ? d.slice(1) : d;
    return national.length === 10 && /^[6-9]/.test(national);
  };

  // UPI ID (VPA): handle@psp where the PSP part has no dot (an email's domain does)
  const isUPI = (s) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,255}@[A-Za-z][A-Za-z0-9]{1,63}$/.test(String(s).trim());

  // IFSC: 4-letter bank code, a literal 0, then a 6-character branch code
  const isIFSC = (s) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(s).trim());

  const isEmail = (s) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(String(s).trim());

  // One-time code: 4-8 digits. Only ever offered by its candidate pattern, which requires an OTP label right
  // before the digits ("OTP: 482913", "verification code is 4821"), never for a bare number.
  const isOTP = (s) => /^\d{4,8}$/.test(String(s).trim());

  const VALIDATE = {
    card: isCard,
    aadhaar: isAadhaar,
    phone: isPhone,
    otp: isOTP,
    pan: isPAN,
    ifsc: isIFSC,
    email: isEmail,
    upi: isUPI,
  };

  // Candidate spans in priority order (a span claimed by an earlier type is not offered to a later one).
  // Lookarounds keep a candidate to a whole token: no letters/digits glued on, and no further
  // space-separated digit group, so a 12-digit run inside a longer number is never taken for an Aadhaar.
  const CANDIDATES = {
    card: /(?<![\w])(?<!\d[ -])\d(?:[ -]?\d){12,18}(?![ -]?\d)(?![\w])/g,
    aadhaar: /(?<![\w])(?<!\d[ -])\d{4}[ -]?\d{4}[ -]?\d{4}(?![ -]?\d)(?![\w])/g,
    phone: /(?<![\w+])(?<!\d[ -])(?:\+?91[ -]?|0)?[6-9](?:[ -]?\d){9}(?![ -]?\d)(?![\w])/g,
    otp: /(?<=\b(?:otp|one[- ]?time[- ]?(?:password|passcode|code|pin)|verification[- ]code|passcode)\W{0,12}(?:is\W{1,4})?)\d{4,8}(?![\w])/gi,
    pan: /(?<![A-Za-z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Za-z0-9])/g,
    ifsc: /(?<![A-Za-z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Za-z0-9])/g,
    email: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
    upi: /(?<![\w.-])[A-Za-z0-9][A-Za-z0-9._-]{1,255}@[A-Za-z][A-Za-z0-9]{1,63}(?![\w@-])(?!\.[A-Za-z0-9])/g,
  };

  const TYPES = Object.keys(CANDIDATES);

  // Validated PII spans in text: [{type, start, end, value}], non-overlapping, sorted by start
  function find(text) {
    const src = String(text ?? '');
    const found = [];
    for (const type of TYPES) {
      for (const m of src.matchAll(CANDIDATES[type])) {
        const start = m.index;
        const end = start + m[0].length;
        if (found.some((f) => start < f.end && f.start < end)) continue;
        if (VALIDATE[type](m[0])) found.push({ type, start, end, value: m[0] });
      }
    }
    return found.sort((a, b) => a.start - b.start);
  }

  // The type a whole value validates as (e.g. a form field's value), or null. OTP is left out: without its
  // label a 4-8 digit value (a PIN code, a quantity) is not an OTP; OTP fields are found by their purpose.
  function typeOf(value) {
    const v = String(value ?? '').trim();
    return TYPES.find((type) => type !== 'otp' && VALIDATE[type](v)) || null;
  }

  return { verhoeff, luhn, isAadhaar, isCard, isPAN, isPhone, isUPI, isIFSC, isEmail, isOTP, validate: (type, s) => Boolean(VALIDATE[type]?.(s)), find, typeOf, TYPES };
})();

// Export for Node-based tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.PrivagValidators;
}
