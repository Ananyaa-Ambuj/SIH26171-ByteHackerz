// Schema of the redaction manifest sent with every frame. The side panel refuses to send a frame whose
// manifest fails this check (fail closed), and the allow-listed keys mean no extra field (OCR text, a field
// value) can ride along by accident. The server applies the same rules (server/app.py).
// Loaded more than once in the same world, so no top-level let/const/class declarations.
globalThis.PrivagRedactionManifest ??= (() => {
  const METHODS = ['black_box', 'solid_mask', 'semantic_mock'];
  const SOURCES = ['dom_text', 'dom_field', 'dom_media', 'florence_od', 'florence_ocr'];
  const REGION_KEYS = new Set(['type', 'method', 'source', 'bbox', 'value']);
  const ELEMENT_KEYS = new Set(['ref', 'role', 'name', 'bbox', 'filled', 'redacted', 'disabled']);
  const TOP_KEYS = new Set(['redacted_regions', 'screenshot_dimensions', 'dom_structure']);

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isShortString = (v, max) => typeof v === 'string' && v.length <= max;

  function checkBbox(b, where, errors) {
    if (!isObject(b) || !['x', 'y', 'w', 'h'].every((k) => isNum(b[k]))) {
      errors.push(`${where}.bbox must be {x, y, w, h} numbers`);
    } else if (b.w <= 0 || b.h <= 0 || b.x < 0 || b.y < 0) {
      errors.push(`${where}.bbox must have x, y >= 0 and w, h > 0`);
    }
  }

  function checkKeys(obj, allowed, where, errors) {
    for (const key of Object.keys(obj)) if (!allowed.has(key)) errors.push(`${where} has unexpected key "${key}"`);
  }

  // Returns a list of problems; an empty list means the manifest is valid
  function validate(manifest) {
    const errors = [];
    if (!isObject(manifest)) return ['manifest must be an object'];
    checkKeys(manifest, TOP_KEYS, 'manifest', errors);

    if (!Array.isArray(manifest.redacted_regions)) {
      errors.push('redacted_regions must be an array');
    } else {
      manifest.redacted_regions.forEach((r, i) => {
        const where = `redacted_regions[${i}]`;
        if (!isObject(r)) return errors.push(`${where} must be an object`);
        checkKeys(r, REGION_KEYS, where, errors);
        if (!isShortString(r.type, 40) || !r.type) errors.push(`${where}.type must be a non-empty string`);
        if (!METHODS.includes(r.method)) errors.push(`${where}.method must be one of ${METHODS.join(', ')}`);
        if (!SOURCES.includes(r.source)) errors.push(`${where}.source must be one of ${SOURCES.join(', ')}`);
        checkBbox(r.bbox, where, errors);
        if (r.value !== undefined && !isShortString(r.value, 200)) errors.push(`${where}.value must be a string`);
        if (r.method === 'semantic_mock' && typeof r.value !== 'string') errors.push(`${where}: semantic_mock needs the value shown`);
        if (r.method === 'solid_mask' && r.value !== undefined) errors.push(`${where}: solid_mask carries no value`);
      });
    }

    const dims = manifest.screenshot_dimensions;
    if (!isObject(dims) || !Number.isInteger(dims.width) || !Number.isInteger(dims.height) || dims.width <= 0 || dims.height <= 0) {
      errors.push('screenshot_dimensions must be {width, height} positive integers');
    }

    const elements = manifest.dom_structure?.elements;
    if (!isObject(manifest.dom_structure) || !Array.isArray(elements)) {
      errors.push('dom_structure.elements must be an array');
    } else {
      elements.forEach((el, i) => {
        const where = `dom_structure.elements[${i}]`;
        if (!isObject(el)) return errors.push(`${where} must be an object`);
        checkKeys(el, ELEMENT_KEYS, where, errors);
        if (typeof el.ref !== 'string' || !/^e\d+$/.test(el.ref)) errors.push(`${where}.ref must look like e1`);
        if (!isShortString(el.role, 40)) errors.push(`${where}.role must be a string`);
        if (!isShortString(el.name, 80)) errors.push(`${where}.name must be a string of at most 80 characters`);
        checkBbox(el.bbox, where, errors);
        for (const flag of ['filled', 'redacted', 'disabled']) {
          if (el[flag] !== undefined && typeof el[flag] !== 'boolean') errors.push(`${where}.${flag} must be a boolean`);
        }
      });
    }
    return errors;
  }

  return { validate, METHODS, SOURCES };
})();

// Export for Node-based tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.PrivagRedactionManifest;
}
