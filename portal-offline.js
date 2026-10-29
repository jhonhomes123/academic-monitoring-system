(function () {
    const databaseName = 'ams-student-offline';
    const storeName = 'page-snapshots';
    const queueStoreName = 'teacher-write-queue';
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
    let teacherRosterWarmupPromise;
    const pageParams = new URLSearchParams(window.location.search);
    const isStudentWarmupFrame = pageParams.get('amsOfflineWarm') === '1';
    const isTeacherWarmupFrame = pageParams.get('amsTeacherOfflineWarm') === '1'
        || pageParams.get('amsTeacherRosterWarm') === '1';
    const isWarmupFrame = isStudentWarmupFrame || isTeacherWarmupFrame;

    function openDatabase() {
        if (!('indexedDB' in window)) return Promise.reject(new Error('Offline storage is unavailable.'));
        if (databasePromise) return databasePromise;

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 2);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(storeName)) {
                    database.createObjectStore(storeName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(queueStoreName)) {
                    database.createObjectStore(queueStoreName, { keyPath: 'key' });
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
            progress.setAttribute('aria-label', 'Preparing portal pages for offline use');
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

    function teacherFilterState() {
        const filterIds = [
            'yearFilter', 'departmentFilter', 'majorFilter', 'subjectFilter', 'sectionFilter',
            'yearSelect', 'departmentSelect', 'majorSelect', 'subjectSelect', 'sectionSelect'
        ];
        return filterIds.map(id => [id, document.getElementById(id)?.value || '']);
    }

    function emptyTeacherFilterState() {
        return [
            'yearFilter', 'departmentFilter', 'majorFilter', 'subjectFilter', 'sectionFilter',
            'yearSelect', 'departmentSelect', 'majorSelect', 'subjectSelect', 'sectionSelect'
        ].map(id => [id, '']);
    }

    function snapshotKey(userId, pageKey, role = 'student', filterState = null) {
        if (role !== 'teacher') return `${userId}:${pageKey}`;
        const filterIds = [
            'yearFilter', 'departmentFilter', 'majorFilter', 'subjectFilter', 'sectionFilter',
            'yearSelect', 'departmentSelect', 'majorSelect', 'subjectSelect', 'sectionSelect'
        ];
        const suppliedState = Object.fromEntries(filterState || teacherFilterState());
        const normalizedState = filterIds.map(id => [id, suppliedState[id] || '']);
        return `${userId}:teacher:${pageKey}:${encodeURIComponent(JSON.stringify(normalizedState))}`;
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
            if (role === 'teacher' && !isWarmupFrame) {
                void syncTeacherQueue(client);
                void preloadTeacherAssignedRosters(client).catch(error => {
                    console.warn('Could not prepare assigned teacher rosters.', error);
                });
            }
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

    function createOperationId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function queueTeacherOperation(client, type, payload, file = null) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in while online before making offline changes.');
        const operationId = createOperationId();
        const database = await openDatabase();
        const operation = {
            key: `${userId}:${operationId}`,
            userId,
            operationId,
            type,
            payload,
            file: file || null,
            createdAt: new Date().toISOString()
        };
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(queueStoreName, 'readwrite');
            transaction.objectStore(queueStoreName).put(operation);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Unable to queue this change on the device.'));
        });
        const pending = await getTeacherQueue(client);
        const changeLabel = type === 'grade' ? 'Grade' : type === 'attachment' ? 'Attachment' : 'Requirement';
        setNotice(`${changeLabel} saved on this device. ${pending.length} change${pending.length === 1 ? '' : 's'} waiting to sync.`, true, 'sync');
        if (window.currentOfflineRole === 'teacher' && window.currentStudentOfflinePage) {
            await applyQueuedTeacherOperations(client, window.currentStudentOfflinePage, document.querySelector('.main'));
        }
        return operationId;
    }

    async function getTeacherQueue(client) {
        const userId = await getUserId(client);
        if (!userId) return [];
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(queueStoreName, 'readonly');
            const request = transaction.objectStore(queueStoreName).getAll();
            request.onsuccess = () => resolve(request.result
                .filter(operation => operation.userId === userId)
                .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt)
                    || first.operationId.localeCompare(second.operationId)));
            request.onerror = () => reject(request.error || new Error('Unable to read queued teacher changes.'));
        });
    }

    async function removeQueuedTeacherOperation(key) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(queueStoreName, 'readwrite');
            transaction.objectStore(queueStoreName).delete(key);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('Unable to remove the synced change.'));
        });
    }

    async function syncTeacherQueue(client) {
        if (!navigator.onLine || syncInProgress) return;
        syncInProgress = true;
        try {
            const operations = await getTeacherQueue(client);
            for (const operation of operations) {
                if (!navigator.onLine) break;
                let payload = { ...operation.payload, type: operation.type };
                if (operation.file) {
                    const safeName = String(operation.file.name || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_');
                    const path = `teacher-offline/${operation.operationId}/${safeName}`;
                    const { error: uploadError } = await client.storage
                        .from('instruction-files')
                        .upload(path, operation.file, { cacheControl: '3600', upsert: false });
                    if (uploadError) {
                        const message = String(uploadError.message || '').toLowerCase();
                        const alreadyUploaded = message.includes('already exists') || message.includes('duplicate');
                        if (!alreadyUploaded) throw uploadError;
                    }
                    const { data: publicUrl } = client.storage.from('instruction-files').getPublicUrl(path);
                    payload = { ...payload, file_path: path, file_url: publicUrl?.publicUrl || null, file_name: operation.file.name };
                }

                const { error } = await client.rpc('sync_teacher_offline_operation', {
                    p_operation_id: operation.operationId,
                    p_payload: payload
                });
                if (error) throw error;
                await removeQueuedTeacherOperation(operation.key);
            }

            const remaining = await getTeacherQueue(client);
            if (remaining.length) {
                setNotice(`${remaining.length} teacher change${remaining.length === 1 ? '' : 's'} still waiting to sync. Reconnect and retry.`, true, 'sync');
            } else if (operations.length) {
                document.querySelectorAll('.offline-queued-requirement').forEach(element => element.remove());
                document.querySelectorAll('button').forEach(button => {
                    if (button.textContent.trim() === 'Queued offline') button.textContent = 'Save';
                });
                setNotice('Teacher changes synced. Refreshing offline rosters...', true, 'ready');
                await preloadTeacherAssignedRosters(client, true);
                window.setTimeout(() => setNotice('', false), 6000);
            }
        } catch (error) {
            console.error('Unable to sync queued teacher changes.', error);
            setNotice('Some teacher changes could not sync. They remain saved on this device; retry when online.', true, 'sync');
        } finally {
            syncInProgress = false;
        }
    }

    let syncInProgress = false;

    async function saveOfflineSnapshot(client, pageKey, role) {
        if (!navigator.onLine) return false;
        window.supabaseClientForOffline = client;
        const userId = await getUserId(client);
        const main = document.querySelector('.main');
        if (!userId || !main || !main.innerHTML.trim()) return false;

        const alertBox = document.getElementById('amsAlert');
        if (alertBox) alertBox.classList.remove('show');
        const confirmModal = document.getElementById('confirmModal');
        if (confirmModal) confirmModal.classList.remove('show');

        await removeOtherUsers(userId);
        const formState = Array.from(main.querySelectorAll('input[id],select[id],textarea[id]')).map(element => ({
            id: element.id,
            value: element.value,
            checked: 'checked' in element ? element.checked : undefined
        }));
        const savedFilterState = role === 'teacher' ? teacherFilterState() : null;
        const pageState = role === 'teacher' && typeof window.capturePortalOfflineState === 'function'
            ? window.capturePortalOfflineState()
            : null;
        await writeSnapshot({
            key: snapshotKey(userId, pageKey, role, savedFilterState),
            html: main.innerHTML,
            formState,
            filterState: savedFilterState,
            pageState,
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

    async function waitForSnapshot(userId, pageKey, role, savedAfter, timeoutMs = 30000, filterState = null) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (!navigator.onLine) return false;
            const snapshot = await readSnapshot(snapshotKey(userId, pageKey, role, filterState));
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
            const defaultFilterState = role === 'teacher' ? emptyTeacherFilterState() : null;
            for (const page of pagesToWarm) {
                if (!(await readSnapshot(snapshotKey(userId, page.key, role, defaultFilterState)))) missingPages.push(page);
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
                    await waitForSnapshot(userId, page.key, role, saveStartedAt, 30000, defaultFilterState);
                } catch (error) {
                    console.warn(`Could not prepare offline ${page.key} page.`, error);
                } finally {
                    frame.remove();
                }
            }));
            setPreparationProgress(false);

            if (navigator.onLine) {
                const hasAllPages = await Promise.all(pages.map(async page =>
                    Boolean(await readSnapshot(snapshotKey(userId, page.key, role, role === 'teacher' ? emptyTeacherFilterState() : null)))
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

    async function preloadTeacherAssignedRosters(client, forceRefresh = false) {
        if (!navigator.onLine || isWarmupFrame) return;
        if (teacherRosterWarmupPromise) {
            const currentWarmup = teacherRosterWarmupPromise;
            await currentWarmup;
            if (forceRefresh && navigator.onLine) return preloadTeacherAssignedRosters(client, true);
            return;
        }

        teacherRosterWarmupPromise = (async () => {
            const userId = await getUserId(client);
            if (!userId) return;
            const { data: teacher, error: teacherError } = await client
                .from('teachers')
                .select('teacher_id')
                .eq('user_id', userId)
                .maybeSingle();
            if (teacherError) throw teacherError;
            if (!teacher) return;

            const { data: semester, error: semesterError } = await client
                .from('semesters')
                .select('semester_id')
                .eq('is_active', true)
                .maybeSingle();
            if (semesterError) throw semesterError;
            if (!semester) return;

            const { data: assignments, error: assignmentsError } = await client
                .from('teacher_subject_assignments')
                .select(`
                    subject_id,
                    subjects(subject_id, semester_id, year_level, major_id, majors(department_id)),
                    teacher_section_assignments(section_id, sections(section_id, section_name, year_level, major_id, majors(department_id)))
                `)
                .eq('teacher_id', teacher.teacher_id);
            if (assignmentsError) throw assignmentsError;

            const rosterRoutes = new Map();
            (assignments || []).forEach(assignment => {
                const subject = assignment.subjects;
                if (!subject || String(subject.semester_id) !== String(semester.semester_id)) return;
                (assignment.teacher_section_assignments || []).forEach(sectionAssignment => {
                    const section = sectionAssignment.sections;
                    if (!section) return;
                    const year = section.year_level || subject.year_level || '';
                    const majorId = section.major_id || subject.major_id;
                    const departmentId = section.majors?.department_id || subject.majors?.department_id;
                    if (!year || !majorId || !departmentId) return;
                    const route = {
                        year,
                        department_id: String(departmentId),
                        major_id: String(majorId),
                        subject_id: String(subject.subject_id),
                        section_id: String(section.section_id)
                    };
                    rosterRoutes.set(`${route.subject_id}:${route.section_id}`, route);
                });
            });

            if (!rosterRoutes.size) return;
            setPreparationProgress(true);
            const tasks = [];
            rosterRoutes.forEach(route => {
                tasks.push({ file: 'teacher_manage_students.html', pageKey: 'students', route, warmParam: 'amsTeacherRosterWarm' });
                tasks.push({ file: 'teacher_student_status.html', pageKey: 'status', route, warmParam: 'amsTeacherOfflineWarm' });
                tasks.push({ file: 'teacher_manage_subjects.html', pageKey: 'subjects', route, warmParam: 'amsTeacherRosterWarm' });
            });

            let nextTask = 0;
            const worker = async () => {
                while (nextTask < tasks.length && navigator.onLine) {
                    const task = tasks[nextTask++];
                    const filterState = task.file === 'teacher_manage_subjects.html'
                        ? [['yearSelect', task.route.year], ['departmentSelect', task.route.department_id], ['majorSelect', task.route.major_id], ['subjectSelect', task.route.subject_id], ['sectionSelect', task.route.section_id]]
                        : [['yearFilter', task.route.year], ['departmentFilter', task.route.department_id], ['majorFilter', task.route.major_id], ['subjectFilter', task.route.subject_id], ['sectionFilter', task.route.section_id]];
                    if (!forceRefresh && await readSnapshot(snapshotKey(userId, task.pageKey, 'teacher', filterState))) continue;

                    const frame = document.createElement('iframe');
                    frame.title = 'Preparing assigned teacher roster';
                    frame.setAttribute('aria-hidden', 'true');
                    frame.tabIndex = -1;
                    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;';
                    const url = new URL(task.file, window.location.href);
                    url.searchParams.set(task.warmParam, '1');
                    Object.entries(task.route).forEach(([key, value]) => url.searchParams.set(key, value));
                    const savedAfter = Date.now();
                    frame.src = url.href;
                    document.body.appendChild(frame);
                    try {
                        await waitForSnapshot(userId, task.pageKey, 'teacher', savedAfter, 30000, filterState);
                    } catch (error) {
                        console.warn(`Could not cache assigned roster for ${task.file}.`, error);
                    } finally {
                        frame.remove();
                    }
                }
            };
            await Promise.all([worker(), worker()]);
            setPreparationProgress(false);

            if (navigator.onLine) {
                const savedRoutes = await Promise.all(tasks.map(async task => {
                    const filterState = task.file === 'teacher_manage_subjects.html'
                        ? [['yearSelect', task.route.year], ['departmentSelect', task.route.department_id], ['majorSelect', task.route.major_id], ['subjectSelect', task.route.subject_id], ['sectionSelect', task.route.section_id]]
                        : [['yearFilter', task.route.year], ['departmentFilter', task.route.department_id], ['majorFilter', task.route.major_id], ['subjectFilter', task.route.subject_id], ['sectionFilter', task.route.section_id]];
                    return Boolean(await readSnapshot(snapshotKey(userId, task.pageKey, 'teacher', filterState)));
                }));
                if (savedRoutes.every(Boolean)) {
                    setNotice('All assigned teacher rosters are saved for offline viewing.', true, 'ready');
                    window.setTimeout(() => setNotice('', false), 6000);
                } else {
                    setNotice('Some assigned rosters were not saved. Keep this page online and retry.', true, 'sync');
                }
            }
        })().finally(() => {
            setPreparationProgress(false);
            teacherRosterWarmupPromise = null;
        });

        return teacherRosterWarmupPromise;
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

            let snapshot = role === 'teacher' && !force
                ? await readLatestTeacherSnapshot(userId, pageKey)
                : await readSnapshot(snapshotKey(userId, pageKey, role));
            if (!snapshot?.html) {
                setNotice(`Offline. This ${role} page has no saved copy on this device yet.`, true);
                return false;
            }

            const main = document.querySelector('.main');
            if (!main) return false;
            main.innerHTML = snapshot.html;
            const restoredAlert = document.getElementById('amsAlert');
            if (restoredAlert) restoredAlert.classList.remove('show');
            const restoredConfirm = document.getElementById('confirmModal');
            if (restoredConfirm) restoredConfirm.classList.remove('show');
            (snapshot.formState || []).forEach(field => {
                const element = document.getElementById(field.id);
                if (!element) return;
                element.value = field.value;
                if (field.checked !== undefined) element.checked = field.checked;
            });
            if (role === 'teacher' && typeof window.restorePortalOfflineState === 'function') {
                window.restorePortalOfflineState(snapshot.pageState);
            }
            makeOfflineViewReadOnly(main);
            let pendingCount = 0;
            if (role === 'teacher') {
                bindTeacherOfflineFilters(client, pageKey, main, snapshot);
                await applyQueuedTeacherOperations(client, pageKey, main);
                pendingCount = (await getTeacherQueue(client)).length;
            }
            const savedTime = new Date(snapshot.savedAt).toLocaleString();
            setNotice(role === 'teacher'
                ? `Offline view: data saved ${savedTime}. ${pendingCount ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to sync. ` : ''}Only cached rosters are available.`
                : `Offline read-only view: showing saved student information from ${savedTime}. Changes and attachments require internet.`, true);
            return true;
        } catch (error) {
            console.warn('Unable to restore the student offline view.', error);
            setNotice(`Offline. A saved ${role} copy could not be opened on this device.`, true);
            return false;
        }
    }

    async function readLatestTeacherSnapshot(userId, pageKey) {
        const database = await openDatabase();
        const prefix = `${userId}:teacher:${pageKey}:`;
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => {
                const match = request.result
                    .filter(snapshot => typeof snapshot.key === 'string' && snapshot.key.startsWith(prefix))
                    .sort((first, second) => Date.parse(second.savedAt) - Date.parse(first.savedAt))[0];
                resolve(match || null);
            };
            request.onerror = () => reject(request.error || new Error('Unable to find saved teacher view.'));
        });
    }

    function bindTeacherOfflineFilters(client, pageKey, container, currentSnapshot) {
        container.querySelectorAll('select#yearFilter,select#departmentFilter,select#majorFilter,select#subjectFilter,select#sectionFilter,select#yearSelect,select#departmentSelect,select#majorSelect,select#subjectSelect,select#sectionSelect').forEach(select => {
            if (select.dataset.offlineFilterBound) return;
            select.dataset.offlineFilterBound = 'true';
            select.addEventListener('change', async () => {
                const loaded = await restoreTeacherSnapshotForFilterChange(client, pageKey, select.id, select.value, currentSnapshot);
                if (!loaded) {
                    (currentSnapshot.formState || []).forEach(field => {
                        const element = document.getElementById(field.id);
                        if (element) element.value = field.value;
                    });
                    setNotice('That teacher roster was not saved on this device. Choose a section while online before using it offline.', true);
                }
            });
        });
    }

    async function restoreTeacherSnapshotForFilterChange(client, pageKey, changedFilterId, changedValue, currentSnapshot) {
        const userId = await getUserId(client);
        const database = await openDatabase();
        const prefix = `${userId}:teacher:${pageKey}:`;
        const snapshots = await new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result.filter(snapshot => snapshot.key.startsWith(prefix)));
            request.onerror = () => reject(request.error || new Error('Unable to inspect saved roster filters.'));
        });

        const filterIds = teacherFilterState().map(([id]) => id).filter(id => snapshots.some(snapshot => snapshot.filterState?.some(([filterId]) => filterId === id)));
        const changedIndex = filterIds.indexOf(changedFilterId);
        const currentValues = Object.fromEntries(teacherFilterState());
        const candidates = snapshots.filter(snapshot => {
            const saved = Object.fromEntries(snapshot.filterState || []);
            if (saved[changedFilterId] !== changedValue) return false;
            return filterIds.slice(0, changedIndex).every(id => saved[id] === (id === changedFilterId ? changedValue : currentValues[id]));
        }).sort((first, second) => Date.parse(second.savedAt) - Date.parse(first.savedAt));
        const snapshot = candidates[0];
        if (!snapshot || !snapshot.filterState) return false;

        const main = document.querySelector('.main');
        if (!main) return false;
        main.innerHTML = snapshot.html;
        const restoredAlert = document.getElementById('amsAlert');
        if (restoredAlert) restoredAlert.classList.remove('show');
        const restoredConfirm = document.getElementById('confirmModal');
        if (restoredConfirm) restoredConfirm.classList.remove('show');
        (snapshot.formState || []).forEach(field => {
            const element = document.getElementById(field.id);
            if (!element) return;
            element.value = field.value;
            if (field.checked !== undefined) element.checked = field.checked;
        });
        if (typeof window.restorePortalOfflineState === 'function') {
            window.restorePortalOfflineState(snapshot.pageState);
        }
        const selected = Object.fromEntries(snapshot.filterState || []);
        filterIds.slice(0, changedIndex + 1).forEach(id => {
            const element = document.getElementById(id);
            if (element && currentValues[id] !== undefined) element.value = currentValues[id];
        });
        makeOfflineViewReadOnly(main);
        bindTeacherOfflineFilters(client, pageKey, main, snapshot);
        await applyQueuedTeacherOperations(client, pageKey, main);
        setNotice(`Offline read-only view: showing the saved roster from ${new Date(snapshot.savedAt).toLocaleString()}.`, true);
        return true;
    }

    async function applyQueuedTeacherOperations(client, pageKey, container) {
        const operations = await getTeacherQueue(client);
        for (const operation of operations) {
            const payload = operation.payload || {};
            if (operation.type === 'grade' && pageKey === 'status') {
                const currentSubject = container.querySelector('#subjectFilter')?.value;
                if (String(currentSubject) !== String(payload.subject_id)) continue;
                const gradeFields = {
                    prelim: 'prelim',
                    midterm: 'midterm',
                    final: 'final',
                    prelim_status: 'prelim-status',
                    midterm_status: 'midterm-status',
                    final_status: 'final-status'
                };
                Object.entries(gradeFields).forEach(([payloadField, elementId]) => {
                    const input = container.querySelector(`#${elementId}-${payload.student_id}`);
                    if (!input) return;
                    input.value = payload[payloadField] ?? '';
                    if (input.tagName === 'SELECT' && typeof window.updateStatusColor === 'function') {
                        window.updateStatusColor(input);
                    }
                });
                const saveButton = container.querySelector(`#save-grade-${payload.student_id}`);
                if (saveButton) saveButton.textContent = 'Queued offline';
            }
            if ((operation.type === 'requirement' || operation.type === 'attachment') && pageKey === 'subjects') {
                const currentSubject = container.querySelector('#subjectSelect')?.value;
                if (String(currentSubject) !== String(payload.subject_id)) continue;
                const studentIds = operation.type === 'requirement'
                    ? (payload.student_ids || [])
                    : (payload.student_ids || []);
                studentIds.forEach(studentId => {
                    const row = container.querySelector(`tr[data-student-id="${studentId}"]`);
                    const cell = row?.children[1];
                    if (!cell) return;
                    const pending = document.createElement('div');
                    pending.className = 'offline-queued-requirement';
                    pending.dataset.operationId = operation.operationId;
                    pending.textContent = operation.type === 'requirement'
                        ? `Waiting to sync: ${payload.requirement_title}`
                        : `Attachment waiting to sync: ${operation.file?.name || payload.file_name || 'File'}`;
                    pending.style.cssText = 'margin:6px 0;padding:7px 9px;border-left:3px solid #d97706;background:#fffbeb;color:#92400e;font-size:12px;';
                    cell.appendChild(pending);
                });
            }
        }
    }

    function makeOfflineViewReadOnly(container) {
        container.querySelectorAll('input,select,textarea,button').forEach(control => {
            const teacherFilter = window.currentOfflineRole === 'teacher'
                && control.matches('select#yearFilter,select#departmentFilter,select#majorFilter,select#subjectFilter,select#sectionFilter,select#yearSelect,select#departmentSelect,select#majorSelect,select#subjectSelect,select#sectionSelect');
            const teacherGradeField = window.currentOfflineRole === 'teacher'
                && /^(prelim|midterm|final|prelim-status|midterm-status|final-status)-\d+$/.test(control.id);
            const requirementInput = window.currentOfflineRole === 'teacher'
                && /^(requirementTitle|requirementDescription|requirementDeadline|requirementFile|instructionFile)$/.test(control.id);
            const studentPicker = window.currentOfflineRole === 'teacher'
                && control.matches('.requirement-student-check');
            const safeTeacherAction = window.currentOfflineRole === 'teacher' && control.matches('button')
                && /openRequirementModal|saveRequirement|closeRequirementModal|selectRequirementStudents|updateRequirementStudentCount|openUploadModal|closeUploadModal|uploadInstruction|saveGrade|updateStatusColor|closeModal/.test(control.getAttribute('onclick') || '');
            control.disabled = !(teacherFilter || teacherGradeField || requirementInput || studentPicker || safeTeacherAction);
        });
        container.querySelectorAll('*').forEach(element => {
            Array.from(element.attributes).forEach(attribute => {
                if (/^on/i.test(attribute.name)) {
                    const handler = attribute.value || '';
                    const isLogout = attribute.name.toLowerCase() === 'onclick' && element.matches('a[href="login.html"]');
                    const isOfflineSupportedAction = window.currentOfflineRole === 'teacher'
                        && attribute.name.toLowerCase() === 'onclick'
                        && /openRequirementModal|saveRequirement|closeRequirementModal|selectRequirementStudents|updateRequirementStudentCount|openUploadModal|closeUploadModal|uploadInstruction|saveGrade|updateStatusColor/.test(handler);
                    if (isLogout || isOfflineSupportedAction) return;
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
    window.queueTeacherOperation = queueTeacherOperation;
    window.syncTeacherQueue = syncTeacherQueue;
    window.preloadTeacherAssignedRosters = preloadTeacherAssignedRosters;
    window.getTeacherOfflineQueue = getTeacherQueue;
    window.syncTeacherOfflineQueue = syncTeacherQueue;
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
        setNotice('Connection restored. Refreshing portal data and syncing queued teacher changes.', true, 'sync');
        if (window.currentOfflineRole === 'teacher' && window.supabaseClientForOffline) {
            void syncTeacherQueue(window.supabaseClientForOffline);
            void preloadTeacherAssignedRosters(window.supabaseClientForOffline, true).catch(error => {
                console.warn('Could not refresh assigned teacher rosters.', error);
            });
        }
    });

    window.addEventListener('DOMContentLoaded', () => {
        if (window.currentOfflineRole === 'teacher' && window.supabaseClientForOffline) {
            void syncTeacherQueue(window.supabaseClientForOffline);
        }
    });
})();
