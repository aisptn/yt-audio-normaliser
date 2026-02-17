// ─────────────────────────────────────────────────────────────
// YouTube Audio Normalizer — Popup Script
// Communicates with the content script running on the active
// YouTube tab to read / write settings and display meters.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ─── DOM refs ──────────────────────────────────────────────
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const dom = {
    enabled:    $('#enabled'),
    autoGain:   $('#autoGain'),
    statusDot:  $('#statusDot'),
    statusText: $('#statusText'),
    targetLevel:    $('#targetLevel'),
    targetLevelVal: $('#targetLevelVal'),
    threshold:    $('#threshold'),   thresholdVal:  $('#thresholdVal'),
    ratio:        $('#ratio'),       ratioVal:      $('#ratioVal'),
    knee:         $('#knee'),        kneeVal:       $('#kneeVal'),
    attack:       $('#attack'),      attackVal:     $('#attackVal'),
    release:      $('#release'),     releaseVal:    $('#releaseVal'),
    makeupGain:   $('#makeupGain'),  makeupGainVal: $('#makeupGainVal'),
    preGain:      $('#preGain'),     preGainVal:    $('#preGainVal'),
    // meters
    meterIn:  $('#meterIn'),   valIn:  $('#valIn'),
    meterOut: $('#meterOut'),  valOut: $('#valOut'),
    meterGR:  $('#meterGR'),   valGR:  $('#valGR'),
    meterAG:  $('#meterAG'),   valAG:  $('#valAG'),
    resetBtn: $('#resetBtn'),
    targetSection: $('#targetSection')
  };

  let currentSettings = {};
  let pollTimer = null;
  let tabId = null;

  // ─── Helpers ───────────────────────────────────────────────
  async function getActiveYTTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && /youtube\.com/.test(tab.url)) return tab;
    return null;
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      if (!tabId) return resolve(null);
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    });
  }

  // ─── Populate UI from settings object ──────────────────────
  function populateUI(s) {
    currentSettings = s;
    dom.enabled.checked  = s.enabled;
    dom.autoGain.checked = s.autoGain;

    dom.targetLevel.value = s.targetLevel;
    dom.threshold.value   = s.threshold;
    dom.ratio.value       = s.ratio;
    dom.knee.value        = s.knee;
    dom.attack.value      = s.attack;
    dom.release.value     = s.release;
    dom.makeupGain.value  = s.makeupGain;
    dom.preGain.value     = s.preGain;

    updateValueLabels();
    highlightPreset(s.preset);
  }

  function updateValueLabels() {
    dom.targetLevelVal.textContent = `${dom.targetLevel.value} dB`;
    dom.thresholdVal.textContent   = `${dom.threshold.value} dB`;
    dom.ratioVal.textContent       = `${dom.ratio.value} : 1`;
    dom.kneeVal.textContent        = `${dom.knee.value} dB`;
    dom.attackVal.textContent      = `${dom.attack.value} ms`;
    dom.releaseVal.textContent     = `${dom.release.value} ms`;
    dom.makeupGainVal.textContent  = `+${dom.makeupGain.value} dB`;
    const pg = parseFloat(dom.preGain.value);
    dom.preGainVal.textContent     = `${pg >= 0 ? '+' : ''}${pg} dB`;
  }

  function highlightPreset(name) {
    $$('.preset').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === name);
    });
  }

  // ─── Meter drawing ────────────────────────────────────────
  function updateMeters(levels, autoGainValue) {
    // Input: -60…0 dB  →  0…100%
    const inPct  = Math.max(0, Math.min(100, ((levels.inputRMS  + 60) / 60) * 100));
    const outPct = Math.max(0, Math.min(100, ((levels.outputRMS + 60) / 60) * 100));
    // Gain reduction: 0…-40 dB → 0…100% (shown right-to-left)
    const grPct  = Math.max(0, Math.min(100, (Math.abs(levels.reduction) / 40) * 100));

    dom.meterIn.style.width  = `${inPct}%`;
    dom.meterOut.style.width = `${outPct}%`;
    dom.meterGR.style.width  = `${grPct}%`;

    dom.valIn.textContent  = levels.inputRMS  > -100 ? `${levels.inputRMS.toFixed(1)} dB`  : '—';
    dom.valOut.textContent = levels.outputRMS > -100 ? `${levels.outputRMS.toFixed(1)} dB` : '—';
    dom.valGR.textContent  = `${levels.reduction.toFixed(1)} dB`;

    // Auto-gain: show bar centered at 50%, expanding left (neg) or right (pos)
    const ag = autoGainValue || 0;
    const agNorm = Math.max(-24, Math.min(24, ag)); // clamp
    const agPct = (Math.abs(agNorm) / 24) * 50;     // max 50% width
    if (agNorm >= 0) {
      dom.meterAG.style.left  = '50%';
      dom.meterAG.style.width = `${agPct}%`;
    } else {
      dom.meterAG.style.left  = `${50 - agPct}%`;
      dom.meterAG.style.width = `${agPct}%`;
    }
    dom.valAG.textContent = `${ag >= 0 ? '+' : ''}${ag.toFixed(1)} dB`;
  }

  // ─── Polling loop ─────────────────────────────────────────
  async function poll() {
    const resp = await sendMsg({ type: 'getState' });
    if (!resp) {
      dom.statusDot.className = 'dot error';
      dom.statusText.textContent = 'No YouTube tab detected';
      return;
    }

    if (resp.isActive) {
      dom.statusDot.className = 'dot active';
      dom.statusText.textContent = `Active · ${resp.contextState}`;
    } else {
      dom.statusDot.className = 'dot';
      dom.statusText.textContent = 'Waiting for video…';
    }

    updateMeters(resp.levels, resp.autoGainValue);
  }

  function startPolling() {
    poll();
    pollTimer = setInterval(poll, 150);
  }

  // ─── Send settings to content script ──────────────────────
  function pushSettings(extra = {}) {
    const s = {
      enabled:     dom.enabled.checked,
      autoGain:    dom.autoGain.checked,
      targetLevel: parseFloat(dom.targetLevel.value),
      threshold:   parseFloat(dom.threshold.value),
      ratio:       parseFloat(dom.ratio.value),
      knee:        parseFloat(dom.knee.value),
      attack:      parseFloat(dom.attack.value),
      release:     parseFloat(dom.release.value),
      makeupGain:  parseFloat(dom.makeupGain.value),
      preGain:     parseFloat(dom.preGain.value),
      ...extra
    };
    sendMsg({ type: 'updateSettings', settings: s });
  }

  // ─── Event listeners ──────────────────────────────────────
  function bindEvents() {
    // Enable toggle
    dom.enabled.addEventListener('change', () => {
      pushSettings({ enabled: dom.enabled.checked });
    });

    // Auto-gain toggle
    dom.autoGain.addEventListener('change', () => {
      pushSettings({ autoGain: dom.autoGain.checked });
    });

    // Preset buttons
    $$('.preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        highlightPreset(preset);

        if (preset === 'custom') {
          pushSettings({ preset: 'custom' });
          return;
        }

        sendMsg({ type: 'applyPreset', preset }).then((resp) => {
          if (resp && resp.settings) populateUI(resp.settings);
        });
      });
    });

    // Sliders
    const sliders = ['targetLevel', 'threshold', 'ratio', 'knee',
                     'attack', 'release', 'makeupGain', 'preGain'];
    sliders.forEach((id) => {
      dom[id].addEventListener('input', () => {
        updateValueLabels();
        highlightPreset('custom');
        pushSettings({ preset: 'custom' });
      });
    });

    // Reset
    dom.resetBtn.addEventListener('click', async () => {
      const resp = await sendMsg({ type: 'resetSettings' });
      if (resp && resp.settings) populateUI(resp.settings);
    });
  }

  // ─── Init ──────────────────────────────────────────────────
  async function init() {
    const tab = await getActiveYTTab();
    if (tab) {
      tabId = tab.id;
      const resp = await sendMsg({ type: 'getState' });
      if (resp && resp.settings) {
        populateUI(resp.settings);
      }
    } else {
      dom.statusDot.className = 'dot error';
      dom.statusText.textContent = 'Open a YouTube page first';
    }

    bindEvents();
    startPolling();
  }

  init();

  // cleanup on popup close
  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
})();