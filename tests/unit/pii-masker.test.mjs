// Unit tests for extension/pii-masker.js (globalThis.PIIMasker, the vault).
// Business rules under test (claims C11, C13, decision D7): every text sent to the server carries fakes instead
// of real PII; a fake is consistent within a task and clearly synthetic; and a fake the model types is turned
// back into the real value only where that value belongs (the field it was read from, or a field of the same
// type for values from the task or page text). Anything else is blocked, never typed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// pii-masker.js reads globalThis.PrivagValidators, so the validators load first
const V = require('../../extension/validators.js');
const PIIMasker = require('../../extension/pii-masker.js');

// Digit positions and separators of a value, e.g. "2345 6789 0124" -> "9999 9999 9999"
const shape = (s) => s.replace(/\d/g, '9');

describe('fakes', () => {
  test('the same real value gets the same fake within a task, so the model can track it across steps', () => {
    const m = new PIIMasker();
    const first = m.getFakeValue('2345 6789 0124', 'aadhaar', 'task');
    assert.equal(m.getFakeValue('2345 6789 0124', 'aadhaar', 'task'), first);
    // The same number spelled without separators maps to the same fake digits
    assert.equal(m.getFakeValue('234567890124', 'aadhaar', 'task'), first.replace(/\D/g, ''));
    // A different number gets a different fake
    assert.notEqual(m.getFakeValue('3456 7890 1235', 'aadhaar', 'task'), first);
  });

  test('numeric fakes keep the original separators, so the page format and field masks still fit', () => {
    const m = new PIIMasker();
    for (const [real, type] of [['2345-6789-0124', 'aadhaar'], ['98765 43210', 'phone'], ['4111 1111 1111 1111', 'card']]) {
      const fake = m.getFakeValue(real, type, 'task');
      assert.equal(shape(fake), shape(real), `${type}: ${real} -> ${fake}`);
      assert.notEqual(fake.replace(/\D/g, ''), real.replace(/\D/g, ''), `${type}: the digits must change`);
    }
  });

  test('fakes are clearly synthetic, so a fake can never be mistaken for, or collide with, a real ID', () => {
    const m = new PIIMasker();
    const aadhaar = m.getFakeValue('2345 6789 0124', 'aadhaar', 'task');
    assert.ok(aadhaar.startsWith('0'), aadhaar);
    assert.equal(V.isAadhaar(aadhaar), false, aadhaar);
    const pan = m.getFakeValue('ABCPE1234F', 'pan', 'task');
    assert.equal(V.isPAN(pan), false, pan);
    const ifsc = m.getFakeValue('SBIN0001234', 'ifsc', 'task');
    assert.equal(ifsc.length, 11, ifsc);
    assert.ok(ifsc.startsWith('ZZZZ'), ifsc);
  });
});

describe('maskText (outgoing text)', () => {
  test('validated PII in the task becomes fakes; numbers failing their checksum stay (C4: regex alone never masks)', () => {
    const m = new PIIMasker();
    const text = 'Aadhaar 2345 6789 0124, order 2345 6789 0125, card 4111 1111 1111 1111';
    const out = m.maskText(text, 'task');
    const expected = text
      .replace('2345 6789 0124', m.getFakeValue('2345 6789 0124', 'aadhaar', 'task'))
      .replace('4111 1111 1111 1111', m.getFakeValue('4111 1111 1111 1111', 'card', 'task'));
    assert.equal(out, expected);
    assert.ok(!out.includes('2345 6789 0124') && !out.includes('4111 1111 1111 1111'), out);
    assert.ok(out.includes('order 2345 6789 0125'), 'the checksum-invalid number must stay readable');
  });

  test('{{secret}} marked text becomes a SECRET_ placeholder and neither the value nor the braces are sent', () => {
    const m = new PIIMasker();
    const out = m.maskText('Log in with password {{hunter22}}', 'task');
    assert.match(out, /^Log in with password SECRET_\d{4}$/);
  });

  test('a marked secret (4+ characters) is masked in every later message even without the braces', () => {
    const m = new PIIMasker();
    const fake = m.maskText('{{hunter22}}', 'task');
    assert.equal(m.maskText('if asked again, type hunter22', 'page'), `if asked again, type ${fake}`);
  });

  test('a marked secret repeated without braces in the same message is masked too (it must not leak in that message)', () => {
    const m = new PIIMasker();
    const out = m.maskText('Use {{hunter22}} as the password; if asked again type hunter22', 'task');
    assert.ok(!out.includes('hunter22'), out);
  });

  test('one mobile number written three ways gets one fake, so the model sees one number, not three', () => {
    const m = new PIIMasker();
    const out = m.maskText('9876543210 / +91 98765 43210 / 09876543210', 'task');
    const fakes = out.split(' / ').map((f) => f.replace(/\D/g, '').slice(-10));
    assert.equal(new Set(fakes).size, 1, out);
    assert.ok(!out.includes('98765'), out);
  });

  test('a PAN typed in lowercase in the task is masked too, with the same fake as its capital form', () => {
    const m = new PIIMasker();
    const out = m.maskText('my PAN is abcpe1234f, again ABCPE1234F', 'task');
    assert.ok(!/abcpe1234f/i.test(out), out);
    assert.match(out, /^my PAN is (ZZZZZ\d{4}Z), again \1$/);
    // A lowercase word that only looks like a PAN (4th letter not a holder type) stays readable
    assert.equal(m.maskText('code order1234x', 'task'), 'code order1234x');
  });

  test('a 1-3 character vault value is not rewritten elsewhere (regression: a short {{a}} rewrote every later string)', () => {
    const m = new PIIMasker();
    assert.match(m.maskText('Initials {{a}}, code {{ab7}}', 'task'), /^Initials SECRET_\d{4}, code SECRET_\d{4}$/);
    const later = 'a cab ab7 about a page';
    assert.equal(m.maskText(later, 'page'), later);
  });

  test('fakes already in the text are kept, so a fake is never faked again into a value the vault cannot resolve', () => {
    const m = new PIIMasker();
    const phone = m.getFakeValue('9876543210', 'phone', 'task');
    const ifsc = m.getFakeValue('SBIN0001234', 'ifsc', 'task');
    // Both fakes are shaped like real values (a 9xxxxxxxxx mobile, an AAAA0XXXXXX code), so only the vault
    // knows they are fakes
    assert.equal(V.isPhone(phone), true);
    assert.equal(V.isIFSC(ifsc), true);
    const size = m.size;
    const text = `Called ${phone}, branch ${ifsc}`;
    assert.equal(m.maskText(text, 'page'), text);
    assert.equal(m.size, size, 'no new fakes');
  });
});

describe('resolve (fake -> real, right before typing)', () => {
  test('a fake read from field f3 resolves only into f3, not into f9 even when f9 is also an email field', () => {
    const m = new PIIMasker();
    const fake = m.getFakeValue('ravi@gmail.com', 'email', 'field:f3');
    assert.deepEqual(m.resolve(fake, { fieldId: 'f3', fieldType: 'email' }), { text: 'ravi@gmail.com', blocked: [] });
    assert.deepEqual(m.resolve(fake, { fieldId: 'f9', fieldType: 'email' }), { text: fake, blocked: [{ fake, type: 'email' }] });
  });

  test('a fake from the task resolves into a field of its type, and is blocked into another type or an untyped field', () => {
    const m = new PIIMasker();
    const out = m.maskText('Send 500 to ravi.kumar@okicici', 'task');
    const fake = out.slice('Send 500 to '.length);
    assert.notEqual(fake, 'ravi.kumar@okicici');
    assert.equal(m.resolve(fake, { fieldId: 'f1', fieldType: 'upi' }).text, 'ravi.kumar@okicici');
    for (const target of [{ fieldId: 'f2', fieldType: 'email' }, { fieldId: 'f2', fieldType: null }, { fieldId: 'f2' }, null]) {
      assert.deepEqual(m.resolve(fake, target), { text: fake, blocked: [{ fake, type: 'upi' }] }, JSON.stringify(target));
    }
  });

  test('a numeric fake resolves with or without its separators, because the model may retype it either way', () => {
    const m = new PIIMasker();
    const fake = m.getFakeValue('2345 6789 0124', 'aadhaar', 'field:f1');
    assert.equal(m.resolve(fake, { fieldId: 'f1' }).text, '2345 6789 0124');
    assert.equal(m.resolve(fake.replace(/\D/g, ''), { fieldId: 'f1' }).text, '234567890124');
  });

  test('blocked fakes are reported and stay fakes in the text, so the caller can refuse to type and tell the model', () => {
    const m = new PIIMasker();
    const upi = m.getFakeValue('ravi.kumar@okicici', 'upi', 'task');
    const email = m.getFakeValue('ravi@gmail.com', 'email', 'field:f3');
    const result = m.resolve(`${upi} / ${email}`, { fieldId: 'f1', fieldType: 'upi' });
    assert.equal(result.text, `ravi.kumar@okicici / ${email}`);
    assert.deepEqual(result.blocked, [{ fake: email, type: 'email' }]);
  });

  test('clear() forgets every real value (task end, tab closed), so nothing can be resolved afterwards', () => {
    const m = new PIIMasker();
    const fake = m.getFakeValue('ravi@gmail.com', 'email', 'task');
    m.maskText('Aadhaar 2345 6789 0124', 'task');
    assert.ok(m.size > 0);
    m.clear();
    assert.equal(m.size, 0);
    assert.deepEqual(m.resolve(fake, { fieldId: 'f3', fieldType: 'email' }), { text: fake, blocked: [] });
  });
});
