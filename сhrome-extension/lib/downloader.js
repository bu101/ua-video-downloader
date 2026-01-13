/**
 * HLS Downloader Library
 */
import { saveChunk } from './db.js';

/**
 * Парсить M3U8 файл та повертає список URL сегментів
 * @param {string} url - URL плейлиста
 * @returns {Promise<Object>} - Об'єкт з сегментами та базовим URL
 */
export async function parseM3U8(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch m3u8 (${response.status}): ${response.statusText}`);
    const text = await response.text();

    // Використовуємо URL об'єкт для коректного об'єднання шляхів
    const playlistUrl = new URL(url);
    const baseUrl = playlistUrl.href.substring(0, playlistUrl.href.lastIndexOf('/') + 1);

    const lines = text.split('\n');
    const segments = [];
    let currentKey = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-KEY')) {
            const keyInfo = parseKeyTag(line);
            if (keyInfo.method && keyInfo.method !== 'NONE') {
                currentKey = keyInfo;
            }
        } else if (!line.startsWith('#')) {
            // Коректне поєднання URL (враховуючи абсолютні шляхи /path/...)
            const segmentUrl = new URL(line, baseUrl).href;
            segments.push({
                url: segmentUrl,
                key: currentKey
            });
        }
    }

    // Якщо це Master Playlist
    if (segments.length === 0 && text.includes('.m3u8')) {
        const subPlaylists = lines.filter(l => l.includes('.m3u8') && !l.startsWith('#')).map(l => l.trim());
        if (subPlaylists.length > 0) {
            const lastPlaylist = subPlaylists[subPlaylists.length - 1];
            const subUrl = new URL(lastPlaylist, baseUrl).href;
            return parseM3U8(subUrl);
        }
    }

    if (segments.length === 0) {
        throw new Error("No segments found in the playlist.");
    }

    return {
        url,
        baseUrl,
        segments
    };
}

/**
 * Парсить тег #EXT-X-KEY
 */
function parseKeyTag(tag) {
    const keyInfo = {};
    const parts = tag.replace('#EXT-X-KEY:', '').split(',');
    parts.forEach(part => {
        const [key, value] = part.split('=');
        if (key && value) {
            keyInfo[key.toLowerCase()] = value.replace(/"/g, '').trim();
        }
    });
    return keyInfo;
}

/**
 * Завантажує один сегмент з повторними спробами
 */
async function fetchSegment(url, retries = 3) {
    for (let i = 0; i <= retries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Status ${response.status}`);
            return await response.arrayBuffer();
        } catch (err) {
            if (i === retries) throw err;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i))); // Експоненціальна затримка
        }
    }
}

/**
 * Завантажує відео сегменти з максимальною швидкістю
 */
export async function downloadVideo(playlist, state, controls, onProgress, title = '') {
    const { segments } = playlist;
    const total = segments.length;

    if (!state.downloadedCount) state.downloadedCount = 0;
    if (!state.currentIndex) state.currentIndex = 0;
    if (!state.downloadedIndices) state.downloadedIndices = new Set();
    else if (!(state.downloadedIndices instanceof Set)) {
        // Якщо завантажили зі сховища, конвертуємо назад у Set
        state.downloadedIndices = new Set(state.downloadedIndices);
    }

    // Оптимізована черга: 10 паралельних запитів (золота середина)
    const MAX_CONCURRENCY = 10;
    const activePromises = new Set();
    const pendingWrites = new Set();

    while (state.currentIndex < total || activePromises.size > 0) {
        if (controls.isPaused) {
            // Зберігаємо Set як масив для chrome.storage
            state.downloadedIndicesArr = Array.from(state.downloadedIndices);
            return { paused: true };
        }
        if (controls.isCancelled) throw new Error("Download cancelled");

        while (activePromises.size < MAX_CONCURRENCY && state.currentIndex < total) {
            const index = state.currentIndex++;

            if (state.downloadedIndices.has(index)) {
                continue;
            }

            const promise = (async (idx) => {
                try {
                    // 1. Тільки завантаження (мережа)
                    const buffer = await fetchSegment(segments[idx].url);

                    // 2. Повідомляємо, що слот вільний відразу після завантаження
                    // але запускаємо запис в DB паралельно
                    const savePromise = saveChunk(playlist.url, idx, buffer).then(() => {
                        state.downloadedIndices.add(idx);
                        state.downloadedCount++;
                        onProgress({
                            percent: Math.round((state.downloadedCount / total) * 100),
                            downloaded: state.downloadedCount,
                            total: total
                        });
                    }).finally(() => {
                        pendingWrites.delete(savePromise);
                    });

                    pendingWrites.add(savePromise);

                    // Ми не чекаємо savePromise тут, щоб розблокувати мережевий слот
                    // Але ми хочемо переконатись, що запис іде
                } catch (err) {
                    console.error(`Failed segment ${idx}:`, err);
                    // Якщо помилка, повертаємо індекс в чергу (можна додати логіку повтору)
                    if (state.currentIndex > idx) state.currentIndex = idx;
                }
            })(index).finally(() => {
                activePromises.delete(promise);
            });

            activePromises.add(promise);
        }

        if (activePromises.size > 0) {
            await Promise.race(activePromises);
        }
    }

    // Чекаємо фіналізації всіх записів у базу даних
    if (pendingWrites.size > 0) {
        console.log(`Waiting for ${pendingWrites.size} pending DB writes...`);
        await Promise.all(Array.from(pendingWrites));
    }

    // Витягуємо назву файлу (пріоритет за заголовком сторінки)
    let fileName = 'video.ts';
    if (title) {
        // Очищаємо назву від заборонених символів
        fileName = title.replace(/[\\/:*?"<>|]/g, '_').trim() + '.ts';
    } else {
        try {
            const urlStr = playlist.url.split('?')[0];
            const parts = urlStr.split('/');
            const lastPart = parts[parts.length - 1];
            if (lastPart.includes('.m3u8') && parts.length > 1) {
                const folderName = parts[parts.length - 2];
                fileName = folderName.length > 2 ? `${folderName}.ts` : `video_${Date.now()}.ts`;
            } else {
                fileName = lastPart.replace('.m3u8', '') + '.ts';
            }
        } catch (e) {
            fileName = `video_${Date.now()}.ts`;
        }
    }

    // Повертаємо метадані. Самі дані вже в IndexedDB
    return {
        success: true,
        totalSegments: total,
        fileName: fileName,
        playlistUrl: playlist.url
    };
}


