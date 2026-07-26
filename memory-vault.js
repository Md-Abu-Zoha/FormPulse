// =============================================================================
//  SmartFill - memory-vault.js  (MV3 Service Worker Module)
//
//  The Dynamic Memory Vault is a self-learning lookup table.
//  It records what the user actually typed into each form field and uses that
//  data to fill identical fields instantly on future forms, with zero AI cost.
//
//  Architecture: Layer 0 (Vault) - Layer 1 (LocalMemory rules) - Layer 2 (AI)
//
//  Storage format (chrome.storage.local key: "smartfill_memory_vault"):
//  {
//    "college state": {
//      "West Bengal": { count: 5, lastSeen: 1721500000 }
//    },
//    "email": {
//      "user@gmail.com": { count: 15, lastSeen: 1721600000 }
//    }
//  }
//
//  Key normalization: lowercase, trim, strip trailing punctuation (* : ? ! ( ) [ ])
//  Full labels are kept intact so "College State" != "Home State".
// =============================================================================

const VAULT_STORE_KEY = "smartfill_memory_vault";
const MAX_VALUES_PER_KEY = 10;
const MAX_VAULT_KEYS = 500;
const TOP_CONTEXT_COUNT = 10;

const NEVER_RECORD_PATTERNS = [
  "password", "passwd", "passcode", "passphrase", "secret",
  "otp", "two-factor", "2fa", "totp", "mfa",
  "cvv", "cvc", "csc", "expiry", "cardnumber",
  "routingnumber", "iban", "bic", "swift",
  "biometric", "fingerprint",
];

function normalizeKey(label) {
  if (!label || typeof label !== "string") return "";
  return label
    .toLowerCase()
    .replace(/[*:!?()\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSensitiveLabel(label) {
  const lower = label.toLowerCase();
  return NEVER_RECORD_PATTERNS.some(p => lower.includes(p));
}

function wordOverlapScore(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

async function loadVault() {
  const result = await chrome.storage.local.get(VAULT_STORE_KEY);
  return result[VAULT_STORE_KEY] ?? {};
}

async function saveVault(vault) {
  await chrome.storage.local.set({ [VAULT_STORE_KEY]: vault });
}

function evictOldestKey(vault) {
  let oldestKey = null, oldestTime = Infinity;
  for (const k of Object.keys(vault)) {
    const vals = Object.values(vault[k] ?? {});
    const latest = vals.reduce((max, v) => Math.max(max, v.lastSeen ?? 0), 0);
    if (latest < oldestTime) { oldestTime = latest; oldestKey = k; }
  }
  if (oldestKey) delete vault[oldestKey];
}

function evictOldestValue(keyEntry) {
  const sorted = Object.entries(keyEntry).sort((a, b) => {
    const diff = a[1].count - b[1].count;
    return diff !== 0 ? diff : a[1].lastSeen - b[1].lastSeen;
  });
  if (sorted.length > 0) delete keyEntry[sorted[0][0]];
}

export const MemoryVault = Object.freeze({

  async get(label) {
    const key = normalizeKey(label);
    if (!key) return null;
    const vault = await loadVault();
    const entry = vault[key];
    if (!entry || typeof entry !== "object") return null;
    const values = Object.entries(entry);
    if (values.length === 0) return null;
    values.sort(([, a], [, b]) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeen - a.lastSeen;
    });
    return values[0][0];
  },

  async recordBatch(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return;
    const vault = await loadVault();
    const now = Date.now();
    for (const { label, value } of pairs) {
      const key = normalizeKey(label);
      if (!key) continue;
      if (!value || typeof value !== "string" || value.trim() === "") continue;
      if (value.startsWith("[ERROR]") || value.startsWith("[MARKER]")) continue;
      if (isSensitiveLabel(key)) continue;
      const trimmedValue = value.trim();
      if (!vault[key] && Object.keys(vault).length >= MAX_VAULT_KEYS) evictOldestKey(vault);
      if (!vault[key]) vault[key] = {};
      if (vault[key][trimmedValue]) {
        vault[key][trimmedValue].count += 1;
        vault[key][trimmedValue].lastSeen = now;
      } else {
        if (Object.keys(vault[key]).length >= MAX_VALUES_PER_KEY) evictOldestValue(vault[key]);
        vault[key][trimmedValue] = { count: 1, lastSeen: now };
      }
    }
    await saveVault(vault);
  },

  async getTopContext(targetLabel, n = TOP_CONTEXT_COUNT) {
    const vault = await loadVault();
    const vaultKeys = Object.keys(vault);
    if (vaultKeys.length === 0) return [];
    const normalizedTarget = normalizeKey(targetLabel);
    const scored = vaultKeys.map(k => {
      const score = wordOverlapScore(normalizedTarget, k);
      const values = Object.entries(vault[k] ?? {});
      if (values.length === 0) return null;
      values.sort(([, a], [, b]) => b.count - a.count || b.lastSeen - a.lastSeen);
      const [bestValue, meta] = values[0];
      return { key: k, value: bestValue, count: meta.count, score };
    }).filter(Boolean);
    scored.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.001) return b.score - a.score;
      return b.count - a.count;
    });
    const relevant = scored.filter(e => e.score > 0);
    const pool = relevant.length > 0 ? relevant : scored;
    return pool.slice(0, n).map(({ key, value, count }) => ({ key, value, count }));
  },

  async getAll() {
    const vault = await loadVault();
    return Object.entries(vault)
      .map(([key, valMap]) => {
        const values = Object.entries(valMap ?? {})
          .map(([value, meta]) => ({ value, count: meta.count, lastSeen: meta.lastSeen }))
          .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
        return { key, values };
      })
      .sort((a, b) => {
        const latestA = a.values[0]?.lastSeen ?? 0;
        const latestB = b.values[0]?.lastSeen ?? 0;
        return latestB - latestA;
      });
  },

  async deleteValue(key, value) {
    const vault = await loadVault();
    if (!vault[key]) return;
    delete vault[key][value];
    if (Object.keys(vault[key]).length === 0) delete vault[key];
    await saveVault(vault);
  },

  async editValue(key, oldValue, newValue) {
    if (!newValue || typeof newValue !== "string" || newValue.trim() === "") return;
    const trimmedNew = newValue.trim();
    if (oldValue === trimmedNew) return; // No change

    const vault = await loadVault();
    if (!vault[key] || !vault[key][oldValue]) return;

    const meta = vault[key][oldValue];
    delete vault[key][oldValue];

    // If the new value already exists, merge the counts
    if (vault[key][trimmedNew]) {
      vault[key][trimmedNew].count += meta.count;
      vault[key][trimmedNew].lastSeen = Math.max(vault[key][trimmedNew].lastSeen, meta.lastSeen);
    } else {
      vault[key][trimmedNew] = meta;
    }

    await saveVault(vault);
  },

  async deleteKey(key) {
    const vault = await loadVault();
    delete vault[key];
    await saveVault(vault);
  },

  async clear() {
    await chrome.storage.local.remove(VAULT_STORE_KEY);
  },

  async size() {
    const vault = await loadVault();
    return Object.keys(vault).length;
  },
});
