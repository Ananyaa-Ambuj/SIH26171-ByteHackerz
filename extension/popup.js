document.getElementById("readButton").addEventListener("click", async () => {

    const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    const currentTab = tabs[0];

    document.getElementById("result").textContent = currentTab.title;

});