(function () {
  var APPLY_FAILURE_PREFIX = 'agent-models-apply-failed:';
  var LAST_CHANGED_AGENT_KEY = 'agent-models-last-changed';

  function failureKey(agent) {
    return APPLY_FAILURE_PREFIX + agent;
  }

  function agents() {
    return window.agentModelsState && Array.isArray(window.agentModelsState.agents)
      ? window.agentModelsState.agents
      : [];
  }

  function rowForAgent(agent) {
    return document.querySelector('#agent-models-table tr[data-agent="' + CSS.escape(agent) + '"]');
  }

  function renderAttentionSummary() {
    var unresolved = agents().filter(function (agent) {
      return sessionStorage.getItem(failureKey(agent.name)) === '1';
    });
    var summary = document.getElementById('agent-models-attention');
    if (!summary) return;
    var title = summary.querySelector('.agent-models-attention__title');
    var list = summary.querySelector('.agent-models-attention__list');
    list.textContent = '';
    summary.hidden = unresolved.length === 0;
    if (unresolved.length === 0) return;
    title.textContent = unresolved.length + ' agent' + (unresolved.length === 1 ? '' : 's') + ' still need attention';
    unresolved.forEach(function (agent) {
      var item = document.createElement('li');
      var link = document.createElement('a');
      link.className = 'agent-models-attention__link';
      link.href = '#row-' + agent.name;
      link.textContent = agent.name;
      item.appendChild(link);
      list.appendChild(item);
    });
  }

  function setApplyFailure(agent, failed) {
    if (failed) sessionStorage.setItem(failureKey(agent), '1');
    else sessionStorage.removeItem(failureKey(agent));
    renderAttentionSummary();
  }

  function markChanged(agent) {
    sessionStorage.setItem(LAST_CHANGED_AGENT_KEY, agent);
    document.querySelectorAll('.recently-changed').forEach(function (badge) { badge.style.display = 'none'; });
    document.querySelectorAll('#agent-models-table tr.batch-recently-changed').forEach(function (row) {
      row.classList.remove('batch-recently-changed');
    });
    var row = rowForAgent(agent);
    if (!row) return;
    row.classList.add('batch-recently-changed');
    var badge = row.querySelector('.recently-changed');
    if (badge) badge.style.display = 'inline-flex';
  }

  function clearRecent() {
    sessionStorage.removeItem(LAST_CHANGED_AGENT_KEY);
    document.querySelectorAll('.recently-changed').forEach(function (badge) { badge.style.display = 'none'; });
    document.querySelectorAll('#agent-models-table tr.batch-recently-changed').forEach(function (row) {
      row.classList.remove('batch-recently-changed');
    });
  }

  function restoreApplyFailures() {
    agents().forEach(function (agent) {
      if (sessionStorage.getItem(failureKey(agent.name)) !== '1') return;
      var row = rowForAgent(agent.name);
      if (!row) return;
      row.classList.add('batch-failed');
      var result = row.querySelector('.batch-result');
      if (result) {
        result.style.display = 'block';
        result.style.color = 'var(--danger)';
        result.textContent = 'Previous Apply failed; this agent still needs attention.';
      }
    });
    var lastChanged = sessionStorage.getItem(LAST_CHANGED_AGENT_KEY);
    if (lastChanged && agents().some(function (agent) { return agent.name === lastChanged; })) markChanged(lastChanged);
    renderAttentionSummary();
  }

  window.AgentModelsAttention = { setApplyFailure: setApplyFailure, markChanged: markChanged, clearRecent: clearRecent };
  if (document.getElementById('agent-models-attention')) restoreApplyFailures();
})();
