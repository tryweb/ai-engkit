/* Providers page client logic. Boot data (provider entries + meta) is injected
 * server-side into window.providersBoot by views/providers.tsx. */
var providersEntries = window.providersBoot.entries;
var providersMeta = window.providersBoot.meta;
var editName = null;
var editState = null;
var editApiKey = null;
var editRawValid = true;

var addState = null;
var addName = null;
var addApiKey = null;
var addRawValid = true;

var oauthProvider = null;
var oauthFlowId = null;
var oauthPollTimer = null;
var oauthPolling = false;

function providerCard(name) {
  return document.querySelector('.provider-card[data-provider="' + name + '"]');
}
function providerMeta(name) {
  return providersMeta.find(function (p) { return p.name === name; });
}

function validateUrl(value) {
  if (!value) return true;
  try {
    var url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function validateProviderName(value) {
  if (!value || !value.trim()) return { valid: false, error: 'Provider name is required' };
  var name = value.trim();
  if (!/^[a-z0-9]([a-z0-9\-]*[a-z0-9])?$/.test(name)) {
    return { valid: false, error: 'Name must be lowercase alphanumeric with hyphens (e.g., "my-provider")' };
  }
  if (providersEntries[name]) {
    return { valid: false, error: 'A provider with this name already exists' };
  }
  return { valid: true, error: null };
}

function validateNpm(value) {
  if (!value || !value.trim()) return { valid: false, error: 'npm package is required for the provider to work' };
  var pkg = value.trim();
  if (!/^(?:(?:@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*)(?:\/[a-z0-9\-~][a-z0-9\-._~]*)?$/.test(pkg)) {
    return { valid: false, error: 'Invalid npm package name format' };
  }
  return { valid: true, error: null };
}

function validateBaseURL(value) {
  if (!value) return { valid: true, error: null };
  if (!validateUrl(value)) {
    return { valid: false, error: 'Invalid URL format (must start with http:// or https://)' };
  }
  return { valid: true, error: null };
}

function showFieldError(prefix, field, error) {
  var el = document.getElementById(prefix + '-' + field + '-error');
  if (el) {
    if (error) {
      el.textContent = error;
      el.style.display = 'block';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }
}

function clearAllErrors(prefix) {
  ['name', 'npm', 'baseurl', 'apikey'].forEach(function (f) {
    showFieldError(prefix, f, null);
  });
}

function restartAiDev() {
  if (!confirm('Restart ai-dev container? OpenCode sessions may briefly disconnect.')) return;
  fetch('/api/env/restart', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      alert('Restart failed: ' + (j.error || 'unknown error'));
    });
}

function openProviderEdit(name) {
  editName = name;
  editApiKey = null;
  editRawValid = true;
  var e = JSON.parse(JSON.stringify(providersEntries[name] || {}));
  editState = e;
  document.getElementById('edit-name').value = name;
  document.getElementById('edit-label').value = e.name || '';
  document.getElementById('edit-npm').value = e.npm || '';
  document.getElementById('edit-baseurl').value = (e.options && e.options.baseURL) || '';
  document.getElementById('edit-apikey').value = '';
  document.getElementById('edit-raw').value = JSON.stringify(e, null, 2);
  document.getElementById('edit-status').textContent = '';
  document.getElementById('edit-modal').style.display = 'flex';
}

function patchField(field, value) {
  if (!editState) return;
  if (field === 'label') editState.name = value;
  else if (field === 'npm') {
    editState.npm = value;
    var result = validateNpm(value);
    showFieldError('edit', 'npm', result.valid ? null : result.error);
  }
  else if (field === 'baseURL') {
    editState.options = editState.options || {};
    editState.options.baseURL = value;
    var result = validateBaseURL(value);
    showFieldError('edit', 'baseurl', result.valid ? null : result.error);
  }
  else if (field === 'apiKey') {
    editApiKey = value;
    return;
  }
  document.getElementById('edit-raw').value = JSON.stringify(editState, null, 2);
}

function onRawInput(text) {
  if (!editState) return;
  var s = document.getElementById('edit-status');
  try {
    editState = JSON.parse(text);
    editRawValid = true;
    s.textContent = '';
  } catch (err) {
    editRawValid = false;
    s.textContent = 'Raw JSON is invalid: ' + err.message;
  }
}

function saveProvider() {
  if (!editName) return;
  if (!editRawValid) return;

  clearAllErrors('edit');
  var hasError = false;

  var npmResult = validateNpm(editState.npm);
  if (!npmResult.valid) {
    showFieldError('edit', 'npm', npmResult.error);
    hasError = true;
  }

  var baseURLResult = validateBaseURL(editState.options && editState.options.baseURL);
  if (!baseURLResult.valid) {
    showFieldError('edit', 'baseurl', baseURLResult.error);
    hasError = true;
  }

  if (hasError) return;

  if (editApiKey) {
    editState.options = editState.options || {};
    editState.options.apiKey = editApiKey;
  }
  fetch('/api/providers/' + editName, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: editState }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      alert('Save failed: ' + (j.error || 'unknown error'));
    });
}

function closeProviderEdit() {
  editName = null;
  document.getElementById('edit-modal').style.display = 'none';
}

function openAddProvider() {
  addState = { name: '', npm: '', options: {} };
  addName = null;
  addApiKey = null;
  addRawValid = true;
  document.getElementById('add-name').value = '';
  document.getElementById('add-label').value = '';
  document.getElementById('add-npm').value = '';
  document.getElementById('add-baseurl').value = '';
  document.getElementById('add-apikey').value = '';
  document.getElementById('add-raw').value = JSON.stringify(addState, null, 2);
  document.getElementById('add-status').textContent = '';
  clearAllErrors('add');
  document.getElementById('add-modal').style.display = 'flex';
}

function validateAddField(field, value) {
  if (!addState) return;
  if (field === 'name') {
    addName = value;
    var result = validateProviderName(value);
    showFieldError('add', 'name', result.valid ? null : result.error);
  } else if (field === 'label') {
    addState.name = value;
  } else if (field === 'npm') {
    addState.npm = value;
    var result = validateNpm(value);
    showFieldError('add', 'npm', result.valid ? null : result.error);
  } else if (field === 'baseURL') {
    addState.options = addState.options || {};
    addState.options.baseURL = value;
    var result = validateBaseURL(value);
    showFieldError('add', 'baseurl', result.valid ? null : result.error);
  } else if (field === 'apiKey') {
    addApiKey = value;
    return;
  }
  document.getElementById('add-raw').value = JSON.stringify(addState, null, 2);
}

function onAddRawInput(text) {
  if (!addState) return;
  var s = document.getElementById('add-status');
  try {
    addState = JSON.parse(text);
    addRawValid = true;
    s.textContent = '';
  } catch (err) {
    addRawValid = false;
    s.textContent = 'Raw JSON is invalid: ' + err.message;
  }
}

function saveNewProvider() {
  if (!addRawValid) return;
  if (!addState) return;

  clearAllErrors('add');
  var hasError = false;

  var nameResult = validateProviderName(addName);
  if (!nameResult.valid) {
    showFieldError('add', 'name', nameResult.error);
    hasError = true;
  }

  var npmResult = validateNpm(addState.npm);
  if (!npmResult.valid) {
    showFieldError('add', 'npm', npmResult.error);
    hasError = true;
  }

  var baseURLResult = validateBaseURL(addState.options && addState.options.baseURL);
  if (!baseURLResult.valid) {
    showFieldError('add', 'baseurl', baseURLResult.error);
    hasError = true;
  }

  if (hasError) return;

  var providerName = addName.trim();
  var payload = JSON.parse(JSON.stringify(addState));
  if (addApiKey) {
    payload.options = payload.options || {};
    payload.options.apiKey = addApiKey;
  }

  fetch('/api/providers/' + providerName, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: payload }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      alert('Add provider failed: ' + (j.error || 'unknown error'));
    });
}

function closeAddProvider() {
  addState = null;
  document.getElementById('add-modal').style.display = 'none';
}

function deleteProvider(name) {
  if (!confirm('Delete provider "' + name + '" from OPENCODE_PROVIDER?')) return;
  fetch('/api/providers/' + name, { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      alert('Delete failed: ' + (j.error || 'unknown error'));
    });
}

function addKey(name) {
  var input = providerCard(name).querySelector('.key-add-input');
  var noteInput = providerCard(name).querySelector('.key-add-note-input');
  var value = input.value;
  if (!value) { input.focus(); return; }
  var note = noteInput.value.trim();
  var pm = providerMeta(name);
  var first = pm && pm.registry.keyCount === 0;
  if (first && !confirm('This is the first key for ' + name + ' — it will be applied to the auth store and ai-dev will restart. Continue?')) return;
  fetch('/api/providers/' + name + '/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: value, note: note }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      alert('Add key failed: ' + (j.error || 'unknown error'));
    });
}

function saveKeyNote(name, keyId, button) {
  var input = button.closest('.key-row').querySelector('.key-row__note');
  if (!input) return;
  button.disabled = true;
  fetch('/api/providers/' + name + '/keys/' + keyId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: input.value }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { alert('Save note failed: ' + (j.error || 'unknown error')); return; }
      button.textContent = 'Saved';
      setTimeout(function () { button.textContent = 'Save'; }, 1200);
    })
    .catch(function (err) {
      alert('Save note failed: ' + (err && err.message ? err.message : 'network error'));
    })
    .finally(function () { button.disabled = false; });
}

function deleteKey(name, keyId) {
  if (!confirm('Delete this API key?')) return;
  fetch('/api/providers/' + name + '/keys/' + keyId, { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      alert('Delete key failed: ' + (j.error || 'unknown error'));
    });
}

function selectActiveKey(name, keyId) {
  if (!confirm('Switching the active key writes it to the auth store and restarts ai-dev (brief downtime). Continue?')) return;
  var status = providerCard(name).querySelector('.key-activation-status');
  status.textContent = 'Applying selected key...';
  fetch('/api/providers/' + name + '/keys/' + keyId + '/active', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      status.textContent = 'Selection not applied';
      alert('Activate key failed: ' + (j.error || 'unknown error'));
    })
    .catch(function (err) {
      status.textContent = 'Selection not applied';
      alert('Activate key failed: ' + (err && err.message ? err.message : 'network error'));
    });
}

function toggleKeyValue(name, keyId, btn) {
  var row = btn.closest('.key-row');
  var mv = row.querySelector('.masked-value');
  var revealed = mv.querySelector('.revealed');
  if (mv.classList.contains('show')) {
    mv.classList.remove('show');
    btn.textContent = 'Show';
    return;
  }
  fetch('/api/providers/' + name + '/keys/' + keyId + '/value')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { alert('Failed to reveal key: ' + (j.error || 'unknown error')); return; }
      revealed.textContent = j.key;
      mv.classList.add('show');
      btn.textContent = 'Hide';
    });
}

function importKey(name) {
  fetch('/api/providers/' + name + '/keys/import-candidate')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.candidate) { alert('No key to import: ' + ((j.error) || 'auth store has no key for ' + name)); return; }
      if (!confirm('Import key ' + j.masked + ' as the first key for ' + name + '? Restart ai-dev afterward to apply it.')) return;
      return fetch('/api/providers/' + name + '/keys/import', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (j2) {
          if (j2.ok) return location.reload();
          alert('Import failed: ' + (j2.error || 'unknown error'));
        });
    })
    .catch(function (err) {
      alert('Import failed: ' + (err && err.message ? err.message : 'network error'));
    });
}

/* ChatGPT Pro/Plus headless OAuth */

function oauthStatus(text) {
  var el = document.getElementById('oauth-poll-status');
  if (el) el.textContent = text;
}

function startOAuth(name) {
  oauthProvider = name;
  oauthFlowId = null;
  var flow = document.getElementById('oauth-flow');
  flow.hidden = false;
  document.getElementById('oauth-apply').hidden = true;
  oauthStatus('Requesting device code…');
  fetch('/api/providers/' + name + '/oauth/start', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { oauthStatus('Could not start: ' + (j.error || 'unknown error')); return; }
      oauthFlowId = j.flowId;
      var uri = j.verificationUri || 'https://auth.openai.com/codex/device';
      document.getElementById('oauth-user-code').textContent = j.userCode || '---';
      var link = document.getElementById('oauth-verify-link');
      link.href = uri;
      link.textContent = uri.replace(/^https?:\/\//, '');
      var intervalMs = Math.max((j.intervalSec || 5) * 1000, 3000);
      var maxPolls = Math.max(1, Math.ceil((j.expiresInSec || 600) / (j.intervalSec || 5)) + 1);
      var polls = 0;
      clearInterval(oauthPollTimer);
      oauthStatus('Open the verification page and enter the code above. Waiting for authorization…');
      oauthPollTimer = setInterval(function () {
        polls += 1;
        if (polls > maxPolls) {
          clearInterval(oauthPollTimer);
          oauthStatus('Timed out waiting for authorization. Start again to retry.');
          return;
        }
        pollOAuth();
      }, intervalMs);
    })
    .catch(function (err) {
      oauthStatus('Could not start: ' + (err && err.message ? err.message : 'network error'));
    });
}

function pollOAuth() {
  if (!oauthFlowId || oauthPolling) return;
  oauthPolling = true;
  fetch('/api/providers/' + (oauthProvider || 'openai') + '/oauth/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flowId: oauthFlowId }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.status === 'ready') {
        clearInterval(oauthPollTimer);
        oauthStatus('Authorization received — finish connecting to write the credential and restart ai-dev.');
        document.getElementById('oauth-apply').hidden = false;
      } else if (j.status === 'expired') {
        clearInterval(oauthPollTimer);
        oauthStatus('Code expired. Start again to retry.');
      } else if (j.status === 'failed') {
        clearInterval(oauthPollTimer);
        oauthStatus('Authorization failed. Start again to retry.');
      } else {
        oauthStatus('Waiting for you to authorize at auth.openai.com/codex/device…');
      }
    })
    .catch(function () { /* transient — the next poll retries */ })
    .finally(function () { oauthPolling = false; });
}

function applyOAuth() {
  if (!oauthFlowId) return;
  if (!confirm('Connect ChatGPT Pro/Plus? This writes an OAuth credential to the auth store (replacing any OpenAI API key) and restarts ai-dev (brief downtime). Continue?')) return;
  oauthStatus('Connecting…');
  fetch('/api/providers/' + (oauthProvider || 'openai') + '/oauth/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flowId: oauthFlowId }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      oauthStatus('Connection failed: ' + (j.error || 'unknown error'));
    })
    .catch(function (err) {
      oauthStatus('Connection failed: ' + (err && err.message ? err.message : 'network error'));
    });
}

function cancelOAuth() {
  clearInterval(oauthPollTimer);
  oauthFlowId = null;
  oauthProvider = null;
  document.getElementById('oauth-flow').hidden = true;
  document.getElementById('oauth-apply').hidden = true;
}

function disconnectOAuth(name) {
  if (!confirm('Disconnect ChatGPT Pro/Plus? The OAuth credential is removed from the auth store and ai-dev restarts.')) return;
  fetch('/api/providers/' + name + '/oauth/disconnect', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) return location.reload();
      alert('Disconnect failed: ' + (j.error || 'unknown error'));
    })
    .catch(function (err) {
      alert('Disconnect failed: ' + (err && err.message ? err.message : 'network error'));
    });
}

function setGoUsage(keyId, item) {
  var badge = document.querySelector('[data-go-usage="' + keyId + '"]');
  if (!badge || !item || !item.monthly) return;
  var tone = item.monthly.tone === 'ok' || item.monthly.tone === 'warn' || item.monthly.tone === 'bad'
    ? item.monthly.tone : 'muted';
  badge.textContent = item.monthly.label || 'Monthly —';
  badge.className = 'go-usage go-usage--' + tone;
  var rolling = item.rolling || {};
  var weekly = item.weekly || {};
  badge.title = 'Rolling ' + (rolling.percent == null ? '—' : rolling.percent + '%') +
    ' (resets ' + (rolling.resetsIn || rolling.resetsAt || '—') + ') · Weekly ' +
    (weekly.percent == null ? '—' : weekly.percent + '%') +
    ' (resets ' + (weekly.resetsIn || weekly.resetsAt || '—') + ')';
}

function refreshGoUsage() {
  if (typeof document==='undefined'||!document.querySelector||typeof fetch!=='function') return;
  if (!document.querySelector('[data-go-usage]')) return;
  fetch('/api/providers/opencode-go/usage')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok || !Array.isArray(j.items)) throw new Error('usage unavailable');
      j.items.forEach(function (item) { setGoUsage(item.keyId, item); });
    })
    .catch(function () {
      document.querySelectorAll('[data-go-usage]').forEach(function (badge) {
        badge.className = 'go-usage go-usage--muted';
        badge.title = 'Usage unavailable';
      });
    });
}

try{ if(typeof document!=='undefined'&&typeof fetch==='function'){ if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',refreshGoUsage);} else {refreshGoUsage();} } }catch(e){}
