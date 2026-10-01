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
