/*
 * 狐狸今天吃什么 · Service Worker
 *
 * 策略（刻意保持简单，这个应用的规模用不上 Workbox）：
 *   - /api/*          永远直连网络，不缓存（菜单要最新，密钥更不能碰缓存）
 *   - /icons/ /image1/ 缓存优先：图标和大图基本不变，省流量
 *   - 其余（页面/样式/脚本/manifest）网络优先，失败回退缓存：保证更新即时可见，
 *     断网时至少能打开上一次的界面继续抽（菜单数据取不到时页面自己会提示）
 *
 * 发版时把 CACHE 版本号 +1，旧缓存整体作废。
 */
const CACHE = 'huliaeat-v7';

const PRECACHE = [
    '/',
    '/styles.css',
    '/script.js',
    '/map.js',
    '/emoji-rules.js',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/image1/eateat.jpg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    const cacheableFile = url.pathname.startsWith('/icons/') || url.pathname.startsWith('/image1/');

    if (cacheableFile) {
        // 缓存优先：命中直接回，未命中拉回并写入
        event.respondWith(
            caches.match(request).then((hit) => hit || fetch(request).then((response) => {
                if (response && response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put(request, copy));
                }
                return response;
            }))
        );
        return;
    }

    // 网络优先：新版本立刻可见；断网回退缓存，最后兜底回首页
    event.respondWith(
        fetch(request).then((response) => {
            if (response && response.ok) {
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
        }).catch(() => caches.match(request).then((hit) => hit || caches.match('/')))
    );
});
