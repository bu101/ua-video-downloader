/**
 * IndexedDB utility for large file storage
 */
const DB_NAME = 'HLSDownloaderDB';
const STORE_NAME = 'chunks';

export async function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveChunk(downloadId, index, buffer) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(buffer, `${downloadId}_${index}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function getChunks(downloadId, count) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const chunks = [];
        let loaded = 0;

        for (let i = 0; i < count; i++) {
            const request = store.get(`${downloadId}_${i}`);
            request.onsuccess = () => {
                chunks[i] = request.result;
                loaded++;
                if (loaded === count) resolve(chunks);
            };
            request.onerror = () => reject(request.error);
        }
    });
}

export async function clearChunks(downloadId, count) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (let i = 0; i < count; i++) {
            store.delete(`${downloadId}_${i}`);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
