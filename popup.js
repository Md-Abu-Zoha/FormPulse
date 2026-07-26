document.addEventListener('DOMContentLoaded', async () => {
  // ─── PROVIDER CONFIG ───────────────────────────────────────────────────────
  // Defines hints and links for each provider shown in the dropdown.
  const PROVIDER_META = {
    groq: {
      label:       'API Key (starts with gsk_)',
      placeholder: 'gsk_xxxxxxxxxxxx',
      hintText:    'Groq keys are created at console.groq.com.',
      color:       '#34d399',
    },
    gemini: {
      label:       'API Key (starts with AQ. or AIza)',
      placeholder: 'AQ. or AIzaSy...',
      hintText:    'Gemini keys are created at aistudio.google.com/app/apikey.',
      color:       '#a78bfa',
    },
    deepseek: {
      label:       'API Key (starts with sk-)',
      placeholder: 'sk-xxxxxxxxxxxx',
      hintText:    'DeepSeek keys are created at platform.deepseek.com.',
      color:       '#38bdf8',
    },
    kimi: {
      label:       'API Key (starts with sk-)',
      placeholder: 'sk-xxxxxxxxxxxx',
      hintText:    'Kimi keys are created at platform.moonshot.cn.',
      color:       '#f472b6',
    },
  };

  // Storage key for which provider was last selected
  const PROVIDER_STORE_KEY = 'smartfill_selected_provider';

  // ─── DOM REFERENCES ─────────────────────────────────────────────────────────
  const profileFields = {
    firstName: document.getElementById('firstName'),
    lastName:  document.getElementById('lastName'),
    email:     document.getElementById('email'),
    phone:     document.getElementById('phone'),
    city:      document.getElementById('city'),
    portfolio: document.getElementById('portfolio'),
    linkedin:  document.getElementById('linkedin'),
    github:    document.getElementById('github'),
    bio:       document.getElementById('bioInput'),
    samples:   document.getElementById('writingSamples'),
    pan:       document.getElementById('pan'),
    aadhaar:   document.getElementById('aadhaar'),
    passport:  document.getElementById('passport'),
    dob:       document.getElementById('dob'),
  };

  // ─── ACCORDION LOGIC ────────────────────────────────────────────────────────
  const bioHeader = document.getElementById('bioHeader');
  const bioContent = document.getElementById('bioContent');
  const samplesHeader = document.getElementById('samplesHeader');
  const samplesContent = document.getElementById('samplesContent');
  const vaultHeader = document.getElementById('vaultHeader');
  const vaultContent = document.getElementById('vaultContent');
  
  const openManualBtn = document.getElementById('openManualBtn');
  if (openManualBtn) {
    openManualBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('manual.html') });
    });
  }

  function toggleAccordion(header, content) {
    if (!header || !content) return;
    const isExpanded = content.classList.contains('expanded');
    if (!isExpanded) {
      header.classList.add('active');
      content.classList.add('expanded');
    } else {
      header.classList.remove('active');
      content.classList.remove('expanded');
    }
  }

  if (bioHeader) bioHeader.addEventListener('click', () => toggleAccordion(bioHeader, bioContent));
  if (samplesHeader) samplesHeader.addEventListener('click', () => toggleAccordion(samplesHeader, samplesContent));
  if (vaultHeader) vaultHeader.addEventListener('click', () => toggleAccordion(vaultHeader, vaultContent));

  // ─── SCROLLBAR FIX FOR ADVANCED SETTINGS ────────────────────────────────────
  const advancedSettings = document.querySelector('.advanced-settings');
  if (advancedSettings) {
    advancedSettings.addEventListener('toggle', (e) => {
      if (e.target.open) {
        document.body.style.overflowY = 'auto';
        loadVaultUI(); // Refresh vault entries whenever the panel opens
      } else {
        document.body.style.overflowY = 'hidden';
        // Force Chrome to scroll to the top to reset the window render bounds
        setTimeout(() => window.scrollTo(0, 0), 10);
      }
    });
  }

  const providerSelect = document.getElementById('providerSelect');
  const apiKeyField    = document.getElementById('apiKey');
  const apiKeyLabel    = document.getElementById('apiKeyLabel');
  const apiKeyHint     = document.getElementById('apiKeyHint');
  const saveBtn        = document.getElementById('saveBtn');
  const fillBtn        = document.getElementById('fillBtn');
  const statusMsg      = document.getElementById('statusMessage');
  const autoPilotToggle = document.getElementById('autoPilotToggle');

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function isInjectableTab(tab) {
    return !!tab?.id && /^(https?|file):\/\//i.test(tab.url || '');
  }

  async function ensureContentScript(tab) {
    if (!isInjectableTab(tab)) {
      throw new Error('Open a normal web page before using SmartFill.');
    }

    // Always inject into all frames so embedded iframes (Greenhouse, Lever, etc.)
    // also get the content script. Chrome deduplicates injections automatically —
    // re-injecting into a frame that already has content.js is safe because
    // TRIGGER_SCAN always resets the registry before scanning.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      });
    } catch (err) {
      if (tab.url && tab.url.startsWith('file://')) {
        throw new Error('Enable "Allow access to file URLs" in extension settings (chrome://extensions) to fill local files.');
      }
      throw new Error(`Could not inject into this page: ${err.message}`);
    }
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  // Load Auto-Pilot state
  chrome.storage.local.get(['autoPilotEnabled'], (res) => {
    if (res.autoPilotEnabled) autoPilotToggle.checked = true;
  });

  // Save Auto-Pilot state on toggle
  autoPilotToggle.addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    await chrome.storage.local.set({ autoPilotEnabled: isEnabled });
    try {
      const tab = await getActiveTab();
      if (isInjectableTab(tab)) {
        await ensureContentScript(tab);
        await sendTabMessage(tab.id, { action: isEnabled ? 'AUTO_PILOT_ENABLED' : 'AUTO_PILOT_DISABLED' });
      }
    } catch (err) {
      showStatus(`Auto-Pilot saved. Page injection skipped: ${err.message}`, 'error');
    }
  });

  // ─── UPDATE PROVIDER HINT ──────────────────────────────────────────────────
  function applyProviderMeta(providerKey) {
    const meta = PROVIDER_META[providerKey] || PROVIDER_META.gemini;
    apiKeyLabel.textContent  = meta.label;
    apiKeyField.placeholder  = meta.placeholder;
    apiKeyHint.textContent   = meta.hintText;
  }

  // ─── LOAD SAVED STATE ─────────────────────────────────────────────────────
  // 1. Load profile fields
  chrome.runtime.sendMessage({ action: 'GET_PROFILE' }, (response) => {
    if (response?.success && response.profile) {
      const data = response.profile;
      for (const [key, el] of Object.entries(profileFields)) {
        if (el && data[key]) el.value = data[key];
      }
    }
  });

  // 2. Load selected provider + check if a key is already saved
  chrome.storage.local.get([PROVIDER_STORE_KEY], (items) => {
    const savedProvider = items[PROVIDER_STORE_KEY] || 'gemini';
    providerSelect.value = savedProvider;
    applyProviderMeta(savedProvider);

    // Check if a key is already stored (without exposing the actual key)
    chrome.storage.local.get(null, (allItems) => {
      const hasKey = Object.keys(allItems).some(k => k.startsWith('smartfill_vault_'));
      if (hasKey) {
        apiKeyField.placeholder = '(Key saved — leave blank to keep it)';
      }
    });
  });

  // ─── PROVIDER SWITCH ──────────────────────────────────────────────────────
  providerSelect.addEventListener('change', () => {
    const chosen = providerSelect.value;
    applyProviderMeta(chosen);
    // Clear the key field so the user knows they need to enter a new key for the new provider
    apiKeyField.value = '';
    apiKeyField.placeholder = PROVIDER_META[chosen]?.placeholder || 'Paste your API key here';
  });

  // ─── SAVE ──────────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.querySelector('span').textContent = 'Saving…';

    try {
      // 1. Save profile fields
      const profile = {};
      for (const [key, el] of Object.entries(profileFields)) {
        if (el) profile[key] = el.value.trim();
      }

      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: 'SAVE_PROFILE', data: { profile } },
          (res) => {
            if (res?.success) resolve();
            else reject(new Error(res?.error || 'Failed to save profile'));
          }
        );
      });

      // 2. Save selected provider
      const selectedProvider = providerSelect.value;
      await chrome.storage.local.set({ [PROVIDER_STORE_KEY]: selectedProvider });

      // 3. Save API key (only if user typed one)
      const rawKey = apiKeyField.value.trim();
      if (rawKey) {
        // Prefix the key with the provider name so background.js knows which API to use
        // groq keys already start with gsk_ and are auto-detected, but we prefix for all others for clarity
        const prefixedKey = selectedProvider === 'groq'   ? rawKey :
                            selectedProvider === 'gemini' ? rawKey :
                            `${selectedProvider}:${rawKey}`;

        await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { action: 'SAVE_API_KEY', data: { apiKey: prefixedKey } },
            (res) => {
              if (res?.success) resolve();
              else reject(new Error(res?.error || 'Failed to save API key'));
            }
          );
        });

        // Clear the field for security
        apiKeyField.value = '';
        apiKeyField.placeholder = '(Key saved — leave blank to keep it)';
      }

      showStatus('✓ Memory saved!', 'success');
    } catch (err) {
      showStatus(`✗ Error: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.querySelector('span').textContent = 'Save Memory';
    }
  });

  // ─── AUTO-FILL ─────────────────────────────────────────────────────────────
  fillBtn.addEventListener('click', async () => {
    fillBtn.disabled = true;

    try {
      const tab = await getActiveTab();
      await ensureContentScript(tab);
      showStatus('Scanning and filling...', 'success');
      const response = await sendTabMessage(tab.id, { action: 'TRIGGER_SCAN' });
      fillBtn.disabled = false;

      if (response?.ok) {
        showStatus(`Filling ${response.fieldCount} field(s)...`, 'success');
      }
    } catch (err) {
      fillBtn.disabled = false;
      showStatus(err.message || 'Please refresh the page and try again.', 'error');
    }
  });

  // ─── STATUS HELPER ─────────────────────────────────────────────────────────
  function showStatus(text, type) {
    statusMsg.textContent = text;
    statusMsg.className = `status ${type} show`;
    setTimeout(() => {
      statusMsg.className = `status ${type}`;
      setTimeout(() => { statusMsg.textContent = ''; }, 300);
    }, 3500);
  }

  // ─── MEMORY VAULT UI ───────────────────────────────────────────────────────

  const vaultCount = document.getElementById('vaultCount');
  const manageVaultBtn = document.getElementById('manageVaultBtn');

  async function loadVaultUI() {
    if (!vaultCount) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'GET_VAULT' });
      if (res?.success && Array.isArray(res.entries)) {
        const total = res.entries.reduce((sum, e) => sum + e.values.length, 0);
        vaultCount.textContent = `(${res.entries.length} key${res.entries.length !== 1 ? 's' : ''}, ${total} value${total !== 1 ? 's' : ''})`;
      }
    } catch {
      // SW may be asleep — silently skip
    }
  }

  if (manageVaultBtn) {
    manageVaultBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('vault.html') });
    });
  }

  // Initial load
  loadVaultUI();
});
