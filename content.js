// ─────────────────────────────────────────────────────────────
// YouTube Audio Normalizer — Content Script
// Injected into youtube.com and music.youtube.com pages.
// Uses Web Audio API to apply dynamic-range compression,
// automatic gain control, and brick-wall limiting.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  /* ── guard against double-injection ── */
  if (window.__ytAudioNormalizerActive) return;
  window.__ytAudioNormalizerActive = true;

  // ─── Presets ───────────────────────────────────────────────
  const PRESETS = {
    light: {
      threshold: -18,
      ratio: 2,
      knee: 20,
      attack: 10,
      release: 300,
      makeupGain: 2,
      autoGain: true,
      targetLevel: -16
    },
    medium: {
      threshold: -24,
      ratio: 4,
      knee: 10,
      attack: 3,
      release: 250,
      makeupGain: 6,
      autoGain: true,
      targetLevel: -14
    },
    heavy: {
      threshold: -35,
      ratio: 10,
      knee: 5,
      attack: 1,
      release: 150,
      makeupGain: 12,
      autoGain: true,
      targetLevel: -11
    }
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    preset: 'medium',
    autoGain: true,
    targetLevel: -14,
    threshold: -24,
    ratio: 4,
    knee: 10,
    attack: 3,       // ms — stored as ms, converted to seconds for Web Audio
    release: 250,     // ms
    makeupGain: 6,    // dB
    preGain: 0,       // dB
    limiterThreshold: -1 // dB
  };

  // ─── State ─────────────────────────────────────────────────
  let settings = { ...DEFAULT_SETTINGS };
  let audioCtx = null;
  let nodes = {};          // all AudioNodes
  let currentVideo = null; // currently connected <video>
  let metering = null;     // setInterval id
  let autoGainValue = 0;   // current auto-gain in dB
  let levels = { inputRMS: -Infinity, outputRMS: -Infinity, reduction: 0 };
  let rmsHistory = [];
  const RMS_HISTORY_LEN = 20; // ~2 s at 100 ms interval

  // ─── Helpers ───────────────────────────────────────────────
  const dBtoLinear = (dB) => Math.pow(10, dB / 20);
  const linearToDB = (lin) => 20 * Math.log10(lin || 1e-10);

  function calcRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }

  // ─── Load / Save settings ─────────────────────────────────
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('normalizerSettings', (res) => {
        if (res.normalizerSettings) {
          settings = { ...DEFAULT_SETTINGS, ...res.normalizerSettings };
        }
        resolve(settings);
      });
    });
  }

  function saveSettings() {
    chrome.storage.sync.set({ normalizerSettings: settings });
  }

  // ─── Build the audio graph ─────────────────────────────────
  //
  //  source ──▸ inputAnalyser ──▸ preGain ──▸ autoGain
  //       ──▸ compressor ──▸ makeupGain ──▸ limiter
  //       ──▸ outputAnalyser ──▸ destination
  //
  function buildGraph(video) {
    if (currentVideo === video && audioCtx) return;   // already wired
    currentVideo = video;

    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext();
      }

      // Source — may only be created once per element
      let source;
      try {
        source = audioCtx.createMediaElementSource(video);
      } catch (e) {
        console.warn('[YT Normalizer] createMediaElementSource failed:', e.message);
        return;
      }

      // --- create nodes ---
      const inputAnalyser  = audioCtx.createAnalyser();
      const preGain        = audioCtx.createGain();
      const autoGain       = audioCtx.createGain();
      const compressor     = audioCtx.createDynamicsCompressor();
      const makeupGain     = audioCtx.createGain();
      const limiter        = audioCtx.createDynamicsCompressor();
      const outputAnalyser = audioCtx.createAnalyser();

      inputAnalyser.fftSize  = 2048;
      outputAnalyser.fftSize = 2048;

      // limiter — brick-wall
      limiter.threshold.value = -1;
      limiter.ratio.value     = 20;
      limiter.knee.value      = 0;
      limiter.attack.value    = 0.001;
      limiter.release.value   = 0.01;

      nodes = { source, inputAnalyser, preGain, autoGain,
                compressor, makeupGain, limiter, outputAnalyser };

      applySettingsToNodes();

      if (settings.enabled) {
        connectProcessing();
      } else {
        connectBypass();
      }

      if (audioCtx.state === 'suspended') audioCtx.resume();

      startMetering();
      console.log('[YT Normalizer] Audio graph ready.');
    } catch (e) {
      console.error('[YT Normalizer] buildGraph error:', e);
    }
  }

  // ─── Connection helpers ────────────────────────────────────
  function disconnectAll() {
    Object.values(nodes).forEach((n) => {
      try { n.disconnect(); } catch (_) { /* ignore */ }
    });
  }

  function connectProcessing() {
    disconnectAll();
    const { source, inputAnalyser, preGain, autoGain,
            compressor, makeupGain, limiter, outputAnalyser } = nodes;
    source.connect(inputAnalyser);
    inputAnalyser.connect(preGain);
    preGain.connect(autoGain);
    autoGain.connect(compressor);
    compressor.connect(makeupGain);
    makeupGain.connect(limiter);
    limiter.connect(outputAnalyser);
    outputAnalyser.connect(audioCtx.destination);
  }

  function connectBypass() {
    disconnectAll();
    nodes.source.connect(audioCtx.destination);
  }

  // ─── Apply current settings to audio nodes ─────────────────
  function applySettingsToNodes() {
    if (!nodes.compressor) return;

    const c = nodes.compressor;
    c.threshold.value = settings.threshold;
    c.ratio.value     = settings.ratio;
    c.knee.value      = settings.knee;
    c.attack.value    = settings.attack / 1000;   // ms → s
    c.release.value   = settings.release / 1000;   // ms → s

    nodes.makeupGain.gain.value = dBtoLinear(settings.makeupGain);
    nodes.preGain.gain.value    = dBtoLinear(settings.preGain);
    nodes.limiter.threshold.value = settings.limiterThreshold;

    if (!settings.autoGain) {
      autoGainValue = 0;
      nodes.autoGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.05);
    }
  }

  // ─── Metering + Auto-Gain loop ─────────────────────────────
  function startMetering() {
    if (metering) clearInterval(metering);
    rmsHistory = [];
    autoGainValue = 0;

    metering = setInterval(() => {
      if (!audioCtx || !nodes.inputAnalyser) return;

      // --- input level ---
      const inBuf = new Float32Array(nodes.inputAnalyser.fftSize);
      nodes.inputAnalyser.getFloatTimeDomainData(inBuf);
      const inRMS = calcRMS(inBuf);
      levels.inputRMS = linearToDB(inRMS);

      // --- output level ---
      const outBuf = new Float32Array(nodes.outputAnalyser.fftSize);
      nodes.outputAnalyser.getFloatTimeDomainData(outBuf);
      const outRMS = calcRMS(outBuf);
      levels.outputRMS = linearToDB(outRMS);

      // --- compressor reduction ---
      levels.reduction = nodes.compressor.reduction;  // negative dB

      // --- Auto-Gain Control ---
      if (settings.enabled && settings.autoGain && inRMS > 0.0005) {
        rmsHistory.push(levels.inputRMS);
        if (rmsHistory.length > RMS_HISTORY_LEN) rmsHistory.shift();

        const avgDB = rmsHistory.reduce((a, b) => a + b, 0) / rmsHistory.length;
        const desired = settings.targetLevel - avgDB;
        // Smoothly approach desired gain, clamp range
        autoGainValue += (desired - autoGainValue) * 0.08;
        autoGainValue = Math.max(-24, Math.min(24, autoGainValue));

        nodes.autoGain.gain.setTargetAtTime(
          dBtoLinear(autoGainValue),
          audioCtx.currentTime,
          0.3
        );
      }
    }, 100);
  }

  // ─── Find the <video> element ──────────────────────────────
  function findVideo() {
    return (
      document.querySelector('#movie_player video') ||
      document.querySelector('ytmusic-player video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video')
    );
  }

  function tryAttach() {
    const video = findVideo();
    if (!video || video === currentVideo) return;
    if (video.readyState >= 2) {
      buildGraph(video);
    } else {
      video.addEventListener('canplay', () => buildGraph(video), { once: true });
    }
  }

  // ─── Observe DOM for SPA navigation ───────────────────────
  function observe() {
    // YouTube fires this custom event on navigation
    document.addEventListener('yt-navigate-finish', tryAttach);
    window.addEventListener('popstate', tryAttach);

    // Fallback: MutationObserver + polling
    const mo = new MutationObserver(() => tryAttach());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(tryAttach, 3000);
  }

  // ─── Resume AudioContext on user gesture ──────────────────
  function resumeOnGesture() {
    const resume = () => {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    };
    document.addEventListener('click', resume, { once: false });
    document.addEventListener('keydown', resume, { once: false });
  }

  // ─── Message handling (popup ↔ content) ───────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'getState':
        sendResponse({
          settings,
          levels,
          autoGainValue,
          isActive: !!(audioCtx && nodes.source),
          contextState: audioCtx ? audioCtx.state : 'none'
        });
        break;

      case 'updateSettings': {
        const incoming = msg.settings;
        // If a preset was selected, merge preset values
        if (incoming.preset && incoming.preset !== 'custom' && PRESETS[incoming.preset]) {
          Object.assign(settings, incoming, PRESETS[incoming.preset]);
        } else {
          Object.assign(settings, incoming);
          if (incoming.preset !== settings.preset) settings.preset = 'custom';
        }
        saveSettings();
        applySettingsToNodes();

        if (typeof incoming.enabled !== 'undefined') {
          if (incoming.enabled) connectProcessing(); else connectBypass();
        }

        sendResponse({ success: true, settings });
        break;
      }

      case 'applyPreset': {
        const p = PRESETS[msg.preset];
        if (p) {
          Object.assign(settings, p, { preset: msg.preset, enabled: true });
          saveSettings();
          applySettingsToNodes();
          connectProcessing();
        }
        sendResponse({ success: true, settings });
        break;
      }

      case 'resetSettings':
        settings = { ...DEFAULT_SETTINGS };
        saveSettings();
        applySettingsToNodes();
        if (settings.enabled) connectProcessing(); else connectBypass();
        sendResponse({ success: true, settings });
        break;

      default:
        sendResponse({ error: 'unknown message type' });
    }
    return true; // keep channel open for async sendResponse
  });

  // ─── Init ──────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    tryAttach();
    observe();
    resumeOnGesture();
    console.log('[YT Normalizer] Content script loaded.');
  }

  init();
})();