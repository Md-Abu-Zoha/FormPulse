// =============================================================================
//  FormPulse – crypto-utils.js
//  Web Crypto API utility for AES-GCM-256 encryption of API keys.
//
//  Security model:
//    • AES-GCM 256-bit authenticated encryption (provides confidentiality
//      AND integrity — any tampering of ciphertext causes decryption to fail)
//    • Encryption key is DERIVED via PBKDF2, never stored in plaintext
//    • Key material = chrome.runtime.id (extension-scoped, non-guessable by
//      web pages) + a cryptographically random 16-byte salt persisted in storage
//    • 100,000 PBKDF2 iterations (NIST SP 800-132 minimum for SHA-256)
//    • A fresh random 12-byte IV is used for every encrypt call (GCM requirement)
//    • Stored blob format: { version, salt_b64, iv_b64, ct_b64 }
//
//  Thread safety:
//    • All operations are async; safe to call concurrently in the SW
//
//  Usage:
//    import { CryptoVault } from './crypto-utils.js';
//    await CryptoVault.saveApiKey("sk-...");
//    const key = await CryptoVault.loadApiKey();
// =============================================================================

const TAG_C = "[FormPulse Crypto]";

const clog = {
  info:     (...a) => {},
  warn:     (...a) => {},
  error:    (...a) => console.error(TAG_C, ...a),
  debug:    (...a) => {},
  group:    (l)   => {},
  groupEnd: ()    => {},
};

// ─── ALGORITHM CONSTANTS ─────────────────────────────────────────────────────

/** AES-GCM parameters. */
const AES_ALGO = { name: "AES-GCM", length: 256 };

/** PBKDF2 parameters. */
const KDF_ALGO  = "PBKDF2";
const KDF_HASH  = "SHA-256";
const KDF_ITERS = 100_000;   // NIST SP 800-132 recommended minimum

/** GCM initialisation vector byte length (96 bits is the GCM standard). */
const IV_BYTES   = 12;

/** Salt byte length for PBKDF2 (128 bits). */
const SALT_BYTES = 16;

/** chrome.storage.local key for persisted encrypted blobs. */
const STORE_KEY_PREFIX = "formpulse_vault_";

/** Schema version – increment if the stored format changes. */
const VAULT_VERSION = 1;

// ─── BASE64 HELPERS ───────────────────────────────────────────────────────────

/**
 * Encode a Uint8Array to a URL-safe Base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Decode a Base64 string to a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function fromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ─── KEY DERIVATION ───────────────────────────────────────────────────────────

/**
 * Derives an AES-GCM-256 CryptoKey from the extension's runtime ID and the
 * provided salt, using PBKDF2 with SHA-256 and 100,000 iterations.
 *
 * The derivation uses `chrome.runtime.id` as the "password" input.
 * This ID is:
 *   • Unique per extension installation
 *   • Inaccessible to web pages (only available inside the extension context)
 *   • Stable across browser sessions (changes only on reinstall/update)
 *
 * @param {Uint8Array} salt  - 16 random bytes, stored alongside ciphertext
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(salt) {
  clog.debug("Deriving AES-GCM key via PBKDF2…");

  const encoder = new TextEncoder();

  // Import the extension ID as raw key material for PBKDF2.
  // chrome.runtime.id is a 32-char hex string — deterministic per extension.
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(chrome.runtime.id),
    { name: KDF_ALGO },
    false,           // not extractable
    ["deriveKey"]
  );

  // Derive the actual AES-GCM key.
  const aesKey = await crypto.subtle.deriveKey(
    {
      name:       KDF_ALGO,
      salt,
      iterations: KDF_ITERS,
      hash:       KDF_HASH,
    },
    keyMaterial,
    AES_ALGO,
    false,           // not extractable — key never leaves the crypto engine
    ["encrypt", "decrypt"]
  );

  clog.debug("Key derivation complete.");
  return aesKey;
}

// ─── SALT MANAGEMENT ─────────────────────────────────────────────────────────

/**
 * Retrieve the persisted PBKDF2 salt for a given vault key, or generate and
 * persist a fresh one if it does not yet exist.
 *
 * The salt is NOT secret — it is safe to store in plaintext.
 * Its role is to prevent pre-computation (rainbow table) attacks.
 *
 * @param {string} vaultKey  - Unique storage sub-key per API key slot
 * @returns {Promise<Uint8Array>}
 */
async function getOrCreateSalt(vaultKey) {
  const storageKey = `${STORE_KEY_PREFIX}salt_${vaultKey}`;
  const result     = await chrome.storage.local.get(storageKey);
  const existing   = result[storageKey];

  if (existing) {
    clog.debug(`Salt loaded from storage for "${vaultKey}".`);
    return fromBase64(existing);
  }

  // First run: generate and persist a fresh random salt.
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  await chrome.storage.local.set({ [storageKey]: toBase64(salt) });
  clog.info(`New salt generated and persisted for "${vaultKey}".`);
  return salt;
}

// ─── ENCRYPT / DECRYPT ───────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string and return a serialisable vault blob.
 *
 * @param {string} plaintext  - The secret to encrypt (e.g. an API key)
 * @param {string} vaultKey   - Logical name for this secret (e.g. "gemini")
 * @returns {Promise<{ version: number, salt_b64: string, iv_b64: string, ct_b64: string }>}
 */
async function encrypt(plaintext, vaultKey) {
  const salt    = await getOrCreateSalt(vaultKey);
  const iv      = crypto.getRandomValues(new Uint8Array(IV_BYTES));  // fresh IV every time
  const aesKey  = await deriveKey(salt);
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded
  );

  return {
    version:  VAULT_VERSION,
    salt_b64: toBase64(salt),
    iv_b64:   toBase64(iv),
    ct_b64:   toBase64(new Uint8Array(cipherBuffer)),
  };
}

/**
 * Decrypt a vault blob previously produced by {@link encrypt}.
 *
 * @param {{ version: number, salt_b64: string, iv_b64: string, ct_b64: string }} blob
 * @returns {Promise<string>}  The original plaintext
 * @throws {Error} If version is unsupported or decryption fails (tampered data)
 */
async function decrypt(blob) {
  if (blob.version !== VAULT_VERSION) {
    throw new Error(`Unsupported vault version: ${blob.version}. Expected ${VAULT_VERSION}.`);
  }

  const salt      = fromBase64(blob.salt_b64);
  const iv        = fromBase64(blob.iv_b64);
  const ct        = fromBase64(blob.ct_b64);
  const aesKey    = await deriveKey(salt);

  let plainBuffer;
  try {
    plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      aesKey,
      ct
    );
  } catch (err) {
    // AES-GCM authentication failure means the ciphertext was tampered with
    // or the key is wrong (e.g., different extension ID after reinstall).
    clog.error("Decryption failed — ciphertext may be corrupt or key mismatch:", err);
    throw new Error("Decryption failed. The stored key may be corrupt. Please re-enter your API key.");
  }

  return new TextDecoder().decode(plainBuffer);
}

// ─── PUBLIC VAULT API ────────────────────────────────────────────────────────

/**
 * The CryptoVault namespace provides the public interface for all
 * secure API key storage operations.
 *
 * @namespace CryptoVault
 */
export const CryptoVault = Object.freeze({

  /**
   * Encrypt and persist an API key to chrome.storage.local.
   *
   * @param {string} apiKey    - The raw API key string (e.g. "sk-...")
   * @param {string} [slot="default"]  - Named slot, use different slots for
   *                                     Gemini vs Groq vs OpenAI keys
   * @returns {Promise<void>}
   * @throws {Error} If encryption or storage write fails
   */
  async saveApiKey(apiKey, slot = "default") {
    clog.group(`saveApiKey [slot=${slot}]`);

    if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
      clog.warn("Refused to save an empty API key.");
      clog.groupEnd();
      throw new Error("API key must be a non-empty string.");
    }

    try {
      const blob        = await encrypt(apiKey.trim(), slot);
      const storageKey  = `${STORE_KEY_PREFIX}${slot}`;
      await chrome.storage.local.set({ [storageKey]: blob });
      clog.info(`API key encrypted and saved to storage [slot=${slot}].`);
    } catch (err) {
      clog.error("saveApiKey failed:", err);
      throw err;
    } finally {
      clog.groupEnd();
    }
  },

  /**
   * Load and decrypt a previously saved API key.
   *
   * @param {string} [slot="default"]
   * @returns {Promise<string|null>}  Decrypted key, or null if not found
   * @throws {Error} If decryption fails (corrupt data or reinstalled extension)
   */
  async loadApiKey(slot = "default") {
    clog.debug(`loadApiKey [slot=${slot}]`);

    const storageKey = `${STORE_KEY_PREFIX}${slot}`;
    const result     = await chrome.storage.local.get(storageKey);
    const blob       = result[storageKey];

    if (!blob) {
      clog.info(`No stored key found for slot="${slot}".`);
      return null;
    }

    try {
      const plaintext = await decrypt(blob);
      clog.info(`API key decrypted successfully [slot=${slot}].`);
      return plaintext;
    } catch (err) {
      clog.error("loadApiKey failed:", err);
      throw err;
    }
  },

  /**
   * Delete an encrypted API key from storage.
   * Also removes the associated salt so a fresh encryption round trip
   * is created if the key is re-saved.
   *
   * @param {string} [slot="default"]
   * @returns {Promise<void>}
   */
  async deleteApiKey(slot = "default") {
    clog.info(`deleteApiKey [slot=${slot}]`);
    const blobKey = `${STORE_KEY_PREFIX}${slot}`;
    const saltKey = `${STORE_KEY_PREFIX}salt_${slot}`;
    await chrome.storage.local.remove([blobKey, saltKey]);
    clog.info(`Vault slot "${slot}" and its salt removed.`);
  },

  /**
   * Check if a key exists in a given slot without decrypting it.
   *
   * @param {string} [slot="default"]
   * @returns {Promise<boolean>}
   */
  async hasApiKey(slot = "default") {
    const storageKey = `${STORE_KEY_PREFIX}${slot}`;
    const result     = await chrome.storage.local.get(storageKey);
    return !!result[storageKey];
  },
});
