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

    if (message.action === "EXECUTE_ACTION") {
        const data = message.data || {};
        const { action, coordinates, target, value } = data;

        console.log('[Privag Content] Executing action:', data);

        // Visual pointer ripple for live demonstrations
        function showVisualMarker(x, y, label) {
            const marker = document.createElement('div');
            marker.style.position = 'fixed';
            marker.style.left = `${x - 15}px`;
            marker.style.top = `${y - 15}px`;
            marker.style.width = '30px';
            marker.style.height = '30px';
            marker.style.borderRadius = '50%';
            marker.style.border = '3px solid #EF4444';
            marker.style.backgroundColor = 'rgba(239, 68, 68, 0.3)';
            marker.style.zIndex = '9999999';
            marker.style.pointerEvents = 'none';
            marker.style.transition = 'all 0.5s ease-out';
            marker.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.8)';

            if (label) {
                const tag = document.createElement('span');
                tag.textContent = label;
                tag.style.position = 'absolute';
                tag.style.bottom = '-20px';
                tag.style.left = '50%';
                tag.style.transform = 'translateX(-50%)';
                tag.style.background = '#1E293B';
                tag.style.color = '#FFFFFF';
                tag.style.padding = '2px 6px';
                tag.style.borderRadius = '4px';
                tag.style.fontSize = '11px';
                tag.style.fontWeight = 'bold';
                tag.style.whiteSpace = 'nowrap';
                marker.appendChild(tag);
            }

            document.body.appendChild(marker);

            setTimeout(() => {
                marker.style.transform = 'scale(1.8)';
                marker.style.opacity = '0';
            }, 300);

            setTimeout(() => {
                marker.remove();
            }, 800);
        }

        try {
            if (action === 'click') {
                if (Array.isArray(coordinates) && coordinates.length >= 2) {
                    const [x, y] = coordinates;
                    showVisualMarker(x, y, `Click: ${target || ''}`);

                    const el = document.elementFromPoint(x, y);
                    if (el) {
                        el.focus?.();
                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                        el.click?.();
                        sendResponse({ success: true, message: `Clicked element at (${x}, ${y})` });
                        return true;
                    }
                }
                sendResponse({ success: false, message: 'Could not find element at coordinates' });
                return true;

            } else if (action === 'type') {
                let targetEl = null;
                if (Array.isArray(coordinates) && coordinates.length >= 2) {
                    targetEl = document.elementFromPoint(coordinates[0], coordinates[1]);
                    showVisualMarker(coordinates[0], coordinates[1], `Type: ${value || ''}`);
                }

                if (!targetEl) {
                    targetEl = document.activeElement;
                }

                if (targetEl && ('value' in targetEl)) {
                    targetEl.focus();
                    targetEl.value = value || '';
                    targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                    targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                    sendResponse({ success: true, message: `Typed into target` });
                    return true;
                }

                sendResponse({ success: false, message: 'No editable input found' });
                return true;

            } else if (action === 'scroll') {
                const scrollAmount = value === 'up' ? -400 : 400;
                window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
                sendResponse({ success: true, message: `Scrolled ${value || 'down'}` });
                return true;

            } else if (action === 'wait' || action === 'done') {
                sendResponse({ success: true, message: `Action ${action} acknowledged` });
                return true;
            }

            sendResponse({ success: true, message: `Unrecognized action: ${action}` });
        } catch (err) {
            console.error('[Privag Content] Execution error:', err);
            sendResponse({ success: false, error: err.message });
        }
    }
});