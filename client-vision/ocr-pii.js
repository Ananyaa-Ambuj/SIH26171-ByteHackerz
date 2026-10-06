// Decides which Florence-2 OCR lines hold PII. No transformers.js here, so the Node unit tests can import it.
// A line is PII when a validator (checksum or structure) accepts a span in it, or when it carries a PII label
// next to a value-looking token, because OCR misreads break checksums. A regex alone never masks.
import '../extension/validators.js';

// Labels that mark an OCR line as PII even when OCR garbles the value itself, e.g. "PAN Card: ABCDE123RF"
// (a 4 misread as R) or "Aadhaar No: 9876432 1098" (a dropped digit) fail their validators
const PII_LABELS = {
    aadhaar: /aadha?ar|adhaa?r/i,
    pan: /\bPAN\b/,
    // Also "credit card" and "debit card"
    card: /\bcard\b/i,
    phone: /phone|mobile/i,
    email: /e-?mail/i,
    upi: /\bUPI\b|\bVPA\b/i,
    ifsc: /\bIFSC\b/i,
    otp: /\bOTP\b|one[- ]?time[- ]?(?:password|passcode|code|pin)/i,
};

function matchLabeledPII(text) {
    // Only when the line also holds a value-looking token, so bare field labels such as "PAN Number" stay
    // readable for the agent: a 6+ character token with an '@' or 3+ digits, or 6+ digits in all (an ID
    // printed in groups, "9876 5432 1098", has no single long token)
    const hasValue = (text.match(/[A-Za-z0-9@._-]{6,}/g) || [])
        .some((token) => token.includes('@') || (token.match(/\d/g) || []).length >= 3)
        || (text.match(/\d/g) || []).length >= 6;
    if (!hasValue) return null;
    // The label that comes first names the line: "PAN Card: ..." is a PAN, not a card
    let found = null;
    for (const [type, label] of Object.entries(PII_LABELS)) {
        const at = text.search(label);
        if (at >= 0 && (found === null || at < found.at)) found = { type, at };
    }
    return found && found.type;
}

// The PII type of one OCR line as {type}, or null when the line can stay readable
export function classifyLine(text) {
    const line = String(text ?? '');
    const validated = globalThis.PrivagValidators.find(line);
    if (validated.length > 0) return { type: validated[0].type };
    const type = matchLabeledPII(line);
    return type ? { type } : null;
}

// Repeatedly replaces any two intersecting {x, y, w, h} boxes with their bounding union until none intersect
export function mergeOverlappingBoxes(boxes) {
    const merged = boxes.map((b) => ({ ...b }));
    let changed = true;
    while (changed) {
        changed = false;
        // Rescan from the start after every merge: the grown union can reach boxes already checked
        for (let i = 0; i < merged.length && !changed; i++) {
            for (let j = i + 1; j < merged.length && !changed; j++) {
                const a = merged[i];
                const b = merged[j];
                if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                    const x = Math.min(a.x, b.x);
                    const y = Math.min(a.y, b.y);
                    merged[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
                    merged.splice(j, 1);
                    changed = true;
                }
            }
        }
    }
    return merged;
}
