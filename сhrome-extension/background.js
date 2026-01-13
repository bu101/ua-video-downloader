// Background Service Worker для перехоплення .m3u8 запитів
import { parseM3U8, downloadVideo } from './lib/downloader.js';
import { clearChunks, openDB } from './lib/db.js';

// Зберігання знайдених .m3u8 URL у пам'яті (синхронізовано з chrome.storage)
let foundVideos = [];
const downloadQueue = [];
let currentDownloadingUrl = null;

// Ініціалізація при кожному запуску/просинанні
chrome.storage.local.get(['foundVideos'], (data) => {
  if (data.foundVideos) {
    foundVideos = data.foundVideos;
    chrome.action.setBadgeText({ text: foundVideos.length > 0 ? foundVideos.length.toString() : '' });
    // Чистимо стару базу даних при запуску
    autoCleanupDB();
  }
});

// Функція для підтримки Service Worker у "бадьорому" стані
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => { });
  }, 20000);
}

function stopKeepAlive() {
  if (activeDownloads.size === 0) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Слухаємо всі мережеві запити
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;

    // Перевіряємо чи це .m3u8 файл
    if (url.includes('.m3u8')) {
      console.log('Found .m3u8 URL:', url);

      // Додаємо до списку якщо ще немає
      const exists = foundVideos.some(video => video.url === url);
      if (!exists) {
        const createVideoInfo = (title = 'Без назви') => {
          const videoInfo = {
            url: url,
            timestamp: new Date().toISOString(),
            tabId: details.tabId,
            title: title,
            quality: detectQuality(url)
          };
          foundVideos.push(videoInfo);
          chrome.storage.local.set({ foundVideos: foundVideos });
          chrome.runtime.sendMessage({ type: 'NEW_VIDEO_FOUND', video: videoInfo }).catch(() => { });
          chrome.action.setBadgeText({ text: foundVideos.length.toString() });
          chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        };

        if (details.tabId > -1) {
          chrome.tabs.get(details.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              createVideoInfo();
            } else {
              createVideoInfo(tab.title);
            }
          });
        } else {
          createVideoInfo();
        }
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// Визначення якості з URL
function detectQuality(url) {
  const qualityMatch = url.match(/\/(\d+p?)\//);
  if (qualityMatch) {
    return qualityMatch[1];
  }

  // Шукаємо числа типу 720, 1080 тощо
  const resolutionMatch = url.match(/\/(\d{3,4})\//);
  if (resolutionMatch) {
    return resolutionMatch[1] + 'p';
  }

  return 'Unknown';
}

// Об’єкт для зберігання активних завантажень та їх станів
const activeDownloads = new Map();

// Обробка повідомлень від popup або content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_VIDEOS') {
    sendResponse({ videos: foundVideos });
  } else if (message.type === 'CLEAR_VIDEOS') {
    foundVideos = [];
    chrome.storage.local.set({ foundVideos: [] });
    chrome.action.setBadgeText({ text: '' });
    autoCleanupDB(); // Очищаємо всі чанки з бази
    sendResponse({ success: true });
  } else if (message.type === 'DOWNLOAD_VIDEO') {
    addToQueue(message.videoUrl);
    sendResponse({ success: true });
  } else if (message.type === 'PAUSE_DOWNLOAD') {
    const download = activeDownloads.get(message.videoUrl);
    if (download) {
      download.controls.isPaused = true;
      stopKeepAlive();
      sendResponse({ success: true });
    }
  } else if (message.type === 'RESUME_DOWNLOAD') {
    const download = activeDownloads.get(message.videoUrl);
    if (download) {
      download.controls.isPaused = false;
      if (currentDownloadingUrl === message.videoUrl) {
        startKeepAlive();
        handleDownload(message.videoUrl);
      } else {
        addToQueue(message.videoUrl);
      }
      sendResponse({ success: true });
    }
  } else if (message.type === 'CANCEL_DOWNLOAD') {
    // Видаляємо з черги, якщо воно там було
    const queueIndex = downloadQueue.indexOf(message.videoUrl);
    if (queueIndex > -1) {
      downloadQueue.splice(queueIndex, 1);
    }

    const download = activeDownloads.get(message.videoUrl);
    if (download) {
      download.controls.isCancelled = true;
      activeDownloads.delete(message.videoUrl);
      if (currentDownloadingUrl === message.videoUrl) {
        currentDownloadingUrl = null;
      }
      stopKeepAlive();
      processQueue();
    }
    sendResponse({ success: true });
  } else if (message.type === 'GET_DOWNLOAD_STATUS') {
    const download = activeDownloads.get(message.videoUrl);
    const isQueued = downloadQueue.includes(message.videoUrl);
    sendResponse({
      isActive: !!download || isQueued,
      isPaused: download?.controls.isPaused || false,
      isQueued: isQueued && currentDownloadingUrl !== message.videoUrl,
      percent: download?.stats?.percent || 0,
      downloaded: download?.stats?.downloaded || 0,
      total: download?.stats?.total || 0,
      isCurrent: currentDownloadingUrl === message.videoUrl
    });
  }
});

/**
 * Автоматичне очищення бази даних IndexedDB.
 * Видаляє чанки, які не належать до списку знайдених відео або старіші за 24 години.
 */
async function autoCleanupDB() {
  try {
    const db = await openDB(); // Потрібно імпортувати або відкрити вручну
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    const keys = await new Promise((resolve) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result);
    });

    const activeUrls = new Set(foundVideos.map(v => v.url));

    for (const key of keys) {
      // Ключ має формат "playlistUrl_index"
      const urlPart = key.substring(0, key.lastIndexOf('_'));
      if (!activeUrls.has(urlPart)) {
        store.delete(key);
      }
    }
    console.log('IndexedDB cleanup finished.');
  } catch (e) {
    console.error('Cleanup error:', e);
  }
}

function addToQueue(url) {
  if (!downloadQueue.includes(url)) {
    downloadQueue.push(url);
  }
  processQueue();
}

async function processQueue() {
  if (currentDownloadingUrl || downloadQueue.length === 0) return;

  currentDownloadingUrl = downloadQueue.shift();
  startKeepAlive();
  await handleDownload(currentDownloadingUrl);
}

// Створення/отримання Offscreen Document та запуск завантаження
// Створення/отримання Offscreen Document та запуск завантаження
async function startOffscreenDownload(playlistUrl, totalSegments, fileName) {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  // Закриваємо старі документи про всяк випадок
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) { }

  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.type === 'OFFSCREEN_READY') {
        console.log('Offscreen ready, triggering IndexedDB read...');
        chrome.runtime.sendMessage({
          type: 'TRIGGER_OFFSCREEN_DOWNLOAD',
          playlistUrl: playlistUrl,
          totalSegments: totalSegments,
          fileName: fileName
        });
      } else if (message.type === 'OFFSCREEN_URL_CREATED') {
        // Отримали URL від offscreen, тепер завантажуємо через downloads API
        chrome.downloads.download({
          url: message.url,
          filename: message.fileName,
          saveAs: true
        }, (downloadId) => {
          const success = !chrome.runtime.lastError;
          const error = chrome.runtime.lastError?.message;

          // Просимо offscreen видалити URL з пам'яті
          chrome.runtime.sendMessage({ type: 'REVOKE_OFFSCREEN_URL', url: message.url });

          chrome.runtime.onMessage.removeListener(listener);
          if (success) {
            resolve();
          } else {
            reject(new Error(error || 'Download failed'));
          }
          setTimeout(() => {
            chrome.offscreen.closeDocument().catch(() => { });
          }, 2000);
        });
      } else if (message.type === 'OFFSCREEN_DOWNLOAD_DONE') {
        chrome.runtime.onMessage.removeListener(listener);
        if (message.success) {
          resolve();
        } else {
          reject(new Error(message.error || 'Offscreen download failed'));
        }
        setTimeout(() => {
          chrome.offscreen.closeDocument().catch(() => { });
        }, 2000);
      }
    };

    // Спочатку додаємо слухача
    chrome.runtime.onMessage.addListener(listener);

    // Тільки потім створюємо документ
    chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'To download large video files'
    }).catch(err => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(err);
    });

    // Тайм-аут
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Offscreen document timeout'));
    }, 45000);
  });
}

// Обробка завантаження відео
async function handleDownload(m3u8Url) {
  let download = activeDownloads.get(m3u8Url);

  if (!download) {
    download = {
      url: m3u8Url,
      state: { chunks: null, downloadedCount: 0, currentIndex: 0 },
      controls: { isPaused: false, isCancelled: false },
      stats: { percent: 0, downloaded: 0, total: 0 }
    };
    activeDownloads.set(m3u8Url, download);
  } else {
    download.controls.isPaused = false;
  }

  try {
    const videoInfo = foundVideos.find(v => v.url === m3u8Url);
    const videoTitle = videoInfo ? videoInfo.title : '';

    const playlist = await parseM3U8(m3u8Url);
    const result = await downloadVideo(
      playlist,
      download.state,
      download.controls,
      (stats) => {
        download.stats = stats;
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          url: m3u8Url,
          percent: stats.percent,
          downloaded: stats.downloaded,
          total: stats.total
        }).catch(() => { });
      },
      videoTitle // Передаємо назву
    );

    if (result && result.success && result.totalSegments) {
      // Прямий виклик offscreen завантаження по завершенню 100%
      await startOffscreenDownload(result.playlistUrl, result.totalSegments, result.fileName);

      // Очищаємо IndexedDB після успішного завантаження
      await clearChunks(result.playlistUrl, result.totalSegments);

      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_FINISHED',
        url: m3u8Url,
        success: true
      }).catch(() => { });
      activeDownloads.delete(m3u8Url);
      currentDownloadingUrl = null; // Поточне завантаження завершено
      stopKeepAlive();
      processQueue(); // Запускаємо наступне з черги
    }
  } catch (error) {
    console.error('Download error:', error);
    if (!download.controls.isCancelled) {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_FINISHED',
        url: m3u8Url,
        success: false,
        error: error.message
      }).catch(() => { });
    }
    activeDownloads.delete(m3u8Url);
    currentDownloadingUrl = null;
    stopKeepAlive();
    processQueue();
  }
}


// Очищення старих записів (старше 24 годин)
setInterval(() => {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  foundVideos = foundVideos.filter(video => {
    return new Date(video.timestamp) > oneDayAgo;
  });
  chrome.storage.local.set({ foundVideos: foundVideos });
  chrome.action.setBadgeText({
    text: foundVideos.length > 0 ? foundVideos.length.toString() : ''
  });
}, 60 * 60 * 1000); // Кожну годину
