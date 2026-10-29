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
    const teacherPages = [
        { key: 'dashboard', file: 'teacher_dashboard.html' },
        { key: 'students', file: 'teacher_manage_students.html' },
        { key: 'subjects', file: 'teacher_manage_subjects.html' },
        { key: 'status', file: 'teacher_student_status.html' },
        { key: 'profile', file: 'teacher_profile.html' }
    ];
    let databasePromise;
    let warmupPromise;
    const pageParams = new URLSearchParams(window.location.search);
    const isStudentWarmupFrame = pageParams.get('amsOfflineWarm') === '1';
    const isTeacherWarmupFrame = pageParams.get('amsTeacherOfflineWarm') === '1';
    const isWarmupFrame = isStudentWarmupFrame || isTeacherWarmupFrame;

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

    function setPreparationProgress(active) {
        let progress = document.getElementById('studentOfflineProgress');
        if (!progress) {
            const style = document.createElement('style');
            style.textContent = '@keyframes amsOfflineProgress { from { transform: translateX(-120%); } to { transform: translateX(350%); } } #studentOfflineProgress { position:fixed; z-index:10001; top:0; left:0; right:0; height:3px; overflow:hidden; background:rgba(29,78,216,.16); pointer-events:none; } #studentOfflineProgress::after { content:""; display:block; width:30%; height:100%; background:#2563eb; animation:amsOfflineProgress 1.15s ease-in-out infinite; }';
            document.head.appendChild(style);
            progress = document.createElement('div');
            progress.id = 'studentOfflineProgress';
            progress.setAttribute('role', 'progressbar');
            progress.setAttribute('aria-label', 'Preparing student pages for offline use');
            document.body.appendChild(progress);
        }
        progress.hidden = !active;
        progress.setAttribute('aria-valuetext', active ? 'Preparing offline pages' : 'Preparation complete');
    }

    async function getUserId(client) {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        return data.session?.user?.id || null;
    }

    function snapshotKey(userId, pageKey, role = 'student') {
        return role === 'teacher'
            ? `${userId}:teacher:${pageKey}`
            : `${userId}:${pageKey}`;
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
        return beginOfflinePage(client, pageKey, 'student');
    }

    async function beginTeacherOfflinePage(client, pageKey) {
        return beginOfflinePage(client, pageKey, 'teacher');
    }

    async function beginOfflinePage(client, pageKey, role) {
        void registerOfflineShell();
        window.supabaseClientForOffline = client;
        window.currentStudentOfflinePage = pageKey;
        window.currentOfflineRole = role;
        if (navigator.onLine) {
            setNotice('', false);
            return false;
        }
        return restoreOfflineSnapshot(client, pageKey, role, false);
    }

    async function saveStudentOfflineSnapshot(client, pageKey) {
        return saveOfflineSnapshot(client, pageKey, 'student');
    }

    async function saveTeacherOfflineSnapshot(client, pageKey) {
        return saveOfflineSnapshot(client, pageKey, 'teacher');
    }

    async function saveOfflineSnapshot(client, pageKey, role) {
        if (!navigator.onLine) return false;
        window.supabaseClientForOffline = client;
        const userId = await getUserId(client);
        const main = document.querySelector('.main');
        if (!userId || !main || !main.innerHTML.trim()) return false;

        await removeOtherUsers(userId);
        const formState = Array.from(main.querySelectorAll('input[id],select[id],textarea[id]')).map(element => ({
            id: element.id,
            value: element.value,
            checked: 'checked' in element ? element.checked : undefined
        }));
        await writeSnapshot({
            key: snapshotKey(userId, pageKey, role),
            html: main.innerHTML,
            formState,
            savedAt: new Date().toISOString()
        });
        if (!isWarmupFrame) {
            const warmPages = role === 'teacher' ? warmTeacherPages : warmStudentPages;
            void warmPages(client, pageKey, userId).catch(error => {
                console.warn(`Could not prepare all ${role} pages for offline viewing.`, error);
            });
        }
        return true;
    }

    async function waitForSnapshot(userId, pageKey, role, savedAfter, timeoutMs = 30000) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (!navigator.onLine) return false;
            const snapshot = await readSnapshot(snapshotKey(userId, pageKey, role));
            if (snapshot?.html && Date.parse(snapshot.savedAt) >= savedAfter) return true;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    }

    async function warmPagesForRole(client, currentPageKey, userId, role, pages) {
        if (!navigator.onLine || isWarmupFrame) return;
        if (warmupPromise) return warmupPromise;

        warmupPromise = (async () => {
            const pagesToWarm = pages.filter(page => page.key !== currentPageKey);
            const missingPages = [];
            for (const page of pagesToWarm) {
                if (!(await readSnapshot(snapshotKey(userId, page.key, role)))) missingPages.push(page);
            }
            if (!missingPages.length) return;

            setPreparationProgress(true);
            await Promise.all(missingPages.map(async page => {
                if (!navigator.onLine) return;
                const frame = document.createElement('iframe');
                frame.title = 'Preparing offline student page';
                frame.setAttribute('aria-hidden', 'true');
                frame.tabIndex = -1;
                frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;';
                const pageUrl = new URL(page.file, window.location.href);
                pageUrl.searchParams.set(role === 'teacher' ? 'amsTeacherOfflineWarm' : 'amsOfflineWarm', '1');
                frame.src = pageUrl.href;
                const saveStartedAt = Date.now();
                document.body.appendChild(frame);

                try {
                    await waitForSnapshot(userId, page.key, role, saveStartedAt);
                } catch (error) {
                    console.warn(`Could not prepare offline ${page.key} page.`, error);
                } finally {
                    frame.remove();
                }
            }));
            setPreparationProgress(false);

            if (navigator.onLine) {
                const hasAllPages = await Promise.all(pages.map(async page =>
                    Boolean(await readSnapshot(snapshotKey(userId, page.key, role)))
                ));
                if (!hasAllPages.every(Boolean)) {
                    setNotice(`Some ${role} pages could not be saved for offline viewing. Open them while online to try again.`, true, 'sync');
                }
            }
        })().finally(() => {
            warmupPromise = null;
        });

        return warmupPromise;
    }

    function warmStudentPages(client, currentPageKey, userId) {
        return warmPagesForRole(client, currentPageKey, userId, 'student', studentPages);
    }

    function warmTeacherPages(client, currentPageKey, userId) {
        return warmPagesForRole(client, currentPageKey, userId, 'teacher', teacherPages);
    }

    async function restoreStudentOfflineSnapshot(client, pageKey, force = false) {
        return restoreOfflineSnapshot(client, pageKey, 'student', force);
    }

    async function restoreTeacherOfflineSnapshot(client, pageKey, force = false) {
        return restoreOfflineSnapshot(client, pageKey, 'teacher', force);
    }

    async function restoreOfflineSnapshot(client, pageKey, role, force = false) {
        if (!force && navigator.onLine) return false;
        try {
            const userId = await getUserId(client);
            if (!userId) {
                setNotice(`Offline. Sign in while connected before using saved ${role} information.`, true);
                return false;
            }

            const snapshot = await readSnapshot(snapshotKey(userId, pageKey, role));
            if (!snapshot?.html) {
                setNotice(`Offline. This ${role} page has no saved copy on this device yet.`, true);
                return false;
            }

            const main = document.querySelector('.main');
            if (!main) return false;
            main.innerHTML = snapshot.html;
            (snapshot.formState || []).forEach(field => {
                const element = document.getElementById(field.id);
                if (!element) return;
                element.value = field.value;
                if (field.checked !== undefined) element.checked = field.checked;
            });
            makeOfflineViewReadOnly(main);
            const savedTime = new Date(snapshot.savedAt).toLocaleString();
            setNotice(`Offline read-only view: showing saved ${role} information from ${savedTime}. Changes and attachments require internet.`, true);
            return true;
        } catch (error) {
            console.warn('Unable to restore the student offline view.', error);
            setNotice(`Offline. A saved ${role} copy could not be opened on this device.`, true);
            return false;
        }
    }

    function makeOfflineViewReadOnly(container) {
        container.querySelectorAll('input,select,textarea,button').forEach(control => {
            control.disabled = true;
        });
        container.querySelectorAll('*').forEach(element => {
            Array.from(element.attributes).forEach(attribute => {
                if (/^on/i.test(attribute.name)) {
                    if (attribute.name.toLowerCase() === 'onclick'
                        && element.matches('a[href="login.html"]')) return;
                    element.removeAttribute(attribute.name);
                }
            });
        });
        container.querySelectorAll('.modal,.confirm-modal-overlay').forEach(modal => {
            modal.style.display = 'none';
            modal.classList.remove('show');
        });
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
    window.beginTeacherOfflinePage = beginTeacherOfflinePage;
    window.saveStudentOfflineSnapshot = saveStudentOfflineSnapshot;
    window.saveTeacherOfflineSnapshot = saveTeacherOfflineSnapshot;
    window.restoreStudentOfflineSnapshot = restoreStudentOfflineSnapshot;
    window.restoreTeacherOfflineSnapshot = restoreTeacherOfflineSnapshot;
    window.clearStudentOfflineSnapshots = clearStudentOfflineSnapshots;

    window.addEventListener('offline', async () => {
        const client = window.supabaseClientForOffline;
        if (client && window.currentStudentOfflinePage) {
            const role = window.currentOfflineRole || 'student';
            await restoreOfflineSnapshot(client, window.currentStudentOfflinePage, role, true);
        } else {
            setNotice('Connection lost. Previously saved portal pages are available on this device.', true);
        }
    });

    window.addEventListener('online', () => {
        setNotice('Connection restored. Reload to refresh your student information.', true);
    });
})();
