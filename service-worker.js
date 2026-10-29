const CACHE_NAME = 'ams-student-shell-v2';
const APP_FILES = [
    './student_dashboard.html',
    './student_subjects.html',
    './student_academic.html',
    './student_requirements.html',
    './student_profile.html',
    './auth-session.js',
    './student-offline.js',
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
    const isStudentPage = sameOrigin && /\/student_(dashboard|subjects|academic|requirements|profile)\.html$/.test(requestUrl.pathname);
    const isLocalAsset = sameOrigin && /\/(auth-session\.js|student-offline\.js|mobile_fix\.css|school_logo\.png)$/.test(requestUrl.pathname);
    const isApprovedCdnAsset = !sameOrigin && CACHEABLE_CDN_HOSTS.has(requestUrl.hostname)
        && (request.destination === 'script' || request.destination === 'style' || request.destination === 'font');

    if (!isStudentPage && !isLocalAsset && !isApprovedCdnAsset) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) {
            if (isStudentPage || isApprovedCdnAsset) {
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
            if (isStudentPage) {
                const fallback = await cache.match('./student_dashboard.html');
                if (fallback) return fallback;
            }
            throw error;
        }
    })());
});
