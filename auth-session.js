async function logoutAndRedirect(event, client) {
    event.preventDefault();

    try {
        const { data: { session } = {} } = await client.auth.getSession();
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
            const pendingCount = pendingCounts.reduce((total, count) => total + count, 0);
            if (pendingCount && !window.confirm(`${pendingCount} unsynced change${pendingCount === 1 ? '' : 's'} ${navigator.onLine ? 'will remain saved on this device.' : 'are saved on this device.'} They will sync after you sign in again while connected. Log out now?`)) {
                return;
            }
        }
        if (session?.user?.id && typeof window.clearStudentOfflineSnapshots === 'function') {
            await window.clearStudentOfflineSnapshots();
            document.querySelector('.main')?.replaceChildren();
        }
    } catch (error) {
        console.warn('Unable to inspect local offline data before logout.', error);
    }

    window.portalLogoutInProgress = true;
    try {
        const { error } = await client.auth.signOut(navigator.onLine ? undefined : { scope: 'local' });
        if (error) throw error;
    } catch (error) {
        console.error('Unable to clear the sign-in session', error);
        alert('Could not sign out right now. Please try again.');
        return;
    }

    window.location.replace('login.html');
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
