// Unit tests for extension/validators.js (globalThis.PrivagValidators).
// Business rule under test (claim C4): a candidate pattern only proposes a span; a value is PII only when its
// type's checksum or structure check passes. Over-masking breaks the agent (order IDs, pincodes become
// placeholders); under-masking leaks real IDs to the server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../../extension/validators.js');

// Appends the one digit that makes `payload` pass `check` (the module's own checksum, pinned to published
// vectors below), so a test can build a checksum-valid number that must still be rejected for another reason
function withCheckDigit(payload, check) {
  for (let d = 0; d <= 9; d++) if (check(`${payload}${d}`)) return `${payload}${d}`;
  throw new Error(`no check digit makes ${payload} valid`);
}

describe('Verhoeff checksum (Aadhaar check digit)', () => {
  test('matches the published vectors, so Aadhaar numbers are judged by the real UIDAI checksum', () => {
    // Wikipedia "Verhoeff algorithm", Examples: the check digit for 236 is 3 (2363 validates);
    // Description: the check digit for 942 is 7
    assert.equal(V.verhoeff('2363'), true);
    assert.equal(V.verhoeff('9427'), true);
    // Wikibooks "Algorithm Implementation/Checksums/Verhoeff Algorithm": 12345 -> 1, 75872 -> 2
    assert.equal(V.verhoeff('123451'), true);
    assert.equal(V.verhoeff('758722'), true);
  });

  test('rejects a wrong check digit and an adjacent transposition, the typos it exists to catch', () => {
    assert.equal(V.verhoeff('2364'), false);
    assert.equal(V.verhoeff('123452'), false);
    // Wikibooks: validateVerhoeff("124351") = False (3 and 4 swapped in 123451)
    assert.equal(V.verhoeff('124351'), false);
  });
});

describe('isAadhaar', () => {
  test('accepts a checksum-valid 12-digit number in the usual spellings, so a real Aadhaar is masked', () => {
    // 2345 6789 0124 passes Verhoeff (asserted here rather than assumed)
    assert.equal(V.verhoeff('234567890124'), true);
    for (const s of ['2345 6789 0124', '234567890124', '2345-6789-0124']) assert.equal(V.isAadhaar(s), true, s);
  });

  test('rejects a checksum-valid number starting with 0 or 1, because Aadhaar numbers never start with 0/1', () => {
    for (const payload of ['02345678901', '12345678901']) {
      const n = withCheckDigit(payload, V.verhoeff);
      assert.equal(V.verhoeff(n), true, `${n} must pass Verhoeff so only the first-digit rule rejects it`);
      assert.equal(V.isAadhaar(n), false, n);
    }
  });

  test('rejects a wrong check digit, so a mistyped or made-up 12-digit number is not treated as an Aadhaar', () => {
    assert.equal(V.isAadhaar('2345 6789 0125'), false);
  });

  test('rejects 11 and 13 digits even when the checksum passes, because an Aadhaar is exactly 12 digits', () => {
    for (const payload of ['2345678901', '234567890123']) {
      const n = withCheckDigit(payload, V.verhoeff);
      assert.equal(V.verhoeff(n), true);
      assert.equal(V.isAadhaar(n), false, `${n.length} digits`);
    }
  });
});

describe('Luhn / isCard', () => {
  // Published test card numbers: Visa 4111 1111 1111 1111 (Braintree testing docs),
  // Mastercard 5555 5555 5555 4444 and Amex 378282246310005 (Stripe testing docs)
  const CARDS = ['4111 1111 1111 1111', '5555 5555 5555 4444', '378282246310005'];

  test('accepts published test card numbers, so card numbers on a page are masked', () => {
    for (const c of CARDS) {
      assert.equal(V.luhn(c), true, c);
      assert.equal(V.isCard(c), true, c);
    }
  });

  test('rejects a card number with one digit changed, so arbitrary long numbers are not masked as cards', () => {
    for (const c of ['4111 1111 1111 1112', '5555 5555 5555 4445', '378282246310006']) {
      assert.equal(V.luhn(c), false, c);
      assert.equal(V.isCard(c), false, c);
    }
  });

  test('a Luhn-valid number shorter than 13 digits is not a card (cards are 13-19 digits)', () => {
    // 17893729974: Wikipedia "Luhn algorithm" worked example; 79927398713: the classic Luhn example
    for (const n of ['17893729974', '79927398713']) {
      assert.equal(V.luhn(n), true, n);
      assert.equal(V.isCard(n), false, n);
    }
  });

  test('a run of one repeated digit is not a card, although it passes Luhn (zero-padded IDs, placeholders)', () => {
    assert.equal(V.luhn('0000 0000 0000 0000'), true);
    assert.equal(V.isCard('0000 0000 0000 0000'), false);
  });
});

describe('isPAN', () => {
  test('accepts AAAAA9999A with a holder-type 4th letter, so real PANs are masked', () => {
    assert.equal(V.isPAN('ABCPE1234F'), true);
    // Every holder type: P person, C company, H HUF, F firm, A AOP, T trust, B BOI, L local authority,
    // J artificial juridical person, G government
    for (const letter of 'PCHFATBLJG') assert.equal(V.isPAN(`ABC${letter}E1234F`), true, letter);
  });

  test('rejects a 4th letter that is no holder type (D), so look-alike product codes are not masked', () => {
    assert.equal(V.isPAN('ABCDE1234F'), false);
  });

  test('rejects lowercase, because PANs are written in capitals and ordinary lowercase text must not match', () => {
    assert.equal(V.isPAN('abcpe1234f'), false);
  });
});

describe('isPhone', () => {
  test('accepts an Indian mobile with +91 / 91 / 0 prefixes and common separators', () => {
    for (const s of ['9876543210', '+91 98765 43210', '+919876543210', '919876543210', '09876543210', '+91-98765-43210', '6123456789']) {
      assert.equal(V.isPhone(s), true, s);
    }
  });

  test('rejects numbers that cannot be Indian mobiles (starting 0-5, wrong length), so other numbers are not masked', () => {
    for (const s of ['5876543210', '+91 58765 43210', '98765432101', '987654321']) {
      assert.equal(V.isPhone(s), false, s);
    }
  });
});

describe('isUPI', () => {
  test('accepts handle@psp UPI IDs, which the old regex-only masker never detected (leak 2 in the review)', () => {
    assert.equal(V.isUPI('ravi.kumar@okicici'), true);
    assert.equal(V.isUPI('9876543210@paytm'), true);
  });

  test('an email address is not a UPI ID (the PSP part has no dot), so it gets an email fake, not a UPI fake', () => {
    assert.equal(V.isUPI('a@b.com'), false);
    assert.equal(V.isUPI('ravi.kumar@gmail.com'), false);
    assert.equal(V.typeOf('ravi.kumar@gmail.com'), 'email');
    assert.equal(V.typeOf('ravi.kumar@okicici'), 'upi');
  });
});

describe('isIFSC', () => {
  test('accepts AAAA0XXXXXX bank codes, so IFSCs (leak 2 in the review) are masked', () => {
    assert.equal(V.isIFSC('SBIN0001234'), true);
    assert.equal(V.isIFSC('HDFC0CAGSBK'), true);
  });

  test('rejects a 5th character other than 0, which the IFSC format reserves', () => {
    assert.equal(V.isIFSC('SBIN1001234'), false);
  });
});

describe('OTP', () => {
  test('a 4-8 digit code is an OTP only after an OTP label, so pincodes and quantities stay readable', () => {
    assert.deepEqual(V.find('OTP: 482913'), [{ type: 'otp', start: 5, end: 11, value: '482913' }]);
    assert.deepEqual(V.find('Your verification code is 4821').map((f) => [f.type, f.value]), [['otp', '4821']]);
    assert.deepEqual(V.find('Pincode 560001'), []);
  });

  test('typeOf never calls a bare number an OTP (OTP fields are found by their purpose instead)', () => {
    assert.equal(V.isOTP('482913'), true);
    assert.equal(V.typeOf('482913'), null);
  });
});

describe('find()', () => {
  test('a card number whose first 12 digits are a valid Aadhaar is reported once, as a card', () => {
    const aadhaar = '234567890124';
    assert.equal(V.isAadhaar(aadhaar), true);
    const digits = withCheckDigit(`${aadhaar}000`, V.luhn);
    const card = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
    assert.equal(V.isCard(card), true);
    assert.deepEqual(V.find(`Card ${card}`), [{ type: 'card', start: 5, end: 5 + card.length, value: card }]);
  });

  test('numbers printed side by side are each found: missing one leaks it, masking a reference number does not', () => {
    // Regression (adversarial review M2): a candidate followed by another digit group used to be dropped
    assert.deepEqual(V.find('9876543210 9123456789').map((f) => `${f.type}:${f.value}`), ['phone:9876543210', 'phone:9123456789']);
    assert.deepEqual(V.find('Mumbai 400001 9876543210').map((f) => f.type), ['phone']);
    assert.deepEqual(V.find('Card 4111 1111 1111 1111 12/28').map((f) => f.value), ['4111 1111 1111 1111']);
    // A valid Aadhaar printed inside a longer grouped number is masked too (over-masking is the safe side)
    assert.deepEqual(V.find('Ref 1111 2345 6789 0124 9999').map((f) => f.value), ['2345 6789 0124']);
  });

  test('a stretch never starts or ends inside a group of digits, so part of one long number is never a match', () => {
    assert.deepEqual(V.find('Ref 23456789012411'), []);
    assert.deepEqual(V.find('Ref 112345678901240'), []);
  });

  test('a number followed by @ is the handle of a UPI ID or email, not a phone number', () => {
    assert.deepEqual(V.find('Pay 9876543210@ybl').map((f) => `${f.type}:${f.value}`), ['upi:9876543210@ybl']);
    assert.deepEqual(V.find('Mail 9876543210@gmail.com').map((f) => f.type), ['email']);
  });

  test('the 0091 international prefix is accepted, so +91 written the long way is still masked', () => {
    assert.deepEqual(V.find('Call 0091 98765 43210').map((f) => f.value), ['0091 98765 43210']);
  });

  test('common OTP phrasings are found, with the label before or after the code', () => {
    for (const text of ['Your OTP for login is 482913', '482913 is your OTP', 'verification code is 4821']) {
      assert.deepEqual(V.find(text).map((f) => f.type), ['otp'], text);
    }
    // Digits between the label and the number break the link, so other numbers on the line stay readable
    assert.deepEqual(V.find('OTP valid for 10 minutes. Order 4567'), []);
  });

  test('"Order 0000000000013" yields nothing (the review saw a digit of it leak through a partial mask)', () => {
    assert.deepEqual(V.find('Order 0000000000013'), []);
  });

  test('digits glued to letters are not a phone number (whole tokens only)', () => {
    assert.deepEqual(V.find('Call 9876543210').map((f) => f.type), ['phone']);
    assert.deepEqual(V.find('ID9876543210X'), []);
  });

  test('candidates that fail their checksum or structure are not reported (C4: a regex match alone never masks)', () => {
    assert.deepEqual(V.find('Aadhaar 2345 6789 0125, card 4111 1111 1111 1112, PAN ABCDE1234F, IFSC SBIN1001234'), []);
  });

  test('output is sorted by position and non-overlapping, so callers can splice replacements in one pass', () => {
    const text = 'Email ravi@example.com, PAN ABCPE1234F, phone +91 98765 43210, card 4111 1111 1111 1111, IFSC SBIN0001234, UPI ravi.kumar@okicici';
    const found = V.find(text);
    assert.deepEqual(found.map((f) => f.type), ['email', 'pan', 'phone', 'card', 'ifsc', 'upi']);
    for (const f of found) assert.equal(text.slice(f.start, f.end), f.value);
    for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].end <= found[i].start, `span ${i} overlaps span ${i - 1}`);
  });
});

describe('typeOf()', () => {
  test('names the type a whole field value validates as, and null for ordinary text', () => {
    assert.equal(V.typeOf('4111 1111 1111 1111'), 'card');
    assert.equal(V.typeOf('2345 6789 0124'), 'aadhaar');
    assert.equal(V.typeOf('ABCPE1234F'), 'pan');
    assert.equal(V.typeOf('SBIN0001234'), 'ifsc');
    assert.equal(V.typeOf('hello world'), null);
  });
});
