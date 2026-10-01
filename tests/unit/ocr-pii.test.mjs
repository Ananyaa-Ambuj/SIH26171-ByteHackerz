// Unit tests for the OCR-line classifier the vision worker runs on Florence-2 OCR output.
// Run: node --test tests/unit/ocr-pii.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, mergeOverlappingBoxes } from '../../client-vision/ocr-pii.js';

const V = globalThis.PrivagValidators;

test('a Verhoeff-valid Aadhaar is masked even without a label', () => {
  // Text in a screenshot often has no label next to it; the checksum alone must be enough to hide a real ID
  assert.equal(V.verhoeff('234567890124'), true);
  assert.deepEqual(classifyLine('2345 6789 0124'), { type: 'aadhaar' });
});

test('a Verhoeff-invalid 12-digit order number stays readable', () => {
  // The old regex masked any 12 digits. A regex alone must never mask: the agent needs order numbers,
  // and the failing checksum is what tells this number apart from an Aadhaar
  assert.equal(V.verhoeff('987654321098'), false);
  assert.equal(classifyLine('Order No: 9876 5432 1098'), null);
});

test('a labelled ID is masked when OCR breaks its checksum', () => {
  // OCR misreads digits (decision D5), so a PII label next to a value masks the line even when the
  // validator rejects the value. Same digits as the order number above; only the label differs.
  assert.deepEqual(classifyLine('Aadhaar No: 9876 5432 1098'), { type: 'aadhaar' });
  assert.deepEqual(V.find('PAN Card: ABCDE123RF'), []);
  assert.deepEqual(classifyLine('PAN Card: ABCDE123RF'), { type: 'pan' });
  assert.equal(V.luhn('4111111111111112'), false);
  assert.deepEqual(classifyLine('Debit Card: 4111 1111 1111 1112'), { type: 'card' });
  assert.deepEqual(V.find('IFSC Code: SB1N0OO1234'), []);
  assert.deepEqual(classifyLine('IFSC Code: SB1N0OO1234'), { type: 'ifsc' });
});

test('bare field labels stay readable', () => {
  // A label with no value next to it is form structure the agent needs to find the right field
  for (const label of ['PAN Number', 'Aadhaar Number', 'Card Number', 'UPI ID', 'IFSC Code', 'Enter OTP', 'Mobile']) {
    assert.equal(classifyLine(label), null, label);
  }
});

test('validated card, UPI, IFSC and OTP lines are masked', () => {
  assert.equal(V.luhn('4111111111111111'), true);
  assert.deepEqual(classifyLine('4111 1111 1111 1111'), { type: 'card' });
  assert.deepEqual(classifyLine('UPI ID: ravi.kumar@okicici'), { type: 'upi' });
  assert.deepEqual(classifyLine('IFSC: SBIN0001234'), { type: 'ifsc' });
  assert.deepEqual(classifyLine('OTP: 482913'), { type: 'otp' });
});

test('names are not masked', () => {
  // User decision D2: names do not need masking, so a name line stays readable
  assert.equal(classifyLine('Full Name: John Doe'), null);
});

test('mergeOverlappingBoxes merges a chain of overlapping boxes into one', () => {
  // Florence returns separate boxes for parts of one person (head, face, person). A chain A-B-C, where A and
  // C do not touch, must end as one box, or a gap between masks would show part of the face. Given as A, C, B:
  // C only overlaps the grown A+B box, so the merge has to look at C again.
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 8, y: 0, w: 10, h: 10 };
  const c = { x: 16, y: 0, w: 10, h: 10 };
  assert.deepEqual(mergeOverlappingBoxes([a, c, b]), [{ x: 0, y: 0, w: 26, h: 10 }]);
});

test('mergeOverlappingBoxes keeps boxes that do not overlap apart', () => {
  // Two people far apart get two masks, not one box over everything between them
  const left = { x: 0, y: 0, w: 10, h: 10 };
  const right = { x: 100, y: 0, w: 10, h: 10 };
  assert.deepEqual(mergeOverlappingBoxes([left, right]), [left, right]);
});
