(function () {
    const databaseName = 'ams-student-offline';
    const storeName = 'page-snapshots';
    const serviceWorkerPath = './service-worker.js';
    const studentPages = [
        { key: 'dashboard', file: 'student_dashboard.html' },
        { key: 'subjects', file: 'student_subjects.html' },
        { key: 'academic', file: 'student_academic.html' },
        { key: 'requirements', file: 'student_requirements.html' },
        { key: 'profile', file: 'student_profile.html' }
    ];
    let databasePromise;
    let warmupPromise;
    const isWarmupFrame = new URLSearchParams(window.location.search).get('amsOfflineWarm') === '1';

    function openDatabase() {
        if (!('indexedDB' in window)) return Promise.reject(new Error('Offline storage is unavailable.'));
        if (databasePromise) return databasePromise;

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 1);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(storeName)) {
                    database.createObjectStore(storeName, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Unable to open offline storage.'));
        });
        return databasePromise;
    }

    function setNotice(message, visible, type = 'offline') {
        let notice = document.getElementById('studentOfflineNotice');
        if (!notice) {
            notice = document.createElement('div');
            notice.id = 'studentOfflineNotice';
            notice.setAttribute('role', 'status');
            notice.style.cssText = 'position:fixed;z-index:10000;top:0;left:0;right:0;padding:9px 16px;text-align:center;color:#fff;font:600 14px/1.4 sans-serif;';
            document.body.appendChild(notice);
        }
        notice.style.background = type === 'ready' ? '#166534' : type === 'sync' ? '#1d4ed8' : '#7c2d12';
        notice.textContent = message;
        notice.hidden = !visible;
        document.body.classList.toggle('student-offline-view', visible);
    }

    async function getUserId(client) {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        return data.session?.user?.id || null;
    }

    function snapshotKey(userId, pageKey) {
        return `${userId}:${pageKey}`;
    }

    async function readSnapshot(key) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('Unable to read offline data.'));
        });
    }

    async function writeSnapshot(snapshot) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readwrite');
            transaction.objectStore(storeName).put(snapshot);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Unable to save offline data.'));
            transaction.onabort = () => reject(transaction.error || new Error('Offline save was interrupted.'));
        });
    }

    async function removeOtherUsers(userId) {
        const database = await openDatabase();
        const keepPrefix = `${userId}:`;
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.getAllKeys();
            request.onsuccess = () => {
                request.result.forEach(key => {
                    if (typeof key === 'string' && !key.startsWith(keepPrefix)) store.delete(key);
                });
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Unable to clean offline data.'));
        });
    }

    async function registerOfflineShell() {
        if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
        try {
            await navigator.serviceWorker.register(serviceWorkerPath);
        } catch (error) {
            console.warn('Student offline pages could not be prepared.', error);
        }
    }

    async function beginStudentOfflinePage(client, pageKey) {
        void registerOfflineShell();
        window.supabaseClientForOffline = client;
        window.currentStudentOfflinePage = pageKey;
        if (navigator.onLine) {
            setNotice('', false);
            return false;
        }
        return restoreStudentOfflineSnapshot(client, pageKey, false);
    }

    async function saveStudentOfflineSnapshot(client, pageKey) {
        if (!navigator.onLine) return false;
        window.supabaseClientForOffline = client;
        const userId = await getUserId(client);
        const main = document.querySelector('.main');
        if (!userId || !main || !main.innerHTML.trim()) return false;

        await removeOtherUsers(userId);
        await writeSnapshot({
            key: snapshotKey(userId, pageKey),
            html: main.innerHTML,
            savedAt: new Date().toISOString()
        });
        if (!isWarmupFrame) {
            void warmStudentPages(client, pageKey, userId).catch(error => {
                console.warn('Could not prepare all student pages for offline viewing.', error);
            });
        }
        return true;
    }

    async function waitForSnapshot(userId, pageKey, savedAfter, timeoutMs = 30000) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (!navigator.onLine) return false;
            const snapshot = await readSnapshot(snapshotKey(userId, pageKey));
            if (snapshot?.html && Date.parse(snapshot.savedAt) >= savedAfter) return true;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    }

    async function warmStudentPages(client, currentPageKey, userId) {
        if (!navigator.onLine || isWarmupFrame) return;
        if (warmupPromise) return warmupPromise;

        warmupPromise = (async () => {
            const pagesToWarm = studentPages.filter(page => page.key !== currentPageKey);
            const missingPages = [];
            for (const page of pagesToWarm) {
                if (!(await readSnapshot(snapshotKey(userId, page.key)))) missingPages.push(page);
            }
            if (!missingPages.length) return;

            setNotice('Preparing the rest of your student pages for offline viewing...', true, 'sync');
            await Promise.all(missingPages.map(async page => {
                if (!navigator.onLine) return;
                const frame = document.createElement('iframe');
                frame.title = 'Preparing offline student page';
                frame.setAttribute('aria-hidden', 'true');
                frame.tabIndex = -1;
                frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;';
                const pageUrl = new URL(page.file, window.location.href);
                pageUrl.searchParams.set('amsOfflineWarm', '1');
                frame.src = pageUrl.href;
                const saveStartedAt = Date.now();
                document.body.appendChild(frame);

                try {
                    await waitForSnapshot(userId, page.key, saveStartedAt);
                } catch (error) {
                    console.warn(`Could not prepare offline ${page.key} page.`, error);
                } finally {
                    frame.remove();
                }
            }));

            if (navigator.onLine) {
                const hasAllPages = await Promise.all(studentPages.map(async page =>
                    Boolean(await readSnapshot(snapshotKey(userId, page.key)))
                ));
                if (hasAllPages.every(Boolean)) {
                    setNotice('All student pages are saved for offline viewing on this device.', true, 'ready');
                    window.setTimeout(() => setNotice('', false), 6000);
                } else {
                    setNotice('Some student pages could not be saved for offline viewing. Open them while online to try again.', true, 'sync');
                }
            }
        })().finally(() => {
            warmupPromise = null;
        });

        return warmupPromise;
    }

    async function restoreStudentOfflineSnapshot(client, pageKey, force = false) {
        if (!force && navigator.onLine) return false;
        try {
            const userId = await getUserId(client);
            if (!userId) {
                setNotice('Offline. Sign in while connected before using saved student information.', true);
                return false;
            }

            const snapshot = await readSnapshot(snapshotKey(userId, pageKey));
            if (!snapshot?.html) {
                setNotice('Offline. This page has no saved copy on this device yet.', true);
                return false;
            }

            const main = document.querySelector('.main');
            if (!main) return false;
            main.innerHTML = snapshot.html;
            const savedTime = new Date(snapshot.savedAt).toLocaleString();
            setNotice(`Offline view: showing saved information from ${savedTime}. Changes and attachments may require internet.`, true);
            return true;
        } catch (error) {
            console.warn('Unable to restore the student offline view.', error);
            setNotice('Offline. A saved copy could not be opened on this device.', true);
            return false;
        }
    }

    async function clearStudentOfflineSnapshots(userId) {
        try {
            const database = await openDatabase();
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(storeName, 'readwrite');
                const store = transaction.objectStore(storeName);
                if (!userId) {
                    store.clear();
                    transaction.oncomplete = () => resolve();
                    transaction.onerror = () => reject(transaction.error || new Error('Unable to clear offline data.'));
                    return;
                }
                const request = store.getAllKeys();
                request.onsuccess = () => {
                    request.result.forEach(key => {
                        if (typeof key === 'string' && key.startsWith(`${userId}:`)) store.delete(key);
                    });
                };
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error || new Error('Unable to clear offline data.'));
            });
        } catch (error) {
            console.warn('Unable to clear student offline data.', error);
        }
    }

    window.beginStudentOfflinePage = beginStudentOfflinePage;
    window.saveStudentOfflineSnapshot = saveStudentOfflineSnapshot;
    window.restoreStudentOfflineSnapshot = restoreStudentOfflineSnapshot;
    window.clearStudentOfflineSnapshots = clearStudentOfflineSnapshots;

    window.addEventListener('offline', async () => {
        const client = window.supabaseClientForOffline;
        if (client && window.currentStudentOfflinePage) {
            await restoreStudentOfflineSnapshot(client, window.currentStudentOfflinePage, true);
        } else {
            setNotice('Connection lost. Previously saved student pages are available on this device.', true);
        }
    });

    window.addEventListener('online', () => {
        setNotice('Connection restored. Reload to refresh your student information.', true);
    });
})();
