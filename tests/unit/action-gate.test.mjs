// Unit tests for extension/action-gate.js (globalThis.PrivagGate).
// Business rule under test (claim C12, user decision D6): every action the server proposes is checked on the
// device before it touches the page. A prompt-injected page or a hijacked server must not be able to make the
// agent type secrets, leave the site the run started on, or submit / pay without the user's click.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Gate = require('../../extension/action-gate.js');

const CTX = { startUrl: 'https://shop.example.in/cart' };
const click = (target, ctx = CTX) => Gate.check({ action: 'click', ref: 'e1' }, target, ctx);
const type = (target) => Gate.check({ action: 'type', ref: 'e1', text: 'hello' }, target, CTX);

// A blocked action carries a reason, because the model is told why its action was refused
function assertBlocked(result, why) {
  assert.equal(result.verdict, 'block', why);
  assert.ok(result.reason, 'a block must say why');
}

describe('verbs', () => {
  test('an unknown verb is blocked, so the server cannot invent actions such as "navigate"', () => {
    assertBlocked(Gate.check({ action: 'navigate', url: 'https://evil.test/' }, null, CTX));
    assertBlocked(Gate.check({}, null, CTX));
    assertBlocked(Gate.check(null, null, CTX));
  });

  test('scroll, wait and done are allowed without a target, because they cannot leak or commit anything', () => {
    for (const action of ['scroll', 'wait', 'done']) {
      assert.equal(Gate.check({ action }, null, CTX).verdict, 'allow', action);
    }
  });
});

describe('type', () => {
  test('without a target it is blocked (the old code typed into the first input on the page, leak 7)', () => {
    assertBlocked(type(null));
  });

  test('into a non-editable element it is blocked', () => {
    assertBlocked(type({ editable: false, label: 'Total' }));
  });

  test('into password / OTP / CVV fields it is blocked: typing secrets is reserved for the user (D6)', () => {
    for (const fieldType of ['password', 'otp', 'cvv']) {
      assertBlocked(type({ editable: true, fieldType }), fieldType);
    }
  });

  test('into an ordinary editable field it is allowed, so the agent can still fill forms', () => {
    assert.equal(type({ editable: true, fieldType: 'email' }).verdict, 'allow');
    assert.equal(type({ editable: true, fieldType: null }).verdict, 'allow');
  });
});

describe('click: navigation stays on the start site', () => {
  test('a link on the same host is allowed', () => {
    assert.equal(click({ href: 'https://shop.example.in/item/42', label: 'Item' }).verdict, 'allow');
  });

  test('"www." is ignored in both directions, because it is the same site', () => {
    assert.equal(click({ href: 'https://example.com/a' }, { startUrl: 'https://www.example.com/' }).verdict, 'allow');
    assert.equal(click({ href: 'https://www.example.com/a' }, { startUrl: 'https://example.com/' }).verdict, 'allow');
  });

  test('a subdomain of the start host is allowed (the start site owns it)', () => {
    assert.equal(click({ href: 'https://pay.example.com/' }, { startUrl: 'https://example.com/' }).verdict, 'allow');
  });

  test('a parent domain or a sibling subdomain is off-site (over-blocking is the safe side)', () => {
    const ctx = { startUrl: 'https://shop.example.com/' };
    assertBlocked(click({ href: 'https://example.com/' }, ctx), 'parent domain');
    assertBlocked(click({ href: 'https://pay.example.com/' }, ctx), 'sibling subdomain');
  });

  test('another site is blocked, including look-alike hosts that merely end with or contain the start host', () => {
    const ctx = { startUrl: 'https://example.com/' };
    assertBlocked(click({ href: 'https://evil.test/' }, ctx));
    assertBlocked(click({ href: 'https://notexample.com/' }, ctx), 'suffix without a dot boundary');
    assertBlocked(click({ href: 'https://example.com.evil.test/' }, ctx), 'start host as a prefix');
  });

  test('mailto: and tel: links are blocked, because they hand data to another application', () => {
    assertBlocked(click({ href: 'mailto:someone@example.com' }));
    assertBlocked(click({ href: 'tel:+919876543210' }));
  });

  test('a javascript: link stays on the page, so it is allowed unless its label commits something', () => {
    assert.equal(click({ href: 'javascript:void(0)', label: 'Show more' }).verdict, 'allow');
    assert.equal(click({ href: 'javascript:void(0)', label: 'Pay now' }).verdict, 'confirm');
  });

  test('without a start URL a link click is blocked (fail closed: off-site cannot be ruled out)', () => {
    const link = { href: 'https://shop.example.in/item/42' };
    assertBlocked(Gate.check({ action: 'click', ref: 'e1' }, link, {}));
    assertBlocked(Gate.check({ action: 'click', ref: 'e1' }, link, undefined));
  });
});

describe('click: submit and pay need the user', () => {
  test('a form that submits off-site is blocked outright (data would leave the start site)', () => {
    assertBlocked(click({ submitsForm: true, formAction: 'https://evil.test/collect', label: 'Continue' }));
  });

  test('a same-site form submit asks the user to confirm', () => {
    assert.equal(click({ submitsForm: true, formAction: 'https://shop.example.in/checkout', label: 'Continue' }).verdict, 'confirm');
    assert.equal(click({ submitsForm: true, label: 'Continue' }).verdict, 'confirm');
  });

  test('"Pay now", "Place order" and "Submit" buttons ask the user to confirm, whatever their case', () => {
    for (const label of ['Pay now', 'Place order', 'Submit', 'PAY NOW']) {
      assert.equal(click({ label }).verdict, 'confirm', label);
    }
  });

  test('an ordinary "Next" button is allowed, so multi-step forms do not stall on every click', () => {
    assert.equal(click({ label: 'Next' }).verdict, 'allow');
  });

  test('labels match whole words only, so "Display options" is not mistaken for "pay"', () => {
    assert.equal(click({ label: 'Display options' }).verdict, 'allow');
  });

  test('the model cannot pre-approve a payment: a "confirmed" flag in its action JSON is ignored', () => {
    const result = Gate.check({ action: 'click', ref: 'e1', confirmed: true }, { label: 'Pay now' }, CTX);
    assert.equal(result.verdict, 'confirm');
  });
});
