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

  // Button / link labels that commit something (word match, any letter case), plus common Hindi labels
  const COMMIT_LABEL = /\b(pay|pay now|payments?|make payment|place (your )?order|order now|checkout|check out|buy|buy now|purchase|complete (purchase|order|payment)|submit|confirm|transfer|send money|donate|book now|subscribe|proceed to (pay|payment|checkout)|payer)\b/i;
  const COMMIT_LABEL_HI = /भुगतान|पेमेंट|जमा करें/;

  function parse(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch {
      return null;
    }
  }

  // Hostname without a leading "www.", lowercased; null when the URL cannot be parsed or is not http(s)
  function hostOf(url) {
    return parse(url)?.hostname.toLowerCase().replace(/^www\./, '') ?? null;
  }

  // Same site as the run's start page: the same host (ignoring "www.") or a subdomain of it, on the same port,
  // with the same scheme or an http -> https upgrade. A parent domain, a sibling subdomain or another port (e.g.
  // a different local service on localhost) counts as off-site (over-blocking is the safe side).
  function sameSite(url, startUrl) {
    const u = parse(url);
    const start = parse(startUrl);
    if (!u || !start) return false;
    const host = hostOf(url);
    const startHost = hostOf(startUrl);
    if (host !== startHost && !host.endsWith(`.${startHost}`)) return false;
    if (u.port !== start.port) return false;
    return u.protocol === start.protocol || (start.protocol === 'http:' && u.protocol === 'https:');
  }

  // Whether the URL points at one of the given origins (e.g. the Privag server itself)
  function isBlockedOrigin(url, origins) {
    const u = parse(url);
    return Boolean(u) && (origins || []).some((o) => parse(o)?.origin === u.origin);
  }

  const allow = () => ({ verdict: 'allow', reason: '' });
  const block = (reason) => ({ verdict: 'block', reason });
  const confirm = (reason) => ({ verdict: 'confirm', reason });

  // action: {action, ...}; target: the element description from content.js or null;
  // ctx: {startUrl, blockedOrigins} -> {verdict: 'allow' | 'block' | 'confirm', reason}
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
      } else if (isBlockedOrigin(target.href, ctx?.blockedOrigins)) {
        return block('The agent may not open the Privag server itself');
      } else if (!sameSite(target.href, ctx?.startUrl)) {
        return block(`Off-site navigation to ${hostOf(target.href)} is blocked`);
      }
    }
    if (target.submitsForm) {
      if (target.formAction && isBlockedOrigin(target.formAction, ctx?.blockedOrigins)) {
        return block('The form submits to the Privag server itself');
      }
      if (target.formAction && !sameSite(target.formAction, ctx?.startUrl)) {
        return block(`The form submits off-site to ${hostOf(target.formAction) || target.formAction}`);
      }
      return confirm('This click submits a form');
    }
    const label = target.label || '';
    if (COMMIT_LABEL.test(label) || COMMIT_LABEL_HI.test(label)) return confirm(`"${label}" looks like a submit or payment`);
    // A button inside a form the page already holds values in may submit it from script
    if (target.inFilledForm) return confirm('This button is part of a filled-in form');
    return allow();
  }

  return { check, sameSite, hostOf, VERBS, SECRET_FIELDS };
})();

// Export for Node-based tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.PrivagGate;
}
