const CACHE_VERSION = "wk-poule-v4";
const ASSETS = ["/", "/index.html", "/style.css", "/app.js"];

// Bij installatie: cache vullen en meteen activeren
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting(); // Nieuwe SW activeert meteen, wacht niet op sluiten tabs
});

// Bij activatie: oude caches weggooien en pagina's herladen
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // Neem direct controle over alle open tabs
  );

  // Stuur alle open tabs een signaal om te herladen
  self.clients.matchAll({ type: "window" }).then(clients => {
    clients.forEach(client => client.postMessage({ type: "SW_UPDATED" }));
  });
});

// Network-first: altijd verse versie proberen, cache alleen als fallback
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
