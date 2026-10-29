(function () {
    const databaseName = 'ams-student-offline';
    const storeName = 'page-snapshots';
    const serviceWorkerPath = './service-worker.js';
    let databasePromise;

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

    function setNotice(message, visible) {
        let notice = document.getElementById('studentOfflineNotice');
        if (!notice) {
            notice = document.createElement('div');
            notice.id = 'studentOfflineNotice';
            notice.setAttribute('role', 'status');
            notice.style.cssText = 'position:fixed;z-index:10000;top:0;left:0;right:0;padding:9px 16px;text-align:center;background:#7c2d12;color:#fff;font:600 14px/1.4 sans-serif;';
            document.body.appendChild(notice);
        }
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
        return true;
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
