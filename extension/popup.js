document.getElementById("readButton").addEventListener("click", async () => {

    const result = document.getElementById("result");

    result.textContent = "Reading page...";

    try {

        const tabs = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        const currentTab = tabs[0];

        if (!currentTab || !currentTab.id) {
            result.textContent = "Could not find current tab.";
            return;
        }

        await chrome.scripting.executeScript({
            target: {
                tabId: currentTab.id
            },
            files: ["content.js"]
        });

        chrome.tabs.sendMessage(
            currentTab.id,
            {
                action: "getPageText"
            },
            (response) => {

                if (chrome.runtime.lastError) {

                    result.textContent =
                        "Error: " + chrome.runtime.lastError.message;

                    return;
                }

                if (!response) {

                    result.textContent =
                        "No response from content script.";

                    return;
                }

                result.textContent = response.text;
            }
        );

    } catch (error) {

        result.textContent =
            "Error: " + error.message;

    }

});