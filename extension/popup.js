const result = document.getElementById("result");
const canvas = document.getElementById("screenshotCanvas");
const ctx = canvas.getContext("2d");

// Keep track of the image globally if needed
let originalImage = null;

// Helper function to make sure the offscreen document is open before messaging it
async function setupOffscreenDocument() {
    if (await chrome.offscreen.hasDocument?.()) return;
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSING'],
        justification: 'Running Florence Worker and canvas operations.'
    });
}

// 1. YOUR EXISTING READ BUTTON LOGIC (Kept exactly as you wrote it)
document.getElementById("readButton").addEventListener("click", async () => {
    result.textContent = "Reading page...";
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTab = tabs[0];

        if (!currentTab || !currentTab.id) {
            result.textContent = "Could not find current tab.";
            return;
        }

        await chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            files: ["content.js"]
        });

        chrome.tabs.sendMessage(currentTab.id, { action: "getPageText" }, (response) => {
            if (chrome.runtime.lastError) {
                result.textContent = "Error: " + chrome.runtime.lastError.message;
                return;
            }
            if (!response) {
                result.textContent = "No response from content script.";
                return;
            }
            result.textContent = response.text;
        });
    } catch (error) {
        result.textContent = "Error: " + error.message;
    }
});

// 2. UPDATED SCREENSHOT BUTTON LOGIC
document.getElementById("screenshotButton").addEventListener("click", async () => {
    try {
        result.textContent = "Capturing screen...";
        
        // Ensure offscreen document is ready to accept the image
        await setupOffscreenDocument();

        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTab = tabs[0];

        // Take screenshot of the current window
        const screenshot = await chrome.tabs.captureVisibleTab(
            currentTab.windowId,
            { format: "png" }
        );

        console.log("Screenshot captured!");
        result.textContent = "Analyzing & Redacting via Florence-2...";

        // Send the screenshot directly to your offscreen.js worker pipeline
        chrome.runtime.sendMessage({
            action: 'RUN_FLORENCE',
            image: screenshot
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
                result.textContent = "Communication error: " + chrome.runtime.lastError.message;
                return;
            }

            if (response && response.success) {
                // Create an image out of the redacted URL returned by offscreen.js
                const redactedImage = new Image();
                redactedImage.onload = function () {
                    // Update canvas dimensions to match the image dimensions
                    canvas.width = redactedImage.width;
                    canvas.height = redactedImage.height;

                    // Clear the old preview and draw the clean, redacted canvas screenshot
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(redactedImage, 0, 0);

                    originalImage = redactedImage;
                    result.textContent = `Redaction complete! (Took ${response.latencyMs || 0}ms)`;
                };
                
                redactedImage.onerror = function () {
                    result.textContent = "Error displaying redacted image preview.";
                };

                redactedImage.src = response.redactedUrl;
            } else {
                result.textContent = "Redaction failed: " + (response.error || "Unknown worker error");
            }
        });

    } catch (error) {
        console.error("SCREENSHOT ERROR:", error);
        result.textContent = "Screenshot error: " + error.message;
    }
});
