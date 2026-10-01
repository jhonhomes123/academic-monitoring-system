async function logoutAndRedirect(event, client) {
    event.preventDefault();

    try {
        const { error } = await client.auth.signOut();
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
