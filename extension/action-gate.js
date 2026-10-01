// Local action gate: every action the server proposes is checked here, on the device, before it can touch
// the page. Pure decisions over a plain description of the target element (built by content.js), so the
// same rules run in the side panel and in the Node tests.
// Rules: no typing into password / OTP / CVV fields; no navigation off the site the run started on; a user
// click before anything that submits a form or looks like paying.
// Loaded more than once in the same world, so no top-level let/const/class declarations.
globalThis.PrivagGate ??= (() => {
  const VERBS = new Set(['click', 'type', 'scroll', 'wait', 'done']);

  // Field purposes the agent may never type into: the user enters these themselves
  const SECRET_FIELDS = new Set(['password', 'otp', 'cvv']);

  // Button / link labels that commit something (word match, any language case)
  const COMMIT_LABEL = /\b(pay|pay now|payment|place order|checkout|check out|buy|buy now|purchase|submit|confirm|transfer|send money|donate|book now|proceed to pay)\b/i;

  // Hostname without a leading "www.", lowercased; null when the URL cannot be parsed or is not http(s)
  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  // Same site as the run's start page: the same host (ignoring "www."), or a subdomain of it. A parent
  // domain or a sibling subdomain counts as off-site (over-blocking is the safe side).
  function sameSite(url, startUrl) {
    const host = hostOf(url);
    const start = hostOf(startUrl);
    if (!host || !start) return false;
    return host === start || host.endsWith(`.${start}`);
  }

  const allow = () => ({ verdict: 'allow', reason: '' });
  const block = (reason) => ({ verdict: 'block', reason });
  const confirm = (reason) => ({ verdict: 'confirm', reason });

  // action: {action, ...}; target: the element description from content.js or null; ctx: {startUrl}
  // -> {verdict: 'allow' | 'block' | 'confirm', reason}
  function check(action, target, ctx) {
    const verb = action?.action;
    if (!VERBS.has(verb)) return block(`Unknown action "${verb}"`);
    if (verb === 'scroll' || verb === 'wait' || verb === 'done') return allow();
    if (!target) return block('No target element');

    if (verb === 'type') {
      if (!target.editable) return block('The target is not a text field');
      if (SECRET_FIELDS.has(target.fieldType)) {
        return block(`Typing into ${target.fieldType} fields is left to the user`);
      }
      return allow();
    }

    // click
    if (target.href) {
      if (/^javascript:/i.test(target.href)) {
        // An in-page script link: stays on the page, but may still commit something
      } else if (!hostOf(target.href)) {
        return block('The link leaves the browser page (non-web URL)');
      } else if (!sameSite(target.href, ctx?.startUrl)) {
        return block(`Off-site navigation to ${hostOf(target.href)} is blocked`);
      }
    }
    if (target.submitsForm) {
      if (target.formAction && !sameSite(target.formAction, ctx?.startUrl)) {
        return block(`The form submits off-site to ${hostOf(target.formAction) || target.formAction}`);
      }
      return confirm('This click submits a form');
    }
    if (COMMIT_LABEL.test(target.label || '')) return confirm(`"${target.label}" looks like a submit or payment`);
    return allow();
  }

  return { check, sameSite, hostOf, VERBS, SECRET_FIELDS };
})();

// Export for Node-based tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.PrivagGate;
}
