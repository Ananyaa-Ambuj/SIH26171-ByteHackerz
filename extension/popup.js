const result = document.getElementById("result");

const canvas = document.getElementById("screenshotCanvas");

const ctx = canvas.getContext("2d");


document.getElementById("readButton").addEventListener("click", async () => {

   
   
    
    //variable for screenshot
    let originalImage = null;
    


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

document.getElementById("screenshotButton").addEventListener("click", async () => {

    try {

        // Get the current active tab
        const tabs = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        const currentTab = tabs[0];

        console.log("Current tab:", currentTab);

        // Take screenshot of the current window
        const screenshot = await chrome.tabs.captureVisibleTab(
            currentTab.windowId,
            {
                format: "png"
            }
        );

        console.log("Screenshot captured!");

        // Create image
        const image = new Image();

        image.onload = function () {

            console.log("Image loaded!");

            // Set canvas size
            canvas.width = image.width;
            canvas.height = image.height;

            // Draw screenshot
            ctx.drawImage(image, 0, 0);

            // Save original image
            originalImage = image;

            result.textContent = "Screenshot captured successfully.";

           image.onload = function () {
              //A variable canvas for data transformation
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const ctx = canvas.getContext("2d");
              
         ctx.drawImage(image, 0, 0);   
              kkkkkkkkkkk
      
        };

        image.onerror = function () {

            console.error("Image could not be loaded.");

            result.textContent = "Screenshot was captured but image could not be loaded.";

        };

        image.src = screenshot;

    } catch (error) {

        console.error("SCREENSHOT ERROR:", error);

        result.textContent =
            "Screenshot error: " + error.message;

    }

});
