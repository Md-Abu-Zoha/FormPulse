// =============================================================================
//  SmartFill – background.js  (MV3 Service Worker)
// =============================================================================

import { CryptoVault } from './crypto-utils.js';
import { AiApiClient, SecurityGate, PayloadBuilder, SUPPORTED_PROVIDERS } from './api-handler.js';
import { MemoryVault } from './memory-vault.js';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const TAG = "[SmartFill SW]";

const ACTION = {
  FILL_FORM:          "FILL_FORM",
  GET_PROFILE:        "GET_PROFILE",
  SAVE_PROFILE:       "SAVE_PROFILE",
  SAVE_API_KEY:       "SAVE_API_KEY",
  GET_HISTORY:        "GET_HISTORY",
  CLEAR_HISTORY:      "CLEAR_HISTORY",
  // Memory Vault actions
  RECORD_MEMORY:      "RECORD_MEMORY",
  GET_VAULT:          "GET_VAULT",
  DELETE_VAULT_KEY:   "DELETE_VAULT_KEY",
  DELETE_VAULT_VALUE: "DELETE_VAULT_VALUE",
  CLEAR_VAULT:        "CLEAR_VAULT",
  PING:               "PING",
};

const STORE = {
  PROFILE: "smartfill_profile",
  HISTORY: "smartfill_history",
  SW_BOOT: "smartfill_sw_boot_count",
};

const MAX_HISTORY_ENTRIES = 50;

// ─── LOGGING ─────────────────────────────────────────────────────────────────

const log = {
  info: (...a) => {},
  warn: (...a) => {},
  error: (...a) => console.error(TAG, ...a),
  debug: (...a) => {},
  group: (l) => {},
  groupEnd: () => {},
};

// ─── STORAGE HELPERS ─────────────────────────────────────────────────────────

async function storageGet(key, fallback) {
  try {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return value !== undefined ? value : fallback;
  } catch (err) {
    log.error(`storageGet("${key}") failed:`, err);
    return fallback;
  }
}

async function storageSet(items) {
  try {
    await chrome.storage.local.set(items);
  } catch (err) {
    log.error("storageSet() failed:", err);
    throw err;
  }
}

async function appendHistory(entry) {
  const history = await storageGet(STORE.HISTORY, []);
  history.unshift({ ...entry, timestamp: entry.timestamp ?? Date.now() });
  if (history.length > MAX_HISTORY_ENTRIES) history.splice(MAX_HISTORY_ENTRIES);
  await storageSet({ [STORE.HISTORY]: history });
}

// ─── KEEP-ALIVE ──────────────────────────────────────────────────────────────

// ─── API CALL ────────────────────────────────────────────────────────────────

async function callFillAPI({ fields, url, userProfile, vaultContext = [] }) {
  log.group("callFillAPI");

  // Load the user's API key from the encrypted CryptoVault.
  // Try "smartfill" vault first (new), then fall back to "gemini" (old) for backward compatibility.
  let apiKey = await CryptoVault.loadApiKey("smartfill");
  if (!apiKey) apiKey = await CryptoVault.loadApiKey("gemini");

  if (!apiKey) {
    log.groupEnd();
    throw new Error(
      "No API key found. Open the SmartFill popup and paste either: " +
      "a Gemini key (starts with AQ.) OR a free Groq key (starts with gsk_) from console.groq.com"
    );
  }

  let provider = await storageGet('smartfill_selected_provider', null);
  let actualKey = apiKey.trim();

  // If we couldn't read from storage, fall back to auto-detect
  if (!provider) {
    provider = "gemini";
    if (actualKey.startsWith("gsk_")) provider = "groq";
    else if (actualKey.toLowerCase().startsWith("kimi:")) provider = "kimi";
    else if (actualKey.toLowerCase().startsWith("deepseek:")) provider = "deepseek";
  }

  // Strip prefix if the user typed it anyway
  if (actualKey.toLowerCase().startsWith("kimi:")) actualKey = actualKey.replace(/^kimi:\s*/i, "");
  else if (actualKey.toLowerCase().startsWith("deepseek:")) actualKey = actualKey.replace(/^deepseek:\s*/i, "");

  log.info(`API key loaded. Provider: ${provider}`);

  let result;
  try {
    result = await AiApiClient.fillFields({
      fields,
      url,
      userProfile,
      apiKey: actualKey,
      provider,
      timeoutMs: 25_000,
      vaultContext: vaultContext ?? [],
    });
  } catch (err) {
    log.error("AiApiClient.fillFields failed:", err);
    log.groupEnd();
    throw err;
  }

  log.info(
    `callFillAPI done: ${Object.keys(result.suggestions).length} suggestion(s), ` +
    `${result.blockedCount} blocked.`
  );
  log.groupEnd();
  return result;
}

// ─── MESSAGE HANDLERS ────────────────────────────────────────────────────────

async function handleFillForm(data) {
  log.group("handleFillForm");

  if (!Array.isArray(data?.fields) || data.fields.length === 0) {
    log.groupEnd();
    throw new Error("No fields provided in FILL_FORM payload.");
  }

  if (!data?.url) {
    log.groupEnd();
    throw new Error("No URL provided in FILL_FORM payload.");
  }

  const profile = await storageGet(STORE.PROFILE, null);
  if (!profile) {
    log.groupEnd();
    throw new Error(
      "No profile found. Please open the SmartFill popup and save your information first."
    );
  }

  log.info(`Profile loaded. Processing ${data.fields.length} field(s) for: ${data.url}`);

  // ── Layer 0: Memory Vault — instant fill from learned data ───────────────
  const vaultSuggestions = {};
  const fieldsNeedingAI  = [];

  for (const field of data.fields) {
    const vaultValue = await MemoryVault.get(field.label);
    if (vaultValue !== null) {
      log.info(`[VAULT] "${field.label}" → "${vaultValue}"`);
      vaultSuggestions[field.id] = { val: vaultValue, state: "LOCAL" };
    } else {
      fieldsNeedingAI.push(field);
    }
  }

  log.info(`Layer 0 done. Vault: ${Object.keys(vaultSuggestions).length}, still need AI: ${fieldsNeedingAI.length}`);

  // ── Build AI vault context (top-10 fuzzy matches for each remaining field) ─
  // We pick a representative label from the remaining fields to fetch context.
  // Context is sent once and covers all fields in the prompt.
  let vaultContext = [];
  if (fieldsNeedingAI.length > 0) {
    // Use the first field's label as the seed for context retrieval.
    // (The AI prompt already lists all fields, so the context acts as a memory hint.)
    const contextSeed = fieldsNeedingAI.map(f => f.label).join(" ");
    vaultContext = await MemoryVault.getTopContext(contextSeed);
    log.info(`Vault context: ${vaultContext.length} relevant entries injected into AI prompt.`);
  }

  let aiSuggestions = {};
  if (fieldsNeedingAI.length > 0) {
    const { suggestions, blockedCount: bc } = await callFillAPI({
      fields: fieldsNeedingAI,
      url: data.url,
      userProfile: profile,
      vaultContext,
    });
    aiSuggestions = suggestions;

    await appendHistory({
      url: data.url,
      fieldsFilled: Object.keys(aiSuggestions).length + Object.keys(vaultSuggestions).length,
      blockedCount: bc,
      timestamp: Date.now(),
    });
  } else {
    await appendHistory({
      url: data.url,
      fieldsFilled: Object.keys(vaultSuggestions).length,
      blockedCount: 0,
      timestamp: Date.now(),
    });
  }

  // Vault fills take priority — they represent verified user data
  const suggestions = { ...aiSuggestions, ...vaultSuggestions };

  log.info(`handleFillForm complete: ${Object.keys(suggestions).length} filled.`);
  log.groupEnd();

  return { ok: true, suggestions, blockedCount: 0 };
}

async function handleGetProfile() {
  const profile = await storageGet(STORE.PROFILE, null);
  return { ok: true, profile };
}

async function handleSaveProfile(data) {
  if (!data?.profile || typeof data.profile !== "object") {
    throw new Error("Invalid profile payload.");
  }
  await storageSet({ [STORE.PROFILE]: data.profile });
  log.info("Profile saved:", Object.keys(data.profile));
  return { ok: true };
}

/**
 * BUG FIX #3 (part 2): New handler that accepts the API key from the popup
 * and saves it securely via CryptoVault.
 */
async function handleSaveApiKey(data) {
  const { apiKey } = data ?? {};
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("API key must be a non-empty string.");
  }
  // Save under a generic "smartfill" vault slot.
  // The key string itself (e.g. "deepseek:sk-xxx" or "gsk_xxx") encodes which provider to use.
  await CryptoVault.saveApiKey(apiKey.trim(), "smartfill");
  log.info("API key saved to CryptoVault.");
  return { ok: true };
}

async function handleGetHistory() {
  const history = await storageGet(STORE.HISTORY, []);
  return { ok: true, history };
}

async function handleClearHistory() {
  await storageSet({ [STORE.HISTORY]: [] });
  return { ok: true };
}

// ─── VAULT HANDLERS ──────────────────────────────────────────────────────────

async function handleRecordMemory(data) {
  const { pairs } = data ?? {};
  if (!Array.isArray(pairs)) throw new Error("RECORD_MEMORY: pairs must be an array.");
  await MemoryVault.recordBatch(pairs);
  return { ok: true };
}

async function handleGetVault() {
  const entries = await MemoryVault.getAll();
  return { ok: true, entries };
}

async function handleDeleteVaultKey(data) {
  const { key } = data ?? {};
  if (!key) throw new Error("DELETE_VAULT_KEY: key is required.");
  await MemoryVault.deleteKey(key);
  return { ok: true };
}

async function handleDeleteVaultValue(data) {
  const { key, value } = data ?? {};
  if (!key || value === undefined) throw new Error("DELETE_VAULT_VALUE: key and value are required.");
  await MemoryVault.deleteValue(key, value);
  return { ok: true };
}

async function handleEditVaultValue(data) {
  const { key, oldValue, newValue } = data ?? {};
  if (!key || oldValue === undefined || newValue === undefined) {
    throw new Error("EDIT_VAULT_VALUE: key, oldValue, and newValue are required.");
  }
  await MemoryVault.editValue(key, oldValue, newValue);
  return { ok: true };
}

async function handleClearVault() {
  await MemoryVault.clear();
  return { ok: true };
}

// ─── MESSAGE ROUTER ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { action, data } = message ?? {};

  log.debug(`onMessage: action="${action}"`);

  let handlerPromise;

  switch (action) {
    case ACTION.FILL_FORM:
      handlerPromise = handleFillForm(data);
      break;

    case ACTION.GET_PROFILE:
      handlerPromise = handleGetProfile();
      break;

    case ACTION.SAVE_PROFILE:
      handlerPromise = handleSaveProfile(data);
      break;

    case ACTION.SAVE_API_KEY:
      handlerPromise = handleSaveApiKey(data);
      break;

    case ACTION.GET_HISTORY:
      handlerPromise = handleGetHistory();
      break;

    case ACTION.CLEAR_HISTORY:
      handlerPromise = handleClearHistory();
      break;

    case ACTION.RECORD_MEMORY:
      handlerPromise = handleRecordMemory(data);
      break;

    case ACTION.GET_VAULT:
      handlerPromise = handleGetVault();
      break;

    case ACTION.DELETE_VAULT_KEY:
      handlerPromise = handleDeleteVaultKey(data);
      break;

    case ACTION.DELETE_VAULT_VALUE:
      handlerPromise = handleDeleteVaultValue(data);
      break;

    case 'EDIT_VAULT_VALUE': // Inline string to avoid ACTION enum sync issues if it exists
      handlerPromise = handleEditVaultValue(data);
      break;

    case ACTION.CLEAR_VAULT:
      handlerPromise = handleClearVault();
      break;

    case ACTION.PING:
      handlerPromise = Promise.resolve({ ok: true, pong: true, ts: Date.now() });
      break;

    default:
      log.warn(`Unknown action: "${action}"`);
      handlerPromise = Promise.reject(new Error(`Unknown action: "${action}"`));
  }

  handlerPromise
    .then((result) => {
      sendResponse({ success: true, ...result });
    })
    .catch((err) => {
      log.error(`Action "${action}" failed:`, err);
      sendResponse({ success: false, error: err?.message ?? String(err) });
    });

  return true; // keep message channel open for async response
});

// ─── LIFECYCLE ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  log.info("onInstalled:", details.reason);

  if (details.reason === "install") {
    const existing = await storageGet(STORE.PROFILE, null);
    if (!existing) {
      await storageSet({
        [STORE.PROFILE]: {
          firstName: "", lastName: "", email: "",
          phone: "", city: "", portfolio: "",
          linkedin: "", github: "", bio: "", samples: "",
          createdAt: Date.now(),
        },
      });
      log.info("Default profile seeded.");
    }
  }

  const boots = await storageGet(STORE.SW_BOOT, 0);
  await storageSet({ [STORE.SW_BOOT]: boots + 1 });
  log.info(`SW boot count: ${boots + 1}`);

  // Set uninstall feedback form URL
  chrome.runtime.setUninstallURL("https://forms.gle/kVYUG9AiRx4hNnFk6");
});

chrome.runtime.onStartup.addListener(async () => {
  log.info("onStartup.");
});

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────

(async function bootstrap() {
  log.group("bootstrap");
  log.info("SW module evaluated at", new Date().toISOString());

  try {
    const profile = await storageGet(STORE.PROFILE, null);
    log.info(profile ? "Profile found in storage." : "No profile in storage yet.");

    const hasKey = await CryptoVault.hasApiKey("smartfill");
    log.info(hasKey ? "SmartFill API key is stored." : "⚠ No API key stored yet.");

  } catch (err) {
    log.error("Bootstrap error:", err);
  }

  log.groupEnd();
})();

self.addEventListener("unhandledrejection", (event) => {
  log.error("Unhandled promise rejection:", event.reason);
  event.preventDefault();
});
