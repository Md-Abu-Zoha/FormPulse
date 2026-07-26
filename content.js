// =============================================================================
//  SmartFill – content.js  (MV3 Content Script)
// =============================================================================

(() => {

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const TAG = "[SmartFill CS]";

const ACTION = {
  FILL_FORM: "FILL_FORM",
  PING:      "PING",
};

// ─── CSS INJECTION ────────────────────────────────────────────────────────────
// Inject visual confidence markers for AI-filled vs TODO fields.
(function injectStyles() {
  const style = document.createElement('style');
  style.id = 'smartfill-styles';
  style.textContent = `
    .smartfill-ai {
      outline: 2px solid rgba(147, 51, 234, 0.6) !important;
      background-color: rgba(147, 51, 234, 0.07) !important;
      transition: outline 0.3s ease, background-color 0.3s ease;
    }
    .smartfill-local {
      outline: 2px solid rgba(34, 197, 94, 0.6) !important;
      background-color: rgba(34, 197, 94, 0.07) !important;
      transition: outline 0.3s ease, background-color 0.3s ease;
    }
    .smartfill-marker {
      outline: 2px solid rgba(234, 179, 8, 0.8) !important;
      background-color: rgba(234, 179, 8, 0.12) !important;
      transition: outline 0.3s ease, background-color 0.3s ease;
    }
    .smartfill-prefilled {
      outline: 2px dashed rgba(156, 163, 175, 0.8) !important;
      background-color: rgba(156, 163, 175, 0.05) !important;
      transition: outline 0.3s ease, background-color 0.3s ease;
    }
  `;
  const target = document.head || document.documentElement;
  if (target && !document.getElementById('smartfill-styles')) {
    target.appendChild(style);
  }
})();

// ─── FIELD SELECTOR ──────────────────────────────────────────────────────────

const FIELD_SELECTOR = [
  'input[type="text"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[type="number"]',
  'input[type="url"]',
  'input[type="date"]',
  'input[type="month"]',
  'input[type="week"]',
  'input[type="time"]',
  'input[type="datetime-local"]',
  'input[type="radio"]',
  'input[type="checkbox"]',
  'input:not([type])',
  "textarea",
  "select",
  '[role="textbox"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  'div[contenteditable="true"]',
  'span[contenteditable="true"]',
]
  .map((s) => `${s}:not([disabled]):not([readonly]):not([hidden])`)
  .join(", ");

const DEBOUNCE_DELAY_MS = 400;
const PRECEDING_TEXT_MAX_CHARS = 200;
const PROCESSED_ATTR = "data-sf-id";

// ─── LOGGING ─────────────────────────────────────────────────────────────────

const log = {
  info:  (...a) => {},
  warn:  (...a) => {},
  error: (...a) => console.error(TAG, ...a),
  debug: (...a) => {},
};

// ─── FIELD REGISTRY ──────────────────────────────────────────────────────────

/**
 * @type {Map<string, FieldDescriptor>}
 */
const fieldRegistry = new Map();

let _idCounter = 0;
function nextFieldId() {
  _idCounter++;
  return `sf_${String(_idCounter).padStart(4, "0")}`;
}

// ─── CONTEXT EXTRACTOR ───────────────────────────────────────────────────────

function resolveIdRef(el, attr) {
  const ref = el.getAttribute(attr);
  if (!ref) return "";
  return ref
    .trim()
    .split(/\s+/)
    .map((id) => {
      const target = document.getElementById(id);
      return target ? (target.textContent ?? "").trim() : "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Extract the best human-readable label for a form field.
 * Priority: <label for=>, ancestor <label>, aria-labelledby, placeholder, name, id
 */
function extractLabel(el) {
  // 1. <label for="id"> association
  const ownId = el.id;
  if (ownId) {
    try {
      const associated = document.querySelector(`label[for="${CSS.escape(ownId)}"]`);
      if (associated) {
        const clone = associated.cloneNode(true);
        clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
        const text = clone.textContent?.trim();
        if (text) return text;
      }
    } catch {}
  }

  // 2. Ancestor <label> (React/Vue wrap inputs inside labels)
  let ancestor = el.parentElement;
  for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
    if (ancestor.tagName === "LABEL") {
      const clone = ancestor.cloneNode(true);
      clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
      const text = clone.textContent?.trim();
      if (text) return text;
    }
  }

  // 3. aria-labelledby
  const labelledBy = resolveIdRef(el, "aria-labelledby");
  if (labelledBy) return labelledBy;

  // 4. Attributes in priority order
  for (const attr of ["aria-label", "placeholder", "title", "name"]) {
    const val = el.getAttribute(attr);
    if (val?.trim()) return val.trim();
  }

  // 5. Try to find a nearby <label>, <th>, or <dt> element in the same table row/form group
  const row = el.closest("tr, .form-group, .field, li");
  if (row) {
    const label = row.querySelector("label, th, dt, span, legend");
    if (label) {
      const text = label.textContent?.trim();
      if (text && text.length < 80) return text;
    }
  }

  // 6. Walk up ancestor chain looking for a labelling sibling at each level.
  // Handles Bootstrap/React grids where input is deeply nested:
  // input → react-wrapper → col-md-9 → form-row → [col-md-3 label is here]
  let node = el.parentElement;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    const container = node.parentElement;
    if (!container) break;

    const siblings = Array.from(container.children);
    const nodeIdx  = siblings.indexOf(node);

    for (let i = nodeIdx - 1; i >= 0; i--) {
      const sib = siblings[i];
      // Skip siblings that themselves contain form inputs
      if (sib.querySelector("input, textarea, select")) continue;

      // Prefer an actual <label> element
      const labelEl = sib.tagName === "LABEL" ? sib : sib.querySelector("label");
      if (labelEl) {
        const t = labelEl.textContent?.trim();
        if (t && t.length > 0 && t.length < 80) return t;
      }

      // Fall back to any text-containing sibling
      const t = sib.textContent?.trim();
      if (t && t.length > 0 && t.length < 80) return t;
    }
  }

  // 7. Walk up tree looking for any preceding text node as absolute fallback

  try {
    let node = el.previousSibling;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim()) {
        return node.nodeValue.trim();
      }
      if (node.nodeType === Node.ELEMENT_NODE && !node.querySelector("input, textarea, select")) {
        const text = node.textContent?.trim();
        if (text && text.length < 80) return text;
      }
      node = node.previousSibling;
    }
  } catch {}

  return "";
}


/**
 * FIX 4 — Collect a small amount of preceding DOM text for additional context.
 * Scoped to the nearest structural ancestor (fieldset, .form-group, li, tr) first
 * to avoid picking up nav bar / cookie banner noise. Falls back to a page-wide
 * text walk only if no structural ancestor is found.
 */
function extractPrecedingContext(el) {
  try {
    // Try to scope text collection to the nearest meaningful structural container.
    // Includes modal/dialog boundaries to prevent reading background page text.
    const scopeRoot = el.closest(
      "fieldset, .form-group, .form-field, .field-wrapper, .input-group, li, tr, [role='group'], dialog, [role='dialog'], .modal, .popup, [class*='modal']"
    ) ?? document.body;

    const walker = document.createTreeWalker(
      scopeRoot,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue?.trim()) return NodeFilter.FILTER_SKIP;
          if (el.contains(node)) return NodeFilter.FILTER_SKIP;
          const parentTag = node.parentElement?.tagName?.toUpperCase() ?? "";
          if (parentTag === "SCRIPT" || parentTag === "STYLE" || parentTag === "NOSCRIPT") {
            return NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const allTextNodes = [];
    while (walker.nextNode()) {
      allTextNodes.push(walker.currentNode);
    }

    const preceding = allTextNodes.filter(
      (node) => el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING
    );

    let context = "";
    for (let i = preceding.length - 1; i >= 0; i--) {
      const chunk = preceding[i].nodeValue?.trim() ?? "";
      context = chunk + " " + context;
      if (context.length >= PRECEDING_TEXT_MAX_CHARS) break;
    }
    return context.trim().slice(-PRECEDING_TEXT_MAX_CHARS);
  } catch {
    return "";
  }
}

// ─── FIELD DISCOVERY ─────────────────────────────────────────────────────────

function pruneRegistry() {
  for (const [id, descriptor] of fieldRegistry) {
    const el = descriptor.element;
    // Shadow DOM elements are inside a shadowRoot, not document directly.
    // Use getRootNode() to find the root and check if it's connected to the page.
    const root = el.getRootNode();
    const isConnected = el.isConnected || (root instanceof ShadowRoot && root.host?.isConnected);
    if (!isConnected) {
      el.removeAttribute(PROCESSED_ATTR);
      fieldRegistry.delete(id);
    }
  }
}

function isElementVisible(el) {
  const type = el.type || el.getAttribute("role");
  const isCheckable = type === "radio" || type === "checkbox";

  let node = el;
  for (let depth = 0; node && node !== document.body && depth < 5; depth++, node = node.parentElement) {
    const cs = window.getComputedStyle(node);
    
    // If a PARENT is hidden, the whole section is hidden (skip it).
    // If the INPUT ITSELF is visually hidden, but it's a radio/checkbox, allow it (custom styling technique).
    if (cs.display === "none" && !(isCheckable && node === el)) {
      return false;
    }
    if (cs.visibility === "hidden" && !(isCheckable && node === el)) {
      return false;
    }
    if (cs.opacity === "0" && !(isCheckable && node === el)) {
      return false;
    }
  }
  const rect = el.getBoundingClientRect();
  return (rect.width > 0 && rect.height > 0) || isCheckable;
}

/**
 * FIX 3 — Extract up to MAX_SELECT_OPTIONS option texts from a <select> element.
 * Returned as a bracketed hint string like "[Options: A, B, C]" so the AI
 * outputs the exact vocabulary present in the dropdown.
 */
const MAX_SELECT_OPTIONS = 20;
function extractSelectOptions(el) {
  if (el.tagName !== "SELECT") return "";
  const opts = Array.from(el.options)
    .map(o => o.text.trim())
    .filter(t => t && t.toLowerCase() !== "select" && t.toLowerCase() !== "please select" && !t.startsWith("--"));
  if (opts.length === 0) return "";
  const sample = opts.slice(0, MAX_SELECT_OPTIONS);
  const suffix = opts.length > MAX_SELECT_OPTIONS ? `, …+${opts.length - MAX_SELECT_OPTIONS} more` : "";
  return `[Options: ${sample.join(", ")}${suffix}]`;
}

function processElement(el) {
  if (el.hasAttribute(PROCESSED_ATTR)) return;
  if (!isElementVisible(el)) return;

  let label   = extractLabel(el);
  let context = extractPrecedingContext(el);
  const inputType = el.getAttribute("type") || el.getAttribute("role") || null;

  // FIX 3 — Append select options to context so AI outputs the exact option text.
  if (el.tagName === "SELECT") {
    const optHint = extractSelectOptions(el);
    if (optHint) context = context ? `${context} ${optHint}` : optHint;
  }

  // FIX 4 — Append placeholder to context so AI knows format requirements (like DD/MM/YYYY)
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) {
    const phHint = `[Placeholder: ${placeholder.trim()}]`;
    context = context ? `${context} ${phHint}` : phHint;
  }

  // Special handling for radio buttons and checkboxes:
  // Build a compound label like "Gender: Male" so the AI knows both the group AND the option.
  if (inputType === "radio" || inputType === "checkbox") {
    const optionValue = el.value || el.getAttribute("data-value") || el.textContent?.trim() || "";
    // Find the group label (the question, e.g. "Gender") by walking up to the fieldset or form row
    const groupEl = el.closest("fieldset, [role='group'], [role='radiogroup'], .form-group, tr, .row, div.col");
    let groupLabel = "";
    if (groupEl) {
      const legend = groupEl.querySelector("legend, label:not([for])");
      if (legend) groupLabel = legend.textContent?.trim() || "";
    }
    // The label for the individual option
    const optionLabel = label || optionValue;
    // Combine: "Gender: Male"
    if (groupLabel && optionLabel && !optionLabel.toLowerCase().includes(groupLabel.toLowerCase())) {
      label = `${groupLabel}: ${optionLabel}`;
    } else if (!label && optionValue) {
      label = optionValue;
    }
  }

  const descriptor = {
    id:          nextFieldId(),
    element:     el,
    label:       label || "(unlabelled)",
    context,
    tagName:     el.tagName.toLowerCase(),
    inputType,
    role:        el.getAttribute("role") ?? null,
    isEditable:  el.getAttribute("contenteditable") === "true",
    discoveredAt: Date.now(),
  };

  el.setAttribute(PROCESSED_ATTR, descriptor.id);
  fieldRegistry.set(descriptor.id, descriptor);

  log.debug(
    `Field registered [${descriptor.id}] label: "${descriptor.label}"`,
    el
  );
}

/**
 * FIX 1 — Shadow DOM: Recursively query fields from a root, descending into
 * any shadow roots encountered. Falls back gracefully to a standard
 * querySelectorAll on browsers / elements that don't support shadow roots.
 *
 * @param {Document|ShadowRoot|HTMLElement} root
 * @returns {Element[]}
 */
function querySelectorAllDeep(root) {
  const results = [];
  try {
    const directMatches = root.querySelectorAll(FIELD_SELECTOR);
    results.push(...directMatches);

    // Walk ALL descendants to find shadow hosts and recurse into their shadow roots
    const allNodes = root.querySelectorAll("*");
    for (const node of allNodes) {
      if (node.shadowRoot) {
        results.push(...querySelectorAllDeep(node.shadowRoot));
      }
    }
  } catch {
    // Shadow root access may throw on certain cross-origin scenarios — ignore silently
  }
  return results;
}

/**
 * Scan the DOM (including shadow roots) and register any new fields.
 * ⚠️ This does NOT trigger an AI call. It only populates fieldRegistry.
 * The AI call is only triggered by the user explicitly clicking "Auto-Fill Page".
 */
function scanForFields() {
  pruneRegistry();

  // FIX 1 — Use the deep walker so shadow-root inputs are also discovered.
  const candidates = querySelectorAllDeep(document);
  let newCount = 0;

  for (const el of candidates) {
    const existingId = el.getAttribute(PROCESSED_ATTR);
    
    if (existingId) {
      const descriptor = fieldRegistry.get(existingId);
      // If the ID isn't in our registry, OR the registered element is a completely 
      // different DOM node, this element was cloned by the website (e.g. clicking 'Add').
      // We must strip the copied attributes and treat it as a brand new field.
      if (!descriptor || descriptor.element !== el) {
        el.removeAttribute(PROCESSED_ATTR);
        el.classList.remove("smartfill-ai", "smartfill-local", "smartfill-marker");
        processElement(el);
        newCount++;
      }
    } else {
      processElement(el);
      newCount++;
    }
  }

  log.info(`Scan complete: +${newCount} new field(s) | Total in registry: ${fieldRegistry.size}`);
  return newCount;
}

// ─── SERIALIZATION ───────────────────────────────────────────────────────────

function serializeFields(isAutoPilot = false) {
  const fieldsToSend = [];
  for (const descriptor of fieldRegistry.values()) {
    const el = descriptor.element;
    
    // Skip if SmartFill already filled this field
    if (el.classList.contains("smartfill-ai") || 
        el.classList.contains("smartfill-local") || 
        el.classList.contains("smartfill-marker")) {
      continue;
    }
    
    // Skip if AutoPilot is running and we already tried this field.
    // This stops AutoPilot from constantly retrying fields the AI skipped.
    if (isAutoPilot && descriptor.sentToAI) continue;

    const hasTextContent = descriptor.isEditable && el.textContent.trim() !== "";
    const hasInputValue = !descriptor.isEditable && 
                          el.type !== "checkbox" && el.type !== "radio" && 
                          el.tagName !== "SELECT" && el.type !== "hidden" && 
                          el.value && el.value.trim() !== "";

    if (hasTextContent || hasInputValue) {
      descriptor.hasPreexistingValue = true;
      el.classList.add("smartfill-prefilled");
      
      // AutoPilot must NEVER overwrite fields you are typing in
      if (isAutoPilot) {
        continue;
      }
      // Manual click: we DO NOT continue. We will send it to the background 
      // so it can check if a Green (Local/Vault) match exists to overwrite it.
    } else {
      descriptor.hasPreexistingValue = false;
    }

    descriptor.sentToAI = true;
    
    fieldsToSend.push({
      id: descriptor.id,
      label: descriptor.label,
      context: descriptor.context,
      tagName: descriptor.tagName,
      inputType: descriptor.inputType,
      role: descriptor.role,
      isEditable: descriptor.isEditable,
    });
  }
  return fieldsToSend;
}

// ─── FILL TRIGGER ────────────────────────────────────────────────────────────

/**
 * Send all registered fields to the background service worker for AI processing.
 * This is the ONLY place we contact the background for a fill. It only runs
 * when the user explicitly clicks the "Auto-Fill Page" button.
 */
function requestFillFromBackground(isAutoPilot = false) {
  const fields = serializeFields(isAutoPilot);

  if (fields.length === 0) {
    log.warn("No fields in registry to fill. Scan may have found nothing.");
    return;
  }

  log.info(`Requesting fill for ${fields.length} field(s) from SW…`);

  chrome.runtime.sendMessage(
    {
      action: ACTION.FILL_FORM,
      data:   { fields, url: location.href },
    },
    (response) => {
      if (chrome.runtime.lastError) {
        log.error("SW message error:", chrome.runtime.lastError.message);
        return;
      }

      if (!response) {
        log.warn("No response from SW.");
        return;
      }

      if (!response.success) {
        log.error("SW returned error:", response.error);
        // Show error visually if we can
        alert(`SmartFill Error: ${response.error}`);
        return;
      }

      log.info("SW fill suggestions received:", response.suggestions);
      applyFillSuggestions(response.suggestions ?? {});
    }
  );
}

// ─── APPLY FILL SUGGESTIONS ──────────────────────────────────────────────────

/**
 * Set a value on a native <select> element by fuzzy-matching the AI's text
 * to the available <option> elements.
 * Match priority: exact value → exact text → case-insensitive → partial contains.
 *
 * @param {HTMLSelectElement} el
 * @param {string} value
 * @returns {boolean} true if an option was found and selected
 */
function setSelectValue(el, value) {
  if (!value) return false;
  const target = value.trim().toLowerCase();
  const options = Array.from(el.options);

  // 1. Exact value match (case-insensitive)
  let match = options.find(o => o.value.toLowerCase() === target);
  // 2. Exact text match (case-insensitive)
  if (!match) match = options.find(o => o.text.trim().toLowerCase() === target);
  // 3. Starts-with: target starts option text (e.g. "India" matches "India (IN)")
  if (!match) match = options.find(o => o.text.trim().toLowerCase().startsWith(target));
  // 4. Target starts option: option starts with target (e.g. "ind" → "India")
  //    Requires target to be at least 3 chars to avoid "in" matching "Indonesia" AND "Iceland"
  if (!match && target.length >= 3) {
    match = options.find(o => o.text.trim().toLowerCase().startsWith(target));
  }
  // 5. Contains: option text fully contains the target word
  if (!match) match = options.find(o => o.text.trim().toLowerCase().includes(target));

  // 6. SAFE reverse: only if option value is >= 3 chars (prevents "in" matching Iceland)
  //    AND the option value is a full word boundary inside the target.
  if (!match) {
    match = options.find(o => {
      const v = o.value.toLowerCase();
      return v.length >= 3 && target.includes(v) && (
        target === v || target.startsWith(v + ' ') || target.endsWith(' ' + v)
      );
    });
  }

  // 7. Scored fuzzy fallback — Levenshtein distance, pick lowest distance
  //    Only fires if nothing matched above, and only if distance is small relative to word length.
  if (!match) {
    function levenshtein(a, b) {
      const dp = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
      );
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          dp[i][j] = a[i-1] === b[j-1]
            ? dp[i-1][j-1]
            : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        }
      }
      return dp[a.length][b.length];
    }

    let bestScore = Infinity;
    let bestOption = null;
    const threshold = Math.max(2, Math.floor(target.length * 0.3)); // max 30% diff

    for (const o of options) {
      const optText = o.text.trim().toLowerCase();
      if (!optText || optText === 'select' || optText === 'choose') continue;
      const dist = levenshtein(target, optText);
      if (dist < bestScore && dist <= threshold) {
        bestScore = dist;
        bestOption = o;
      }
    }
    match = bestOption;
  }

  if (match) {
    el.value = match.value;
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("input",  { bubbles: true, composed: true }));
    log.info(`✓ Select matched "${value}" → option "${match.text}" (value="${match.value}")`);
    return true;
  }

  log.warn(`setSelectValue: no option matched "${value}" in <select> with ${options.length} options.`);
  return false;
}

/**
 * Set a value on an input/textarea element, handling both:
 *   a) Plain HTML inputs — fast native setter path
 *   b) React-controlled inputs (including date pickers) — simulate typing
 *
 * @param {HTMLElement} el
 * @param {string} value
 */
function setInputValue(el, value) {
  // Native date inputs STRICTLY require YYYY-MM-DD format
  if (el.type === "date" && value) {
    const d = new Date(value);
    if (!isNaN(d)) {
      value = d.toISOString().split('T')[0];
    }
  }

  // Bypass readonly locks often used by custom DatePickers
  const wasReadOnly = el.readOnly;
  if (wasReadOnly) el.readOnly = false;

  el.focus();
  
  try {
    // Select existing text so insertText overwrites it
    el.select();
  } catch (e) {
    // .select() may throw on certain input types (like email/number) in some browsers
  }

  // Safest method: Simulate a native user "paste".
  // This allows React/Vue masks to safely intercept, filter, and format the input
  // without crashing the page (which happens when forcing raw values via prototype setters).
  const success = document.execCommand("insertText", false, value);

  // Fallback if insertText fails (e.g., blocked by browser security context)
  if (!success) {
    try {
      let nativeSetter = null;
      if (el instanceof HTMLTextAreaElement) {
        nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      } else if (el instanceof HTMLInputElement) {
        nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      }

      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }
    } catch (err) {
      el.value = value;
    }

    // Fire synthetic events for the fallback
    el.dispatchEvent(new Event("input",  { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  } else {
    // For successful paste, dispatch change to commit
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  // Dispatch blur to commit changes and close popups
  el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));

  // Restore the readonly lock if we removed it
  if (wasReadOnly) el.readOnly = true;
}

/**
 * Simulate a realistic user click, which is necessary for many custom
 * UI libraries (like Google Forms) that listen to pointer/mouse events.
 * It fires events on the element AND all its children to ensure we hit
 * whatever specific span/div has the event listener attached.
 */
function simulateClick(elem) {
  const opts = { bubbles: true, cancelable: true, composed: true };
  
  // Fire on the element itself and all its internal children
  const targets = [elem, ...Array.from(elem.querySelectorAll('*'))];
  
  for (const target of targets) {
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', opts));
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new PointerEvent('pointerup', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.click();
    } catch {}
  }
}

/**
 * Site-Specific Adapter: Google Forms
 * Google uses a highly proprietary DOM structure for their dropdowns,
 * appending portals to the body and blocking standard programmatic clicks.
 */
const GoogleFormsAdapter = {
  async fillDropdown(el, value) {
    if (!value) return false;
    
    // 1. Open the dropdown via simulated physical click
    el.focus();
    simulateClick(el);
    
    // 2. Wait for Google's `exportSelectPopup` to animate in (takes ~300-400ms)
    await new Promise(r => setTimeout(r, 400));
    
    // 3. Find the options in the portal. Google uses role="option" and data-value.
    const target = value.trim().toLowerCase();
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    
    let match = options.find(o => {
      const dataVal = (o.getAttribute('data-value') || '').trim().toLowerCase();
      const textVal = (o.textContent || '').trim().toLowerCase();
      return dataVal === target || textVal === target;
    });
    
    if (!match) {
      match = options.find(o => {
        const dataVal = (o.getAttribute('data-value') || '').trim().toLowerCase();
        const textVal = (o.textContent || '').trim().toLowerCase();
        return dataVal.includes(target) || textVal.includes(target);
      });
    }
    
    if (match) {
      try { match.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
      // Wait for the browser to repaint the new scroll position before grabbing coordinates
      await new Promise(r => setTimeout(r, 100));
      
      // Google options need the exact same physical click simulation
      simulateClick(match);
      log.info(`✓ [Google Forms Adapter] matched "${value}" → option "${match.getAttribute('data-value') || match.textContent.trim()}"`);
      
      // Wait for it to close before moving to the next field
      await new Promise(r => setTimeout(r, 200));
      return true;
    }
    
    log.warn(`[Google Forms Adapter] no option matched "${value}".`);
    document.body.click();
    await new Promise(r => setTimeout(r, 200));
    return false;
  }
};

/**
 * Experimental heuristic to handle custom div-based dropdowns (like Google Forms listboxes).
 * 1. Click the listbox to open the dropdown menu.
 * 2. Wait a brief moment for the menu to render (often in a React portal or body).
 * 3. Find the option with the matching text and click it.
 *
 * @param {HTMLElement} el
 * @param {string} value
 */
async function setListboxValue(el, value) {
  if (!value) return false;
  
  // 1. Click to open
  el.focus();
  simulateClick(el);
  
  // 2. Wait for the popup/portal to appear and animations to finish
  await new Promise(r => setTimeout(r, 300));
  
  // 3. Find the option. Google forms and most UI libs use role="option".
  const target = value.trim().toLowerCase();
  
  // Use deep query in case the portal is inside a shadow root
  const options = Array.from(querySelectorAllDeep(document).filter(n => n.getAttribute('role') === 'option'));
  
  // We don't filter by visibility because animations might cause bounding rects to be 0 temporarily.
  // Just find the option that matches text or data-value.
  
  // 1. Exact text or data-value match
  let match = options.find(o => {
    const text = o.textContent.trim().toLowerCase();
    const dataVal = (o.getAttribute('data-value') || '').trim().toLowerCase();
    return text === target || dataVal === target;
  });
  
  // 2. Contains match
  if (!match) {
    match = options.find(o => {
      const text = o.textContent.trim().toLowerCase();
      const dataVal = (o.getAttribute('data-value') || '').trim().toLowerCase();
      return text.includes(target) || dataVal.includes(target);
    });
  }
  
  if (match) {
    try { match.scrollIntoView({ block: "center", inline: "nearest" }); } catch {}
    // Wait for the browser to repaint the new scroll position before grabbing coordinates
    await new Promise(r => setTimeout(r, 100));
    
    simulateClick(match);
    log.info(`✓ Listbox matched "${value}" → option "${match.textContent.trim()}"`);
    return true;
  }
  
  log.warn(`setListboxValue: no option matched "${value}".`);
  
  // If we didn't find a match, close the listbox by clicking elsewhere so it doesn't stay open
  document.body.click();
  return false;
}

/**
 * Apply the SW's fill suggestions back into the live DOM elements.
 * Handles React/Vue native setter override and fires synthetic events.
 *
 * @param {Record<string, { val: string, state: string }>} suggestions
 */
async function applyFillSuggestions(suggestions) {
  const entries = Object.entries(suggestions);
  if (entries.length === 0) {
    log.warn("Received empty suggestions object.");
    return;
  }

  let applied = 0;
  let skipped = 0;

  for (const [fieldId, suggestion] of entries) {
    if (!suggestion) { skipped++; continue; }

    const value = typeof suggestion === "string" ? suggestion : suggestion.val;
    const state = typeof suggestion === "string" ? "AI"  : (suggestion.state || "AI");

    if (!value && value !== "0") { skipped++; continue; }

    const descriptor = fieldRegistry.get(fieldId);
    if (!descriptor) {
      log.warn(`No registry entry for field ID "${fieldId}" — skipping.`);
      skipped++;
      continue;
    }

    if (descriptor.hasPreexistingValue && state !== "LOCAL") {
      log.info(`Skipping pre-filled field "${fieldId}" because suggestion is not LOCAL.`);
      skipped++;
      continue;
    }

    const el = descriptor.element;
    if (!document.contains(el)) {
      log.warn(`Element "${fieldId}" detached from DOM — skipping.`);
      skipped++;
      continue;
    }

    // Apply visual confidence CSS class. If it's overwriting a pre-filled field, it drops the dashed grey border.
    el.classList.remove("smartfill-ai", "smartfill-local", "smartfill-marker", "smartfill-prefilled");
    if (state === "LOCAL")  el.classList.add("smartfill-local");
    else if (state === "MARKER") el.classList.add("smartfill-marker");
    else                    el.classList.add("smartfill-ai");

    try {
      if (descriptor.isEditable) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      } else {
        const role = el.getAttribute("role");
        if (el.type === "checkbox" || el.type === "radio" || role === "checkbox" || role === "radio") {
          // Case-insensitive match: check if AI's value contains or matches this option's value
          const elVal   = (el.value || el.getAttribute("data-value") || el.textContent || "").toLowerCase().trim();
          const aiVal   = value.toLowerCase().trim();
          
          // If the AI explicitly says "no" or "false" (meaning do not check this option),
          // we must NOT check it, even if the option's text happens to literally be "No".
          const isExplicitlyNegative = (aiVal === "false" || aiVal === "no" || aiVal === "unchecked");
          
          const shouldCheck = (
            aiVal === "true" ||
            aiVal === "yes" ||
            aiVal === "checked" ||
            (!isExplicitlyNegative && (
              aiVal === elVal ||
              aiVal.includes(elVal) ||
              (elVal.length > 0 && aiVal.split(/[,;/]+/).map(v => v.trim()).some(v => v === elVal))
            ))
          );
          if (shouldCheck) {
            // Use .click() — React listens to the real browser click event
            el.focus();
            el.click();
            // Also set directly as fallback for non-React forms or custom elements
            if (el.checked !== undefined && !el.checked) {
              el.checked = true;
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } else if (role === "checkbox" || role === "radio") {
              el.setAttribute("aria-checked", "true");
            }
            log.info(`✓ Clicked [${el.type || role}] "${descriptor.label}" (value="${elVal}")`);
          }
        } else {
          // Route <select> to the smart fuzzy matcher, listbox to heuristic clicker, everything else to setInputValue
          if (el.tagName === "SELECT") {
            // Vault-safety: if this value came from the Memory Vault (LOCAL state),
            // confirm the saved text actually exists in THIS dropdown's options before using it.
            // Dropdown option lists differ across websites, so a Vault value like "comp engg"
            // won't match any real option and the fuzzy matcher will pick something wrong.
            if (state === "LOCAL") {
              const options = Array.from(el.options).map(o => o.text.trim().toLowerCase());
              const needle  = value.toLowerCase();
              const hasMatch = options.some(opt =>
                opt === needle ||
                opt.includes(needle) ||
                needle.includes(opt.substring(0, Math.min(opt.length, 6)))
              );
              if (!hasMatch) {
                log.warn(`Vault value "${value}" for <select> "${descriptor.label}" has no matching option — skipping Vault, deferring to AI.`);
                // Remove the visual class so the field stays neutral for the AI to fill
                el.classList.remove("smartfill-local");
                skipped++;
                continue;
              }
            }
            setSelectValue(el, value);
          } else if (role === "listbox") {
            if (window.location.hostname.includes("docs.google.com")) {
              await GoogleFormsAdapter.fillDropdown(el, value);
            } else {
              await setListboxValue(el, value);
            }
          } else {
            setInputValue(el, value);
          }
        }
      }

      log.info(`✓ [${state}] Filled "${descriptor.label}" → "${value}"`);
      applied++;
    } catch (err) {
      log.error(`Failed to fill field [${fieldId}] "${descriptor.label}":`, err);
      skipped++;
    }
  }

  log.info(`Fill complete: ${applied} applied, ${skipped} skipped out of ${entries.length} suggestions.`);
}

// ─── MUTATION OBSERVER ────────────────────────────────────────────────────────

let _debounceTimer = null;
let _autoPilotEnabled = false;

// Initialize Auto-Pilot state from storage
chrome.storage.local.get(['autoPilotEnabled'], (res) => {
  _autoPilotEnabled = !!res.autoPilotEnabled;
});

// Listen for Auto-Pilot state changes from the popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoPilotEnabled !== undefined) {
    _autoPilotEnabled = changes.autoPilotEnabled.newValue;
    log.info(`Auto-Pilot mode is now ${_autoPilotEnabled ? 'ON' : 'OFF'}`);
    
    // If just turned on, scan immediately in case new fields appeared while toggling
    if (_autoPilotEnabled) debouncedScan();
  }
});

function debouncedScan() {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    const newCount = scanForFields();
    if (newCount > 0 && _autoPilotEnabled) {
      log.info(`Auto-Pilot detected ${newCount} new fields. Triggering background AI auto-fill...`);
      requestFillFromBackground(true);
    }
  }, 1000); // 1-second debounce to batch multiple fields appearing sequentially
}

function handleMutations(records) {
  let shouldScan = false;
  for (const record of records) {
    if (record.type === "childList" && (record.addedNodes.length > 0 || record.removedNodes.length > 0)) {
      shouldScan = true;
      break;
    }
    if (record.type === "attributes") {
      shouldScan = true;
      break;
    }
  }
  if (shouldScan) debouncedScan();
}

function startObserver() {
  const observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    subtree:       true,
    childList:     true,
    attributes:    true,
    attributeFilter: ['class', 'style', 'hidden'],
    characterData: false,
  });
  log.info("MutationObserver started.");
  return observer;
}

// ─── MESSAGE LISTENER ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { action } = message ?? {};
  log.debug("Message received:", action);

  switch (action) {

    case "TRIGGER_SCAN": {
      // User clicked "Auto-Fill Page" in the popup.
      // Step 1: Clear old registry. Use the deep walker to also clear attributes
      // on shadow DOM elements which document.querySelectorAll would miss.
      querySelectorAllDeep(document)
        .filter(el => el.hasAttribute(PROCESSED_ATTR))
        .forEach(el => el.removeAttribute(PROCESSED_ATTR));
      // Also sweep the light DOM as a fast fallback
      document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach(el => el.removeAttribute(PROCESSED_ATTR));
      fieldRegistry.clear();
      _idCounter = 0;

      // Step 2: Discover all fields on the page right now.
      scanForFields();

      // Step 3: ONLY NOW send them to the background for AI processing.
      requestFillFromBackground();

      sendResponse({ ok: true, fieldCount: fieldRegistry.size });
      break;
    }

    case "PING": {
      sendResponse({ ok: true });
      break;
    }

    case "AUTO_PILOT_ENABLED": {
      _autoPilotEnabled = true;
      scanForFields();
      sendResponse({ ok: true });
      break;
    }

    case "AUTO_PILOT_DISABLED": {
      _autoPilotEnabled = false;
      sendResponse({ ok: true });
      break;
    }

    case "GET_FIELDS": {
      sendResponse({ ok: true, fields: serializeFields() });
      break;
    }

    default:
      log.debug("Unhandled message:", action);
      return false;
  }

  return true;
});

// ─── SUBMIT INTERCEPTOR ───────────────────────────────────────────────────────

/**
 * Collect the current values of all filled fields in the registry.
 * Skips fields that: are empty, are sensitive (password/OTP), or were never filled.
 * Sends them to the background as a RECORD_MEMORY batch.
 */
function snapshotAndRecord() {
  const SENSITIVE_PATTERN = /password|passwd|otp|cvv|cvc|secret|biometric|fingerprint/i;
  const JUNK_PATTERN = /search|query|keyword|comment|message|notes|feedback/i;
  const pairs = [];

  for (const descriptor of fieldRegistry.values()) {
    // Skip unlabelled or sensitive fields
    if (!descriptor.label || descriptor.label === "(unlabelled)") continue;
    if (SENSITIVE_PATTERN.test(descriptor.label)) continue;
    
    // Skip likely junk fields (searches, comment boxes)
    if (JUNK_PATTERN.test(descriptor.label)) continue;

    const el = descriptor.element;
    if (!document.contains(el) && !el.isConnected) continue;

    let currentValue = "";
    if (descriptor.isEditable) {
      currentValue = el.textContent?.trim() ?? "";
    } else if (el.tagName === "SELECT") {
      // NEVER save <select> values to the vault.
      // Dropdown option lists are unique to each website — a saved answer like
      // "comp engg" won't exist as an option on a different site's dropdown,
      // and the fuzzy matcher will pick a completely wrong option instead.
      continue;
    } else if (el.type === "checkbox" || el.type === "radio") {
      // Only record if checked
      if (!el.checked) continue;
      currentValue = el.value || el.getAttribute("data-value") || descriptor.label;
    } else {
      currentValue = el.value?.trim() ?? "";
    }

    if (!currentValue) continue;
    // Skip placeholder/error values from our own extension
    if (currentValue.startsWith("[ERROR]") || currentValue.startsWith("[MARKER]")) continue;
    
    // Skip huge blocks of text (like essays or multi-paragraph feedback)
    if (currentValue.length > 100) continue;

    pairs.push({ label: descriptor.label, value: currentValue });
  }

  if (pairs.length === 0) return;

  log.info(`Submit interceptor: recording ${pairs.length} field(s) to Memory Vault.`);

  chrome.runtime.sendMessage({
    action: "RECORD_MEMORY",
    data: { pairs },
  }).catch(() => {
    // Silently ignore if SW is asleep — memory recording is best-effort
  });
}

/**
 * Attach submit interceptor to form submits and navigation buttons.
 * Uses event delegation on document so it works even with dynamically injected forms.
 */
function startSubmitInterceptor() {
  const NAV_BUTTON_PATTERN = /\b(next|submit|continue|save|proceed|done|finish|apply|send)\b/i;

  // 1. Standard HTML form submit
  document.addEventListener("submit", (e) => {
    if (e.target && e.target.tagName === "FORM") {
      snapshotAndRecord();
    }
  }, { capture: true, passive: true });

  // 2. Button/link clicks that navigate the form
  document.addEventListener("click", (e) => {
    const el = e.target?.closest("button, [role='button'], a, input[type='submit'], input[type='button']");
    if (!el) return;
    const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim();
    if (NAV_BUTTON_PATTERN.test(text)) {
      snapshotAndRecord();
    }
  }, { capture: true, passive: true });

  log.info("Submit interceptor active.");
}

// ─── INITIALISATION ───────────────────────────────────────────────────────────

(function init() {
  log.info("Content script initialised at", new Date().toISOString());
  log.info("URL:", location.href);

  // Discover fields on page load (passive — does NOT call the AI).
  // This pre-populates the registry so fills are instant when user clicks the button.
  scanForFields();

  // Watch for dynamic SPA route changes / multi-step forms.
  startObserver();

  // Watch for form submissions / navigation to learn from user-filled data.
  startSubmitInterceptor();
})();

})();
