document.addEventListener('DOMContentLoaded', () => {
  const tbody = document.getElementById('vaultTableBody');
  const totalKeysBadge = document.getElementById('totalKeysBadge');
  const totalValuesBadge = document.getElementById('totalValuesBadge');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const toast = document.getElementById('toast');
  const searchInput = document.getElementById('searchInput');
  
  let allEntries = [];

  function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  async function loadVault() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'GET_VAULT' });
      if (res && res.success) {
        allEntries = res.entries || [];
        renderTable();
      } else {
        renderError();
      }
    } catch (err) {
      console.error('Failed to load vault:', err);
      renderError();
    }
  }

  function renderError() {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">Failed to connect to extension. Try reloading the page.</td></tr>`;
  }

  function renderTable() {
    const query = searchInput.value.trim().toLowerCase();
    
    let filteredEntries = allEntries;
    if (query) {
      filteredEntries = allEntries.filter(e => 
        e.key.toLowerCase().includes(query) || 
        e.values.some(v => v.value.toLowerCase().includes(query))
      );
    }

    if (!filteredEntries || filteredEntries.length === 0) {
      if (allEntries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="empty-state">Your Memory Vault is empty. SmartFill will automatically learn as you fill forms.</td></tr>`;
      } else {
        tbody.innerHTML = `<tr><td colspan="3" class="empty-state">No results found for "${query}"</td></tr>`;
      }
      totalKeysBadge.textContent = `${allEntries.length} Keys`;
      const totalAll = allEntries.reduce((sum, e) => sum + e.values.length, 0);
      totalValuesBadge.textContent = `${totalAll} Values`;
      return;
    }

    const totalValues = allEntries.reduce((sum, e) => sum + e.values.length, 0);
    totalKeysBadge.textContent = `${allEntries.length} Key${allEntries.length !== 1 ? 's' : ''}`;
    totalValuesBadge.textContent = `${totalValues} Value${totalValues !== 1 ? 's' : ''}`;

    tbody.innerHTML = '';

    for (const entry of filteredEntries) {
      const tr = document.createElement('tr');

      // 1. Key Cell
      const keyTd = document.createElement('td');
      keyTd.className = 'key-cell';
      keyTd.textContent = entry.key;
      tr.appendChild(keyTd);

      // 2. Values Cell
      const valsTd = document.createElement('td');
      valsTd.className = 'values-cell';
      
      for (const v of entry.values) {
        const chip = document.createElement('div');
        chip.className = 'vault-chip';

        const text = document.createElement('span');
        text.className = 'vault-chip-text';
        text.textContent = v.value;

        const count = document.createElement('span');
        count.className = 'vault-chip-count';
        count.textContent = `x${v.count}`;

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'vault-chip-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'vault-chip-edit';
        editBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
        editBtn.title = "Edit this value";
        editBtn.onclick = async () => {
          const newVal = prompt(`Edit value for "${entry.key}":`, v.value);
          if (newVal === null || newVal.trim() === "" || newVal.trim() === v.value) return;
          
          const res = await chrome.runtime.sendMessage({
            action: 'EDIT_VAULT_VALUE',
            data: { key: entry.key, oldValue: v.value, newValue: newVal }
          });
          if (res?.success) {
            showToast('Value updated');
            loadVault();
          } else {
            showToast('Failed to update value', 'error');
          }
        };

        const delBtn = document.createElement('button');
        delBtn.className = 'vault-chip-del';
        delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        delBtn.title = "Delete this value";
        delBtn.onclick = async () => {
          const res = await chrome.runtime.sendMessage({
            action: 'DELETE_VAULT_VALUE',
            data: { key: entry.key, value: v.value }
          });
          if (res?.success) {
            showToast('Value deleted');
            loadVault();
          } else {
            showToast('Failed to delete value', 'error');
          }
        };

        actionsDiv.appendChild(editBtn);
        actionsDiv.appendChild(delBtn);

        chip.appendChild(text);
        chip.appendChild(count);
        chip.appendChild(actionsDiv);
        valsTd.appendChild(chip);
      }
      tr.appendChild(valsTd);

      // 3. Action Cell
      const actionTd = document.createElement('td');
      actionTd.className = 'action-cell';
      const delKeyBtn = document.createElement('button');
      delKeyBtn.className = 'btn-delete-key';
      delKeyBtn.title = "Delete this entire key";
      delKeyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
      delKeyBtn.onclick = async () => {
        if (!confirm(`Delete all memory for "${entry.key}"?`)) return;
        const res = await chrome.runtime.sendMessage({
          action: 'DELETE_VAULT_KEY',
          data: { key: entry.key }
        });
        if (res?.success) {
          showToast(`Deleted key: ${entry.key}`);
          loadVault();
        } else {
          showToast('Failed to delete key', 'error');
        }
      };
      actionTd.appendChild(delKeyBtn);
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    }
  }

  clearAllBtn.addEventListener('click', async () => {
    if (!confirm("Are you sure you want to clear ALL memory? This cannot be undone.")) return;
    const res = await chrome.runtime.sendMessage({ action: 'CLEAR_VAULT' });
    if (res?.success) {
      showToast('Memory Vault cleared completely');
      loadVault();
    } else {
      showToast('Failed to clear vault', 'error');
    }
  });

  searchInput.addEventListener('input', () => {
    renderTable();
  });

  // Init
  loadVault();
});
