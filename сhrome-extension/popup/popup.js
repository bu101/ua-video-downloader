// Popup logic for HLS Downloader
document.addEventListener('DOMContentLoaded', () => {
    const videoList = document.getElementById('video-list');
    const clearBtn = document.getElementById('clear-btn');
    const statusBar = document.getElementById('status-bar');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    const pauseBtn = document.getElementById('pause-btn');
    const resumeBtn = document.getElementById('resume-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    let currentDownloadUrl = null;

    // Отримуємо список відео та статус активного завантаження при відкритті
    loadInitialState();

    function loadInitialState() {
        chrome.runtime.sendMessage({ type: 'GET_VIDEOS' }, (response) => {
            if (response && response.videos) {
                renderVideos(response.videos);
                checkActiveDownloads(response.videos);
            }
        });
    }

    function checkActiveDownloads(videos) {
        videos.forEach(video => {
            chrome.runtime.sendMessage({
                type: 'GET_DOWNLOAD_STATUS',
                videoUrl: video.url
            }, (status) => {
                if (status && status.isActive) {
                    // Показуємо статус-бар лише для того, що реально качається зараз
                    if (status.isCurrent) {
                        currentDownloadUrl = video.url;
                        showStatusBar(status, status.isPaused);
                    }
                }
            });
        });
    }

    // Обробка кнопок керування
    pauseBtn.addEventListener('click', () => {
        if (!currentDownloadUrl) return;
        chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOAD', videoUrl: currentDownloadUrl }, () => {
            showStatusBar(null, true);
        });
    });

    resumeBtn.addEventListener('click', () => {
        if (!currentDownloadUrl) return;
        chrome.runtime.sendMessage({ type: 'RESUME_DOWNLOAD', videoUrl: currentDownloadUrl }, () => {
            showStatusBar(null, false);
        });
    });

    cancelBtn.addEventListener('click', () => {
        if (!currentDownloadUrl) return;
        if (confirm('Ви впевнені, що хочете скасувати завантаження?')) {
            chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD', videoUrl: currentDownloadUrl }, () => {
                hideStatusBar();
                currentDownloadUrl = null;
                renderVideos(); // Refresh to enable buttons
            });
        }
    });

    clearBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLEAR_VIDEOS' }, (response) => {
            if (response && response.success) {
                renderVideos([]);
            }
        });
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'NEW_VIDEO_FOUND') {
            loadInitialState();
        } else if (message.type === 'DOWNLOAD_PROGRESS') {
            if (message.url === currentDownloadUrl) {
                updateProgress(message);
            }
        } else if (message.type === 'DOWNLOAD_FINISHED') {
            const btn = document.querySelector(`.download-btn[data-url="${message.url}"]`);
            if (message.success) {
                if (btn) btn.textContent = 'Готово!';
            } else {
                if (btn) {
                    btn.textContent = 'Помилка';
                    btn.style.background = 'var(--error)';
                }
            }

            if (message.url === currentDownloadUrl) {
                setTimeout(() => finishDownload(btn, document.querySelectorAll('.download-btn')), 3000);
            } else {
                // Якщо це було щось із черги, просто оновлюємо список
                setTimeout(loadInitialState, 3000);
            }
        }
    });

    function renderVideos(videos) {
        if (!videos) {
            chrome.runtime.sendMessage({ type: 'GET_VIDEOS' }, (r) => renderVideos(r.videos));
            return;
        }

        if (videos.length === 0) {
            videoList.innerHTML = `
                <div class="empty-state">
                  <div class="icon">🔍</div>
                  <p>Відео не знайдено</p>
                  <span>Відтворіть відео на сторінці, щоб воно з'явилося тут</span>
                </div>
            `;
            return;
        }

        videoList.innerHTML = '';
        const sortedVideos = [...videos].reverse();

        sortedVideos.forEach((video) => {
            const item = document.createElement('div');
            item.className = 'video-item';
            // Використовуємо реальну назву сторінки, якщо вона є
            const fileName = video.title || video.url.split('/').pop().split('?')[0] || 'index.m3u8';

            item.innerHTML = `
                <div class="video-info">
                  <span class="video-url" title="${video.url}">${fileName}</span>
                  <span class="video-quality">${video.quality || 'Auto'}</span>
                </div>
                <button class="download-btn" data-url="${video.url}">Завантажити</button>
            `;

            const btn = item.querySelector('.download-btn');

            // Запитуємо статус для кожної кнопки
            chrome.runtime.sendMessage({
                type: 'GET_DOWNLOAD_STATUS',
                videoUrl: video.url
            }, (status) => {
                if (status) {
                    if (status.isQueued) {
                        btn.textContent = 'У черзі...';
                        btn.disabled = true;
                    } else if (status.isCurrent) {
                        btn.textContent = 'Завантажується...';
                        btn.classList.add('active');
                        currentDownloadUrl = video.url;
                    }
                }
            });

            btn.addEventListener('click', () => startDownload(video.url, btn));
            videoList.appendChild(item);
        });
    }

    function startDownload(url, btn) {
        btn.textContent = 'Додано...';
        btn.disabled = true;

        chrome.runtime.sendMessage({
            type: 'DOWNLOAD_VIDEO',
            videoUrl: url
        }, (response) => {
            if (response && response.success) {
                // Оновлюємо інтерфейс, щоб побачити статус "Завантажується" або "У черзі"
                setTimeout(loadInitialState, 500);
            } else {
                btn.textContent = 'Помилка';
                btn.style.background = 'var(--error)';
                setTimeout(loadInitialState, 3000);
            }
        });
    }

    function finishDownload(btn, btns) {
        btn.textContent = 'Завантажити';
        btn.style.background = '';
        btns.forEach(b => b.disabled = false);
        hideStatusBar();
        currentDownloadUrl = null;
        renderVideos();
    }

    function showStatusBar(stats, isPaused) {
        statusBar.classList.remove('hidden');
        if (stats) updateProgress(stats);

        if (isPaused) {
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.remove('hidden');
            progressText.classList.add('dimmed');
        } else {
            pauseBtn.classList.remove('hidden');
            resumeBtn.classList.add('hidden');
            progressText.classList.remove('dimmed');
        }
    }

    function hideStatusBar() {
        statusBar.classList.add('hidden');
    }

    function updateProgress(stats) {
        const percent = typeof stats === 'object' ? stats.percent : stats;
        const downloaded = stats.downloaded || 0;
        const total = stats.total || 0;

        progressBar.style.width = `${percent}%`;
        if (total > 0) {
            progressText.textContent = `Завантаження: ${percent}% (${downloaded}/${total})`;
        } else {
            progressText.textContent = `Завантаження: ${percent}%`;
        }
    }
});

