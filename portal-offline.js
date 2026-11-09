(function () {
    const databaseName = 'ams-student-offline';
    const storeName = 'page-snapshots';
    const queueStoreName = 'teacher-write-queue';
    const adminQueueStoreName = 'admin-account-create-queue';
    const adminResultsStoreName = 'admin-created-account-results';
    const adminPasswordResetResultsStoreName = 'admin-password-reset-results';
    const adminDeletionResultsStoreName = 'admin-deletion-results';
    const adminLookupStoreName = 'admin-account-lookups';
    const adminStructureQueueStoreName = 'admin-structure-write-queue';
    const adminStructureMapStoreName = 'admin-structure-id-map';
    const adminSystemLogStoreName = 'admin-system-logs';
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
    let adminSnapshotObserver;
    let adminSnapshotTimer;
    let adminOfflineReadyNoticeShown = false;
    const teacherSyncFailureStorageKey = 'ams-teacher-sync-last-failure';
    const pageParams = new URLSearchParams(window.location.search);
    const isStudentWarmupFrame = pageParams.get('amsOfflineWarm') === '1';
    const isTeacherWarmupFrame = pageParams.get('amsTeacherOfflineWarm') === '1'
        || pageParams.get('amsTeacherRosterWarm') === '1';
    const isWarmupFrame = isStudentWarmupFrame || isTeacherWarmupFrame;

    function openDatabase() {
        if (!('indexedDB' in window)) return Promise.reject(new Error('Offline storage is unavailable.'));
        if (databasePromise) return databasePromise;

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 7);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(storeName)) {
                    database.createObjectStore(storeName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(queueStoreName)) {
                    database.createObjectStore(queueStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminQueueStoreName)) {
                    database.createObjectStore(adminQueueStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminResultsStoreName)) {
                    database.createObjectStore(adminResultsStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminPasswordResetResultsStoreName)) {
                    database.createObjectStore(adminPasswordResetResultsStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminDeletionResultsStoreName)) {
                    database.createObjectStore(adminDeletionResultsStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminLookupStoreName)) {
                    database.createObjectStore(adminLookupStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminStructureQueueStoreName)) {
                    database.createObjectStore(adminStructureQueueStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminStructureMapStoreName)) {
                    database.createObjectStore(adminStructureMapStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminSystemLogStoreName)) {
                    database.createObjectStore(adminSystemLogStoreName, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Unable to open offline storage.'));
        });
        return databasePromise;
    }

    function setNotice(message, visible, type = 'offline', action = null) {
        if (!visible && !navigator.onLine && window.currentOfflineRole === 'admin') return;
        let notice = document.getElementById('studentOfflineNotice');
        if (!notice) {
            notice = document.createElement('div');
            notice.id = 'studentOfflineNotice';
            notice.setAttribute('role', 'status');
            notice.style.cssText = 'position:fixed;z-index:10000;top:0;left:0;right:0;padding:9px 16px;text-align:center;color:#fff;font:600 14px/1.4 sans-serif;';
            document.body.appendChild(notice);
        }
        notice.style.background = type === 'ready' ? '#166534' : type === 'sync' ? '#1d4ed8' : '#7c2d12';
        notice.style.top = '0';
        notice.replaceChildren(document.createTextNode(message));
        if (action) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.textContent = action.label;
            actionButton.style.cssText = 'margin-left:10px;padding:4px 8px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer;';
            actionButton.addEventListener('click', action.onClick);
            notice.appendChild(actionButton);
        }
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

    async function beginAdminOfflinePage(client) {
        window.supabaseClientForOffline = client;
        window.currentOfflineRole = 'admin';
        window.adminOfflineView = false;
        if (!navigator.onLine) {
            await restoreAdminOfflineSnapshot(client);
            return true;
        }

        const userId = await getUserId(client);
        if (!userId) return false;
        const { data: admin, error } = await client.from('admins')
            .select('id')
            .eq('auth_user_id', userId)
            .maybeSingle();
        if (error || !admin) return false;
        void refreshAdminAccountLookupsIfStale(client, userId).catch(cacheError => {
            console.warn('Admin offline lookup refresh is still pending.', cacheError);
        });
        void syncAdminQueues(client);

        const main = document.querySelector('.main');
        if (main && !adminSnapshotObserver) {
            adminSnapshotObserver = new MutationObserver(() => {
                clearTimeout(adminSnapshotTimer);
                adminSnapshotTimer = window.setTimeout(() => {
                    void saveAdminOfflineSnapshot(client, userId);
                }, 1200);
            });
            adminSnapshotObserver.observe(main, { childList: true, subtree: true, characterData: true, attributes: true });
        }
        return false;
    }

    async function saveAdminOfflineSnapshot(client, userId) {
        if (!navigator.onLine) return false;
        const currentUserId = userId || await getUserId(client);
        const main = document.querySelector('.main');
        if (!currentUserId || !main) return false;
        const snapshotMain = main.cloneNode(true);
        snapshotMain.querySelectorAll('.modal,.modal-overlay,.confirm-modal-overlay,.ams-alert').forEach(element => {
                if (!['confirmModal', 'createStudentModal', 'createTeacherModal', 'editStudentModal', 'editTeacherModal', 'addStudentsToSectionModal', 'unassignSelectedStudentsModal', 'departmentModal', 'majorModal', 'sectionModal', 'subjectModal', 'deleteDepartmentModal', 'deleteMajorModal', 'deleteSectionModal', 'deleteSubjectModal', 'teacherAssignModal', 'teacherSectionModal', 'teacherAssignmentModal'].includes(element.id)) {
                element.remove();
                return;
            }
            element.style.display = 'none';
            element.querySelectorAll('#createdStudentCredentials,#createdTeacherCredentials').forEach(credentials => {
                credentials.style.display = 'none';
                credentials.querySelectorAll('code,span').forEach(value => { value.textContent = ''; });
            });
        });
        snapshotMain.querySelectorAll('#adminCreatedAccountsTable tr').forEach(row => {
            if (row.children.length >= 6) row.children[5].textContent = 'Saved locally';
        });
        await writeSnapshot({
            key: `${currentUserId}:admin:dashboard`,
            html: snapshotMain.innerHTML,
            savedAt: new Date().toISOString()
        });
        if (!adminOfflineReadyNoticeShown) {
            adminOfflineReadyNoticeShown = true;
            setNotice('Admin data is saved on this device and ready for offline viewing.', true, 'ready');
            window.setTimeout(() => setNotice('', false), 6000);
        }
        return true;
    }

    async function restoreAdminOfflineSnapshot(client) {
        try {
            const userId = await getUserId(client);
            if (!userId) {
                setNotice('Offline admin view is unavailable. Sign in while connected first.', true);
                return false;
            }
            const snapshot = await readSnapshot(`${userId}:admin:dashboard`);
            const main = document.querySelector('.main');
            if (!snapshot?.html || !main) {
                setNotice('No saved admin data is available on this device yet. Open the dashboard while connected first.', true);
                return false;
            }
            const currentMain = main.cloneNode(true);
            main.innerHTML = snapshot.html;
            if (!main.querySelector('#manageUnassignSelectedSectionButton')) {
                const currentButton = currentMain.querySelector('#manageUnassignSelectedSectionButton');
                const actionGroup = main.querySelector('#manageSectionActions');
                if (currentButton && actionGroup) actionGroup.appendChild(currentButton.cloneNode(true));
            }
            if (!main.querySelector('#unassignSelectedStudentsModal')) {
                const currentModal = currentMain.querySelector('#unassignSelectedStudentsModal');
                if (currentModal) main.appendChild(currentModal.cloneNode(true));
            }
            const userLookups = await getAdminAccountLookups(client, userId);
            const semesterSelect = main.querySelector('#activeSemesterSelect');
            if (semesterSelect && userLookups?.semesters?.length) {
                semesterSelect.innerHTML = '<option value="">Select Semester</option>';
                userLookups.semesters.forEach(semester => {
                    semesterSelect.add(new Option(`${semester.semester_name}${semester.is_active ? ' (Active)' : ''}`, semester.semester_id));
                });
                const { pending } = await getAdminStructureData(client);
                const queuedSemester = pending.filter(item => item.type === 'semester_set').at(-1);
                const selectedSemesterId = queuedSemester?.payload.semester_id
                    || userLookups.semesters.find(semester => semester.is_active)?.semester_id;
                semesterSelect.value = selectedSemesterId ? String(selectedSemesterId) : '';
            }
            document.querySelectorAll('.modal,.modal-overlay,.confirm-modal-overlay').forEach(modal => {
                modal.style.display = 'none';
                modal.classList.remove('show');
            });
            document.querySelectorAll('input,select,textarea,button').forEach(control => {
                const inAllowedModal = control.closest('#createStudentModal,#createTeacherModal,#editStudentModal,#editTeacherModal,#addStudentsToSectionModal,#unassignSelectedStudentsModal,#departmentModal,#majorModal,#sectionModal,#subjectModal,#deleteDepartmentModal,#deleteMajorModal,#deleteSectionModal,#deleteSubjectModal,#teacherAssignModal,#teacherSectionModal,#teacherAssignmentModal');
                const opensAllowedModal = control.matches('button')
                    && /openCreateStudentModal|openCreateTeacherModal|openEditStudentModal|openEditQueuedStudentAccount|openEditTeacherModal|openEditQueuedTeacherAccount|openAddStudentsToSectionModal|openUnassignSelectedStudentsModal|transitionAdminSection|openDepartmentModal|openMajorModal|openSectionModal|openSubjectModal|openDeleteDepartmentModal|openDeleteMajorModal|openDeleteSectionModal|openDeleteSubjectModal|openTeacherAssignModal|openAddSectionModal/.test(control.getAttribute('onclick') || '');
                const isAllowedOfflineAction = control.matches('button')
                    && /createStudentAccount|createTeacherAccount|saveStudentEdits|saveTeacherEdits|resetStudentPassword|resetTeacherPassword|deleteStudent|deleteTeacher|deleteCreatedStudentAccount|deleteCreatedTeacherAccount|deleteQueuedTeacherAccount|deleteAllUnassignedStudents|deleteAllGraduatedStudents|clearAdminCreatedAccounts|clearAdminDeletionResults|loadUnassignedStudents|loadGraduatedStudents|transitionSelectedManageSection|unassignAllStudentsFromSelectedSection|unassignSelectedStudentsFromSection|assignSelectedUnassignedStudents|addDepartment|addMajor|addSection|addSubject|setActiveSemester|deleteDepartment|deleteMajor|deleteSectionModalAction|deleteSubject|assignTeacherToSubject|removeTeacherAssignment|saveTeacherSection|closeCreateStudentModal|closeEditStudentModal|closeTeacherAssignmentModal|closeModal|closeDepartmentModal|closeMajorModal|closeSectionModal|closeSubjectModal|closeDeleteDepartmentModal|closeDeleteMajorModal|closeDeleteSectionModal|closeDeleteSubjectModal|closeTeacherAssignModal|closeTeacherSectionModal|loadEditStudentMajors|loadEditStudentSections|loadDepartmentDeleteOptions|loadMajorsForDelete|loadMajorsForDeleteSection|loadSectionsForDelete|loadMajorsForDeleteSubject|loadSubjectsForDelete/.test(control.getAttribute('onclick') || '');
                const isAllowedOfflineStandaloneAction = control.matches('button')
                    && /deleteAllLogs|deleteStudent|deleteTeacher|deleteCreatedStudentAccount|deleteCreatedTeacherAccount|deleteQueuedTeacherAccount|resetTeacherPassword|openEditTeacherModal|deleteAllUnassignedStudents|deleteAllGraduatedStudents|clearAdminCreatedAccounts|clearAdminPasswordResetResults|clearAdminDeletionResults|transitionSelectedManageSection|unassignAllStudentsFromSelectedSection|openUnassignSelectedStudentsModal/.test(control.getAttribute('onclick') || '');
                const isSemesterPicker = control.id === 'activeSemesterSelect';
                const isExplorerBack = control.id === 'backButton';
                const isStudentFilter = ['manageStudentYear', 'manageStudentDepartment', 'manageStudentMajor', 'manageStudentSection'].includes(control.id);
                control.disabled = !(opensAllowedModal || isSemesterPicker || (control.matches('button') && /setActiveSemester/.test(control.getAttribute('onclick') || ''))
                    || isExplorerBack || isStudentFilter || isAllowedOfflineStandaloneAction || control.id === 'confirmActionBtn' || control.matches('.cancel-btn')
                    || (inAllowedModal && (!control.matches('button') || isAllowedOfflineAction)));
            });
                    const manageYear = main.querySelector('#manageStudentYear');
                    const manageDepartment = main.querySelector('#manageStudentDepartment');
                    const manageMajor = main.querySelector('#manageStudentMajor');
                    const manageSection = main.querySelector('#manageStudentSection');
                    if (manageYear) manageYear.value = '';
                    if (manageDepartment) manageDepartment.value = '';
                    if (manageMajor) manageMajor.value = '';
                    if (manageSection) manageSection.value = '';
                    const manageTable = main.querySelector('#manageStudentsTable');
                    if (manageTable) manageTable.innerHTML = '<tr><td colspan="4">Select a year, department, major, and section to view students.</td></tr>';
                    const sectionActions = main.querySelector('#manageSectionActions');
                    if (sectionActions) sectionActions.style.display = 'none';
            window.adminOfflineView = true;
            setNotice(`Offline view: admin data saved ${new Date(snapshot.savedAt).toLocaleString()}. Only saved admin data is available.`, true);
            return true;
        } catch (error) {
            console.warn('Unable to restore the offline admin view.', error);
            setNotice('Saved admin data could not be opened on this device.', true);
            return false;
        }
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
        const changeLabel = type === 'grade'
            ? 'Grade'
            : type === 'attachment'
                ? 'Attachment'
                : type === 'requirement_delete'
                    ? 'Delete'
                    : 'Requirement';
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

    function adminStoreRequest(storeName, mode, action) {
        return openDatabase().then(database => new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, mode);
            const request = action(transaction.objectStore(storeName));
            let result;
            if (request) {
                request.onsuccess = () => { result = request.result; };
                request.onerror = () => reject(request.error || new Error('Unable to access saved admin account data.'));
            }
            transaction.oncomplete = () => resolve(request ? result : true);
            transaction.onerror = () => reject(transaction.error || new Error('Unable to save admin account data.'));
            transaction.onabort = () => reject(transaction.error || new Error('Admin account data transaction was interrupted.'));
        }));
    }

    async function writeAdminHistoryRecord(storeName, record) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const markerRequest = store.get(`${record.userId}:__clear_marker__`);
            let saved = false;
            markerRequest.onsuccess = () => {
                const hiddenOperationIds = new Set(markerRequest.result?.hiddenOperationIds || []);
                if (!hiddenOperationIds.has(record.operationId)) {
                    store.put(record);
                    saved = true;
                }
            };
            markerRequest.onerror = () => reject(markerRequest.error || new Error('Unable to verify cleared history.'));
            transaction.oncomplete = () => resolve(saved);
            transaction.onerror = () => reject(transaction.error || new Error('Unable to save admin history.'));
            transaction.onabort = () => reject(transaction.error || new Error('Saving admin history was interrupted.'));
        });
    }

    async function clearAdminHistory(storeName, userId, queueActions) {
        while (window.adminAccountSyncInProgress) {
            await new Promise(resolve => window.addEventListener('admin-account-sync-finished', resolve, { once: true }));
        }
        window.adminHistoryClearInProgress = true;
        try {
            const database = await openDatabase();
            const cleared = await new Promise((resolve, reject) => {
                const transaction = database.transaction([storeName, adminQueueStoreName], 'readwrite');
                const resultStore = transaction.objectStore(storeName);
                const queueStore = transaction.objectStore(adminQueueStoreName);
                const resultRequest = resultStore.getAll();
                const queueRequest = queueStore.getAll();
                let resultReady = false;
                let queueReady = false;
                let resultCount = 0;
                let queuedCount = 0;
                const finishClear = () => {
                    if (!resultReady || !queueReady) return;
                    const userResults = resultRequest.result.filter(item => item.userId === userId);
                    const marker = userResults.find(item => item.recordType === 'clear-marker');
                    const hiddenOperationIds = new Set(marker?.hiddenOperationIds || []);
                    userResults.forEach(item => {
                        if (item.recordType !== 'clear-marker') resultCount += 1;
                        if (item.operationId) hiddenOperationIds.add(item.operationId);
                        resultStore.delete(item.key);
                    });
                    queueRequest.result.filter(item => item.userId === userId && queueActions.includes(item.action)).forEach(item => {
                        queuedCount += 1;
                        hiddenOperationIds.add(item.operationId);
                        queueStore.delete(item.key);
                    });
                    resultStore.put({
                        key: `${userId}:__clear_marker__`,
                        userId,
                        recordType: 'clear-marker',
                        hiddenOperationIds: [...hiddenOperationIds],
                        clearedAt: new Date().toISOString()
                    });
                };
                resultRequest.onsuccess = () => { resultReady = true; finishClear(); };
                queueRequest.onsuccess = () => { queueReady = true; finishClear(); };
                resultRequest.onerror = () => reject(resultRequest.error || new Error('Unable to read saved admin results.'));
                queueRequest.onerror = () => reject(queueRequest.error || new Error('Unable to read pending admin operations.'));
                transaction.oncomplete = () => resolve({ resultCount, queuedCount });
                transaction.onerror = () => reject(transaction.error || new Error('Unable to clear saved admin results.'));
                transaction.onabort = () => reject(transaction.error || new Error('Clearing saved admin results was interrupted.'));
            });
            const [remainingResults, remainingQueue] = await Promise.all([
                adminStoreRequest(storeName, 'readonly', store => store.getAll()),
                adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll())
            ]);
            const marker = remainingResults.find(item => item.userId === userId && item.recordType === 'clear-marker');
            const hiddenOperationIds = new Set(marker?.hiddenOperationIds || []);
            const resultsLeft = remainingResults.filter(item => item.userId === userId
                && item.recordType !== 'clear-marker' && !hiddenOperationIds.has(item.operationId)).length;
            const queuedLeft = remainingQueue.filter(item => item.userId === userId
                && queueActions.includes(item.action) && !hiddenOperationIds.has(item.operationId)).length;
            if (resultsLeft || queuedLeft) {
                throw new Error(`Local clear verification failed: ${resultsLeft} saved result(s) and ${queuedLeft} queued operation(s) remain.`);
            }
            return cleared;
        } finally {
            window.adminHistoryClearInProgress = false;
            window.dispatchEvent(new CustomEvent('admin-history-clear-finished'));
        }
    }

    async function nextAdminQueueTimestamp(userId) {
        const [accountOperations, structureOperations] = await Promise.all([
            adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll()),
            adminStoreRequest(adminStructureQueueStoreName, 'readonly', store => store.getAll())
        ]);
        const latestTimestamp = [...accountOperations, ...structureOperations]
            .filter(item => item.userId === userId)
            .reduce((latest, item) => Math.max(latest, Date.parse(item.createdAt) || 0), 0);
        return new Date(Math.max(Date.now(), latestTimestamp + 1)).toISOString();
    }

    async function saveAdminAccountResult(userId, operationId, role, payload, result) {
        const lookups = role === 'student' ? await getAdminAccountLookups(null, userId) : null;
        const section = lookups?.sections.find(item => String(item.section_id) === String(payload.section_id || result.section_id));
        await adminStoreRequest(adminResultsStoreName, 'readwrite', store => store.put({
            key: `${userId}:${operationId}`, userId, operationId, role,
            accountId: role === 'student' ? result.login_id : result.teacher_number,
            temporaryPassword: result.temporary_password,
            createdAt: new Date().toISOString(),
            payload: {
                first_name: payload.first_name,
                middle_initial: payload.middle_initial,
                last_name: payload.last_name,
                user_id: role === 'student' ? result.student_id : result.user_id || null,
                profile_id: role === 'student' ? result.student_id : result.teacher_id || null,
                teacher_id: role === 'teacher' ? result.teacher_id || null : null,
                section_id: payload.section_id || result.section_id || null,
                year_level: payload.year_level || section?.year_level || '',
                section_name: section?.section_name || ''
            }
        }));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        if (typeof window.renderAdminCreatedAccounts === 'function') {
            await window.renderAdminCreatedAccounts();
        }
    }

    async function recordAdminAccountCreationFailure(client, role, payload, errorMessage) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before saving this account request.');
        const operationId = createOperationId();
        const accountId = role === 'teacher' ? payload.teacher_number : payload.student_number;
        const record = {
            key: `${userId}:${operationId}`,
            userId,
            operationId,
            role,
            accountId: String(accountId || ''),
            createdAt: new Date().toISOString(),
            status: `Needs attention: ${errorMessage || 'Account creation failed.'}`,
            failed: true,
            payload: { ...payload }
        };
        await adminStoreRequest(adminResultsStoreName, 'readwrite', store => store.put(record));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        return operationId;
    }

    async function discardAdminAccountResult(client, operationId) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before removing this saved request.');
        const key = `${userId}:${operationId}`;
        const record = await adminStoreRequest(adminResultsStoreName, 'readonly', store => store.get(key));
        if (!record || record.userId !== userId || !record.failed) {
            throw new Error('This failed account request was not found.');
        }
        await adminStoreRequest(adminResultsStoreName, 'readwrite', store => store.delete(key));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        return true;
    }

    async function removeAdminAccountResult(client, accountNumber, role = 'student') {
        const userId = await getUserId(client);
        if (!userId || !accountNumber) return;
        const allResults = await adminStoreRequest(adminResultsStoreName, 'readonly', store => store.getAll());
        await Promise.all(allResults.filter(item => item.userId === userId && item.role === role
            && String(item.accountId) === String(accountNumber)).map(item => adminStoreRequest(
            adminResultsStoreName, 'readwrite', store => store.delete(item.key)
        )));
    }

    async function updateAdminTeacherAccountResult(client, teacherId, payload) {
        const userId = await getUserId(client);
        if (!userId || !teacherId) return;
        const [allResults, lookups] = await Promise.all([
            adminStoreRequest(adminResultsStoreName, 'readonly', store => store.getAll()),
            getAdminAccountLookups(client, userId)
        ]);
        const teacher = (lookups?.teachers || []).find(item => String(item.teacher_id) === String(teacherId));
        if (!teacher) return;
        const result = allResults.find(item => item.userId === userId && item.role === 'teacher'
            && (String(item.payload?.teacher_id || item.payload?.profile_id || '') === String(teacherId)
                || String(item.accountId) === String(teacher.teacher_number)));
        if (!result) return;
        await adminStoreRequest(adminResultsStoreName, 'readwrite', store => store.put({
            ...result,
            accountId: teacher.teacher_number,
            payload: { ...result.payload, ...payload, teacher_id: teacher.teacher_id, profile_id: teacher.teacher_id,
                user_id: teacher.user_id, first_name: teacher.first_name, middle_initial: teacher.middle_initial, last_name: teacher.last_name }
        }));
    }

    async function removeAdminStudentFromLocalRosters(client, studentId, studentNumber) {
        const userId = await getUserId(client);
        if (!userId) return;
        const allRecords = await adminStoreRequest(adminLookupStoreName, 'readonly', store => store.getAll());
        const matchesStudent = student =>
            (studentId != null && String(student.student_id) === String(studentId))
            || (studentNumber && String(student.student_number || '') === String(studentNumber));
        const rosterRecords = allRecords.filter(record => record.userId === userId && Array.isArray(record.students));
        await Promise.all(rosterRecords.map(record => adminStoreRequest(
            adminLookupStoreName,
            'readwrite',
            store => store.put({
                ...record,
                students: record.students.filter(student => !matchesStudent(student)),
                savedAt: new Date().toISOString()
            })
        )));
        window.dispatchEvent(new CustomEvent('admin-student-data-changed'));
    }

    window.removeAdminAccountResult = removeAdminAccountResult;

    async function performAdminStudentDeletion(client, payload, anonKey) {
        const studentId = Number(payload.student_id);
        const studentNumber = String(payload.student_number || '').trim();
        const userId = String(payload.user_id || '');
        let query = client.from('students').select('student_id, user_id, student_number, first_name, middle_initial, last_name');
        if (Number.isInteger(studentId) && studentId > 0) query = query.eq('student_id', studentId);
        else if (studentNumber) query = query.eq('student_number', studentNumber);
        else if (userId) query = query.eq('user_id', userId);
        else throw new Error('A student ID or account identifier is required.');

        const { data: student, error: studentError } = await query.maybeSingle();
        if (studentError) throw new Error(studentError.message);
        const resolvedUserId = String(student?.user_id || userId);
        if (!resolvedUserId) throw new Error('The student login could not be identified.');

        if (student) {
            const { error: activityError } = await client.from('activity_logs')
                .update({ user_id: null }).eq('user_id', resolvedUserId);
            if (activityError) throw new Error(activityError.message);

            const { data: requirements, error: requirementsError } = await client.from('student_requirements')
                .select('requirement_id').eq('student_id', student.student_id);
            if (requirementsError) throw new Error(requirementsError.message);
            const requirementIds = (requirements || []).map(item => item.requirement_id).filter(Boolean);

            const { error: filesByStudentError } = await client.from('subject_instruction_files')
                .delete().eq('student_id', student.student_id);
            if (filesByStudentError) throw new Error(filesByStudentError.message);
            if (requirementIds.length) {
                const { error: filesByRequirementError } = await client.from('subject_instruction_files')
                    .delete().in('requirement_id', requirementIds);
                if (filesByRequirementError) throw new Error(filesByRequirementError.message);
                const { error: requirementsDeleteError } = await client.from('student_requirements')
                    .delete().in('requirement_id', requirementIds);
                if (requirementsDeleteError) throw new Error(requirementsDeleteError.message);
            }
            const { error: gradesError } = await client.from('student_grades')
                .delete().eq('student_id', student.student_id);
            if (gradesError) throw new Error(gradesError.message);
            const { error: studentDeleteError } = await client.from('students')
                .delete().eq('student_id', student.student_id);
            if (studentDeleteError) throw new Error(studentDeleteError.message);
        }

        const { error: appUserError } = await client.from('users').delete().eq('user_id', resolvedUserId);
        if (appUserError) throw new Error(appUserError.message);
        const { data: { session } } = await client.auth.getSession();
        if (!session) throw new Error('Please sign in again as an administrator.');
        const response = await fetch('https://nrqrsolfowebujogawti.supabase.co/functions/v1/delete-user', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: anonKey,
                Authorization: `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ user_id: resolvedUserId })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok && !/not found|does not exist/i.test(result.error || '')) {
            throw new Error(result.error || 'Unable to delete the authentication account.');
        }

        if (student) {
            const activity = `Deleted student ${student.first_name || 'Unknown'} ${student.last_name || 'student'} [${student.student_number || studentId}]`;
            const { error: logError } = await client.from('activity_logs').insert({ user_id: null, activity });
            if (logError) console.warn('Student account was deleted, but the activity log could not be saved.', logError);
        }
        return {
            ok: true,
            student_id: student?.student_id || studentId || null,
            student_number: student?.student_number || studentNumber,
            first_name: student?.first_name || payload.first_name || '',
            middle_initial: payload.middle_initial || '',
            last_name: student?.last_name || payload.last_name || ''
        };
    }

    async function saveAdminPasswordResetResult(userId, operationId, payload, result) {
        const roster = await getAdminStudentRoster(null, userId);
        const student = roster?.students?.find(item => payload.student_number
            ? String(item.student_number) === String(payload.student_number)
            : String(item.student_id) === String(payload.student_id));
        const record = {
            key: `${userId}:${operationId}`, userId, operationId,
            role: 'student',
            studentId: String(payload.student_id || student?.student_id || ''),
            studentNumber: result.student_number || student?.student_number || '',
            name: student ? [student.last_name, student.first_name, student.middle_initial ? `${String(student.middle_initial).replace(/\.$/, '')}.` : ''].filter(Boolean).join(', ') : '',
            temporaryPassword: result.temporary_password,
            delivery: result.delivery,
            email: result.email || '',
            emailAvailable: Boolean(result.email_available),
            emailError: result.email_error || '',
            createdAt: new Date().toISOString()
        };
        await writeAdminHistoryRecord(adminPasswordResetResultsStoreName, record);
        window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
    }

    async function saveAdminTeacherPasswordResetResult(userId, operationId, payload, result) {
        const lookups = await getAdminAccountLookups(null, userId);
        const teacher = (lookups?.teachers || []).find(item => String(item.teacher_id) === String(payload.teacher_id)
            || String(item.teacher_number) === String(payload.teacher_number));
        const record = {
            key: `${userId}:${operationId}`, userId, operationId, role: 'teacher',
            teacherId: String(payload.teacher_id || ''), studentId: '',
            studentNumber: result.teacher_number || teacher?.teacher_number || '',
            name: teacher ? [teacher.last_name, teacher.first_name, teacher.middle_initial ? `${String(teacher.middle_initial).replace(/\.$/, '')}.` : ''].filter(Boolean).join(', ') : '',
            temporaryPassword: result.temporary_password,
            delivery: result.delivery,
            email: result.email || '',
            emailAvailable: Boolean(result.email),
            emailError: result.email_error || '',
            createdAt: new Date().toISOString()
        };
        await writeAdminHistoryRecord(adminPasswordResetResultsStoreName, record);
        window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
    }

    async function saveAdminDeletionResult(userId, operationId, payload, result, status = 'Deleted') {
        const isBulkCleanup = Boolean(payload.scope);
        const record = {
            key: `${userId}:${operationId}`,
            userId,
            operationId,
            role: payload.account_role === 'teacher' || result.teacher_id ? 'teacher' : 'student',
            studentNumber: isBulkCleanup
                ? 'Bulk cleanup'
                : String(result.student_number || result.teacher_number || payload.student_number || payload.teacher_number || payload.student_id || payload.teacher_id || ''),
            name: isBulkCleanup
                ? payload.scope === 'unassigned' ? 'Unassigned student accounts' : 'Graduate sections and students'
                : [result.last_name || payload.last_name, result.first_name || payload.first_name, result.middle_initial || payload.middle_initial]
                    .filter(Boolean).join(', '),
            status,
            deletedAt: new Date().toISOString()
        };
        await writeAdminHistoryRecord(adminDeletionResultsStoreName, record);
        window.dispatchEvent(new CustomEvent('admin-deletion-data-changed'));
    }

    async function recordAdminLocalDeletion(client, operationId, payload, status = 'Removed before sync') {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before recording the deletion.');
        await saveAdminDeletionResult(userId, operationId, payload, {
            student_number: payload.student_number || payload.student_id,
            first_name: payload.first_name,
            middle_initial: payload.middle_initial,
            last_name: payload.last_name
        }, status);
    }

    async function getAdminDeletionData(client) {
        const userId = await getUserId(client);
        if (!userId) return { queued: [], completed: [] };
        const [allQueued, allCompleted] = await Promise.all([
            adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll()),
            adminStoreRequest(adminDeletionResultsStoreName, 'readonly', store => store.getAll())
        ]);
        const userResults = allCompleted.filter(item => item.userId === userId);
        const clearMarker = userResults.find(item => item.recordType === 'clear-marker');
        const hiddenOperationIds = new Set(clearMarker?.hiddenOperationIds || []);
        const hiddenResults = userResults.filter(item => item.recordType !== 'clear-marker'
            && hiddenOperationIds.has(item.operationId));
        const hiddenQueue = allQueued.filter(item => item.userId === userId
            && ['admin-delete', 'admin-bulk-delete'].includes(item.action)
            && hiddenOperationIds.has(item.operationId));
        await Promise.all([
            ...hiddenResults.map(item => adminStoreRequest(adminDeletionResultsStoreName, 'readwrite', store => store.delete(item.key))),
            ...hiddenQueue.map(item => adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(item.key)))
        ]);
        return {
            queued: allQueued.filter(item => item.userId === userId
                && ['admin-delete', 'admin-bulk-delete'].includes(item.action)
                && !hiddenOperationIds.has(item.operationId))
                .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt)),
            completed: userResults.filter(item => item.recordType !== 'clear-marker'
                && !hiddenOperationIds.has(item.operationId))
                .sort((first, second) => Date.parse(second.deletedAt) - Date.parse(first.deletedAt))
        };
    }

    async function clearAdminDeletionResults(client) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before clearing deletion history.');
        const cleared = await clearAdminHistory(adminDeletionResultsStoreName, userId, ['admin-delete', 'admin-bulk-delete']);
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-deletion-data-changed'));
        return cleared;
    }

    async function submitAdminPasswordReset(client, studentId, functionUrl, anonKey) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in while connected before resetting a student password.');
        const operationId = createOperationId();
        const payload = { student_id: Number(studentId) };
        if (!navigator.onLine) {
            const createdAt = await nextAdminQueueTimestamp(userId);
            await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
                key: `${userId}:${operationId}`, userId, operationId, role: 'student', action: 'admin-reset', payload,
                functionUrl, anonKey, createdAt, lastError: null
            }));
            setNotice('Student password reset saved on this device. It will run when connected.', true, 'sync');
            window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
            window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
            return { queued: true, operationId };
        }

        const { data: { session } } = await client.auth.getSession();
        if (!session) throw new Error('Please sign in again as an administrator.');
        const response = await fetch(functionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ action: 'admin-reset', operation_id: operationId, ...payload })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Password reset failed.');
        await saveAdminPasswordResetResult(userId, operationId, payload, result);
        return result;
    }

    async function queuePasswordResetForPendingStudent(client, studentNumber, functionUrl, anonKey) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in while connected before resetting a student password.');
        if (!studentNumber || navigator.onLine) {
            throw new Error('This password reset can only be queued for a pending student while offline.');
        }
        const operationId = createOperationId();
        const createdAt = await nextAdminQueueTimestamp(userId);
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
            key: `${userId}:${operationId}`, userId, operationId, role: 'student', action: 'admin-reset',
            payload: { student_number: String(studentNumber) }, functionUrl, anonKey, createdAt, lastError: null
        }));
        setNotice('Student password reset saved on this device. It will run after the student account is created.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
        return { queued: true, operationId };
    }

    async function getAdminPasswordResetData(client) {
        const userId = await getUserId(client);
        if (!userId) return { queued: [], completed: [] };
        const [allQueued, allCompleted] = await Promise.all([
            adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll()),
            adminStoreRequest(adminPasswordResetResultsStoreName, 'readonly', store => store.getAll())
        ]);
        const userResults = allCompleted.filter(item => item.userId === userId);
        const clearMarker = userResults.find(item => item.recordType === 'clear-marker');
        const hiddenOperationIds = new Set(clearMarker?.hiddenOperationIds || []);
        const hiddenResults = userResults.filter(item => item.recordType !== 'clear-marker'
            && hiddenOperationIds.has(item.operationId));
        const hiddenQueue = allQueued.filter(item => item.userId === userId && item.action === 'admin-reset'
            && hiddenOperationIds.has(item.operationId));
        await Promise.all([
            ...hiddenResults.map(item => adminStoreRequest(adminPasswordResetResultsStoreName, 'readwrite', store => store.delete(item.key))),
            ...hiddenQueue.map(item => adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(item.key)))
        ]);
        return {
            queued: allQueued.filter(item => item.userId === userId && item.action === 'admin-reset'
                && !hiddenOperationIds.has(item.operationId))
                .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt)),
            completed: userResults.filter(item => item.recordType !== 'clear-marker'
                && !hiddenOperationIds.has(item.operationId))
                .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))
        };
    }

    async function saveAdminAccountLookups(client, userId = null) {
        try {
            userId = userId || await getUserId(client);
            if (!userId) return;
            const [departmentsResult, majorsResult, sectionsResult, semestersResult, subjectsResult, teacherAssignmentsResult, teachersResult, teacherSectionsResult] = await Promise.all([
                client.from('departments').select('department_id, department_name').order('department_name'),
                client.from('majors').select('major_id, department_id, major_name').order('major_name'),
                client.from('sections').select('section_id, major_id, year_level, section_name').order('section_name'),
                client.from('semesters').select('semester_id, semester_name, is_active').order('semester_id'),
                client.from('subjects').select('subject_id, subject_code, subject_name, major_id, semester_id, year_level, semesters(semester_name)').order('subject_name'),
                client.from('teacher_subject_assignments').select('assignment_id, teacher_id, subject_id, teachers(first_name,middle_initial,last_name,teacher_number), subjects(subject_name,subject_code,major_id,year_level)').order('assignment_id'),
                client.from('teachers').select('teacher_id, user_id, teacher_number, first_name, middle_initial, last_name, users!teachers_user_id_fkey(email)').order('last_name'),
                client.from('teacher_section_assignments').select('teacher_section_id, assignment_id, section_id, sections(section_name)')
            ]);
            const lookupError = departmentsResult.error || majorsResult.error || sectionsResult.error || semestersResult.error || subjectsResult.error || teacherAssignmentsResult.error || teachersResult.error || teacherSectionsResult.error;
            if (lookupError) throw lookupError;

            const students = [];
            const pageSize = 1000;
            for (let offset = 0; ; offset += pageSize) {
                const { data, error } = await client.from('students').select(`
                    student_id,
                    student_number,
                    first_name,
                    middle_initial,
                    last_name,
                    gender,
                    section_id,
                    graduated_at,
                    users!students_user_id_fkey (
                        user_id,
                        email,
                        onboarding_required
                    )
                `).order('student_id').range(offset, offset + pageSize - 1);
                if (error) throw error;
                students.push(...(data || []));
                if (!data || data.length < pageSize) break;
            }

            await adminStoreRequest(adminLookupStoreName, 'readwrite', store => store.put({
                key: `${userId}:lookups`, userId,
                departments: departmentsResult.data || [], majors: majorsResult.data || [], sections: sectionsResult.data || [],
                semesters: semestersResult.data || [], subjects: subjectsResult.data || [],
                teacherAssignments: teacherAssignmentsResult.data || [],
                teachers: teachersResult.data || [], teacherSections: teacherSectionsResult.data || [],
                savedAt: new Date().toISOString()
            }));
            await adminStoreRequest(adminLookupStoreName, 'readwrite', store => store.put({
                key: `${userId}:all-students`, userId, students, savedAt: new Date().toISOString()
            }));
        } catch (error) {
            console.warn('Could not cache admin account dropdown data.', error);
        }
    }

    async function refreshAdminAccountLookupsIfStale(client, userId) {
        const [lookups, studentRoster] = await Promise.all([
            getAdminAccountLookups(client, userId),
            getAdminStudentRoster(client, userId)
        ]);
        const maxAgeMs = 5 * 60 * 1000;
        const isFresh = record => {
            const savedAt = Date.parse(record?.savedAt || '');
            return Number.isFinite(savedAt) && Date.now() - savedAt < maxAgeMs;
        };
        if (isFresh(lookups) && isFresh(studentRoster)) return false;
        await saveAdminAccountLookups(client, userId);
        return true;
    }

    async function refreshAdminTeacherLookups(client, userId = null) {
        userId = userId || await getUserId(client);
        if (!userId) return;
        const { data: teachers, error } = await client.from('teachers')
            .select('teacher_id, user_id, teacher_number, first_name, middle_initial, last_name, users!teachers_user_id_fkey(email)')
            .order('last_name');
        if (error) throw error;
        const lookups = await getAdminAccountLookups(client, userId);
        if (!lookups) return;
        await adminStoreRequest(adminLookupStoreName, 'readwrite', store => store.put({
            ...lookups, teachers: teachers || [], savedAt: new Date().toISOString()
        }));
    }

    async function getAdminAccountLookups(client, suppliedUserId = null) {
        const userId = suppliedUserId || await getUserId(client);
        if (!userId) return null;
        return await adminStoreRequest(adminLookupStoreName, 'readonly', store => store.get(`${userId}:lookups`)) || null;
    }

    async function saveAdminStudentSection(client, sectionId, students) {
        const userId = await getUserId(client);
        if (!userId || !sectionId) return;
        await adminStoreRequest(adminLookupStoreName, 'readwrite', store => store.put({
            key: `${userId}:students:${sectionId}`, userId, sectionId: String(sectionId), students,
            savedAt: new Date().toISOString()
        }));
    }

    async function getAdminStudentSection(client, sectionId) {
        const userId = await getUserId(client);
        if (!userId || !sectionId) return null;
        const allStudents = await adminStoreRequest(adminLookupStoreName, 'readonly', store => store.get(`${userId}:all-students`));
        if (allStudents?.students) {
            return {
                sectionId: String(sectionId),
                students: allStudents.students.filter(student => String(student.section_id) === String(sectionId)),
                savedAt: allStudents.savedAt
            };
        }
        return await adminStoreRequest(adminLookupStoreName, 'readonly', store => store.get(`${userId}:students:${sectionId}`)) || null;
    }

    async function getAdminStudentRoster(client, suppliedUserId = null) {
        const userId = suppliedUserId || await getUserId(client);
        if (!userId) return null;
        return await adminStoreRequest(adminLookupStoreName, 'readonly', store => store.get(`${userId}:all-students`)) || null;
    }

    async function cacheSystemLogEntries(client, logs) {
        const userId = await getUserId(client);
        if (!userId || !Array.isArray(logs) || !logs.length) return [];
        const records = logs.map(log => ({
            key: `${userId}:${log.log_id || log.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`}:${log.created_at || new Date().toISOString()}`,
            userId,
            log_id: log.log_id || log.id || null,
            activity: log.activity || 'System activity',
            created_at: log.created_at || new Date().toISOString()
        }));
        await adminStoreRequest(adminSystemLogStoreName, 'readwrite', store => {
            let firstRequest = null;
            records.forEach(record => {
                const request = store.put(record);
                if (!firstRequest) firstRequest = request;
            });
            return firstRequest;
        });
        return records;
    }

    async function getCachedSystemLogs(client) {
        const userId = await getUserId(client);
        if (!userId) return [];
        const records = await adminStoreRequest(adminSystemLogStoreName, 'readonly', store => store.getAll());
        const userRecords = (records || []).filter(record => record.userId === userId);
        if (userRecords.some(record => record.recordType === 'system-log-delete-request')) return [];
        return userRecords
            .filter(record => record.recordType !== 'system-log-cache-state')
            .filter(record => !String(record.log_id || '').startsWith('pending:'))
            .sort((first, second) => Date.parse(second.created_at || 0) - Date.parse(first.created_at || 0));
    }

    async function queueSystemLogDeleteAll(client) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in before queuing activity-log deletion.');
        const records = await adminStoreRequest(adminSystemLogStoreName, 'readonly', store => store.getAll());
        const userKeys = (records || []).filter(record => record.userId === userId).map(record => record.key);
        const requestedAt = new Date().toISOString();
        await adminStoreRequest(adminSystemLogStoreName, 'readwrite', store => {
            userKeys.forEach(key => store.delete(key));
            return store.put({
                key: `${userId}:__delete_all_request__`,
                userId,
                recordType: 'system-log-delete-request',
                requestedAt
            });
        });
        return { requestedAt };
    }

    async function hasQueuedSystemLogDeleteAll(client) {
        const userId = await getUserId(client);
        if (!userId) return false;
        const request = await adminStoreRequest(
            adminSystemLogStoreName,
            'readonly',
            store => store.get(`${userId}:__delete_all_request__`)
        );
        return Boolean(request);
    }

    async function syncQueuedSystemLogDeleteAll(client) {
        const userId = await getUserId(client);
        if (!userId || !navigator.onLine) return false;
        const request = await adminStoreRequest(
            adminSystemLogStoreName,
            'readonly',
            store => store.get(`${userId}:__delete_all_request__`)
        );
        if (!request) return false;

        const { error: deleteError } = await client.from('activity_logs')
            .delete()
            .neq('log_id', 0);
        if (deleteError) throw deleteError;

        const { error: resetError } = await client.rpc('reset_activity_logs_id');
        if (resetError) throw resetError;

        await clearCachedSystemLogs(client);
        return true;
    }

    async function getSystemLogCacheState(client) {
        const userId = await getUserId(client);
        if (!userId) return null;
        return await adminStoreRequest(
            adminSystemLogStoreName,
            'readonly',
            store => store.get(`${userId}:__sync_state__`)
        ) || null;
    }

    async function saveSystemLogCacheState(client, state) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in before saving the offline log sync checkpoint.');
        return await adminStoreRequest(
            adminSystemLogStoreName,
            'readwrite',
            store => store.put({
                key: `${userId}:__sync_state__`,
                userId,
                recordType: 'system-log-cache-state',
                lastLogId: String(state.lastLogId || '0'),
                completed: Boolean(state.completed),
                totalCount: Number.isFinite(Number(state.totalCount)) ? Number(state.totalCount) : null,
                cachedCount: Number.isFinite(Number(state.cachedCount)) ? Number(state.cachedCount) : null,
                updatedAt: new Date().toISOString()
            })
        );
    }

    async function clearCachedSystemLogs(client) {
        const userId = await getUserId(client);
        if (!userId) return false;
        const records = await adminStoreRequest(adminSystemLogStoreName, 'readonly', store => store.getAll());
        const keysToDelete = (records || []).filter(record => record.userId === userId)
            .map(record => record.key);
        await adminStoreRequest(adminSystemLogStoreName, 'readwrite', store => {
            keysToDelete.forEach(key => store.delete(key));
            return null;
        });
        return true;
    }

    async function queueAdminStructureOperation(client, type, payload) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in while connected before making offline admin changes.');
        const createdAt = await nextAdminQueueTimestamp(userId);
        const operationId = createOperationId();
        const localRef = ['department_add', 'major_add', 'section_add', 'subject_add', 'teacher_subject_assign', 'teacher_section_assign'].includes(type)
            ? `local:${operationId}`
            : null;
        await adminStoreRequest(adminStructureQueueStoreName, 'readwrite', store => store.put({
            key: `${userId}:${operationId}`, userId, operationId, localRef, type, payload,
            createdAt, lastError: null
        }));
        setNotice('Admin change saved on this device. It will apply when connected.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-structure-data-changed'));
        return { operationId, localRef };
    }

    async function queueAdminStructureDelete(client, type, recordId) {
        if (recordId === null || recordId === undefined) throw new Error('Choose an item to delete.');
        const idFields = {
            department_delete: 'department_id',
            major_delete: 'major_id',
            section_delete: 'section_id',
            subject_delete: 'subject_id'
        };
        const idField = idFields[type];
        if (!idField) throw new Error('This delete action is not supported offline.');
        return queueAdminStructureOperation(client, type, { [idField]: String(recordId) });
    }

    async function cancelQueuedAdminSubject(client, localSubjectRef) {
        const userId = await getUserId(client);
        if (!userId || !String(localSubjectRef).startsWith('local:')) {
            throw new Error('Only a subject that has not synced can be canceled here.');
        }
        const { pending } = await getAdminStructureData(client);
        const subjectOperation = pending.find(item => item.type === 'subject_add' && item.localRef === localSubjectRef);
        if (!subjectOperation) throw new Error('The unsynced subject could not be found.');
        const relatedOperations = pending.filter(item =>
            item.operationId === subjectOperation.operationId
            || String(item.payload.subject_id || '') === String(localSubjectRef)
        );
        await Promise.all(relatedOperations.map(item => adminStoreRequest(
            adminStructureQueueStoreName,
            'readwrite',
            store => store.delete(item.key)
        )));
        window.dispatchEvent(new CustomEvent('admin-structure-data-changed'));
        return true;
    }

    async function clearAdminPasswordResetResults(client) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before clearing saved reset results.');
        const cleared = await clearAdminHistory(adminPasswordResetResultsStoreName, userId, ['admin-reset']);
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
        return cleared;
    }

    async function discardQueuedAdminAccountOperation(client, operationId) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before managing saved offline operations.');
        const key = `${userId}:${operationId}`;
        const item = await adminStoreRequest(adminQueueStoreName, 'readonly', store => store.get(key));
        if (!item || item.userId !== userId) throw new Error('This saved operation was not found.');
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(key));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        return true;
    }

    async function getAdminStructureData(client) {
        const userId = await getUserId(client);
        if (!userId) return { lookups: null, pending: [] };
        const [lookups, allPending] = await Promise.all([
            getAdminAccountLookups(client, userId),
            adminStoreRequest(adminStructureQueueStoreName, 'readonly', store => store.getAll())
        ]);
        const pending = allPending.filter(item => item.userId === userId)
            .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
        return { lookups, pending };
    }

    async function clearAdminStructureQueue(client) {
        const userId = await getUserId(client);
        if (!userId) return;
        const { pending } = await getAdminStructureData(client);
        await Promise.all(pending.map(item => adminStoreRequest(
            adminStructureQueueStoreName,
            'readwrite',
            store => store.delete(item.key)
        )));
        window.dispatchEvent(new CustomEvent('admin-structure-data-changed'));
    }

    async function getAdminStructureIdMap(userId) {
        const mappings = await adminStoreRequest(adminStructureMapStoreName, 'readonly', store => store.getAll());
        return new Map(mappings.filter(item => item.userId === userId).map(item => [item.localRef, item.realId]));
    }

    async function getAdminStructureLocalIdMap(client) {
        const userId = await getUserId(client);
        return userId ? await getAdminStructureIdMap(userId) : new Map();
    }

    async function syncAdminStructureQueue(client, operationId = null) {
        if (!navigator.onLine || window.adminStructureSyncInProgress) return;
        window.adminStructureSyncInProgress = true;
        let currentOperation = null;
        try {
            const userId = await getUserId(client);
            if (!userId) return;
            const { pending: allPending } = await getAdminStructureData(client);
            const pending = operationId ? allPending.filter(item => item.operationId === operationId) : allPending;
            const idMap = await getAdminStructureIdMap(userId);
            for (const operation of pending) {
                if (!navigator.onLine) break;
                currentOperation = operation;
                const payload = { ...operation.payload, type: operation.type };
                for (const field of ['department_id', 'major_id', 'semester_id', 'teacher_id', 'subject_id', 'section_id', 'assignment_id', 'teacher_section_id']) {
                    const value = payload[field];
                    if (typeof value === 'string' && value.startsWith('local:')) {
                        if (!idMap.has(value)) throw new Error(`An earlier queued ${field.replace('_id', '')} is still waiting to sync.`);
                        payload[field] = idMap.get(value);
                    }
                }
                if (typeof payload.assignment_id === 'string' && payload.assignment_id.startsWith('local-assignment:')) {
                    if (!idMap.has(payload.assignment_id)) throw new Error('The teacher-to-subject assignment is still waiting to sync.');
                    payload.assignment_id = idMap.get(payload.assignment_id);
                }

                const { data, error } = await client.rpc('sync_admin_offline_operation', {
                    p_operation_id: operation.operationId,
                    p_payload: payload
                });
                if (error) {
                    await adminStoreRequest(adminStructureQueueStoreName, 'readwrite', store => store.put({ ...operation, lastError: error.message }));
                    setNotice(`An admin change is still waiting to apply. ${error.message || 'It remains saved and will retry.'}`, true, 'sync');
                    window.setTimeout(() => {
                        if (navigator.onLine && window.currentOfflineRole === 'admin') {
                            void syncAdminQueues(client);
                        }
                    }, 15000);
                    break;
                }
                if (operation.localRef && data?.record_id !== undefined) {
                    const mapping = { key: `${userId}:${operation.localRef}`, userId, localRef: operation.localRef, realId: data.record_id };
                    await adminStoreRequest(adminStructureMapStoreName, 'readwrite', store => store.put(mapping));
                    idMap.set(operation.localRef, data.record_id);
                }
                if (operation.type === 'teacher_subject_assign' && data?.record_id !== undefined) {
                    const mappingRef = operation.localRef || `local:${operation.operationId}`;
                    const mapping = { key: `${userId}:${mappingRef}`, userId, localRef: mappingRef, realId: data.record_id };
                    await adminStoreRequest(adminStructureMapStoreName, 'readwrite', store => store.put(mapping));
                    idMap.set(mappingRef, data.record_id);
                }
                await adminStoreRequest(adminStructureQueueStoreName, 'readwrite', store => store.delete(operation.key));
                currentOperation = null;
            }
            const remaining = await getAdminStructureData(client);
            if (!remaining.pending.length && pending.length) {
                setNotice('Saved admin changes have been applied.', true, 'ready');
                await saveAdminAccountLookups(client, userId);
            }
            window.dispatchEvent(new CustomEvent('admin-structure-data-changed'));
        } catch (error) {
            console.warn('Unable to sync queued admin structure changes.', error);
            if (currentOperation) {
                await adminStoreRequest(adminStructureQueueStoreName, 'readwrite', store => store.put({
                    ...currentOperation,
                    lastError: error?.message || 'Unable to apply this change.'
                }));
            }
            const reason = error?.message || 'The change remains saved and will retry.';
            setNotice(`An admin change is still waiting to apply: ${reason}`, true, 'sync');
            window.setTimeout(() => {
                if (navigator.onLine && window.currentOfflineRole === 'admin') {
                    void syncAdminQueues(client);
                }
            }, 15000);
        } finally {
            window.adminStructureSyncInProgress = false;
        }
    }

    async function submitAdminAccountCreation(client, role, payload, functionUrl, anonKey) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in while connected before creating an account offline.');
        const operationId = createOperationId();
        if (!navigator.onLine) {
            const createdAt = await nextAdminQueueTimestamp(userId);
            await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
                key: `${userId}:${operationId}`, userId, operationId, role, payload,
                functionUrl, anonKey, createdAt, lastError: null
            }));
            setNotice(`${role === 'student' ? 'Student' : 'Teacher'} account saved on this device. It will be created when you are online.`, true, 'sync');
            window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
            return { queued: true, operationId };
        }

        const { data: { session } } = await client.auth.getSession();
        if (!session) throw new Error('Please sign in again as an administrator.');
        const response = await fetch(functionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ action: 'admin-create', operation_id: operationId, ...payload })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Account creation failed.');
        await saveAdminAccountResult(userId, operationId, role, payload, result);
        if (role === 'teacher') await refreshAdminTeacherLookups(client, userId);
        return result;
    }

    async function submitAdminAccountDeletion(client, payload, functionUrl, anonKey) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before deleting a student account.');
        const operationId = createOperationId();
        if (!navigator.onLine) {
            const createdAt = await nextAdminQueueTimestamp(userId);
            await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
                key: `${userId}:${operationId}`, userId, operationId, role: 'student', action: 'admin-delete', payload,
                functionUrl, anonKey, createdAt, lastError: null
            }));
            setNotice('Student account deletion saved on this device. It will run when connected.', true, 'sync');
            window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
            return { queued: true, operationId };
        }

        const result = await performAdminStudentDeletion(client, payload, anonKey);
        await saveAdminDeletionResult(userId, operationId, payload, result);
        await removeAdminAccountResult(client, payload.student_number || result.student_number);
        await removeAdminStudentFromLocalRosters(client, result.student_id || payload.student_id, result.student_number || payload.student_number);
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        return result;
    }

    async function submitAdminTeacherOperation(client, action, payload, functionUrl, anonKey) {
        if (!['admin-edit', 'admin-reset', 'admin-delete'].includes(action)) {
            throw new Error('This teacher account action is not supported.');
        }
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before changing a teacher account.');
        const allQueued = action === 'admin-edit'
            ? await adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll())
            : [];
        const existing = allQueued.filter(item => item.userId === userId && item.role === 'teacher'
            && item.action === action && String(item.payload.teacher_id) === String(payload.teacher_id))
            .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))[0];
        const operationId = action === 'admin-edit' ? existing?.operationId || createOperationId() : createOperationId();
        if (!navigator.onLine) {
            if (action === 'admin-delete' && !payload.teacher_id) throw new Error('The teacher ID is required for deletion.');
            const createdAt = existing?.createdAt || await nextAdminQueueTimestamp(userId);
            await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
                ...(existing || {}), key: `${userId}:${operationId}`, userId, operationId,
                role: 'teacher', action, payload, functionUrl, anonKey, createdAt,
                updatedAt: new Date().toISOString(), lastError: null
            }));
            setNotice(`Teacher ${action === 'admin-edit' ? 'edit' : action === 'admin-reset' ? 'password reset' : 'deletion'} saved on this device. It will run when connected.`, true, 'sync');
            window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
            if (action === 'admin-reset') window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
            if (action === 'admin-delete') window.dispatchEvent(new CustomEvent('admin-deletion-data-changed'));
            return { queued: true, operationId };
        }

        const { data: { session } } = await client.auth.getSession();
        if (!session) throw new Error('Please sign in again as an administrator.');
        const response = await fetch(functionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ action, operation_id: operationId, ...payload })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Teacher ${action.replace('admin-', '')} failed.`);
        if (action === 'admin-reset') await saveAdminTeacherPasswordResetResult(userId, operationId, payload, result);
        if (action === 'admin-delete') {
            await saveAdminDeletionResult(userId, operationId, payload, result);
            await removeAdminAccountResult(client, result.teacher_number || payload.teacher_number, 'teacher');
        }
        if (action === 'admin-edit' || action === 'admin-delete') await refreshAdminTeacherLookups(client, userId);
        if (action === 'admin-edit') await updateAdminTeacherAccountResult(client, payload.teacher_id, payload);
        return result;
    }

    async function queueAdminBulkDeletion(client, scope, functionUrl, anonKey) {
        if (!['unassigned', 'graduated'].includes(scope)) {
            throw new Error('Choose an approved student cleanup scope.');
        }
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before scheduling student cleanup.');
        if (navigator.onLine) throw new Error('A connected cleanup should run immediately, not be queued.');
        const operationId = createOperationId();
        const createdAt = await nextAdminQueueTimestamp(userId);
        const payload = { scope };
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
            key: `${userId}:${operationId}`, userId, operationId, role: 'student',
            action: 'admin-bulk-delete', payload, functionUrl, anonKey, createdAt, lastError: null
        }));
        setNotice('Scoped student cleanup saved on this device. It will run when connected.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-deletion-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-structure-data-changed'));
        return { queued: true, operationId };
    }

    async function queueAdminStudentEdit(client, payload, functionUrl, anonKey) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in while connected before making offline student edits.');
        const allQueued = await adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll());
        const existing = allQueued
            .filter(item => item.userId === userId && item.action === 'admin-edit' && String(item.payload.student_id) === String(payload.student_id))
            .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt))[0];
        const operationId = existing?.operationId || createOperationId();
        const createdAt = existing?.createdAt || await nextAdminQueueTimestamp(userId);
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
            ...(existing || {}),
            key: `${userId}:${operationId}`, userId, operationId, role: 'student', action: 'admin-edit', payload,
            functionUrl, anonKey, createdAt, updatedAt: new Date().toISOString(), lastError: null
        }));
        setNotice('Student edit saved on this device. It will apply when connected.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-student-data-changed'));
        return { queued: true, operationId };
    }

    async function updateQueuedAdminStudentCreation(client, operationId, payload) {
        const userId = await getUserId(client);
        if (!userId || navigator.onLine) throw new Error('Queued student accounts can only be edited while offline.');
        const key = `${userId}:${operationId}`;
        const queuedItem = await adminStoreRequest(adminQueueStoreName, 'readonly', store => store.get(key));
        if (!queuedItem || queuedItem.role !== 'student' || (queuedItem.action || 'admin-create') !== 'admin-create') {
            throw new Error('This queued student account could not be found.');
        }
        if (queuedItem.processing || queuedItem.lastError) {
            throw new Error('This account request has already started syncing. Reconnect and resolve its sync status before editing it.');
        }
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
            ...queuedItem, payload, updatedAt: new Date().toISOString()
        }));
        setNotice('Queued student details updated on this device.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-student-data-changed'));
        return true;
    }

    async function updateQueuedAdminTeacherCreation(client, operationId, payload) {
        const userId = await getUserId(client);
        if (!userId || navigator.onLine) throw new Error('Queued teacher accounts can only be edited while offline.');
        const key = `${userId}:${operationId}`;
        const queuedItem = await adminStoreRequest(adminQueueStoreName, 'readonly', store => store.get(key));
        if (!queuedItem || queuedItem.role !== 'teacher' || (queuedItem.action || 'admin-create') !== 'admin-create') {
            throw new Error('This queued teacher account could not be found.');
        }
        if (queuedItem.processing || queuedItem.lastError) {
            throw new Error('This account request has started syncing. Reconnect and resolve its sync status before editing it.');
        }
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
            ...queuedItem, payload, updatedAt: new Date().toISOString()
        }));
        setNotice('Queued teacher details updated on this device.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        return true;
    }

    async function queuePasswordResetForPendingTeacher(client, teacherNumber, functionUrl, anonKey) {
        const userId = await getUserId(client);
        if (!userId || !teacherNumber || navigator.onLine) {
            throw new Error('This password reset can only be queued for a pending teacher while offline.');
        }
        const operationId = createOperationId();
        const createdAt = await nextAdminQueueTimestamp(userId);
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
            key: `${userId}:${operationId}`, userId, operationId, role: 'teacher', action: 'admin-reset',
            payload: { teacher_number: String(teacherNumber) }, functionUrl, anonKey, createdAt, lastError: null
        }));
        setNotice('Teacher password reset saved on this device. It will run after the teacher account is created.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
        return { queued: true, operationId };
    }

    async function getAdminAccountData(client) {
        const userId = await getUserId(client);
        if (!userId) return { queued: [], completed: [] };
        const [allQueued, allCompleted, allPasswordResets] = await Promise.all([
            adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll()),
            adminStoreRequest(adminResultsStoreName, 'readonly', store => store.getAll()),
            adminStoreRequest(adminPasswordResetResultsStoreName, 'readonly', store => store.getAll())
        ]);
        return {
                queued: allQueued.filter(item => item.userId === userId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
            completed: allCompleted.filter(item => item.userId === userId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
            passwordResets: allPasswordResets.filter(item => item.userId === userId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        };
    }

    async function discardQueuedAdminAccountRequest(client, operationId) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before managing saved account requests.');
        const key = `${userId}:${operationId}`;
        const queuedItem = await adminStoreRequest(adminQueueStoreName, 'readonly', store => store.get(key));
        if (!queuedItem || queuedItem.userId !== userId) throw new Error('This saved account request was not found.');
        const accountNumber = String(queuedItem.role === 'teacher'
            ? queuedItem.payload?.teacher_number || ''
            : queuedItem.payload?.student_number || '');
        const relatedStudentIds = new Set();
        if (accountNumber && queuedItem.role === 'student') {
            const roster = await getAdminStudentRoster(client, userId);
            (roster?.students || []).filter(student => String(student.student_number) === accountNumber)
                .forEach(student => relatedStudentIds.add(String(student.student_id)));
        }
        const [allAccountOperations, allStructureOperations] = await Promise.all([
            adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll()),
            adminStoreRequest(adminStructureQueueStoreName, 'readonly', store => store.getAll())
        ]);
        const relatedAccountOperations = allAccountOperations.filter(item => item.userId === userId
            && item.key !== key
            && item.role === queuedItem.role
            && item.action === 'admin-reset'
            && String(item.role === 'teacher' ? item.payload?.teacher_number || '' : item.payload?.student_number || '') === accountNumber);
        const relatedStructureOperations = allStructureOperations.filter(item => {
            if (queuedItem.role !== 'student' || item.userId !== userId
                || !['student_section_assign', 'student_section_unassign'].includes(item.type)) return false;
            const numberMatch = (item.payload?.student_numbers || []).map(String).includes(accountNumber);
            const idMatch = (item.payload?.student_ids || []).some(studentId => relatedStudentIds.has(String(studentId)));
            return numberMatch || idMatch;
        });
        await Promise.all([
            adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(key)),
            ...relatedAccountOperations.map(item => adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(item.key))),
            ...relatedStructureOperations.map(item => adminStoreRequest(adminStructureQueueStoreName, 'readwrite', store => store.delete(item.key)))
        ]);
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        if (relatedStructureOperations.length) window.dispatchEvent(new CustomEvent('admin-structure-data-changed'));
        if (relatedAccountOperations.length) window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
        return true;
    }

    async function clearAdminAccountResults(client) {
        const userId = await getUserId(client);
        if (!userId) return;
        const allResults = await adminStoreRequest(adminResultsStoreName, 'readonly', store => store.getAll());
        const allResetResults = await adminStoreRequest(adminPasswordResetResultsStoreName, 'readonly', store => store.getAll());
        await Promise.all(allResults.filter(item => item.userId === userId).map(item =>
            adminStoreRequest(adminResultsStoreName, 'readwrite', store => store.delete(item.key))));
        await Promise.all(allResetResults.filter(item => item.userId === userId).map(item =>
            adminStoreRequest(adminPasswordResetResultsStoreName, 'readwrite', store => store.delete(item.key))));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
    }

    async function syncAdminAccountQueue(client, operationId = null) {
        if (!navigator.onLine || window.adminAccountSyncInProgress || window.adminHistoryClearInProgress) return;
        window.adminAccountSyncInProgress = true;
        try {
            const userId = await getUserId(client);
            if (!userId) return;
            const { queued: allQueued } = await getAdminAccountData(client);
            const queued = operationId ? allQueued.filter(item => item.operationId === operationId) : allQueued;
            for (const item of queued) {
                if (!navigator.onLine) break;
                const { data: { session } } = await client.auth.getSession();
                if (!session) return;
                try {
                    const payload = { ...item.payload };
                    if ((item.action || 'admin-create') === 'admin-create' || item.action === 'admin-edit') {
                        const idMap = await getAdminStructureIdMap(userId);
                        for (const field of ['department_id', 'major_id', 'section_id']) {
                            const value = payload[field];
                            if (typeof value !== 'string' || !value.startsWith('local:')) continue;
                            if (!idMap.has(value)) throw new Error(`The selected ${field.replace('_id', '')} is still waiting to sync. This account request will retry automatically.`);
                            payload[field] = idMap.get(value);
                        }
                    }
                    if (item.role === 'teacher' && item.action === 'admin-reset'
                        && !payload.teacher_id && payload.teacher_number) {
                        const { data: teacher, error: teacherError } = await client.from('teachers')
                            .select('teacher_id').eq('teacher_number', payload.teacher_number).maybeSingle();
                        if (teacherError || !teacher) throw new Error(teacherError?.message || 'The queued teacher account is not available yet.');
                        payload.teacher_id = teacher.teacher_id;
                    }
                    let result;
                    if (item.action === 'admin-delete' && item.role === 'student') {
                        result = await performAdminStudentDeletion(client, payload, item.anonKey);
                    } else if (item.role === 'teacher' && item.action === 'admin-delete') {
                        const response = await fetch(item.functionUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', apikey: item.anonKey, Authorization: `Bearer ${session.access_token}` },
                            body: JSON.stringify({
                                action: 'admin-delete',
                                teacher_id: Number(item.payload.teacher_id),
                                user_id: String(item.payload.user_id || ''),
                                teacher_number: String(item.payload.teacher_number || '')
                            })
                        });
                        result = await response.json().catch(() => ({}));
                        if (!response.ok) throw new Error(result.error || 'Teacher account deletion failed.');
                    } else if (item.action === 'admin-bulk-delete') {
                        const response = await fetch(item.functionUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                apikey: item.anonKey,
                                Authorization: `Bearer ${session.access_token}`
                            },
                            body: JSON.stringify({ scope: item.payload.scope })
                        });
                        result = await response.json().catch(() => ({}));
                        if (!response.ok) throw new Error(result.error || 'Scoped student cleanup failed.');
                    } else {
                        const response = await fetch(item.functionUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', apikey: item.anonKey, Authorization: `Bearer ${session.access_token}` },
                            body: JSON.stringify({ action: item.action || 'admin-create', operation_id: item.operationId, ...payload })
                        });
                        result = await response.json().catch(() => ({}));
                        if (!response.ok) throw new Error(result.error || 'Account creation failed.');
                    }
                    if ((item.action || 'admin-create') === 'admin-create') {
                        await saveAdminAccountResult(userId, item.operationId, item.role, payload, result);
                        if (item.role === 'teacher') {
                            await refreshAdminTeacherLookups(client, userId);
                            if (result.teacher_id) {
                                const localRef = `local:${item.operationId}`;
                                await adminStoreRequest(adminStructureMapStoreName, 'readwrite', store => store.put({
                                    key: `${userId}:${localRef}`, userId, localRef, realId: result.teacher_id
                                }));
                            }
                        }
                    } else if (item.action === 'admin-reset') {
                        if (item.role === 'teacher') {
                            await saveAdminTeacherPasswordResetResult(userId, item.operationId, item.payload, result);
                        } else {
                            await saveAdminPasswordResetResult(userId, item.operationId, item.payload, result);
                        }
                    } else if (item.action === 'admin-delete' && item.role === 'student') {
                        await saveAdminDeletionResult(userId, item.operationId, item.payload, result);
                        await removeAdminAccountResult(client, item.payload.student_number || result.student_number);
                        await removeAdminStudentFromLocalRosters(client, result.student_id || item.payload.student_id, result.student_number || item.payload.student_number);
                    } else if (item.role === 'teacher' && item.action === 'admin-delete') {
                        await saveAdminDeletionResult(userId, item.operationId, item.payload, result);
                        await removeAdminAccountResult(client, result.teacher_number || item.payload.teacher_number, 'teacher');
                        await refreshAdminTeacherLookups(client, userId);
                    } else if (item.role === 'teacher' && item.action === 'admin-edit') {
                        await refreshAdminTeacherLookups(client, userId);
                        await updateAdminTeacherAccountResult(client, payload.teacher_id, payload);
                    } else if (item.action === 'admin-bulk-delete') {
                        const label = item.payload.scope === 'unassigned' ? 'Unassigned students' : 'Graduate sections';
                        await saveAdminDeletionResult(
                            userId,
                            item.operationId,
                            { ...item.payload, student_number: label },
                            result,
                            item.payload.scope === 'unassigned'
                                ? `Deleted ${result.deleted} unassigned student account(s)`
                                : `Deleted ${result.deleted} students and ${result.deleted_sections} Graduate sections`
                        );
                            await saveAdminAccountLookups(client, userId);
                    }
                    await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(item.key));
                } catch (error) {
                    const failureReason = error?.message || 'Account creation is waiting to retry.';
                    const stillProcessing = failureReason.includes('Account creation is still processing.')
                        || failureReason.includes('Password reset is still processing.');
                    await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
                        ...item,
                        processing: stillProcessing,
                        lastError: stillProcessing ? null : failureReason
                    }));
                    if (item.action === 'admin-reset') {
                        window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
                    }
                    if (item.role === 'teacher' && item.action === 'admin-delete') {
                        window.dispatchEvent(new CustomEvent('admin-deletion-data-changed'));
                    }
                    setNotice(stillProcessing
                        ? (item.action === 'admin-reset'
                            ? `The ${item.role} password reset is still processing. We’ll check again shortly.`
                            : `The saved ${item.role} account is being created. We’ll check again shortly.`)
                        : (item.action === 'admin-reset'
                            ? `A saved ${item.role} password reset could not be applied yet: ${failureReason}`
                            : item.action === 'admin-delete'
                                ? `A saved ${item.role} deletion could not be applied yet: ${failureReason}`
                                : item.action === 'admin-bulk-delete'
                                    ? `A saved scoped student cleanup could not be applied yet: ${failureReason}`
                                : `A saved ${item.role} account could not be created yet: ${failureReason}`), true, 'sync');
                    window.setTimeout(() => {
                        if (navigator.onLine && window.currentOfflineRole === 'admin') {
                            void syncAdminQueues(client);
                        }
                    }, stillProcessing ? 35000 : 15000);
                    break;
                }
            }
            window.dispatchEvent(new CustomEvent('admin-password-reset-data-changed'));
            if (queued.some(item => item.action === 'admin-edit') && navigator.onLine) {
                await saveAdminAccountLookups(client, userId);
                window.dispatchEvent(new CustomEvent('admin-student-data-changed'));
            }
            window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        } catch (error) {
            console.warn('Unable to sync queued admin account creations.', error);
        } finally {
            window.adminAccountSyncInProgress = false;
            window.dispatchEvent(new CustomEvent('admin-account-sync-finished'));
        }
    }

    async function syncAdminQueues(client) {
        if (!navigator.onLine || window.adminQueueSyncInProgress) return;
        window.adminQueueSyncInProgress = true;
        try {
            const userId = await getUserId(client);
            if (!userId) return;
            while (navigator.onLine) {
                const [{ pending: structurePending }, { queued: accountPending }] = await Promise.all([
                    getAdminStructureData(client),
                    getAdminAccountData(client)
                ]);
                const next = [
                    ...structurePending.map(item => ({ ...item, queue: 'structure' })),
                    ...accountPending.map(item => ({ ...item, queue: 'account' }))
                ].sort((first, second) => Date.parse(first.createdAt || 0) - Date.parse(second.createdAt || 0)
                    || first.operationId.localeCompare(second.operationId))[0];
                if (!next) break;

                if (next.queue === 'structure') await syncAdminStructureQueue(client, next.operationId);
                else await syncAdminAccountQueue(client, next.operationId);

                const [{ pending: remainingStructure }, { queued: remainingAccounts }] = await Promise.all([
                    getAdminStructureData(client),
                    getAdminAccountData(client)
                ]);
                const stillQueued = next.queue === 'structure'
                    ? remainingStructure.some(item => item.operationId === next.operationId)
                    : remainingAccounts.some(item => item.operationId === next.operationId);
                if (stillQueued) break;
            }
        } catch (error) {
            console.warn('Unable to sync queued admin changes in order.', error);
        } finally {
            window.adminQueueSyncInProgress = false;
        }
    }

    window.submitAdminAccountCreation = submitAdminAccountCreation;
    window.recordAdminAccountCreationFailure = recordAdminAccountCreationFailure;
    window.discardAdminAccountResult = discardAdminAccountResult;
    window.submitAdminAccountDeletion = submitAdminAccountDeletion;
    window.submitAdminTeacherOperation = submitAdminTeacherOperation;
    window.queuePasswordResetForPendingTeacher = queuePasswordResetForPendingTeacher;
    window.updateQueuedAdminTeacherCreation = updateQueuedAdminTeacherCreation;
    window.queueAdminBulkDeletion = queueAdminBulkDeletion;
    window.getAdminDeletionData = getAdminDeletionData;
    window.clearStoredAdminDeletionResults = clearAdminDeletionResults;
    window.recordAdminLocalDeletion = recordAdminLocalDeletion;
    window.submitAdminPasswordReset = submitAdminPasswordReset;
    window.queuePasswordResetForPendingStudent = queuePasswordResetForPendingStudent;
    window.getAdminAccountData = getAdminAccountData;
    window.getAdminPasswordResetData = getAdminPasswordResetData;
    window.discardQueuedAdminAccountRequest = discardQueuedAdminAccountRequest;
    window.clearPortalOfflineNotice = () => setNotice('', false);
    window.clearAdminAccountResults = clearAdminAccountResults;
    window.syncAdminAccountQueue = syncAdminQueues;
    window.getAdminAccountLookups = getAdminAccountLookups;
    window.saveAdminAccountLookups = saveAdminAccountLookups;
    window.refreshAdminTeacherLookups = refreshAdminTeacherLookups;
    window.saveAdminStudentSection = saveAdminStudentSection;
    window.getAdminStudentSection = getAdminStudentSection;
        window.getAdminStudentRoster = getAdminStudentRoster;
        window.queueAdminStudentEdit = queueAdminStudentEdit;
        window.updateQueuedAdminStudentCreation = updateQueuedAdminStudentCreation;
    window.queueAdminStructureOperation = queueAdminStructureOperation;
    window.queueAdminStructureDelete = queueAdminStructureDelete;
    window.cacheSystemLogEntries = cacheSystemLogEntries;
    window.getCachedSystemLogs = getCachedSystemLogs;
    window.queueSystemLogDeleteAll = queueSystemLogDeleteAll;
    window.hasQueuedSystemLogDeleteAll = hasQueuedSystemLogDeleteAll;
    window.syncQueuedSystemLogDeleteAll = syncQueuedSystemLogDeleteAll;
    window.getSystemLogCacheState = getSystemLogCacheState;
    window.saveSystemLogCacheState = saveSystemLogCacheState;
    window.clearCachedSystemLogs = clearCachedSystemLogs;
    window.cancelQueuedAdminSubject = cancelQueuedAdminSubject;
    window.clearStoredAdminPasswordResetResults = clearAdminPasswordResetResults;
    window.discardQueuedAdminAccountOperation = discardQueuedAdminAccountOperation;
    window.cancelQueuedAdminSubject = cancelQueuedAdminSubject;
    window.getAdminStructureData = getAdminStructureData;
    window.syncAdminStructureQueue = syncAdminQueues;
    window.clearAdminStructureQueue = clearAdminStructureQueue;
    window.getAdminStructureLocalIdMap = getAdminStructureLocalIdMap;

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
        let failedOperation = null;
        try {
            const operations = await getTeacherQueue(client);
            for (const operation of operations) {
                if (!navigator.onLine) break;
                failedOperation = operation;
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
                failedOperation = null;
            }

            const remaining = await getTeacherQueue(client);
            if (remaining.length) {
                const retryMessage = navigator.onLine
                    ? `${remaining.length} teacher change${remaining.length === 1 ? '' : 's'} is still waiting to sync. The app will retry automatically while connected.`
                    : `${remaining.length} teacher change${remaining.length === 1 ? '' : 's'} still waiting to sync. Reconnect and retry.`;
                setNotice(retryMessage, true, 'sync');
            } else if (operations.length) {
                try { sessionStorage.removeItem(teacherSyncFailureStorageKey); } catch {}
                document.querySelectorAll('.offline-queued-requirement').forEach(element => element.remove());
                document.querySelectorAll('button').forEach(button => {
                    if (button.textContent.trim() === 'Queued offline') button.textContent = 'Save';
                });
                setNotice('Teacher changes synced. Refreshing saved teacher data...', true, 'ready');
                await preloadTeacherAssignedRosters(client, true);
                window.setTimeout(() => window.location.reload(), 1200);
            }
        } catch (error) {
            console.error('Unable to sync queued teacher changes.', error);
            const failedType = failedOperation?.type || 'unknown';
            const failedPayload = failedOperation?.payload || {};
            const invalidGrade = failedOperation?.type === 'grade'
                && (!Number.isInteger(Number(failedPayload.subject_id)) || Number(failedPayload.subject_id) <= 0
                    || !Number.isInteger(Number(failedPayload.section_id)) || Number(failedPayload.section_id) <= 0);
            const assignmentError = String(error?.message || '').includes('You are not assigned to this active subject and section.');
            const changeLabel = failedType === 'grade' ? 'grade' : failedType === 'attachment' ? 'file' : failedType === 'requirement_delete' ? 'requirement deletion' : failedType === 'requirement' ? 'requirement' : 'change';
            const operationTag = failedOperation?.operationId ? ` (${failedOperation.operationId.slice(0, 8)})` : '';
            const syncMessage = navigator.onLine
                ? invalidGrade
                    ? 'An older saved grade is missing its subject and section, so it cannot sync. Remove it here, then enter the grade again after selecting the class.'
                    : assignmentError && failedType === 'grade'
                    ? 'A saved grade could not sync because this teacher is not assigned to that class. It will keep trying until the issue is fixed or the saved grade is removed.'
                    : failedOperation
                        ? `Saved ${changeLabel}${operationTag} could not sync: ${error?.message || 'server rejected the change'}. It remains on this device and will retry.`
                        : `Could not check the saved teacher queue: ${error?.message || 'storage read failed'}. No new change was made.`
                : 'Some teacher changes could not sync. They remain saved on this device; retry when online.';
            const discardAction = invalidGrade ? {
                label: 'Remove this saved grade',
                onClick: async () => {
                    const confirmed = window.confirm('This saved grade is missing its subject and section, so it cannot sync. Remove it from this device? You can enter it again after selecting the correct subject and section.');
                    if (!confirmed) return;
                    await removeQueuedTeacherOperation(failedOperation.key);
                    setNotice('The unsynced grade was removed. Your other saved changes are still here.', true, 'ready');
                    void syncTeacherQueue(client);
                }
            } : null;
            const failureSignature = `${failedOperation?.operationId || 'queue-read'}:${error?.message || 'unknown'}`;
            let shouldNotify = true;
            try {
                shouldNotify = sessionStorage.getItem(teacherSyncFailureStorageKey) !== failureSignature;
                if (shouldNotify) sessionStorage.setItem(teacherSyncFailureStorageKey, failureSignature);
            } catch {}
            if (shouldNotify) setNotice(syncMessage, true, 'sync', discardAction);
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
                    setNotice('Your assigned teacher data is saved for offline viewing.', true, 'ready');
                    window.setTimeout(() => setNotice('', false), 6000);
                } else {
                    setNotice('Some assigned teacher data could not be saved. Stay online and try again.', true, 'sync');
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

            let snapshot;
            if (role === 'teacher' && !force) {
                const routeParams = new URLSearchParams(window.location.search);
                const hasStatusRoute = pageKey === 'status'
                    && ['year', 'department_id', 'major_id', 'subject_id', 'section_id'].every(key => routeParams.get(key));
                snapshot = await readTeacherRouteSnapshot(userId, pageKey);
                if (!snapshot && hasStatusRoute) {
                    setNotice('This class list is not saved for offline use yet. Connect to the internet, open the class once, then try again offline.', true);
                    return true;
                }
                snapshot = snapshot || await readLatestTeacherSnapshot(userId, pageKey);
            } else {
                snapshot = await readSnapshot(snapshotKey(userId, pageKey, role));
            }
            if (!snapshot?.html) {
                if (!navigator.onLine) {
                    setNotice(`Offline. This ${role} page has no saved copy on this device yet.`, true);
                }
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
            const routeParams = new URLSearchParams(window.location.search);
            const hasStatusRoute = role === 'teacher' && pageKey === 'status'
                && ['year', 'department_id', 'major_id', 'subject_id', 'section_id'].every(key => routeParams.get(key));
            if (role === 'teacher' && !hasStatusRoute) {
                clearTeacherFilterSelections(main, pageKey);
            }
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
                ? `Offline view: teacher data saved ${savedTime}. ${pendingCount ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to sync. ` : ''}Only saved teacher data is available.`
                : `Offline read-only view: showing saved student information from ${savedTime}. Changes and attachments require internet.`, true);
            return true;
        } catch (error) {
            console.warn('Unable to restore the student offline view.', error);
            if (!navigator.onLine) {
                setNotice(`Offline. A saved ${role} copy could not be opened on this device.`, true);
            }
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

    async function readTeacherRouteSnapshot(userId, pageKey) {
        if (pageKey !== 'status') return null;
        const params = new URLSearchParams(window.location.search);
        const routeFilters = {
            yearFilter: params.get('year'),
            departmentFilter: params.get('department_id'),
            majorFilter: params.get('major_id'),
            subjectFilter: params.get('subject_id'),
            sectionFilter: params.get('section_id')
        };
        if (Object.values(routeFilters).some(value => !value)) return null;

        const database = await openDatabase();
        const prefix = `${userId}:teacher:${pageKey}:`;
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => {
                const match = request.result
                    .filter(snapshot => typeof snapshot.key === 'string'
                        && snapshot.key.startsWith(prefix)
                        && Object.entries(routeFilters).every(([id, value]) =>
                            (snapshot.filterState || []).some(([filterId, savedValue]) => filterId === id && String(savedValue) === String(value))))
                    .sort((first, second) => Date.parse(second.savedAt) - Date.parse(first.savedAt))[0];
                resolve(match || null);
            };
            request.onerror = () => reject(request.error || new Error('Unable to find the saved class roster.'));
        });
    }

    function bindTeacherOfflineFilters(client, pageKey, container, currentSnapshot) {
        container.querySelectorAll('select#yearFilter,select#departmentFilter,select#majorFilter,select#subjectFilter,select#sectionFilter,select#yearSelect,select#departmentSelect,select#majorSelect,select#subjectSelect,select#sectionSelect').forEach(select => {
            if (select.dataset.offlineFilterBound) return;
            select.dataset.offlineFilterBound = 'true';
            select.addEventListener('change', async () => {
                if (['students', 'subjects', 'status'].includes(pageKey) && !hasCompleteTeacherFilters(container, pageKey)) {
                    clearTeacherResultTable(container, pageKey, 'Select each filter, including Section, to open this class list.');
                }
                const loaded = await restoreTeacherSnapshotForFilterChange(client, pageKey, select.id, select.value, currentSnapshot);
                if (!loaded) {
                    (currentSnapshot.formState || []).forEach(field => {
                        const element = document.getElementById(field.id);
                        if (element) element.value = field.value;
                    });
                    setNotice('That class data is not saved on this device. Choose the section while online to save it for offline use.', true);
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

        const filterIds = getTeacherFilterIds(pageKey);
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
        filterIds.slice(changedIndex + 1).forEach(id => {
            const element = document.getElementById(id);
            if (element) element.selectedIndex = 0;
        });
        if (['students', 'subjects', 'status'].includes(pageKey) && !hasCompleteTeacherFilters(main, pageKey)) {
            clearTeacherResultTable(main, pageKey, 'Select each filter, including Section, to open this class list.');
        }
        makeOfflineViewReadOnly(main);
        bindTeacherOfflineFilters(client, pageKey, main, snapshot);
        await applyQueuedTeacherOperations(client, pageKey, main);
        setNotice(`Offline view: showing saved teacher data from ${new Date(snapshot.savedAt).toLocaleString()}.`, true);
        return true;
    }

    function clearTeacherFilterSelections(container, pageKey) {
        getTeacherFilterIds(pageKey).forEach(id => {
            const select = container.querySelector(`#${id}`);
            if (select) select.selectedIndex = 0;
        });
        clearTeacherResultTable(container, pageKey, 'Select each filter, including Section, to open this class list.');
    }

    function getTeacherFilterIds(pageKey) {
        return ['students', 'status'].includes(pageKey)
            ? ['yearFilter', 'departmentFilter', 'majorFilter', 'subjectFilter', 'sectionFilter']
            : ['yearSelect', 'departmentSelect', 'majorSelect', 'subjectSelect', 'sectionSelect'];
    }

    function hasCompleteTeacherFilters(container, pageKey) {
        return getTeacherFilterIds(pageKey).every(id => {
            const select = container.querySelector(`#${id}`);
            return Boolean(select?.value);
        });
    }

    function clearTeacherResultTable(container, pageKey, message) {
        const tableBody = container.querySelector('#studentStatusBody, #studentTableBody, #studentsTable');
        if (tableBody) {
            const columnCount = pageKey === 'status' ? 5 : 3;
            tableBody.innerHTML = `<tr><td colspan="${columnCount}" class="empty">${message}</td></tr>`;
        }
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
            if (operation.type === 'requirement_delete' && pageKey === 'subjects') {
                const currentSubject = container.querySelector('#subjectSelect')?.value;
                if (String(currentSubject) !== String(payload.subject_id)) continue;
                container.querySelectorAll(`[data-requirement-id="${payload.requirement_id}"]`).forEach(element => element.remove());
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
                && /openRequirementModal|saveRequirement|deleteRequirement|closeRequirementModal|selectRequirementStudents|updateRequirementStudentCount|openUploadModal|closeUploadModal|uploadInstruction|saveGrade|updateStatusColor|closeModal/.test(control.getAttribute('onclick') || '');
            control.disabled = !(teacherFilter || teacherGradeField || requirementInput || studentPicker || safeTeacherAction);
        });
        if (window.currentOfflineRole === 'teacher') {
            container.querySelectorAll('#confirmActionBtn, .cancel-btn').forEach(button => {
                button.disabled = false;
            });
        }
        container.querySelectorAll('*').forEach(element => {
            Array.from(element.attributes).forEach(attribute => {
                if (/^on/i.test(attribute.name)) {
                    const handler = attribute.value || '';
                    const isLogout = attribute.name.toLowerCase() === 'onclick' && element.matches('a[href="login.html"]');
                    const isOfflineSupportedAction = window.currentOfflineRole === 'teacher'
                        && attribute.name.toLowerCase() === 'onclick'
                        && /openRequirementModal|saveRequirement|deleteRequirement|closeRequirementModal|selectRequirementStudents|updateRequirementStudentCount|openUploadModal|closeUploadModal|uploadInstruction|saveGrade|updateStatusColor/.test(handler);
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
    window.beginAdminOfflinePage = beginAdminOfflinePage;
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
        if (client && window.currentOfflineRole === 'admin') {
            await restoreAdminOfflineSnapshot(client);
        } else if (client && window.currentStudentOfflinePage) {
            const role = window.currentOfflineRole || 'student';
            await restoreOfflineSnapshot(client, window.currentStudentOfflinePage, role, true);
        } else {
            setNotice('Connection lost. Previously saved portal pages are available on this device.', true);
        }
    });

    window.addEventListener('online', async () => {
        if (window.portalLogoutInProgress) return;
        const client = window.supabaseClientForOffline;
        if (client) {
            try {
                const { data: { session } } = await client.auth.getSession();
                if (!session) {
                    setNotice('', false);
                    if (!/\/login\.html$/i.test(window.location.pathname)) window.location.replace('login.html');
                    return;
                }
            } catch (error) {
                console.warn('Unable to verify the session after reconnect.', error);
                return;
            }
        }

        if (window.currentOfflineRole === 'admin' && client) {
            setNotice('Connection restored. Syncing saved admin changes.', true, 'sync');
            void resumeAdminOnline(client);
        } else if (window.currentOfflineRole === 'teacher' && client) {
            setNotice('Connection restored. Syncing saved teacher changes.', true, 'sync');
            void syncTeacherQueue(client);
            void preloadTeacherAssignedRosters(client, true).catch(error => {
                console.warn('Could not refresh assigned teacher data.', error);
            });
        } else if (client) {
            setNotice('Connection restored.', true, 'ready');
            window.setTimeout(() => setNotice('', false), 4000);
        }
    });

    function clientForOffline() {
        return window.supabaseClientForOffline;
    }

    async function resumeAdminOnline(client) {
        try {
            const wasOfflineView = Boolean(window.adminOfflineView);
            const userId = await getUserId(client);
            const { data: admin, error } = await client.from('admins').select('id').eq('auth_user_id', userId).maybeSingle();
            if (error || !admin) return;
            void refreshAdminAccountLookupsIfStale(client, userId).catch(cacheError => {
                console.warn('Admin offline lookup refresh is still pending after reconnect.', cacheError);
            });
            await syncAdminQueues(client);
            if (wasOfflineView) {
                window.location.reload();
                return;
            }
            window.startSystemLogsRealtimeSync?.();
            window.scheduleSystemLogsOfflineSync?.();
        } catch (error) {
            console.warn('Unable to resume admin data after reconnect.', error);
        }
    }

    window.addEventListener('DOMContentLoaded', () => {
        if (window.currentOfflineRole === 'teacher' && window.supabaseClientForOffline) {
            void syncTeacherQueue(window.supabaseClientForOffline);
        }
    });
})();
