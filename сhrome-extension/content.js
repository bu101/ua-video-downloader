// Content Script для взаємодії зі сторінкою

console.log('HLS Video Downloader: Content script loaded');

// Перехоплення XMLHttpRequest для виявлення .m3u8 запитів
(function () {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalFetch = window.fetch;

    // Перехоплення XMLHttpRequest
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.m3u8')) {
            console.log('XHR .m3u8 detected:', url);
            chrome.runtime.sendMessage({
                type: 'M3U8_DETECTED',
                url: url,
                method: 'XHR'
            });
        }
        return originalOpen.apply(this, arguments);
    };

    // Перехоплення Fetch API
    window.fetch = function (url, options) {
        if (typeof url === 'string' && url.includes('.m3u8')) {
            console.log('Fetch .m3u8 detected:', url);
            chrome.runtime.sendMessage({
                type: 'M3U8_DETECTED',
                url: url,
                method: 'Fetch'
            });
        }
        return originalFetch.apply(this, arguments);
    };
})();

// Пошук відео елементів на сторінці
function findVideoElements() {
    const videos = document.querySelectorAll('video');
    const videoInfo = [];

    videos.forEach((video, index) => {
        const info = {
            index: index,
            src: video.src || video.currentSrc,
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight,
            paused: video.paused
        };

        videoInfo.push(info);
    });

    if (videoInfo.length > 0) {
        console.log('Found video elements:', videoInfo);
    }

    return videoInfo;
}

// Спостереження за DOM для нових відео елементів
const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
            mutation.addedNodes.forEach(node => {
                if (node.tagName === 'VIDEO') {
                    console.log('New video element added:', node);
                    findVideoElements();
                }
            });
        }
    }
});

// Запуск спостереження
observer.observe(document.body, {
    childList: true,
    subtree: true
});

// Початковий пошук відео
setTimeout(() => {
    findVideoElements();
}, 2000);

// Слухаємо повідомлення від background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_PAGE_INFO') {
        sendResponse({
            url: window.location.href,
            title: document.title,
            videos: findVideoElements()
        });
    }
});
