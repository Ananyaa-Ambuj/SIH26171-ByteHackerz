// Unit tests for extension/redaction-manifest.js (globalThis.PrivagRedactionManifest).
// Business rule under test (claim C10, decision D1): the manifest sent with every frame describes what was
// hidden and how, with allow-listed keys only, so nothing else (OCR text, a raw field value) can ride along.
// The side panel refuses to send a frame whose manifest fails this check (fail closed).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Manifest = require('../../extension/redaction-manifest.js');

// One region per method of the D1 policy: a black-boxed card number that still carries the placeholder the
// agent may type, a solid-masked face, and an email replaced by a format-preserving fake
function validManifest() {
  return {
    redacted_regions: [
      { type: 'card', method: 'black_box', source: 'dom_field', bbox: { x: 120, y: 340, w: 220, h: 28 }, value: '4111 1111 1111 0001' },
      { type: 'face', method: 'solid_mask', source: 'florence_od', bbox: { x: 40, y: 60, w: 96, h: 96 } },
      { type: 'email', method: 'semantic_mock', source: 'dom_text', bbox: { x: 0, y: 0, w: 180, h: 18 }, value: 'user_0001@example.com' },
    ],
    screenshot_dimensions: { width: 1280, height: 720 },
    dom_structure: {
      elements: [
        { ref: 'e1', role: 'textbox', name: 'Card number', bbox: { x: 120, y: 340, w: 220, h: 28 }, filled: true, redacted: true },
        { ref: 'e2', role: 'button', name: 'Pay now', bbox: { x: 120, y: 400, w: 90, h: 32 }, disabled: false },
      ],
    },
  };
}

// Applies one change to a fresh valid manifest and returns the errors, so each error is caused by that change
function errorsAfter(change) {
  const m = validManifest();
  change(m);
  return Manifest.validate(m);
}

function assertRejected(errors, pattern) {
  assert.ok(errors.length > 0, 'the change must make the manifest invalid');
  assert.ok(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got ${JSON.stringify(errors)}`);
}

describe('valid manifest', () => {
  test('a realistic manifest with one region per method passes, so normal frames are not withheld', () => {
    assert.deepEqual(Manifest.validate(validManifest()), []);
  });

  test('the only methods are black_box, solid_mask and semantic_mock (the D1 masking policy)', () => {
    assert.deepEqual([...Manifest.METHODS].sort(), ['black_box', 'semantic_mock', 'solid_mask']);
  });

  test('a non-object manifest is rejected outright', () => {
    for (const m of [null, [], 'manifest', 42]) assert.deepEqual(Manifest.validate(m), ['manifest must be an object']);
  });
});

describe('each violation is reported (the frame is then withheld)', () => {
  test('an extra region key such as text_snippet: OCR text must never ride along with the frame', () => {
    assertRejected(errorsAfter((m) => { m.redacted_regions[0].text_snippet = 'Rahul Sharma 2345 6789 0124'; }), /redacted_regions\[0\].*"text_snippet"/);
  });

  test('method gaussian_blur: faces are solid-masked now, a blur is no longer a valid method', () => {
    assertRejected(errorsAfter((m) => { m.redacted_regions[1].method = 'gaussian_blur'; }), /redacted_regions\[1\]\.method/);
  });

  test('an unknown source: every region must name the detector that found it', () => {
    assertRejected(errorsAfter((m) => { m.redacted_regions[2].source = 'regex'; }), /redacted_regions\[2\]\.source/);
  });

  test('semantic_mock without a value: the model must be told which placeholder it sees', () => {
    assertRejected(errorsAfter((m) => { delete m.redacted_regions[2].value; }), /redacted_regions\[2\].*semantic_mock/);
  });

  test('solid_mask with a value: a masked face or photo carries nothing the model could read', () => {
    assertRejected(errorsAfter((m) => { m.redacted_regions[1].value = 'Rahul Sharma'; }), /redacted_regions\[1\].*solid_mask/);
  });

  test('a bbox with a negative origin or a zero / negative size does not describe a real region', () => {
    assertRejected(errorsAfter((m) => { m.redacted_regions[0].bbox.x = -5; }), /redacted_regions\[0\]\.bbox/);
    assertRejected(errorsAfter((m) => { m.redacted_regions[0].bbox.w = 0; }), /redacted_regions\[0\]\.bbox/);
    assertRejected(errorsAfter((m) => { m.redacted_regions[0].bbox.h = -1; }), /redacted_regions\[0\]\.bbox/);
    assertRejected(errorsAfter((m) => { m.dom_structure.elements[0].bbox.w = 0; }), /elements\[0\]\.bbox/);
  });

  test('an element ref that is not e<number>: the model addresses elements only by these refs', () => {
    assertRejected(errorsAfter((m) => { m.dom_structure.elements[1].ref = 'button#pay'; }), /elements\[1\]\.ref/);
    assertRejected(errorsAfter((m) => { m.dom_structure.elements[1].ref = 'e'; }), /elements\[1\]\.ref/);
  });

  test('an element name over 80 characters: long names are where page text (and PII) would ride along', () => {
    assertRejected(errorsAfter((m) => { m.dom_structure.elements[0].name = 'x'.repeat(81); }), /elements\[0\]\.name/);
    assert.deepEqual(errorsAfter((m) => { m.dom_structure.elements[0].name = 'x'.repeat(80); }), []);
  });

  test('an extra top-level key: only regions, dimensions and the element list may be sent', () => {
    assertRejected(errorsAfter((m) => { m.page_text = 'Account holder Rahul Sharma'; }), /manifest has unexpected key "page_text"/);
  });

  test('missing screenshot_dimensions: the server cannot map boxes to the frame without them', () => {
    assertRejected(errorsAfter((m) => { delete m.screenshot_dimensions; }), /screenshot_dimensions/);
  });
});
