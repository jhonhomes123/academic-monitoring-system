(function () {
    const databaseName = 'ams-student-offline';
    const storeName = 'page-snapshots';
    const queueStoreName = 'teacher-write-queue';
    const adminQueueStoreName = 'admin-account-create-queue';
    const adminResultsStoreName = 'admin-created-account-results';
    const adminLookupStoreName = 'admin-account-lookups';
    const adminStructureQueueStoreName = 'admin-structure-write-queue';
    const adminStructureMapStoreName = 'admin-structure-id-map';
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
    const pageParams = new URLSearchParams(window.location.search);
    const isStudentWarmupFrame = pageParams.get('amsOfflineWarm') === '1';
    const isTeacherWarmupFrame = pageParams.get('amsTeacherOfflineWarm') === '1'
        || pageParams.get('amsTeacherRosterWarm') === '1';
    const isWarmupFrame = isStudentWarmupFrame || isTeacherWarmupFrame;

    function openDatabase() {
        if (!('indexedDB' in window)) return Promise.reject(new Error('Offline storage is unavailable.'));
        if (databasePromise) return databasePromise;

        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 4);
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
                if (!database.objectStoreNames.contains(adminLookupStoreName)) {
                    database.createObjectStore(adminLookupStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminStructureQueueStoreName)) {
                    database.createObjectStore(adminStructureQueueStoreName, { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains(adminStructureMapStoreName)) {
                    database.createObjectStore(adminStructureMapStoreName, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Unable to open offline storage.'));
        });
        return databasePromise;
    }

    function setNotice(message, visible, type = 'offline', action = null) {
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
        await saveAdminAccountLookups(client, userId);
        void syncAdminAccountQueue(client);
        void syncAdminStructureQueue(client);

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
            if (!['createStudentModal', 'createTeacherModal', 'departmentModal', 'majorModal', 'sectionModal', 'subjectModal', 'deleteDepartmentModal', 'deleteMajorModal', 'deleteSectionModal', 'deleteSubjectModal'].includes(element.id)) {
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
            main.innerHTML = snapshot.html;
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
                const inAllowedModal = control.closest('#createStudentModal,#createTeacherModal,#departmentModal,#majorModal,#sectionModal,#subjectModal,#deleteDepartmentModal,#deleteMajorModal,#deleteSectionModal,#deleteSubjectModal');
                const opensAllowedModal = control.matches('button')
                    && /openCreateStudentModal|openCreateTeacherModal|openDepartmentModal|openMajorModal|openSectionModal|openSubjectModal|openDeleteDepartmentModal|openDeleteMajorModal|openDeleteSectionModal|openDeleteSubjectModal/.test(control.getAttribute('onclick') || '');
                const isAllowedOfflineAction = control.matches('button')
                    && /createStudentAccount|createTeacherAccount|addDepartment|addMajor|addSection|addSubject|setActiveSemester|deleteDepartment|deleteMajor|deleteSectionModalAction|deleteSubject|closeCreateStudentModal|closeModal|closeDepartmentModal|closeMajorModal|closeSectionModal|closeSubjectModal|closeDeleteDepartmentModal|closeDeleteMajorModal|closeDeleteSectionModal|closeDeleteSubjectModal|loadDepartmentDeleteOptions|loadMajorsForDelete|loadMajorsForDeleteSection|loadSectionsForDelete|loadMajorsForDeleteSubject|loadSubjectsForDelete/.test(control.getAttribute('onclick') || '');
                const isSemesterPicker = control.id === 'activeSemesterSelect';
                const isExplorerBack = control.id === 'backButton';
                control.disabled = !(opensAllowedModal || isSemesterPicker || (control.matches('button') && /setActiveSemester/.test(control.getAttribute('onclick') || ''))
                    || isExplorerBack || control.id === 'confirmActionBtn' || control.matches('.cancel-btn')
                    || (inAllowedModal && (!control.matches('button') || isAllowedOfflineAction)));
            });
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
                year_level: payload.year_level || section?.year_level || '',
                section_name: section?.section_name || ''
            }
        }));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        if (typeof window.renderAdminCreatedAccounts === 'function') {
            await window.renderAdminCreatedAccounts();
        }
    }

    async function saveAdminAccountLookups(client, userId) {
        try {
            const [departmentsResult, majorsResult, sectionsResult, semestersResult, subjectsResult, teacherAssignmentsResult] = await Promise.all([
                client.from('departments').select('department_id, department_name').order('department_name'),
                client.from('majors').select('major_id, department_id, major_name').order('major_name'),
                client.from('sections').select('section_id, major_id, year_level, section_name').order('section_name'),
                client.from('semesters').select('semester_id, semester_name, is_active').order('semester_id'),
                client.from('subjects').select('subject_id, subject_code, subject_name, major_id, semester_id, year_level, semesters(semester_name)').order('subject_name'),
                client.from('teacher_subject_assignments').select('assignment_id, subject_id, teachers(first_name,middle_initial,last_name)').order('assignment_id')
            ]);
            const lookupError = departmentsResult.error || majorsResult.error || sectionsResult.error || semestersResult.error || subjectsResult.error || teacherAssignmentsResult.error;
            if (lookupError) throw lookupError;
            await adminStoreRequest(adminLookupStoreName, 'readwrite', store => store.put({
                key: `${userId}:lookups`, userId,
                departments: departmentsResult.data || [], majors: majorsResult.data || [], sections: sectionsResult.data || [],
                semesters: semestersResult.data || [], subjects: subjectsResult.data || [],
                teacherAssignments: teacherAssignmentsResult.data || [],
                savedAt: new Date().toISOString()
            }));
        } catch (error) {
            console.warn('Could not cache admin account dropdown data.', error);
        }
    }

    async function getAdminAccountLookups(client, suppliedUserId = null) {
        const userId = suppliedUserId || await getUserId(client);
        if (!userId) return null;
        return await adminStoreRequest(adminLookupStoreName, 'readonly', store => store.get(`${userId}:lookups`)) || null;
    }

    async function queueAdminStructureOperation(client, type, payload) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in while connected before making offline admin changes.');
        const operationId = createOperationId();
        const localRef = ['department_add', 'major_add', 'section_add', 'subject_add'].includes(type)
            ? `local:${operationId}`
            : null;
        await adminStoreRequest(adminStructureQueueStoreName, 'readwrite', store => store.put({
            key: `${userId}:${operationId}`, userId, operationId, localRef, type, payload,
            createdAt: new Date().toISOString(), lastError: null
        }));
        setNotice('Admin change saved on this device. It will apply when connected.', true, 'sync');
        window.dispatchEvent(new CustomEvent('admin-structure-data-changed'));
        return { operationId, localRef };
    }

    async function queueAdminStructureDelete(client, type, recordId) {
        if (recordId === null || recordId === undefined || String(recordId).startsWith('local:')) {
            throw new Error('This pending item must sync before it can be deleted.');
        }
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

    async function syncAdminStructureQueue(client) {
        if (!navigator.onLine || window.adminStructureSyncInProgress) return;
        window.adminStructureSyncInProgress = true;
        let currentOperation = null;
        try {
            const userId = await getUserId(client);
            if (!userId) return;
            const { pending } = await getAdminStructureData(client);
            const idMap = await getAdminStructureIdMap(userId);
            for (const operation of pending) {
                if (!navigator.onLine) break;
                currentOperation = operation;
                const payload = { ...operation.payload, type: operation.type };
                for (const field of ['department_id', 'major_id', 'semester_id']) {
                    const value = payload[field];
                    if (typeof value === 'string' && value.startsWith('local:')) {
                        if (!idMap.has(value)) throw new Error(`An earlier queued ${field.replace('_id', '')} is still waiting to sync.`);
                        payload[field] = idMap.get(value);
                    }
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
                            void syncAdminStructureQueue(client);
                        }
                    }, 15000);
                    break;
                }
                if (operation.localRef && data?.record_id !== undefined) {
                    const mapping = { key: `${userId}:${operation.localRef}`, userId, localRef: operation.localRef, realId: data.record_id };
                    await adminStoreRequest(adminStructureMapStoreName, 'readwrite', store => store.put(mapping));
                    idMap.set(operation.localRef, data.record_id);
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
                    void syncAdminStructureQueue(client);
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
            await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
                key: `${userId}:${operationId}`, userId, operationId, role, payload,
                functionUrl, anonKey, createdAt: new Date().toISOString(), lastError: null
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
        return result;
    }

    async function getAdminAccountData(client) {
        const userId = await getUserId(client);
        if (!userId) return { queued: [], completed: [] };
        const [allQueued, allCompleted] = await Promise.all([
            adminStoreRequest(adminQueueStoreName, 'readonly', store => store.getAll()),
            adminStoreRequest(adminResultsStoreName, 'readonly', store => store.getAll())
        ]);
        return {
            queued: allQueued.filter(item => item.userId === userId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
            completed: allCompleted.filter(item => item.userId === userId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        };
    }

    async function discardQueuedAdminAccountRequest(client, operationId) {
        const userId = await getUserId(client);
        if (!userId) throw new Error('Sign in again before managing saved account requests.');
        const key = `${userId}:${operationId}`;
        const queuedItem = await adminStoreRequest(adminQueueStoreName, 'readonly', store => store.get(key));
        if (!queuedItem || queuedItem.userId !== userId) throw new Error('This saved account request was not found.');
        await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(key));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        return true;
    }

    async function clearAdminAccountResults(client) {
        const userId = await getUserId(client);
        if (!userId) return;
        const allResults = await adminStoreRequest(adminResultsStoreName, 'readonly', store => store.getAll());
        await Promise.all(allResults.filter(item => item.userId === userId).map(item =>
            adminStoreRequest(adminResultsStoreName, 'readwrite', store => store.delete(item.key))));
        window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
    }

    async function syncAdminAccountQueue(client) {
        if (!navigator.onLine || window.adminAccountSyncInProgress) return;
        window.adminAccountSyncInProgress = true;
        try {
            const userId = await getUserId(client);
            if (!userId) return;
            const { queued } = await getAdminAccountData(client);
            for (const item of queued) {
                if (!navigator.onLine) break;
                const { data: { session } } = await client.auth.getSession();
                if (!session) return;
                try {
                    const response = await fetch(item.functionUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', apikey: item.anonKey, Authorization: `Bearer ${session.access_token}` },
                        body: JSON.stringify({ action: 'admin-create', operation_id: item.operationId, ...item.payload })
                    });
                    const result = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(result.error || 'Account creation failed.');
                    await saveAdminAccountResult(userId, item.operationId, item.role, item.payload, result);
                    await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.delete(item.key));
                } catch (error) {
                    const failureReason = error?.message || 'Account creation is waiting to retry.';
                    const stillProcessing = failureReason.includes('Account creation is still processing.');
                    await adminStoreRequest(adminQueueStoreName, 'readwrite', store => store.put({
                        ...item,
                        processing: stillProcessing,
                        lastError: stillProcessing ? null : failureReason
                    }));
                    setNotice(stillProcessing
                        ? `The saved ${item.role} account is being created. We’ll check again shortly.`
                        : `A saved ${item.role} account could not be created yet: ${failureReason}`, true, 'sync');
                    window.setTimeout(() => {
                        if (navigator.onLine && window.currentOfflineRole === 'admin') {
                            void syncAdminAccountQueue(client);
                        }
                    }, stillProcessing ? 35000 : 15000);
                    break;
                }
            }
            window.dispatchEvent(new CustomEvent('admin-account-data-changed'));
        } catch (error) {
            console.warn('Unable to sync queued admin account creations.', error);
        } finally {
            window.adminAccountSyncInProgress = false;
        }
    }

    window.submitAdminAccountCreation = submitAdminAccountCreation;
    window.getAdminAccountData = getAdminAccountData;
    window.discardQueuedAdminAccountRequest = discardQueuedAdminAccountRequest;
    window.clearAdminAccountResults = clearAdminAccountResults;
    window.syncAdminAccountQueue = syncAdminAccountQueue;
    window.getAdminAccountLookups = getAdminAccountLookups;
    window.queueAdminStructureOperation = queueAdminStructureOperation;
    window.queueAdminStructureDelete = queueAdminStructureDelete;
    window.getAdminStructureData = getAdminStructureData;
    window.syncAdminStructureQueue = syncAdminStructureQueue;
    window.clearAdminStructureQueue = clearAdminStructureQueue;

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
            const syncMessage = navigator.onLine
                ? invalidGrade
                    ? 'An older saved grade is missing its subject and section, so it cannot sync. Remove it here, then enter the grade again after selecting the class.'
                    : assignmentError && failedType === 'grade'
                    ? 'A saved grade could not sync because this teacher is not assigned to that class. It will keep trying until the issue is fixed or the saved grade is removed.'
                    : `A saved ${failedType === 'grade' ? 'grade' : failedType === 'attachment' ? 'file' : failedType === 'requirement_delete' ? 'requirement deletion' : failedType === 'requirement' ? 'requirement' : 'change'} could not sync. It is still saved on this device and will be retried.`
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
            setNotice(syncMessage, true, 'sync', discardAction);
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
            const userId = await getUserId(client);
            const { data: admin, error } = await client.from('admins').select('id').eq('auth_user_id', userId).maybeSingle();
            if (error || !admin) return;
            await saveAdminAccountLookups(client, userId);
            await syncAdminAccountQueue(client);
            await syncAdminStructureQueue(client);
            if (window.adminOfflineView) window.location.reload();
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
