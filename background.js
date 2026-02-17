// Service worker — handles installation and sets defaults

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({
      normalizerSettings: {
        enabled: true,
        preset: 'medium',
        autoGain: true,
        targetLevel: -14,
        threshold: -24,
        ratio: 4,
        knee: 10,
        attack: 3,
        release: 250,
        makeupGain: 6,
        preGain: 0,
        limiterThreshold: -1
      }
    });
    console.log('[YT Normalizer] Installed with default settings.');
  }
});