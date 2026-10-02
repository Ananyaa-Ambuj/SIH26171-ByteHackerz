// Privag AI — Background Service Worker (Chrome/Brave) / event page (Firefox)
// Opens the extension's panel (sidepanel.html) when the toolbar icon is clicked

if (chrome.sidePanel) {
  // Chrome/Brave: the Side Panel API
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[Privag Background] Error setting panel behavior:', error));
} else if (chrome.sidebarAction) {
  // Firefox has no sidePanel API: the same page is the sidebar (manifest "sidebar_action"). sidebarAction.open()
  // is only allowed while handling a user action, so it is called synchronously from the click.
  chrome.action.onClicked.addListener(() => {
    chrome.sidebarAction.open().catch((error) => console.error('[Privag Background] Error opening sidebar:', error));
  });
}

console.log('[Privag Background] Initialized with panel support.');
