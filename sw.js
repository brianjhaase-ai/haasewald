/* Haasewald offline support.
 * - The app itself (pages, code, parcel lines, contours) is saved on install, so it opens with no signal.
 *   Every new version of the site changes BUILD below, which makes the browser install the new copy:
 *   the page then offers a reload, so everyone is on the newest version as soon as they have a signal.
 * - Map pictures are saved as they are viewed (up to MAX_TILES), so places you have looked at keep
 *   working offline.
 * - Family positions and land trails always come fresh from the network (the app keeps its own copy of
 *   the land trails).
 */
var BUILD = '96697b8-20261114000244';
var APP_CACHE = 'haasewald-app-' + BUILD;
var TILE_CACHE = 'haasewald-tiles-v1';
var MAX_TILES = 6000;
var APP_FILES = [
  './', 'index.html', 'download.html', 'style.css', 'app.js', 'glyphs.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'data/parcels.json', 'data/contours.json', 'data/config.json', 'data/dem.bin',
  'icons/favicon.png', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'
];
var TILE_HOSTS = ['server.arcgisonline.com', 'gis.dearborncounty.in.gov', 'basemap.nationalmap.gov', 'carto.nationalmap.gov', 'tile.openstreetmap.org'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(APP_CACHE).then(function (cache) {
    return cache.addAll(APP_FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('haasewald-app-') === 0 && k !== APP_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

var putsSinceTrim = 0;
function trimTiles() {
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.keys().then(function (keys) {
      var extra = keys.length - MAX_TILES;
      if (extra <= 0) return;
      // Oldest first (insertion order).
      return Promise.all(keys.slice(0, extra + 200).map(function (k) { return cache.delete(k); }));
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // The app's own files: the saved copy of this version (it is replaced as a whole when a new version arrives).
    event.respondWith(caches.open(APP_CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return fetch(req).catch(function () {
          return req.mode === 'navigate' ? cache.match('index.html') : Response.error();
        });
      });
    }));
    return;
  }

  if (TILE_HOSTS.indexOf(url.hostname) >= 0 && req.destination === 'image') {
    event.respondWith(caches.open(TILE_CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res.ok) {
            cache.put(req, res.clone());
            if (++putsSinceTrim >= 200) { putsSinceTrim = 0; trimTiles(); }
          }
          return res;
        });
      });
    }));
  }
  // Everything else (Firebase, county lookups) goes straight to the network.
});
