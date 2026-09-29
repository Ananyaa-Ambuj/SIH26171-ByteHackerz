// Privag AI — Background Service Worker
// Automatically opens the Chrome Side Panel when the toolbar icon is clicked

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Privag Background] Error setting panel behavior:', error));

console.log('[Privag Background] Service Worker initialized with Side Panel support.');
