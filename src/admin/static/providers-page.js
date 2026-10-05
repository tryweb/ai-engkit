/* Providers page client logic. Boot data (provider entries + meta) is injected
 * server-side into window.providersBoot by views/providers.tsx. */
var providersEntries = window.providersBoot.entries;
var providersMeta = window.providersBoot.meta;
var isV2Mode = !!window.providersBoot.v2Mode;
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

  if (isV2Mode) {
    var raw = document.getElementById('add-raw').value;
    try {
      var parsed = JSON.parse(raw);
      if (parsed.url) {
        fetch('/api/providers/wellknown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: parsed.url }),
        }).then(function(r){return r.json();}).then(function(j){ if(j.ok) return location.reload(); alert('Add provider failed: '+(j.error||'unknown')); });
        return;
      }
    } catch(e) {}
    var baseURL = (addState.options && addState.options.baseURL) || '';
    if (baseURL && validateUrl(baseURL) && baseURL.includes('wellknown') || baseURL.includes('.json')) {
      fetch('/api/providers/wellknown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: baseURL }),
      }).then(function(r){return r.json();}).then(function(j){ if(j.ok) return location.reload(); alert('Add provider failed: '+(j.error||'unknown')); });
      return;
    }
  }

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
    body: JSON.stringify({ provider: payload, url: payload.url }),
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
  var answer = undefined;
  if (isV2Mode) {
    if (name === 'azure') {
      var rn = prompt('Enter Azure Resource Name (required for Azure):');
      if (rn === null) return;
      rn = rn.trim();
      if (!rn) { alert('Resource name required'); return; }
      answer = { resourceName: rn };
    } else if (name === 'cloudflare-ai-gateway') {
      var acc = prompt('Enter Cloudflare Account ID:');
      if (acc === null) return;
      acc = acc.trim();
      var gw = prompt('Enter Cloudflare AI Gateway ID:');
      if (gw === null) return;
      gw = gw.trim();
      if (!acc || !gw) { alert('Both fields required'); return; }
      answer = { accountId: acc, gatewayId: gw };
    } else if (name === 'cloudflare-workers-ai') {
      var acc2 = prompt('Enter Cloudflare Account ID:');
      if (acc2 === null) return;
      acc2 = acc2.trim();
      if (!acc2) { alert('Account ID required'); return; }
      answer = { accountId: acc2 };
    }
  }
  var first = pm && pm.registry.keyCount === 0;
  if (first && !isV2Mode && !confirm('This is the first key for ' + name + ' — it will be applied to the auth store and ai-dev will restart. Continue?')) return;
  var body = { value: value, note: note };
  if (answer) body.answer = answer;
  fetch('/api/providers/' + name + '/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  if (isV2Mode) {
    if (!confirm('Switch active credential?')) return;
  } else {
    if (!confirm('Switching the active key writes it to the auth store and restarts ai-dev (brief downtime). Continue?')) return;
  }
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
  if (isV2Mode) { alert('Key value is not retrievable via Integrations API (stored securely).'); return; }
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

function oauthStatus(text, provider) {
  var name = provider || oauthProvider;
  var el = document.getElementById('oauth-poll-status-' + name) || document.getElementById('oauth-poll-status');
  if (el) el.textContent = text;
}

function startOAuth(name) {
  if (isV2Mode) { return startOAuthV2(name, 'chatgpt-browser'); }
  oauthProvider = name;
  oauthFlowId = null;
  var flow = document.getElementById('oauth-flow-' + name) || document.getElementById('oauth-flow');
  if (flow) flow.hidden = false;
  var applyBtn = document.getElementById('oauth-apply-' + name) || document.getElementById('oauth-apply');
  if (applyBtn) applyBtn.hidden = true;
  oauthStatus('Requesting device code…', name);
  fetch('/api/providers/' + name + '/oauth/start', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { oauthStatus('Could not start: ' + (j.error || 'unknown error')); return; }
      oauthFlowId = j.flowId;
      var uri = j.verificationUri || 'https://auth.openai.com/codex/device';
      var codeEl = document.getElementById('oauth-user-code-' + oauthProvider) || document.getElementById('oauth-user-code');
      if (codeEl) codeEl.textContent = j.userCode || '---';
      var link = document.getElementById('oauth-verify-link-' + oauthProvider) || document.getElementById('oauth-verify-link');
      if (link) { link.href = uri; link.textContent = uri.replace(/^https?:\/\//, ''); }
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

function applyOAuth(name) {
  if (!oauthFlowId) return;
  var prov = name || oauthProvider;
  if (!confirm('Connect ChatGPT Pro/Plus? This writes an OAuth credential to the auth store (replacing any OpenAI API key) and restarts ai-dev (brief downtime). Continue?')) return;
  oauthStatus('Connecting…', prov);
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

function cancelOAuth(name) {
  clearInterval(oauthPollTimer);
  var prov = name || oauthProvider;
  oauthFlowId = null;
  if (!name) oauthProvider = null;
  var flow = document.getElementById('oauth-flow-' + prov) || document.getElementById('oauth-flow');
  if (flow) flow.hidden = true;
  var applyBtn = document.getElementById('oauth-apply-' + prov) || document.getElementById('oauth-apply');
  if (applyBtn) applyBtn.hidden = true;
}

function disconnectOAuth(name) {
  if (isV2Mode) {
    if (!confirm('Disconnect ChatGPT Pro/Plus? The OAuth credential is removed.')) return;
    fetch('/api/providers/' + name + '/oauth/v2/disconnect', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({}) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) return location.reload();
        alert('Disconnect failed: ' + (j.error || 'unknown error'));
      })
      .catch(function (err) {
        alert('Disconnect failed: ' + (err && err.message ? err.message : 'network error'));
      });
    return;
  }
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

function startOAuthV2(name, methodID) {
  oauthProvider = name;
  oauthFlowId = null;
  var flow = document.getElementById('oauth-flow-' + name) || document.getElementById('oauth-flow');
  if (flow) flow.hidden = false;
  var applyBtn = document.getElementById('oauth-apply-' + name) || document.getElementById('oauth-apply');
  if (applyBtn) applyBtn.hidden = true;
  oauthStatus('Starting OAuth…', name);
  fetch('/api/providers/' + name + '/oauth/v2/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ methodID: methodID || 'chatgpt-browser' })
  })
    .then(function(r){return r.json();})
    .then(function(j){
      if (!j.ok) { oauthStatus('Could not start: '+(j.error||'unknown')); return; }
      oauthFlowId = j.attemptID;
      if (j.url) {
        var codeEl2 = document.getElementById('oauth-user-code-' + oauthProvider) || document.getElementById('oauth-user-code');
        if (codeEl2) codeEl2.textContent = j.url;
        var link2 = document.getElementById('oauth-verify-link-' + oauthProvider) || document.getElementById('oauth-verify-link');
        if (link2) { link2.href = j.url; link2.textContent = j.url; }
      }
      oauthStatus(j.instructions || 'Complete authorization in your browser. Polling…');
      clearInterval(oauthPollTimer);
      oauthPollTimer = setInterval(function(){ pollOAuthV2(); }, 3000);
    })
    .catch(function(err){ oauthStatus('Could not start: '+(err && err.message ? err.message : 'network')); });
}

function pollOAuthV2() {
  if (!oauthFlowId) return;
  var prov = oauthProvider || 'openai';
  fetch('/api/providers/' + prov + '/oauth/v2/status/' + oauthFlowId)
    .then(function(r){return r.json();})
    .then(function(j){
      if (j.status === 'complete') {
        clearInterval(oauthPollTimer);
        oauthStatus('Authorization complete — connected.', oauthProvider);
        setTimeout(function(){ location.reload(); }, 1000);
      } else if (j.status === 'failed') {
        clearInterval(oauthPollTimer);
        oauthStatus('Authorization failed: '+(j.message||'unknown'));
      } else if (j.status === 'expired') {
        clearInterval(oauthPollTimer);
        oauthStatus('Code expired. Start again.');
      } else {
        oauthStatus('Waiting for authorization…');
      }
    });
}
