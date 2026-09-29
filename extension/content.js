chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === "getPageText") {

        const headings = document.querySelectorAll("h1, h2, h3");
        const paragraphs = document.querySelectorAll("p");

        let usefulText = "";

        headings.forEach((heading) => {
            const text = heading.innerText.trim();

            if (text !== "") {
                usefulText += text + "\n\n";
            }
        });

        paragraphs.forEach((paragraph) => {
            const text = paragraph.innerText.trim();

            if (text !== "") {
                usefulText += text + "\n\n";
            }
        });

        usefulText = usefulText.substring(0, 5000);

        sendResponse({
            text: usefulText
        });
    }

});