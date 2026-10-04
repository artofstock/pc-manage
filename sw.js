const CACHE_NAME = "pc-mgmt-cache-v4";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
const NETWORK_TIMEOUT_MS = 3000; // 현장에서 통신이 느릴 때는 3초 뒤 저장된 화면으로 바로 연다

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 네트워크 우선: 최신 파일을 먼저 받아 오고, 실패하거나 느리면 캐시를 사용한다.
// (예전 방식은 캐시 우선이라 새 버전을 올려도 화면이 바뀌지 않는 문제가 있었다)
function networkFirst(req) {
  return new Promise((resolve) => {
    let done = false;
    const useCache = () =>
      caches.match(req, { ignoreSearch: true }).then((c) => {
        if (c && !done) { done = true; resolve(c); }
        return c;
      });
    const timer = setTimeout(useCache, NETWORK_TIMEOUT_MS);
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        clearTimeout(timer);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        if (!done) { done = true; resolve(res); }
      })
      .catch(() => {
        clearTimeout(timer);
        useCache().then((c) => {
          if (!done) { done = true; resolve(c || Response.error()); }
        });
      });
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // 외부 CDN(QR 스캔 라이브러리)은 네트워크 우선, 실패 시 캐시
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(networkFirst(event.request));
});
