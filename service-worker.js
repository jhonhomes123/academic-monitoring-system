const CACHE_NAME = 'ams-student-shell-v73';
const APP_FILES = [
    './student_dashboard.html',
    './student_subjects.html',
    './student_academic.html',
    './student_requirements.html',
    './student_profile.html',
    './teacher_dashboard.html',
    './teacher_manage_students.html',
    './teacher_manage_subjects.html',
    './teacher_student_status.html',
    './teacher_profile.html',
    './admin_dashboard.html',
    './auth-session.js',
    './portal-offline.js',
    './mobile_fix.css',
    './school_logo.png'
];
const EXTERNAL_ASSETS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css'
];
const CACHEABLE_CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com']);

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(APP_FILES);
        await Promise.all(EXTERNAL_ASSETS.map(async url => {
            try {
                const response = await fetch(url, { mode: 'no-cors' });
                if (response.ok || response.type === 'opaque') await cache.put(url, response);
            } catch (error) {
                console.warn('Could not pre-cache an external student asset.', error);
            }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith('ams-student-shell-') && key !== CACHE_NAME)
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const requestUrl = new URL(request.url);
    const sameOrigin = requestUrl.origin === self.location.origin;
    const isPortalPage = sameOrigin && /\/(student_(dashboard|subjects|academic|requirements|profile)|teacher_(dashboard|manage_students|manage_subjects|student_status|profile)|admin_dashboard)\.html$/.test(requestUrl.pathname);
    const isMobileStylesheet = sameOrigin && requestUrl.pathname.endsWith('/mobile_fix.css');
    const isLocalAsset = sameOrigin && /\/(auth-session\.js|portal-offline\.js|mobile_fix\.css|school_logo\.png)$/.test(requestUrl.pathname);
    const isApprovedCdnAsset = !sameOrigin && CACHEABLE_CDN_HOSTS.has(requestUrl.hostname)
        && (request.destination === 'script' || request.destination === 'style' || request.destination === 'font');

    if (!isPortalPage && !isLocalAsset && !isApprovedCdnAsset) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        if (isMobileStylesheet) {
            try {
                const freshResponse = await fetch(request);
                if (freshResponse.ok) {
                    await cache.put(request, freshResponse.clone());
                    return freshResponse;
                }
            } catch (error) {
                console.warn('Using the cached mobile stylesheet while offline.', error);
            }

            const cachedStylesheet = await cache.match(request);
            if (cachedStylesheet) return cachedStylesheet;
            throw new Error('The mobile stylesheet is unavailable offline.');
        }

        const cached = await cache.match(request, { ignoreSearch: isPortalPage });
        if (cached) {
            if (isPortalPage || isApprovedCdnAsset) {
                event.waitUntil(fetch(request).then(response => {
                    if (response.ok || response.type === 'opaque') return cache.put(request, response.clone());
                }).catch(() => {}));
            }
            return cached;
        }

        try {
            const response = await fetch(request);
            if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
            return response;
        } catch (error) {
            if (isPortalPage) {
                const fallbackFile = requestUrl.pathname.endsWith('/admin_dashboard.html')
                    ? './admin_dashboard.html'
                    : requestUrl.pathname.includes('/teacher_')
                        ? './teacher_dashboard.html'
                        : './student_dashboard.html';
                const fallback = await cache.match(fallbackFile);
                if (fallback) return fallback;
            }
            throw error;
        }
    })());
});
