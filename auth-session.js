function showLogoutConfirmation(title, message) {
    const existingModal = document.getElementById('confirmModal');
    if (existingModal && typeof window.showConfirmModal === 'function') {
        return new Promise(resolve => {
            let settled = false;
            const finish = approved => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKeyDown);
                resolve(approved);
            };
            const onKeyDown = event => {
                if (event.key !== 'Escape') return;
                window.closeConfirmModal?.();
                finish(false);
            };
            existingModal.querySelector('.cancel-btn')?.addEventListener('click', () => finish(false), { once: true });
            document.addEventListener('keydown', onKeyDown);
            window.showConfirmModal(title, message, () => finish(true));
        });
    }

    let style = document.getElementById('amsLogoutConfirmStyles');
    if (!style) {
        style = document.createElement('style');
        style.id = 'amsLogoutConfirmStyles';
        style.textContent = `
            #amsLogoutConfirmOverlay { position:fixed; inset:0; z-index:20000; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(15,23,42,.58); }
            #amsLogoutConfirmDialog { width:min(440px,100%); padding:28px; border-radius:16px; background:#fff; box-shadow:0 24px 70px rgba(15,23,42,.28); color:#1e293b; font-family:inherit; }
            #amsLogoutConfirmDialog .confirm-icon { width:48px; height:48px; margin:0 auto 16px; display:grid; place-items:center; border-radius:50%; background:#fff7ed; color:#c2410c; font-size:26px; font-weight:700; }
            #amsLogoutConfirmDialog h2 { margin:0 0 12px; text-align:center; color:#0b3d91; font-size:21px; }
            #amsLogoutConfirmDialog p { margin:0; line-height:1.55; text-align:center; color:#475569; }
            #amsLogoutConfirmDialog .confirm-buttons { display:flex; justify-content:center; gap:12px; margin-top:24px; }
            #amsLogoutConfirmDialog .confirm-buttons button { min-width:112px; padding:11px 16px; border:0; border-radius:9px; color:#fff; font:inherit; font-size:14px; font-weight:600; line-height:1.2; cursor:pointer; }
            #amsLogoutConfirmDialog .cancel-btn { background:#64748b; }
            #amsLogoutConfirmDialog .confirm-btn { background:#dc2626; }
            #amsLogoutConfirmDialog button:focus-visible { outline:3px solid #93c5fd; outline-offset:3px; }
        `;
        document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.id = 'amsLogoutConfirmOverlay';
    overlay.innerHTML = '<div id="amsLogoutConfirmDialog" role="dialog" aria-modal="true" aria-labelledby="amsLogoutConfirmTitle" aria-describedby="amsLogoutConfirmMessage"><div class="confirm-icon" aria-hidden="true">!</div><h2 id="amsLogoutConfirmTitle"></h2><p id="amsLogoutConfirmMessage"></p><div class="confirm-buttons"><button type="button" class="cancel-btn">Cancel</button><button type="button" class="confirm-btn">Log out</button></div></div>';
    overlay.querySelector('#amsLogoutConfirmTitle').textContent = title;
    overlay.querySelector('#amsLogoutConfirmMessage').textContent = message;
    document.body.appendChild(overlay);

    return new Promise(resolve => {
        const finish = approved => {
            document.removeEventListener('keydown', onKeyDown);
            overlay.remove();
            resolve(approved);
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') finish(false);
        };
        overlay.querySelector('.cancel-btn').addEventListener('click', () => finish(false));
        overlay.querySelector('.confirm-btn').addEventListener('click', () => finish(true));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish(false);
        });
        document.addEventListener('keydown', onKeyDown);
        overlay.querySelector('.cancel-btn').focus();
    });
}

async function logoutAndRedirect(event, client) {
    event.preventDefault();

    let session = null;
    try {
        const { data: { session: activeSession } = {} } = await client.auth.getSession();
        session = activeSession || null;
        if (session) {
            const pendingCounts = [];
            if (typeof window.getTeacherOfflineQueue === 'function') {
                pendingCounts.push((await window.getTeacherOfflineQueue(client)).length);
            }
            if (typeof window.getAdminStructureData === 'function') {
                pendingCounts.push((await window.getAdminStructureData(client)).pending.length);
            }
            if (typeof window.getAdminAccountData === 'function') {
                pendingCounts.push((await window.getAdminAccountData(client)).queued.length);
            }
            if (typeof window.hasQueuedSystemLogDeleteAll === 'function'
                && await window.hasQueuedSystemLogDeleteAll(client)) {
                pendingCounts.push(1);
            }
            const pendingCount = pendingCounts.reduce((total, count) => total + count, 0);
            if (pendingCount) {
                const message = `${pendingCount} unsynced change${pendingCount === 1 ? ' is' : 's are'} saved on this device and will sync when the internet connection returns. After logging out, sign in again when connected for syncing to resume. Log out now?`;
                if (!await showLogoutConfirmation('Unsynced Data', message)) return;
            }
        }
    } catch (error) {
        console.warn('Unable to inspect local offline data before logout.', error);
        const message = 'I could not verify the queued changes. Any saved offline changes remain on this device and can sync after you sign in again while connected. Log out anyway?';
        if (!await showLogoutConfirmation('Check Saved Data', message)) return;
    }

    if (session?.user?.id && typeof window.clearStudentOfflineSnapshots === 'function') {
        await window.clearStudentOfflineSnapshots(session.user.id);
        document.querySelector('.main')?.replaceChildren();
    }

    window.portalLogoutInProgress = true;
    try {
        const { error } = await client.auth.signOut(navigator.onLine ? undefined : { scope: 'local' });
        if (error) throw error;
    } catch (error) {
        window.portalLogoutInProgress = false;
        console.error('Unable to clear the sign-in session', error);
        alert('Could not sign out right now. Please try again.');
        return;
    }

    window.location.replace('index.html');
}

function enableHorizontalMenuWheel() {
    document.querySelectorAll('.sidebar .menu').forEach(menu => {
        menu.addEventListener('wheel', event => {
            if (window.innerWidth > 768 || menu.scrollWidth <= menu.clientWidth) return;

            const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
                ? event.deltaX
                : event.deltaY;
            if (!horizontalDelta) return;

            const maxScroll = menu.scrollWidth - menu.clientWidth;
            const nextScroll = Math.max(0, Math.min(maxScroll, menu.scrollLeft + horizontalDelta));
            if (nextScroll !== menu.scrollLeft) {
                event.preventDefault();
                menu.scrollLeft = nextScroll;
            }
        }, { passive: false });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enableHorizontalMenuWheel, { once: true });
} else {
    enableHorizontalMenuWheel();
}
