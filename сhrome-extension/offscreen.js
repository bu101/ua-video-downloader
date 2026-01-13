import { getChunks } from './lib/db.js';

// Повідомляємо фоновий процес, що ми готові приймати дані
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });

// Очікуємо повідомлення з даними для створення URL
chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'TRIGGER_OFFSCREEN_DOWNLOAD') {
        const { playlistUrl, totalSegments, fileName } = message;

        try {
            console.log(`Starting to read ${totalSegments} chunks from IndexedDB...`);

            // Читаємо всі чанки з IndexedDB
            const chunks = await getChunks(playlistUrl, totalSegments);

            // Фільтруємо на випадок, якщо якісь сегменти не завантажились
            const validChunks = chunks.filter(c => c !== undefined && c !== null);

            console.log(`Successfully read ${validChunks.length} chunks. Creating Blob...`);

            // Створюємо Blob та URL
            const blob = new Blob(validChunks, { type: 'video/mp2t' });
            const url = URL.createObjectURL(blob);

            // Відправляємо URL назад у Background
            chrome.runtime.sendMessage({
                type: 'OFFSCREEN_URL_CREATED',
                url: url,
                fileName: fileName
            });
        } catch (err) {
            console.error('Offscreen error:', err);
            chrome.runtime.sendMessage({
                type: 'OFFSCREEN_DOWNLOAD_DONE',
                success: false,
                error: "Blob creation failed: " + err.message
            });
        }
    } else if (message.type === 'REVOKE_OFFSCREEN_URL') {
        URL.revokeObjectURL(message.url);
    }
});
