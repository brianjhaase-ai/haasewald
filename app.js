/* Haasewald web app: the land map for phones without the Android app (iPhones especially).
 *
 * Same data and the same family group as the Android app:
 *  - parcels and 5 ft contours bundled with the site (copied from the Android app's assets at build time);
 *  - family locations and the owner's land trails from the same Firebase Realtime Database, over REST,
 *    with anonymous sign-in, under groups/<family code>/members and groups/<family code>/trails;
 *  - the same privacy rule: a position is shared only while inside the sharing area (the owned land plus
 *    the first and second rings of neighbouring parcels), and removed on leaving or switching off.
 * A browser cannot track location with the screen off, so on an iPhone sharing works while the page is open.
 */
(function () {
  'use strict';

  var BUILD = { id: '96697b8-20261114000244', version: '2.10' };

  // ------------------------------------------------------------------ small helpers

  var store = {
    get: function (key, fallback) {
      try { var v = localStorage.getItem('hw.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { if (value === null || value === undefined) localStorage.removeItem('hw.' + key); else localStorage.setItem('hw.' + key, JSON.stringify(value)); } catch (e) { /* private mode: settings are not kept */ }
    }
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var toastTimer = null;
  function toast(message, ms) {
    var t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }

  function copyText(text, label) {
    var done = function () { toast('Copied: ' + (label || text)); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { prompt('Copy this:', text); });
    else prompt('Copy this:', text);
  }

  // ------------------------------------------------------------------ geometry (feet, miles and acres for display)

  var FEET_PER_METER = 3.28084;
  var R_EARTH = 6371008.8;

  function rad(d) { return d * Math.PI / 180; }
  function haversine(a, b) {
    var dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function formatDistance(m) {
    var ft = m * FEET_PER_METER;
    return ft < 2640 ? Math.round(ft).toLocaleString('en-US') + ' ft' : (ft / 5280).toFixed(2) + ' mi';
  }
  function bearing(a, b) {
    var y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    var x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function compass(deg) {
    var points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    var arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
    var i = Math.round(deg / 45) % 8;
    return points[i] + ' ' + arrows[i];
  }
  /** Ray casting on a ring of [lon, lat] pairs. */
  function inRing(lat, lon, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function polygonsOf(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }
  function inGeometry(lat, lon, geometry) {
    return polygonsOf(geometry).some(function (poly) {
      if (!inRing(lat, lon, poly[0])) return false;
      for (var h = 1; h < poly.length; h++) if (inRing(lat, lon, poly[h])) return false;
      return true;
    });
  }
  /** Shortest distance in meters from a point to the edges of a geometry (flat-earth, fine at this scale). */
  function distanceToEdges(p, geometry) {
    var kx = Math.cos(rad(p.lat)) * 111320, ky = 110540;
    var best = Infinity;
    polygonsOf(geometry).forEach(function (poly) {
      poly.forEach(function (ring) {
        for (var i = 0; i + 1 < ring.length; i++) {
          var ax = (ring[i][0] - p.lon) * kx, ay = (ring[i][1] - p.lat) * ky;
          var bx = (ring[i + 1][0] - p.lon) * kx, by = (ring[i + 1][1] - p.lat) * ky;
          var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
          var t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
          var cx = ax + t * dx, cy = ay + t * dy;
          best = Math.min(best, Math.sqrt(cx * cx + cy * cy));
        }
      });
    });
    return best;
  }
  /** Area in square meters (outer rings minus holes). */
  function areaOf(geometry) {
    var total = 0;
    polygonsOf(geometry).forEach(function (poly) {
      poly.forEach(function (ring, idx) {
        var lat0 = ring[0][1], kx = Math.cos(rad(lat0)) * 111320, ky = 110540, a = 0;
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
        total += (idx === 0 ? 1 : -1) * Math.abs(a / 2);
      });
    });
    return total;
  }
  function centroidOf(geometry) {
    var polys = polygonsOf(geometry), best = null, bestArea = -1;
    polys.forEach(function (poly) {
      var a = Math.abs(areaOf({ type: 'Polygon', coordinates: [poly[0]] }));
      if (a > bestArea) { bestArea = a; best = poly[0]; }
    });
    if (!best) return null;
    var sx = 0, sy = 0, n = best.length - 1 || 1;
    for (var i = 0; i < n; i++) { sx += best[i][0]; sy += best[i][1]; }
    var c = { lat: sy / n, lon: sx / n };
    return c;
  }
  function pathLength(points) {
    var m = 0;
    for (var i = 1; i < points.length; i++) m += haversine(points[i - 1], points[i]);
    return m;
  }
  /** Google encoded polyline, 1e-5 precision (same as PathCodec.kt). */
  function decodePath(text) {
    var out = [], i = 0, lat = 0, lon = 0;
    function read() {
      var shift = 0, result = 0, b;
      do {
        if (i >= text.length) return null;
        b = text.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      return (result & 1) ? ~(result >> 1) : (result >> 1);
    }
    while (i < text.length) {
      var dLat = read(); if (dLat === null) break;
      var dLon = read(); if (dLon === null) break;
      lat += dLat; lon += dLon;
      out.push({ lat: lat / 1e5, lon: lon / 1e5 });
    }
    return out;
  }
  function timeAgo(then) {
    var s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 172800) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' days ago';
  }
  function fmtCoord(p) { return p.lat.toFixed(6) + ', ' + p.lon.toFixed(6); }

  // ------------------------------------------------------------------ people: colours and icons (same as the Android app)

  var PERSON_COLORS = [
    ['Red', '#E53935'], ['Orange', '#FB8C00'], ['Green', '#43A047'], ['Teal', '#00897B'], ['Blue', '#1E88E5'],
    ['Purple', '#8E24AA'], ['Pink', '#D81B60'], ['Brown', '#6D4C41'], ['Slate', '#546E7A'], ['Black', '#212121']
  ];
  var TOKEN_LABELS = {
    hat: 'Top hat', car: 'Race car', dog: 'Scottie dog', cat: 'Cat', boot: 'Boot', ship: 'Battleship',
    horse: 'Horse', penguin: 'Penguin', trex: 'T-rex', duck: 'Rubber duck', house: 'House', money: 'Money'
  };
  var GLYPHS = window.PERSON_GLYPHS || {};

  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    function lin(c) { var v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  }
  function usableColor(hex) { return typeof hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(hex) && luminance(hex) < 0.6 ? hex.toUpperCase() : null; }
  /** Java's String.hashCode, so a person without a chosen colour gets the same one as in the Android app. */
  function javaHash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (31 * h + s.charCodeAt(i)) | 0; return h; }
  function automaticColor(uid) { return PERSON_COLORS[(javaHash(uid) & 0x7fffffff) % PERSON_COLORS.length][1]; }

  function glyphSvg(id, ink, bg) {
    var g = GLYPHS[id];
    if (!g) return '';
    if (g.text) return '<text x="24" y="39" font-size="46" font-weight="800" text-anchor="middle" fill="' + ink + '" font-family="-apple-system,Roboto,Arial,sans-serif">' + esc(g.text) + '</text>';
    var out = '';
    (g.fill || []).forEach(function (d) { out += '<path d="' + d + '" fill="' + ink + '"/>'; });
    (g.cut || []).forEach(function (d) { out += '<path d="' + d + '" fill="' + bg + '"/>'; });
    (g.fill2 || []).forEach(function (d) { out += '<path d="' + d + '" fill="' + ink + '"/>'; });
    return out;
  }
  /** Round badge: white ring, disc in the colour, white silhouette (or initial). */
  function badgeSvg(color, iconId, initial, size) {
    var r = 24, ring = 2.2, inner = GLYPHS[iconId] ? '<g transform="translate(8.2 8.2) scale(0.66)">' + glyphSvg(iconId, '#fff', color) + '</g>'
      : '<text x="24" y="31.5" font-size="22" font-weight="700" text-anchor="middle" fill="#fff" font-family="-apple-system,Roboto,Arial,sans-serif">' + esc((initial || '?').slice(0, 1).toUpperCase()) + '</text>';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48"><circle cx="24" cy="24" r="' + r + '" fill="#fff"/><circle cx="24" cy="24" r="' + (r - ring) + '" fill="' + color + '"/>' + inner + '</svg>';
  }
  /** The map marker: badge with the name on a pill underneath. Returns { html, w, h, anchorY }. */
  function personMarker(name, color, iconId) {
    var label = (name || 'Someone').slice(0, 14), circle = 36, gap = 3, pillH = 18;
    var w = Math.max(circle, Math.round(label.length * 7 + 16)) + 2, h = circle + gap + pillH;
    var cx = w / 2;
    var html = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<circle cx="' + cx + '" cy="' + (circle / 2 + 1.5) + '" r="' + (circle / 2 - 1) + '" fill="rgba(0,0,0,.27)"/>' +
      '<g transform="translate(' + (cx - circle / 2 + 1) + ' 1) scale(' + ((circle - 2) / 48) + ')">' + badgeSvg(color, iconId, label, 48).replace(/^<svg[^>]*>|<\/svg>$/g, '') + '</g>' +
      '<rect x="' + (cx - (w - 2) / 2) + '" y="' + (circle + gap) + '" width="' + (w - 2) + '" height="' + pillH + '" rx="9" fill="' + color + '"/>' +
      '<text x="' + cx + '" y="' + (circle + gap + 13) + '" font-size="11.5" font-weight="700" text-anchor="middle" fill="#fff" font-family="-apple-system,Roboto,Arial,sans-serif">' + esc(label) + '</text></svg>';
    return { html: html, w: w, h: h, anchorY: circle / 2 };
  }

  // ------------------------------------------------------------------ the map

  var DEARBORN = L.latLngBounds([38.935, -85.133], [39.308, -84.819]);
  var map = L.map('map', { zoomControl: true, doubleClickZoom: false, maxZoom: 20, minZoom: 5, attributionControl: true, worldCopyJump: false })
    .setView([39.1132, -84.935], 15);
  map.zoomControl.setPosition('bottomright');
  map.attributionControl.setPrefix(false);

  map.createPane('contours').style.zIndex = 410;
  map.createPane('parcels').style.zIndex = 420;
  map.createPane('trails').style.zIndex = 430;
  map.createPane('labels').style.zIndex = 440;
  map.createPane('me').style.zIndex = 650;
  map.getPane('labels').style.pointerEvents = 'none';
  var contourRenderer = L.canvas({ pane: 'contours', padding: 0.3 });
  var parcelRenderer = L.svg({ pane: 'parcels', padding: 0.3 });

  /** An ArcGIS map service with no tile cache: each tile is rendered for its Web Mercator box. */
  var ExportLayer = L.TileLayer.extend({
    getTileUrl: function (c) {
      var world = 2 * Math.PI * 6378137, size = world / Math.pow(2, c.z);
      var minX = -world / 2 + c.x * size, maxY = world / 2 - c.y * size;
      return this._url + '/export?bbox=' + minX + ',' + (maxY - size) + ',' + (minX + size) + ',' + maxY +
        '&bboxSR=3857&imageSR=3857&size=256,256&format=' + this.options.format + (this.options.transparentTiles ? '&transparent=true' : '') + '&f=image';
    }
  });

  var tiles = {
    esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 20, crossOrigin: true, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
    }),
    county: new ExportLayer('https://gis.dearborncounty.in.gov/arcgis/rest/services/Orthos/Orthos_2023/MapServer', {
      minZoom: 12, maxNativeZoom: 20, maxZoom: 20, bounds: DEARBORN, format: 'jpg', crossOrigin: true,
      attribution: 'Photos: Dearborn County, EagleView 2023'
    }),
    topo: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 16, maxZoom: 20, crossOrigin: true, attribution: 'USGS The National Map'
    }),
    street: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 20, crossOrigin: true, attribution: '© OpenStreetMap contributors'
    }),
    roads: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 20, crossOrigin: true, attribution: 'Roads © Esri'
    }),
    places: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 20, crossOrigin: true, attribution: 'Labels © Esri'
    }),
    usgsContours: new ExportLayer('https://carto.nationalmap.gov/arcgis/rest/services/contours/MapServer', {
      minZoom: 13, maxNativeZoom: 17, maxZoom: 20, format: 'png32', transparentTiles: true, crossOrigin: true,
      attribution: 'Contours: USGS'
    })
  };

  var BASES = [
    { id: 'county2023', label: 'Aerial photo – Dearborn County 2023 (sharpest)' },
    { id: 'topo', label: 'Topo map – USGS' },
    { id: 'street', label: 'Street map – OpenStreetMap' }
  ];
  var settings = {
    base: store.get('base', 'county2023'),
    labels: store.get('labels', false),
    parcelLabels: store.get('parcelLabels', true),
    contours: store.get('contours', true),
    usgsContours: store.get('usgsContours', false),
    landTrails: store.get('landTrails', true),
    landMarkers: store.get('landMarkers_on', true),
    wind: store.get('wind', false)
  };
  function isPhotoBase() { return settings.base === 'county2023'; }

  function applyTiles() {
    [tiles.esri, tiles.county, tiles.topo, tiles.street, tiles.roads, tiles.places, tiles.usgsContours].forEach(function (t) { if (map.hasLayer(t)) map.removeLayer(t); });
    if (settings.base === 'topo') tiles.topo.addTo(map);
    else if (settings.base === 'street') tiles.street.addTo(map);
    else { tiles.esri.addTo(map); tiles.county.addTo(map); }
    if (settings.usgsContours) tiles.usgsContours.addTo(map);
    if (settings.labels) { tiles.roads.addTo(map); tiles.places.addTo(map); }
    restyleContours();
  }

  // ------------------------------------------------------------------ parcels

  var ROLE_STYLE = {
    owned: { color: '#F2B705', weight: 3, fillOpacity: 0.20, label: 'Your land', chip: '#FFE08A' },
    // Every parcel that is not yours is blue; the Martins' land a darker blue (the owner's choice).
    adjoining: { color: '#4DA3FF', weight: 2, fillOpacity: 0.10, label: 'Adjoining parcel', chip: '#D3E6FF' },
    adjoining2: { color: '#4DA3FF', weight: 1.5, fillOpacity: 0.07, label: 'Second ring of neighbors', chip: '#D3E6FF' },
    rex: { color: '#1747C9', weight: 2.4, fillOpacity: 0.25, label: "Rex Martin's land", chip: '#BFCDF5' },
    sam: { color: '#1747C9', weight: 2.4, fillOpacity: 0.25, label: "Sam Martin's land (land contract)", chip: '#BFCDF5' },
    martin_adjoining: { color: '#4DA3FF', weight: 1.5, fillOpacity: 0.07, label: 'Neighbor of the Martins', chip: '#D3E6FF' },
    martin_adjoining2: { color: '#4DA3FF', weight: 1.2, fillOpacity: 0.07, label: 'Near the Martins', chip: '#D3E6FF' },
    nearby: { color: '#4DA3FF', weight: 1.1, fillOpacity: 0.05, label: 'Within a mile of your land', chip: '#D3E6FF' }
  };
  // Sharing works anywhere on the parcels drawn on the map (the owner widened it on Nov 11, 2026).
  var SHARING_ROLES = { owned: true, adjoining: true, adjoining2: true, rex: true, sam: true, martin_adjoining: true, martin_adjoining2: true, nearby: true };
  var MARTIN_ROLES = { rex: true, sam: true, martin_adjoining: true, martin_adjoining2: true };
  var parcels = [];       // { feature, role, name, geometry, area, center, bbox }
  var parcelLayer = L.layerGroup().addTo(map);
  var martinLayer = L.layerGroup();
  // Light-blue parcels (everything that is neither yours nor the Martins'): hidden when zoomed well out.
  var neighborsLayer = L.layerGroup();
  var martinNeighborsLayer = L.layerGroup();
  var LIGHT_BLUE = { adjoining: true, adjoining2: true, martin_adjoining: true, martin_adjoining2: true, nearby: true };
  var parcelLabelLayer = L.layerGroup();
  var martinLabelLayer = L.layerGroup();

  function roleOf(props) { var r = props && props.role; return ROLE_STYLE[r] ? r : 'owned'; }
  function bboxOf(geometry) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    polygonsOf(geometry).forEach(function (poly) { poly[0].forEach(function (c) { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }); });
    return b;
  }

  function loadParcels(fc) {
    parcels = fc.features.filter(function (f) { return polygonsOf(f.geometry).length; }).map(function (f) {
      var role = roleOf(f.properties);
      return { feature: f, props: f.properties || {}, role: role, name: (f.properties && f.properties.name) || 'Parcel', geometry: f.geometry, area: areaOf(f.geometry), center: centroidOf(f.geometry), bbox: bboxOf(f.geometry) };
    });
    // Outer rings first, so your own land is drawn on top.
    var order = { nearby: 0, martin_adjoining2: 1, martin_adjoining: 2, adjoining2: 3, adjoining: 4, rex: 5, sam: 6, owned: 7 };
    parcels.slice().sort(function (a, b) { return order[a.role] - order[b.role]; }).forEach(function (p) {
      var s = ROLE_STYLE[p.role];
      var martin = !!MARTIN_ROLES[p.role];
      L.geoJSON(p.feature, {
        renderer: parcelRenderer, interactive: false,
        style: { color: s.color, weight: s.weight, opacity: 1, fillColor: s.color, fillOpacity: s.fillOpacity }
      }).addTo(LIGHT_BLUE[p.role] ? (martin ? martinNeighborsLayer : neighborsLayer) : (martin ? martinLayer : parcelLayer));
      // No labels for the many parcels within a mile, to keep the map light on phones.
      if (p.center && acresOf(p) > 0 && p.role !== 'nearby') {
        var acres = acresOf(p);
        L.tooltip({ permanent: true, direction: 'center', className: 'parcel-label', pane: 'labels', interactive: false })
          .setLatLng([p.center.lat, p.center.lon]).setContent(acres > 0 ? acres.toFixed(1) + ' ac' : '').addTo(martin ? martinLabelLayer : parcelLabelLayer);
      }
    });
    updateParcelLabels();
  }
  function acresOf(p) {
    var a = parseFloat(p.props.Acreage);
    return a > 0 ? a : p.area / 4046.8564224;
  }
  function updateParcelLabels() {
    var show = settings.parcelLabels && map.getZoom() >= 16;
    if (show && !map.hasLayer(parcelLabelLayer)) parcelLabelLayer.addTo(map);
    if (!show && map.hasLayer(parcelLabelLayer)) map.removeLayer(parcelLabelLayer);
    var showMartin = show;
    if (showMartin && !map.hasLayer(martinLabelLayer)) martinLabelLayer.addTo(map);
    if (!showMartin && map.hasLayer(martinLabelLayer)) map.removeLayer(martinLabelLayer);
  }
  function showLayer(layer, on) {
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
  function updateMartin() {
    var near = map.getZoom() >= 13;
    showLayer(martinLayer, true);
    showLayer(neighborsLayer, near);
    showLayer(martinNeighborsLayer, near);
    updateParcelLabels();
  }
  /** The parcel under a point, preferring your own land over a neighbor's where they overlap. */
  function parcelAt(lat, lon) {
    var hits = parcels.filter(function (p) { return lon >= p.bbox[0] && lon <= p.bbox[2] && lat >= p.bbox[1] && lat <= p.bbox[3] && inGeometry(lat, lon, p.geometry); });
    var rank = { owned: 0, adjoining: 1, adjoining2: 2, rex: 3, sam: 3, martin_adjoining: 4, martin_adjoining2: 5, nearby: 6 };
    hits.sort(function (a, b) { return rank[a.role] - rank[b.role]; });
    return hits[0] || null;
  }
  /** The family sharing area: every parcel drawn on the map. */
  function inSharingArea(lat, lon) { return parcels.some(function (p) { return SHARING_ROLES[p.role] && inGeometry(lat, lon, p.geometry); }); }
  function ownedParcels() { return parcels.filter(function (p) { return p.role === 'owned'; }); }

  // ------------------------------------------------------------------ 5 ft contours (bundled)

  var contourData = null, contourCasing = null, contourLine = null, contourMinorShown = null;
  // Zoomed well out: no contours; a little closer: the 25 ft lines; closer still: all 5 ft lines (as in the Android app).
  function contourLevel() { var z = map.getZoom(); return z < 13 ? 0 : z < 14 ? 1 : 2; }
  function contourFilter(f) { return f.properties.index || contourLevel() === 2; }
  function buildContours() {
    if (!contourData) return;
    [contourCasing, contourLine].forEach(function (l) { if (l) map.removeLayer(l); });
    contourMinorShown = contourLevel();
    if (!settings.contours || contourMinorShown === 0) return;
    contourCasing = L.geoJSON(contourData, { renderer: contourRenderer, interactive: false, filter: function (f) { return f.properties.index; }, style: casingStyle }).addTo(map);
    contourLine = L.geoJSON(contourData, { renderer: contourRenderer, interactive: false, filter: contourFilter, style: lineStyle }).addTo(map);
  }
  // Only the 25 ft index lines get a dark edge; the 5 ft lines in between stay thin so a wide view is not busy.
  function casingStyle(f) {
    var idx = f.properties.index;
    return { color: isPhotoBase() ? '#000000' : '#FFFFFF', opacity: idx ? (isPhotoBase() ? 0.5 : 0.6) : 0, weight: idx ? 3.2 : 0, lineCap: 'round', lineJoin: 'round' };
  }
  function lineStyle(f) {
    var idx = f.properties.index;
    return { color: isPhotoBase() ? '#FFFFFF' : '#8B5A2B', opacity: idx ? 0.95 : (isPhotoBase() ? 0.55 : 0.5), weight: idx ? 1.5 : 0.7, lineCap: 'round', lineJoin: 'round' };
  }
  function restyleContours() {
    if (contourCasing) contourCasing.setStyle(casingStyle);
    if (contourLine) contourLine.setStyle(lineStyle);
  }

  // ------------------------------------------------------------------ GPS

  var me = { raw: null, est: null, watch: null, denied: false, follow: true, firstFix: true };
  var meDot = L.marker([0, 0], { pane: 'me', interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) });
  var meCircle = L.circle([0, 0], { radius: 1, pane: 'me', interactive: false, color: '#1A73E8', weight: 1, opacity: 0.5, fillOpacity: 0.12 });

  /**
   * A small smoothing filter like the Android app's: positions are blended by their reported accuracy, and
   * the expected wander grows with time and speed, so a still phone stays still and a walking one keeps up.
   */
  function smooth(fix) {
    var e = me.est;
    if (!e || fix.time - e.time > 60000) { me.est = { lat: fix.lat, lon: fix.lon, var: fix.acc * fix.acc, time: fix.time, acc: fix.acc }; return; }
    var dt = Math.max(0, (fix.time - e.time) / 1000);
    var speed = fix.speed != null && fix.speed >= 0 ? fix.speed : 1.0;
    var variance = e.var + dt * (0.5 + speed * speed * 2);
    var k = variance / (variance + fix.acc * fix.acc);
    me.est = {
      lat: e.lat + k * (fix.lat - e.lat), lon: e.lon + k * (fix.lon - e.lon),
      var: (1 - k) * variance, time: fix.time, acc: Math.sqrt((1 - k) * variance)
    };
  }

  function startGps() {
    if (!('geolocation' in navigator)) { me.denied = true; renderStatus(); return; }
    if (me.watch !== null) return;
    me.watch = navigator.geolocation.watchPosition(function (pos) {
      var c = pos.coords;
      var fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 100, speed: c.speed, time: pos.timestamp || Date.now() };
      me.denied = false;
      me.raw = fix;
      if (fix.acc <= 60 || !me.est) smooth(fix);
      drawMe();
      renderStatus();
    }, function (err) {
      if (err.code === 1) { me.denied = true; me.watch = null; }
      renderStatus();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 });
  }

  function drawMe() {
    var e = me.est;
    if (!e) return;
    var ll = [e.lat, e.lon];
    meDot.setLatLng(ll); meCircle.setLatLng(ll); meCircle.setRadius(Math.max(3, e.acc));
    if (!map.hasLayer(meDot)) { meCircle.addTo(map); meDot.addTo(map); }
    if (me.firstFix) {
      me.firstFix = false;
      // Only jump to the phone if it is near the land; otherwise the map stays on the land.
      if (inSharingArea(e.lat, e.lon) || ownedParcels().some(function (p) { return p.center && haversine(e, p.center) < 5000; })) map.setView(ll, Math.max(map.getZoom(), 16));
      else me.follow = false;
      $('btn-locate').classList.toggle('following', me.follow);
    } else if (me.follow) {
      map.panTo(ll, { animate: true });
    }
  }
  map.on('dragstart', function () { me.follow = false; $('btn-locate').classList.remove('following'); });
  $('btn-locate').addEventListener('click', function () {
    if (me.denied) {
      toast('Location is blocked for this page. Allow it in Settings > Privacy > Location Services > Safari Websites (iPhone), then reload.', 7000);
      return;
    }
    startGps();
    me.follow = true;
    this.classList.add('following');
    if (me.est) map.setView([me.est.lat, me.est.lon], Math.max(map.getZoom(), 17));
    else toast('Finding your location…');
  });

  // ------------------------------------------------------------------ status card

  var statusCollapsed = store.get('statusCollapsed', false);
  $('status').classList.toggle('collapsed', statusCollapsed);
  $('status-toggle').addEventListener('click', function () {
    statusCollapsed = !statusCollapsed;
    store.set('statusCollapsed', statusCollapsed);
    $('status').classList.toggle('collapsed', statusCollapsed);
    $('status-toggle').setAttribute('aria-expanded', String(!statusCollapsed));
    syncStatusHeight();
  });
  function syncStatusHeight() { document.documentElement.style.setProperty('--status-h', $('status').offsetHeight + 'px'); }
  if (window.ResizeObserver) new ResizeObserver(syncStatusHeight).observe($('status'));

  function renderStatus() {
    var lines = [], title;
    var e = me.est;
    if (!e) {
      title = me.denied ? 'Location is off' : 'Waiting for GPS';
      if (me.denied) lines.push('Allow location for this page to see where you are.');
    } else {
      var here = parcelAt(e.lat, e.lon);
      title = !here ? 'Outside the mapped parcels' : here.role === 'owned' ? 'On your land' : here.role === 'adjoining' ? "On a neighbor's parcel" : here.role === 'adjoining2' ? 'On a nearby parcel' : ROLE_STYLE[here.role].label;
      if (here) lines.push(esc(here.name) + ' · ' + acresOf(here).toFixed(1) + ' acres');
      var owned = ownedParcels();
      if (owned.length) {
        var d = Math.min.apply(null, owned.map(function (p) { return distanceToEdges(e, p.geometry); }));
        if (d < 3000) lines.push((here && here.role === 'owned' ? 'Boundary line ' : 'Your land ') + formatDistance(d) + ' away');
      }
      var feet = elevation.feetAt(e.lat, e.lon);
      if (feet !== null) lines.push('Elevation ' + Math.round(feet).toLocaleString('en-US') + ' ft');
      lines.push('GPS accurate to ±' + Math.round(e.acc * FEET_PER_METER) + ' ft · ' + fmtCoord(e));
    }
    if (settings.wind) lines.push(esc(weather.windSummary()));
    if (family.code && store.get('share', false)) lines.push(esc(family.statusText));
    if (family.others.length) {
      lines.push(family.others.slice(0, 4).map(function (p) {
        return esc(p.name) + (e ? ' ' + formatDistance(haversine(e, p)) + ' ' + compass(bearing(e, p)).split(' ')[0] : '');
      }).join(' · '));
    }
    $('status-title').textContent = title;
    $('status-body').innerHTML = lines.map(function (l) { return '<div>' + l + '</div>'; }).join('');
    syncStatusHeight();
  }

  // ------------------------------------------------------------------ taps: double tap a parcel for its information

  var lastTap = null, singleTapTimer = null;
  map.on('click', function (ev) {
    var now = Date.now();
    if (lastTap && now - lastTap.t < 420 && lastTap.p.distanceTo(ev.containerPoint) < 40) {
      lastTap = null;
      clearTimeout(singleTapTimer);
      var hit = parcelAt(ev.latlng.lat, ev.latlng.lng);
      if (hit) showParcel(hit);
      else map.setZoomAround(ev.latlng, Math.min(map.getMaxZoom(), map.getZoom() + 1));
      return;
    }
    lastTap = { t: now, p: ev.containerPoint };
    clearTimeout(singleTapTimer);
    singleTapTimer = setTimeout(function () { if (!$('sheet').hidden) hideSheet(); }, 430);
  });

  function hideSheet() { $('sheet').hidden = true; }
  $('sheet-close').addEventListener('click', hideSheet);

  function showParcel(p) {
    var s = ROLE_STYLE[p.role], props = p.props;
    var number = props.ALTPin || props.PIN || '';
    var rows = [
      ['Parcel number', number], ['State PIN', props.PIN], ['Zoning', props.Zoning], ['Tax district', props.TAXDISTRICT],
      ['Deed instrument', props.DeedInstNu], ['Survey instrument', props.SurvInstNu], ['Subdivision', props.Subdivision],
      ['Buildable', props.Buildable_NonBuildable]
    ].filter(function (r) { return r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== '' && String(r[1]) !== '0'; });
    var body = $('sheet-body');
    body.innerHTML = '<h2>' + esc(p.name) + '</h2>' +
      '<span class="chip" style="background:' + s.chip + ';color:#1B1C18">' + s.label + '</span>' +
      '<div class="big">' + acresOf(p).toFixed(2) + ' acres</div>' +
      '<table>' + rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>' +
      '<div class="note">From Dearborn County GIS. For reference only, not a legal survey.</div>';
    var actions = el('div', { class: 'row' }, [
      el('button', { class: 'btn', text: 'Zoom to parcel', onclick: function () { map.fitBounds(L.geoJSON(p.feature).getBounds(), { padding: [40, 40] }); hideSheet(); } }),
      number ? el('button', { class: 'btn', text: 'Copy parcel number', onclick: function () { copyText(number); } }) : null,
      number ? el('button', { class: 'btn', text: 'Property record', onclick: function () { copyText(number, number + ' (paste it into the search)'); window.open('https://beacon.schneidercorp.com/', '_blank', 'noopener'); } }) : null,
      el('button', { class: 'btn', text: 'Recorded surveys', onclick: function () { showSurveys(p); } })
    ]);
    body.appendChild(actions);
    $('sheet').hidden = false;
  }

  function showSurveys(p) {
    var rings = [];
    polygonsOf(p.geometry).forEach(function (poly) { rings.push(poly[0]); });
    var params = new URLSearchParams({
      where: '1=1', geometry: JSON.stringify({ rings: rings, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolygon',
      inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json'
    });
    toast('Looking up recorded surveys…');
    fetch('https://gis.dearborncounty.in.gov/arcgis/rest/services/Planning/CertifiedSurveys/MapServer/0/query', { method: 'POST', body: params })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var seen = {}, list = (json.features || []).map(function (f) { return f.attributes || {}; })
          .filter(function (a) { var u = String(a.CertSurveySecPlat || '').trim(); if (!/^http/.test(u) || seen[u]) return false; seen[u] = true; return true; })
          .sort(function (a, b) { return (b.DateReleased || 0) - (a.DateReleased || 0); });
        var body = el('div');
        if (!list.length) body.appendChild(el('p', { text: 'The county has no recorded surveys touching this parcel.' }));
        list.forEach(function (a) {
          var when = a.DateReleased ? new Date(a.DateReleased).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Undated';
          var url = String(a.CertSurveySecPlat).trim().replace(/^http:\/\//, 'https://');
          body.appendChild(el('p', {}, [
            el('a', { href: url, target: '_blank', rel: 'noopener', text: when + ' – ' + (String(a.OwnerLastName || '').trim() || 'Survey') }),
            el('div', { class: 'note', text: [String(a.RoadName || '').trim(), a['Shape.STArea()'] ? (a['Shape.STArea()'] / 43560).toFixed(1) + ' acres' : ''].filter(Boolean).join(' · ') })
          ]));
        });
        body.appendChild(el('p', { class: 'note', text: 'The county draws survey areas loosely, so this can include surveys of neighboring land.' }));
        openDialog('Recorded surveys', body);
      })
      .catch(function () { toast('Could not reach the county server. Try again with a signal.'); });
  }

  // ------------------------------------------------------------------ dialogs

  var dlg = $('dlg');
  function openDialog(title, body, actions) {
    $('dlg-title').textContent = title;
    var holder = $('dlg-body');
    holder.innerHTML = '';
    holder.appendChild(body);
    var bar = $('dlg-actions');
    bar.innerHTML = '';
    (actions || []).forEach(function (a) {
      bar.appendChild(el('button', { type: 'button', class: 'btn' + (a.primary ? ' primary' : ''), text: a.label, onclick: function () { a.onClick(); } }));
    });
    bar.appendChild(el('button', { value: 'close', class: 'btn', text: 'Close' }));
    if (dlg.open) dlg.close();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function closeDialog() { if (dlg.open) dlg.close(); }

  // ------------------------------------------------------------------ layers

  $('btn-layers').addEventListener('click', function () {
    var body = el('div');
    body.appendChild(el('h3', { text: 'Base map' }));
    BASES.forEach(function (b) {
      var input = el('input', { type: 'radio', name: 'base', value: b.id });
      input.checked = settings.base === b.id;
      input.addEventListener('change', function () { settings.base = b.id; store.set('base', b.id); applyTiles(); });
      body.appendChild(el('label', { class: 'opt' }, [input, b.label]));
    });
    body.appendChild(el('h3', { text: 'Show on top' }));
    function toggle(key, label, onChange) {
      var input = el('input', { type: 'checkbox' });
      input.checked = !!settings[key];
      // 'landMarkers' is also where the markers themselves are saved, so its switch is stored by onChange instead.
      input.addEventListener('change', function () { settings[key] = input.checked; if (key !== 'landMarkers') store.set(key, input.checked); onChange(); });
      body.appendChild(el('label', { class: 'opt' }, [input, label]));
    }
    toggle('labels', 'Roads and place names', applyTiles);
    toggle('parcelLabels', 'Parcel acreage labels (when zoomed in)', updateParcelLabels);
    toggle('contours', '5 ft contours – around the land (works offline)', buildContours);
    toggle('usgsContours', '10 ft contours – USGS (needs internet)', applyTiles);
    toggle('wind', 'Wind direction and speed', function () { windLayer.update(); if (settings.wind && weather.isStale()) weather.refresh().catch(function () {}); renderStatus(); });
    toggle('landTrails', 'Land trails (published by the owner)', function () { landTrails.show(settings.landTrails); });
    toggle('landMarkers', 'Land markers (stands, gates… published by the owner)', function () { store.set('landMarkers_on', settings.landMarkers); landMarkers.show(settings.landMarkers); });
    var trailNote = el('div', { class: 'note', text: landTrails.summary() + ' ' + landMarkers.summary() + '.' });
    body.appendChild(trailNote);
    body.appendChild(el('button', {
      type: 'button', class: 'btn', text: 'Check for new trails and markers now', onclick: function () {
        landTrails.check(true).then(function (msg) {
          return landMarkers.check().then(function (msg2) { trailNote.textContent = landTrails.summary() + ' ' + landMarkers.summary() + '.'; toast(msg + ' ' + msg2); });
        });
      }
    }));
    openDialog('Map layers', body);
  });

  // ------------------------------------------------------------------ Firebase (same project and rules as the Android app)

  var config = null;
  var fb = {
    idToken: null, expiresAt: 0,
    auth: function () { return store.get('auth', null); },
    pending: null,
    /** A valid sign-in token. Calls made while one is being fetched share it, so the phone never signs up twice. */
    ensure: function (force) {
      var self = this;
      if (!force && self.idToken && Date.now() < self.expiresAt - 60000) return Promise.resolve(self.idToken);
      if (self.pending) return self.pending;
      self.pending = self.fetchToken().then(function (t) { self.pending = null; return t; }, function (e) { self.pending = null; throw e; });
      return self.pending;
    },
    fetchToken: function () {
      var self = this;
      var saved = self.auth();
      var refresh = saved && saved.refresh ? fetch('https://securetoken.googleapis.com/v1/token?key=' + config.apiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(saved.refresh)
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j) return null;
        return { idToken: j.id_token, refresh: j.refresh_token, expiresIn: +j.expires_in, uid: j.user_id };
      }).catch(function () { return null; }) : Promise.resolve(null);
      return refresh.then(function (got) {
        if (got) return got;
        return fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + config.apiKey, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true })
        }).then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) {
              var m = (j.error && j.error.message) || ('error ' + r.status);
              throw new Error(/OPERATION_NOT_ALLOWED/.test(m) ? 'Anonymous sign-in is not turned on in the Firebase project.' : 'Sign-in failed: ' + m);
            }
            return { idToken: j.idToken, refresh: j.refreshToken, expiresIn: +j.expiresIn, uid: j.localId };
          });
        });
      }).then(function (t) {
        self.idToken = t.idToken;
        self.expiresAt = Date.now() + t.expiresIn * 1000;
        store.set('auth', { refresh: t.refresh, uid: t.uid });
        return t.idToken;
      });
    },
    uid: function () { var a = this.auth(); return a && a.uid; },
    request: function (method, path, body, retried) {
      var self = this;
      return self.ensure(!!retried).then(function (token) {
        return fetch(config.databaseUrl + '/' + path + '.json?auth=' + encodeURIComponent(token), {
          method: method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined
        });
      }).then(function (r) {
        if (r.status === 401 && !retried) return self.request(method, path, body, true);
        if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'The database refused the request (check the database rules).' : 'Server error ' + r.status);
        return r.text().then(function (t) { return t && t !== 'null' ? JSON.parse(t) : null; });
      });
    },
    /** Best effort removal while the page is being closed. */
    deleteOnExit: function (path) {
      if (!this.idToken || Date.now() > this.expiresAt) return;
      try { fetch(config.databaseUrl + '/' + path + '.json?auth=' + encodeURIComponent(this.idToken), { method: 'DELETE', keepalive: true }); } catch (e) { /* ignore */ }
    }
  };

  // ------------------------------------------------------------------ family location sharing

  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function newCode() {
    var bytes = new Uint32Array(16), out = '';
    crypto.getRandomValues(bytes);
    for (var i = 0; i < 16; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }
  function normalizeCode(input) {
    var s = String(input || '').toUpperCase().replace(/[-\s]/g, '');
    return s.length === 16 && s.split('').every(function (c) { return CODE_ALPHABET.indexOf(c) >= 0; }) ? s : null;
  }
  function formatCode(code) { return code.match(/.{1,4}/g).join('-'); }

  var family = {
    code: store.get('code', null),
    others: [],
    published: false,
    statusText: 'Off',
    timer: null,
    layer: L.layerGroup().addTo(map),
    markers: {}
  };

  function myColor() { return usableColor(store.get('color', null)) || automaticColor(fb.uid() || 'you'); }

  function sharingTick() {
    var code = family.code;
    if (!config || !code || !store.get('share', false) || document.hidden) return Promise.resolve();
    var uid;
    return fb.ensure().then(function () {
      uid = fb.uid();
      var e = me.est;
      var fresh = e && Date.now() - e.time < 90000 && e.acc <= 50;
      var inside = fresh && inSharingArea(e.lat, e.lon);
      if (inside) {
        var body = { name: (store.get('name', '') || 'Someone').slice(0, 30), lat: +e.lat.toFixed(7), lon: +e.lon.toFixed(7), t: Date.now(), acc: Math.round(e.acc * 10) / 10 };
        var color = usableColor(store.get('color', null)), icon = store.get('icon', null);
        if (color) body.color = color;
        if (icon && GLYPHS[icon]) body.icon = icon;
        family.statusText = 'Sharing your position';
        return fb.request('PUT', 'groups/' + code + '/members/' + uid, body).then(function () { family.published = true; });
      }
      family.statusText = !e ? 'Waiting for GPS' : !fresh ? 'Waiting for a good GPS fix' : 'You are outside the shared area: your position is not shared';
      if (family.published) return fb.request('DELETE', 'groups/' + code + '/members/' + uid).then(function () { family.published = false; });
    }).then(function () {
      return fb.request('GET', 'groups/' + code + '/members');
    }).then(function (all) {
      var now = Date.now(), list = [];
      Object.keys(all || {}).forEach(function (key) {
        var o = all[key];
        if (key === uid || !o || typeof o.lat !== 'number' || typeof o.lon !== 'number') return;
        if (now - (o.t || 0) > 3 * 60 * 1000) return;
        if (!inSharingArea(o.lat, o.lon)) return;
        list.push({ uid: key, name: String(o.name || 'Someone'), lat: o.lat, lon: o.lon, t: o.t, acc: o.acc, color: usableColor(o.color) || automaticColor(key), icon: GLYPHS[o.icon] ? o.icon : null });
      });
      family.others = list;
      family.statusText += ' · ' + (list.length ? list.length + ' other' + (list.length === 1 ? '' : 's') + ' in the area' : 'nobody else in the area');
    }).catch(function (err) {
      family.statusText = "Can't reach the sharing server: " + (err && err.message ? err.message : 'no connection');
    }).then(function () {
      drawPeople();
      renderStatus();
      var live = $('family-status');
      if (live) live.textContent = family.statusText;
    });
  }

  function drawPeople() {
    var keep = {};
    family.others.forEach(function (p) {
      keep[p.uid] = true;
      var m = personMarker(p.name, p.color, p.icon);
      var key = p.name + p.color + p.icon;
      var existing = family.markers[p.uid];
      if (existing && existing.key === key) { existing.marker.setLatLng([p.lat, p.lon]); existing.person = p; return; }
      if (existing) family.layer.removeLayer(existing.marker);
      var marker = L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: 'person-icon', html: m.html, iconSize: [m.w, m.h], iconAnchor: [m.w / 2, m.anchorY] }),
        keyboard: false, title: p.name
      }).addTo(family.layer);
      var entry = { marker: marker, key: key, person: p };
      marker.on('click', function () { showPerson(entry.person); });
      family.markers[p.uid] = entry;
    });
    Object.keys(family.markers).forEach(function (uid) {
      if (!keep[uid]) { family.layer.removeLayer(family.markers[uid].marker); delete family.markers[uid]; }
    });
  }

  function showPerson(p) {
    var lines = ['Updated ' + timeAgo(p.t)];
    if (me.est) lines.push(formatDistance(haversine(me.est, p)) + ' ' + compass(bearing(me.est, p)) + ' from you');
    lines.push(fmtCoord(p));
    if (p.acc) lines.push('Accurate to about ' + Math.round(p.acc * FEET_PER_METER) + ' ft');
    var body = el('div', {}, lines.map(function (l) { return el('p', { text: l }); }));
    openDialog(p.name, body, [{ label: 'Copy coordinates', onClick: function () { copyText(fmtCoord(p)); } }]);
  }

  function startSharingLoop() {
    if (family.timer) return;
    sharingTick();
    family.timer = setInterval(sharingTick, 15000);
  }
  function stopSharing() {
    clearInterval(family.timer);
    family.timer = null;
    var code = family.code, uid = fb.uid();
    var done = family.published && code && uid ? fb.request('DELETE', 'groups/' + code + '/members/' + uid).catch(function () {}) : Promise.resolve();
    family.published = false;
    family.others = [];
    family.statusText = 'Off';
    drawPeople();
    renderStatus();
    return done;
  }

  // A browser cannot run in the background: take this phone off the map while the page is hidden.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (family.published && family.code) { fb.deleteOnExit('groups/' + family.code + '/members/' + fb.uid()); family.published = false; }
    } else {
      if (store.get('share', false) && family.code) sharingTick();
      landTrails.checkIfDue(); landMarkers.checkIfDue();
    }
  });
  window.addEventListener('pagehide', function () {
    if (family.published && family.code) fb.deleteOnExit('groups/' + family.code + '/members/' + fb.uid());
  });

  $('btn-family').addEventListener('click', openFamily);

  function openFamily() {
    if (!config) { openDialog('Family', el('p', { text: 'Family sharing is not set up on this site.' })); return; }
    var body = el('div');
    var on = !!store.get('share', false);
    var name = el('input', { type: 'text', placeholder: 'Your name (shown to the others)', maxlength: '30', autocomplete: 'given-name' });
    name.value = store.get('name', '');
    name.addEventListener('input', function () { store.set('name', name.value.trim()); paintLook(); });
    body.appendChild(name);

    body.appendChild(el('h3', { text: 'Your icon and color on the map' }));
    var preview = el('div', { style: 'text-align:center;margin:4px 0' });
    var grid = el('div', { class: 'tokens' });
    var swatches = el('div', { class: 'swatches', style: 'margin-top:10px' });
    function paintLook() {
      var color = myColor(), icon = store.get('icon', null);
      var m = personMarker(name.value.trim() || 'You', color, icon);
      preview.innerHTML = m.html;
      grid.innerHTML = '';
      (window.PERSON_GLYPH_ORDER || Object.keys(GLYPHS)).forEach(function (id) {
        var b = el('button', { type: 'button', class: 'token' + (icon === id ? ' on' : ''), title: TOKEN_LABELS[id] || id, 'aria-label': TOKEN_LABELS[id] || id, html: badgeSvg(color, id, '', 48) });
        b.addEventListener('click', function () { store.set('icon', icon === id ? null : id); paintLook(); });
        grid.appendChild(b);
      });
      swatches.innerHTML = '';
      var chosen = usableColor(store.get('color', null));
      PERSON_COLORS.forEach(function (c) {
        var s = el('button', { type: 'button', class: 'swatch' + (chosen === c[1] ? ' on' : ''), title: c[0], 'aria-label': c[0], style: 'background:' + c[1] });
        s.addEventListener('click', function () { store.set('color', chosen === c[1] ? null : c[1]); paintLook(); });
        swatches.appendChild(s);
      });
    }
    body.appendChild(preview);
    body.appendChild(grid);
    body.appendChild(swatches);
    body.appendChild(el('div', { class: 'note', text: 'Tap a choice again to clear it. With no icon you show as your initial; with no color you get one automatically.' }));
    paintLook();

    body.appendChild(el('h3', { text: 'Family code' }));
    body.appendChild(el('div', { class: 'mono', text: family.code ? formatCode(family.code) : 'No code yet' }));
    var codeRow = el('div', { class: 'row' });
    codeRow.appendChild(el('button', { type: 'button', class: 'btn', text: 'Join with a code I was given', onclick: joinCode }));
    if (family.code) {
      codeRow.appendChild(el('button', { type: 'button', class: 'btn', text: 'Send the code', onclick: function () { shareCode(family.code); } }));
      codeRow.appendChild(el('button', { type: 'button', class: 'btn', text: 'Leave this group', onclick: leaveGroup }));
    } else {
      codeRow.appendChild(el('button', { type: 'button', class: 'btn', text: 'Create a new family code', onclick: function () { family.code = newCode(); store.set('code', family.code); landTrails.check(false); landMarkers.check(); openFamily(); } }));
    }
    body.appendChild(codeRow);

    var sw = el('input', { type: 'checkbox' });
    sw.checked = on;
    sw.addEventListener('change', function () {
      if (sw.checked) {
        if (!name.value.trim()) { sw.checked = false; toast('Enter your name first'); return; }
        if (!family.code) { sw.checked = false; toast('Join or create a family code first'); return; }
        store.set('share', true);
        startGps();
        startSharingLoop();
      } else {
        store.set('share', false);
        stopSharing();
      }
      $('family-status').textContent = sw.checked ? 'Starting…' : 'Off';
    });
    body.appendChild(el('label', { class: 'switch-row' }, [sw, 'Share and see family locations']));
    body.appendChild(el('div', { id: 'family-status', class: 'note', text: on ? family.statusText : 'Off' }));
    body.appendChild(el('p', {
      class: 'note',
      text: 'Your position is sent only while you are on the parcels drawn on the map (your land, everything within about a mile, and the Martin land), and only while this page is open on your screen ' +
        '(a web page cannot share in the background; the Android app can). When you leave the area, close the page or switch this off, your marker disappears for everyone. ' +
        'Only people with your family code can see you. The family code also brings you the land trails the owner publishes.'
    }));
    openDialog('Family', body);
  }

  function joinCode() {
    var input = el('input', { type: 'text', placeholder: 'ABCD-EFGH-JKMN-PQRS', autocapitalize: 'characters', autocomplete: 'off', class: 'mono' });
    var err = el('div', { class: 'err' });
    var body = el('div', {}, [el('p', { text: "Enter the code the group's owner sent you." }), input, err]);
    openDialog('Join a family group', body, [{
      label: 'Join', primary: true, onClick: function () {
        var code = normalizeCode(input.value);
        if (!code) { err.textContent = 'A code is 16 letters and numbers.'; return; }
        stopSharing().then(function () {
          family.code = code;
          store.set('code', code);
          toast('Joined the family group');
          landTrails.check(false); landMarkers.check();
          openFamily();
        });
      }
    }]);
    setTimeout(function () { input.focus(); }, 50);
  }

  function leaveGroup() {
    if (!confirm('Leave this family group? You will stop seeing the others and the land trails.')) return;
    stopSharing().then(function () {
      store.set('share', false);
      family.code = null;
      store.set('code', null);
      landTrails.clear(); landMarkers.clear();
      openFamily();
    });
  }

  function shareCode(code) {
    var text = 'Join the Haasewald family map. Android: install the app, then menu > My land > Family location sharing > Join with a code I was given. ' +
      'iPhone: open ' + location.href.split('#')[0].split('?')[0] + ' in Safari, tap the family button, then Join with a code. Code: ' + formatCode(code);
    if (navigator.share) navigator.share({ text: text }).catch(function () {});
    else copyText(text, 'the invitation with the code');
  }

  // ------------------------------------------------------------------ land trails (published by the owner from the Android app)

  var landTrails = {
    list: [],
    layer: L.layerGroup(),
    CHECK_EVERY_MS: 6 * 3600 * 1000,
    loadCache: function () { this.list = this.parse(store.get('trails', null)); this.draw(); },
    parse: function (raw) {
      if (!raw || typeof raw !== 'object') return [];
      return Object.keys(raw).map(function (id) {
        var o = raw[id] || {};
        var pts = decodePath(String(o.pts || ''));
        return { id: id, name: String(o.name || 'Trail'), color: /^#[0-9A-Fa-f]{6}$/.test(o.color) ? o.color : '#1E88E5', points: pts, t: o.t || 0 };
      }).filter(function (t) { return t.points.length >= 2; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    },
    draw: function () {
      var self = this;
      self.layer.clearLayers();
      self.list.forEach(function (t) {
        var ll = t.points.map(function (p) { return [p.lat, p.lon]; });
        var open = function () { self.showTrail(t); };
        L.polyline(ll, { pane: 'trails', color: '#000', opacity: 0.6, weight: 7.5, lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false }).on('click', open).addTo(self.layer);
        L.polyline(ll, { pane: 'trails', color: t.color, opacity: 1, weight: 4.5, lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false }).on('click', open).addTo(self.layer);
      });
    },
    show: function (on) { if (on && !map.hasLayer(this.layer)) this.layer.addTo(map); if (!on && map.hasLayer(this.layer)) map.removeLayer(this.layer); },
    showTrail: function (t) {
      var body = el('div', {}, [el('p', { text: formatDistance(pathLength(t.points)) + ' long' }), el('p', { text: 'Updated ' + timeAgo(t.t) })]);
      openDialog(t.name, body, [{
        label: 'Zoom to trail', onClick: function () {
          closeDialog();
          map.fitBounds(L.latLngBounds(t.points.map(function (p) { return [p.lat, p.lon]; })), { padding: [40, 40] });
        }
      }]);
    },
    summary: function () {
      if (!family.code) return 'Join your family group to receive the land trails (family button, top right).';
      var at = store.get('trailsAt', 0), n = this.list.length;
      return (n === 1 ? '1 trail' : n + ' trails') + (at ? '. Checked ' + timeAgo(at) + '.' : '. Not checked yet.');
    },
    checkIfDue: function () { if (Date.now() - store.get('trailsAt', 0) >= this.CHECK_EVERY_MS) this.check(false); },
    check: function (userAsked) {
      var self = this;
      if (!config || !family.code) return Promise.resolve('Join your family group first (family button, top right).');
      return fb.request('GET', 'groups/' + family.code + '/trails').then(function (raw) {
        var list = self.parse(raw);
        store.set('trails', raw || {});
        store.set('trailsAt', Date.now());
        self.list = list;
        self.draw();
        return list.length ? 'Land trails up to date (' + list.length + ').' : 'No land trails have been published yet.';
      }).catch(function (err) {
        return 'Could not check for new land trails: ' + (err && err.message ? err.message : 'no connection');
      });
    },
    clear: function () { this.list = []; store.set('trails', null); store.set('trailsAt', 0); this.draw(); }
  };

  // ------------------------------------------------------------------ sun, moon and stand winds (same maths as the Android app)

  /** Sunrise, sunset and Indiana's legal hunting hours (half an hour either side) for a calendar date. NOAA equations. */
  function sunFor(date, place) {
    var y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    var cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var n = cumulative[m - 1] + d + (m > 2 && leap ? 1 : 0);
    var g = 2 * Math.PI / (leap ? 366 : 365) * (n - 1);
    var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var latR = rad(place.lat);
    var cosHa = Math.cos(rad(90.833)) / (Math.cos(latR) * Math.cos(decl)) - Math.tan(latR) * Math.tan(decl);
    if (cosHa < -1 || cosHa > 1) return null;
    var ha = Math.acos(cosHa) * 180 / Math.PI;
    var midnight = Date.UTC(y, m - 1, d);
    var sunrise = midnight + (720 - 4 * (place.lon + ha) - eq) * 60000;
    var sunset = midnight + (720 - 4 * (place.lon - ha) - eq) * 60000;
    return { sunrise: sunrise, sunset: sunset, legalStart: sunrise - 30 * 60000, legalEnd: sunset + 30 * 60000 };
  }

  var SYNODIC = 29.530588853, NEW_MOON_REF = 947182440000;
  function moonAge(ms) { var days = (ms - NEW_MOON_REF) / 86400000; return ((days % SYNODIC) + SYNODIC) % SYNODIC; }
  function moonAt(ms) {
    var f = moonAge(ms) / SYNODIC, lit = (1 - Math.cos(2 * Math.PI * f)) / 2;
    var p = f < 0.0339 || f >= 0.9661 ? ['New moon', '🌑'] : f < 0.2161 ? ['Waxing crescent', '🌒'] : f < 0.2839 ? ['First quarter', '🌓']
      : f < 0.4661 ? ['Waxing gibbous', '🌔'] : f < 0.5339 ? ['Full moon', '🌕'] : f < 0.7161 ? ['Waning gibbous', '🌖']
      : f < 0.7839 ? ['Last quarter', '🌗'] : ['Waning crescent', '🌘'];
    return { name: p[0], emoji: p[1], lit: lit };
  }
  function moonNext(ms, targetAge) { var wait = targetAge - moonAge(ms); if (wait <= 0) wait += SYNODIC; return ms + wait * 86400000; }

  var WIND_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function windPoint(fromDeg) { return WIND_POINTS[Math.floor((((fromDeg % 360) + 360 + 22.5) % 360) / 45) % 8]; }
  function parseWinds(text) {
    var given = String(text || '').toUpperCase().split(/[\s,;]+/);
    return WIND_POINTS.filter(function (p) { return given.indexOf(p) >= 0; });
  }
  /** The typical direction over several hours: averaged as arrows, weighted by speed. */
  function averageWind(dirs, speeds) {
    if (!dirs.length) return null;
    var x = 0, y = 0;
    dirs.forEach(function (deg, i) { var w = Math.max(0.5, speeds[i] || 1); x += w * Math.sin(rad(deg)); y += w * Math.cos(rad(deg)); });
    if (x === 0 && y === 0) return dirs[0];
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  }
  /** An arrow pointing where the wind blows to (wind from the north blows south). */
  function windArrow(fromDeg) { return ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'][((Math.round(fromDeg / 45) % 8) + 8) % 8]; }
  function clock(ms) { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }

  // ------------------------------------------------------------------ weather (Open-Meteo, the same forecast as the Android app)

  function landCenter() {
    var owned = ownedParcels().filter(function (p) { return p.center; });
    if (!owned.length) { var c = map.getCenter(); return { lat: c.lat, lon: c.lng }; }
    return { lat: owned.reduce(function (s, p) { return s + p.center.lat; }, 0) / owned.length, lon: owned.reduce(function (s, p) { return s + p.center.lon; }, 0) / owned.length };
  }

  var weather = {
    forecast: null, pending: null,
    parse: function (raw, fetched) {
      if (!raw || !raw.hourly) return null;
      var h = raw.hourly, d = raw.daily || {};
      function at(arr, i) { return arr && arr[i] !== null && arr[i] !== undefined ? arr[i] : null; }
      var hours = [];
      (h.time || []).forEach(function (t, i) {
        var mph = at(h.wind_speed_10m, i), from = at(h.wind_direction_10m, i);
        if (mph === null || from === null) return;
        hours.push({ t: t * 1000, temp: at(h.temperature_2m, i), rain: at(h.precipitation_probability, i), code: at(h.weather_code, i), mph: mph, from: from, gust: at(h.wind_gusts_10m, i) });
      });
      var days = (d.time || []).map(function (t, i) {
        return { t: t * 1000, code: at(d.weather_code, i), high: at(d.temperature_2m_max, i), low: at(d.temperature_2m_min, i), rain: at(d.precipitation_probability_max, i), windMax: at(d.wind_speed_10m_max, i), from: at(d.wind_direction_10m_dominant, i) };
      });
      return { hours: hours, days: days, fetched: fetched };
    },
    load: function () { this.forecast = this.parse(store.get('weather', null), store.get('weatherAt', 0)); },
    isStale: function () { return Date.now() - store.get('weatherAt', 0) > 30 * 60000; },
    refresh: function () {
      var self = this;
      if (self.pending) return self.pending;
      var p = landCenter();
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + p.lat.toFixed(4) + '&longitude=' + p.lon.toFixed(4) +
        '&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant' +
        '&temperature_unit=fahrenheit&wind_speed_unit=mph&timeformat=unixtime&timezone=auto&forecast_days=7&past_hours=1';
      self.pending = fetch(url).then(function (r) { if (!r.ok) throw new Error('weather ' + r.status); return r.json(); }).then(function (raw) {
        var parsed = self.parse(raw, Date.now());
        if (!parsed || !parsed.hours.length) throw new Error('empty forecast');
        store.set('weather', raw);
        store.set('weatherAt', parsed.fetched);
        self.forecast = parsed;
        self.pending = null;
        windLayer.update();
        renderStatus();
        return parsed;
      }, function (e) { self.pending = null; throw e; });
      return self.pending;
    },
    /** The forecast for this hour, or null if none is saved for it. */
    now: function () {
      var f = this.forecast, t = Date.now(), best = null;
      if (!f) return null;
      f.hours.forEach(function (h) { if (h.t <= t + 30 * 60000 && (!best || h.t > best.t)) best = h; });
      return best && t - best.t < 90 * 60000 ? best : null;
    },
    windSummary: function () {
      var r = this.now();
      if (!r) return this.forecast ? 'Wind: the saved forecast has run out' : 'Wind: no forecast yet (needs a signal once)';
      var gust = r.gust !== null && r.gust >= r.mph + 3 ? ', gusts ' + Math.round(r.gust) : '';
      return r.mph < 1.5 ? 'Wind: calm' + gust : 'Wind from ' + windPoint(r.from) + ' · ' + Math.round(r.mph) + ' mph' + gust;
    }
  };
  function describeWeather(code) {
    var table = { 0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'], 45: ['🌫️', 'Fog'], 48: ['🌫️', 'Fog'],
      51: ['🌦️', 'Drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Drizzle'], 56: ['🌦️', 'Drizzle'], 57: ['🌦️', 'Drizzle'],
      61: ['🌧️', 'Rain'], 63: ['🌧️', 'Rain'], 66: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 67: ['🌧️', 'Heavy rain'],
      71: ['🌨️', 'Snow'], 73: ['🌨️', 'Snow'], 77: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 80: ['🌦️', 'Showers'], 81: ['🌦️', 'Showers'],
      82: ['⛈️', 'Heavy showers'], 85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'], 95: ['⛈️', 'Thunderstorms'], 96: ['⛈️', 'Thunderstorms'], 99: ['⛈️', 'Thunderstorms'] };
    return table[code] || ['·', '—'];
  }

  // ------------------------------------------------------------------ wind layer: arrows across the map pointing where the wind blows

  var windLayer = {
    box: $('wind'), legend: $('wind-legend'),
    color: function (mph) { return mph < 5 ? '#FFFFFF' : mph < 12 ? '#FFEB3B' : mph < 20 ? '#FF9800' : '#F44336'; },
    update: function () {
      var on = !!settings.wind, r = weather.now();
      this.legend.hidden = !on;
      this.box.hidden = !on || !r || r.mph < 1.5;
      if (!on) return;
      this.legend.querySelector('b').textContent = weather.windSummary();
      if (!r || r.mph < 1.5) return;
      var s = Math.min(30, r.mph) / 30, len = 22 + s * 38, head = 8 + Math.min(30, r.mph) / 5, shaft = 2.2 + s * 2.4, half = len / 2;
      var d = 'M' + (-shaft / 2) + ' ' + half + ' L' + (shaft / 2) + ' ' + half + ' L' + (shaft / 2) + ' ' + (-half + head) + ' L' + (head / 1.6) + ' ' + (-half + head) +
        ' L0 ' + (-half) + ' L' + (-head / 1.6) + ' ' + (-half + head) + ' L' + (-shaft / 2) + ' ' + (-half + head) + ' Z';
      var toward = (r.from + 180) % 360;
      function arrow(x, y) { return '<path transform="translate(' + x + ' ' + y + ') rotate(' + toward + ')" d="' + d + '" fill="' + windLayer.color(r.mph) + '" fill-opacity="0.9" stroke="rgba(0,0,0,0.7)" stroke-width="1.6" stroke-linejoin="round"/>'; }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">' + arrow(55, 55) + arrow(165, 165) + '</svg>';
      this.box.style.backgroundImage = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    }
  };
  windLayer.legend.addEventListener('click', function () { openConditions(); });

  // ------------------------------------------------------------------ elevation (the grid bundled with the site, works offline)

  var elevation = {
    grid: null,
    load: function () {
      var self = this;
      return fetch('data/dem.bin').then(function (r) { if (!r.ok) throw new Error('dem'); return r.arrayBuffer(); }).then(function (buf) {
        var dv = new DataView(buf);
        var magic = ''; for (var i = 0; i < 6; i++) magic += String.fromCharCode(dv.getUint8(i));
        if (magic !== 'HWDEM1') throw new Error('not a grid');
        self.grid = { cols: dv.getInt32(6, true), rows: dv.getInt32(10, true), west: dv.getFloat64(14, true), south: dv.getFloat64(22, true), east: dv.getFloat64(30, true), north: dv.getFloat64(38, true), dv: dv };
        renderStatus();
      }).catch(function () { /* no elevation line */ });
    },
    feetAt: function (lat, lon) {
      var g = this.grid;
      if (!g || lat < g.south || lat > g.north || lon < g.west || lon > g.east) return null;
      var x = (lon - g.west) / (g.east - g.west) * g.cols - 0.5, y = (g.north - lat) / (g.north - g.south) * g.rows - 0.5;
      var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      function cell(r, c) {
        r = Math.max(0, Math.min(g.rows - 1, r)); c = Math.max(0, Math.min(g.cols - 1, c));
        var v = g.dv.getInt16(46 + (r * g.cols + c) * 2, true);
        return v === -32768 ? null : v / 10;
      }
      var a = cell(y0, x0), b = cell(y0, x0 + 1), c = cell(y0 + 1, x0), d = cell(y0 + 1, x0 + 1);
      if (a === null || b === null || c === null || d === null) return null;
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  };

  // ------------------------------------------------------------------ markers: your own (kept on this phone) and the owner's land markers

  var MARKER_TYPES = [
    ['general', 'General', '📍', '#E53935'], ['stand', 'Deer stand / blind', '🦌', '#6D4C41'], ['corner', 'Corner pin / survey marker', '📐', '#FFB300'],
    ['gate', 'Gate / access', '🚪', '#546E7A'], ['water', 'Water / spring / creek crossing', '💧', '#1E88E5'], ['camera', 'Trail camera', '📷', '#8E24AA'],
    ['plot', 'Food plot / feeder', '🌱', '#43A047'], ['building', 'Building / camp', '🏠', '#00897B'], ['hazard', 'Hazard', '⚠️', '#F4511E']
  ];
  function markerType(id) { for (var i = 0; i < MARKER_TYPES.length; i++) if (MARKER_TYPES[i][0] === id) return MARKER_TYPES[i]; return MARKER_TYPES[0]; }
  function pinIcon(typeId) {
    var t = markerType(typeId);
    return L.divIcon({ className: 'pin', html: '<div class="pin-disc" style="background:' + t[3] + '"><span>' + t[2] + '</span></div><div class="pin-tip" style="border-top-color:' + t[3] + '"></div>', iconSize: [38, 47], iconAnchor: [19, 47] });
  }
  function safeKey(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60); }
  function distanceLine(p) { return me.est ? formatDistance(haversine(me.est, p)) + ' ' + compass(bearing(me.est, p)) + ' from you' : null; }

  function markerDetails(m, typeLabelExtra) {
    var t = markerType(m.type), body = el('div');
    body.appendChild(el('p', { class: 'note', text: t[1] + (typeLabelExtra || '') }));
    var winds = parseWinds(m.winds);
    if (winds.length) body.appendChild(el('p', { text: 'Good in wind from ' + winds.join(', ') }));
    if (m.note) body.appendChild(el('p', { text: m.note, style: 'white-space:pre-wrap' }));
    body.appendChild(el('p', { class: 'mono', style: 'font-size:15px', text: fmtCoord(m) }));
    var d = distanceLine(m);
    if (d) body.appendChild(el('p', { class: 'note', text: d }));
    return body;
  }

  var myMarkers = {
    list: store.get('markers', []),
    layer: L.layerGroup().addTo(map),
    save: function () { store.set('markers', this.list); this.draw(); landMarkers.draw(); },
    draw: function () {
      var self = this;
      self.layer.clearLayers();
      self.list.forEach(function (m) {
        L.marker([m.lat, m.lon], { icon: pinIcon(m.type), title: m.title, keyboard: false }).on('click', function () { self.show(m); }).addTo(self.layer);
      });
    },
    show: function (m) {
      var self = this, t = markerType(m.type);
      openDialog(t[2] + ' ' + (m.title || '(untitled)'), markerDetails(m, ''), [
        { label: 'Copy coordinates', onClick: function () { copyText(fmtCoord(m)); } },
        { label: 'Edit', onClick: function () { self.edit(m); } }
      ]);
    },
    edit: function (m, at) {
      var self = this, isNew = !m;
      m = m || { id: 'web-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), lat: at.lat, lon: at.lon, title: '', note: '', type: 'general', winds: '' };
      var title = el('input', { type: 'text', placeholder: 'Title (e.g. North stand, SW corner pin)', maxlength: '80' });
      title.value = m.title;
      var type = el('select', { class: 'field' }, MARKER_TYPES.map(function (t) { var o = el('option', { value: t[0], text: t[2] + '  ' + t[1] }); if (t[0] === m.type) o.selected = true; return o; }));
      var good = parseWinds(m.winds);
      var windRow = el('div', { class: 'winds' }, WIND_POINTS.map(function (p) {
        var box = el('input', { type: 'checkbox', value: p });
        box.checked = good.indexOf(p) >= 0;
        return el('label', {}, [box, p]);
      }));
      var windBlock = el('div', {}, [el('div', { class: 'note', text: 'Good winds for this stand (the wind comes FROM)' }), windRow]);
      function showWinds() { windBlock.hidden = type.value !== 'stand'; }
      type.addEventListener('change', showWinds);
      showWinds();
      var note = el('textarea', { class: 'field', rows: '3', placeholder: 'Notes' });
      note.value = m.note || '';
      var body = el('div', {}, [title, type, windBlock, note, el('div', { class: 'note', text: fmtCoord(m) + ' · kept on this phone only' })]);
      var actions = [{
        label: 'Save', primary: true, onClick: function () {
          m.title = title.value.trim() || markerType(type.value)[1];
          m.type = type.value;
          m.note = note.value.trim();
          m.winds = type.value === 'stand' ? Array.prototype.filter.call(windRow.querySelectorAll('input'), function (b) { return b.checked; }).map(function (b) { return b.value; }).join(',') : '';
          m.t = Date.now();
          if (isNew) self.list.push(m);
          self.save();
          closeDialog();
        }
      }];
      if (!isNew) actions.unshift({
        label: 'Delete', onClick: function () {
          if (!confirm('Delete marker "' + m.title + '"?')) return;
          self.list = self.list.filter(function (x) { return x.id !== m.id; });
          self.save();
          closeDialog();
        }
      });
      openDialog(isNew ? 'New marker' : 'Edit marker', body, actions);
    }
  };
  // A long press (or right click) on the map adds a marker there.
  map.on('contextmenu', function (ev) { myMarkers.edit(null, { lat: ev.latlng.lat, lon: ev.latlng.lng }); });

  var landMarkers = {
    list: [], photos: {},
    layer: L.layerGroup(),
    parse: function (raw) {
      if (!raw || typeof raw !== 'object') return [];
      return Object.keys(raw).map(function (id) {
        var o = raw[id] || {};
        return { id: id, title: String(o.title || 'Marker'), type: String(o.type || 'general'), note: String(o.note || ''), lat: o.lat, lon: o.lon, t: o.t || 0, winds: String(o.winds || ''), photo: o.photo || null };
      }).filter(function (m) { return typeof m.lat === 'number' && typeof m.lon === 'number'; }).sort(function (a, b) { return a.title.localeCompare(b.title); });
    },
    loadCache: function () { this.list = this.parse(store.get('landMarkers', null)); this.draw(); },
    draw: function () {
      var self = this, mine = {};
      myMarkers.list.forEach(function (m) { mine[safeKey(m.id)] = true; });
      self.layer.clearLayers();
      self.list.forEach(function (m) {
        if (mine[m.id]) return;
        L.marker([m.lat, m.lon], { icon: pinIcon(m.type), title: m.title, keyboard: false }).on('click', function () { self.open(m); }).addTo(self.layer);
      });
    },
    show: function (on) { showLayer(this.layer, on); },
    open: function (m) {
      var self = this, body = markerDetails(m, ' · land marker from the owner');
      if (m.photo) {
        var img = el('img', { alt: 'Photo of ' + m.title, style: 'width:100%;border-radius:10px;margin-top:8px;display:none' });
        body.appendChild(img);
        var show = function (src) { img.src = src; img.style.display = 'block'; };
        if (self.photos[m.photo]) show(self.photos[m.photo]);
        else if (family.code) fb.request('GET', 'groups/' + family.code + '/photos/' + m.photo).then(function (o) {
          if (o && o.jpg) { self.photos[m.photo] = 'data:image/jpeg;base64,' + o.jpg; show(self.photos[m.photo]); }
        }).catch(function () { body.appendChild(el('p', { class: 'note', text: 'The photo needs a signal to load.' })); });
      }
      openDialog(markerType(m.type)[2] + ' ' + m.title, body, [{ label: 'Copy coordinates', onClick: function () { copyText(fmtCoord(m)); } }]);
    },
    summary: function () { var n = this.list.length; return n === 1 ? '1 land marker' : n + ' land markers'; },
    checkIfDue: function () { if (Date.now() - store.get('landMarkersAt', 0) >= landTrails.CHECK_EVERY_MS) this.check(); },
    check: function () {
      var self = this;
      if (!config || !family.code) return Promise.resolve('');
      return fb.request('GET', 'groups/' + family.code + '/markers').then(function (raw) {
        store.set('landMarkers', raw || {});
        store.set('landMarkersAt', Date.now());
        self.list = self.parse(raw);
        self.draw();
        return self.list.length ? 'Land markers up to date (' + self.list.length + ').' : 'No land markers have been published yet.';
      }).catch(function () { return ''; });
    },
    clear: function () { this.list = []; store.set('landMarkers', null); store.set('landMarkersAt', 0); this.draw(); }
  };

  /** Every stand, yours and the owner's (each once), with the winds it hunts well in. */
  function allStands() {
    var seen = {}, out = [];
    myMarkers.list.concat(landMarkers.list).forEach(function (m) {
      var key = safeKey(m.id);
      if (m.type !== 'stand' || seen[key]) return;
      seen[key] = true;
      out.push({ title: m.title || 'Stand', good: parseWinds(m.winds) });
    });
    return out.sort(function (a, b) { return a.title.localeCompare(b.title); });
  }

  // ------------------------------------------------------------------ the Hunting & weather page

  function card(title, children) { return el('section', { class: 'card' }, [el('h3', { text: title })].concat(children)); }

  function standsCard(f, now, place) {
    var all = allStands(), set = all.filter(function (s) { return s.good.length; }), rows = [];
    if (!all.length) return card('Stands for the wind', [el('p', { text: 'Add a marker of type "Deer stand / blind" (press and hold on the map) and tick the winds it hunts well in. This page then shows which stands suit the forecast.' })]);
    if (!set.length) return card('Stands for the wind', [el('p', { text: 'Your stands have no good winds set yet. Tap a stand on the map, then Edit, and tick the winds it hunts well in.' })]);
    if (!f || !f.hours.length) return card('Stands for the wind', [el('p', { text: 'No forecast saved yet. It downloads when the phone has a signal.' })]);
    function row(label, fromDeg, speedText, light) {
      var point = windPoint(fromDeg);
      var good = set.filter(function (s) { return s.good.indexOf(point) >= 0; }), bad = set.filter(function (s) { return s.good.indexOf(point) < 0; });
      rows.push(el('p', { class: 'rowhead', text: label + '  ·  wind from ' + point + ' ' + speedText }));
      rows.push(good.length ? el('p', { class: 'good', text: '✔  ' + good.map(function (s) { return s.title; }).join(', ') }) : el('p', { text: '✖  None of your stands suits this wind' }));
      if (good.length && bad.length) rows.push(el('p', { class: 'note', text: 'Not good: ' + bad.map(function (s) { return s.title; }).join(', ') }));
      if (light) rows.push(el('p', { class: 'note', text: 'Light wind: the direction may wander.' }));
    }
    var nowHour = weather.now();
    if (nowHour) row('Now', nowHour.from, Math.round(nowHour.mph) + ' mph', nowHour.mph < 3);
    var sit = 3.5 * 3600000;
    [0, 1].forEach(function (offset) {
      var date = new Date(); date.setDate(date.getDate() + offset);
      var day = sunFor(date, place);
      if (!day) return;
      [['morning', day.legalStart, day.legalStart + sit], ['evening', day.legalEnd - sit, day.legalEnd]].forEach(function (part) {
        if (part[2] < now) return;
        var hours = f.hours.filter(function (h) { return h.t >= part[1] - 30 * 60000 && h.t <= part[2]; });
        if (hours.length < 2) return;
        var avg = averageWind(hours.map(function (h) { return h.from; }), hours.map(function (h) { return h.mph; }));
        var lo = Math.round(Math.min.apply(null, hours.map(function (h) { return h.mph; }))), hi = Math.round(Math.max.apply(null, hours.map(function (h) { return h.mph; })));
        row((offset === 0 ? 'This ' : 'Tomorrow ') + part[0], avg, lo === hi ? hi + ' mph' : lo + '–' + hi + ' mph', hi < 3);
      });
    });
    f.days.slice(2).forEach(function (d) {
      if (d.from === null) return;
      row(new Date(d.t + 12 * 3600000).toLocaleDateString('en-US', { weekday: 'long' }), d.from, d.windMax !== null ? 'up to ' + Math.round(d.windMax) + ' mph' : '', false);
    });
    var unset = all.filter(function (s) { return !s.good.length; });
    if (unset.length) rows.push(el('p', { class: 'note', text: 'No good winds set for: ' + unset.map(function (s) { return s.title; }).join(', ') + '.' }));
    return card('Stands for the wind', rows);
  }

  function conditionsBody(problem) {
    var f = weather.forecast, now = Date.now(), place = landCenter(), body = el('div', { class: 'cards' });
    var today = sunFor(new Date(), place), tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
    var tomorrow = sunFor(tmr, place), kids = [];
    if (today) {
      kids.push(el('p', { class: 'big2', text: 'Today  ' + clock(today.legalStart) + ' – ' + clock(today.legalEnd) }));
      kids.push(el('p', { text: 'Sunrise ' + clock(today.sunrise) + '  ·  Sunset ' + clock(today.sunset) }));
      var left = function (ms) { var min = Math.floor(ms / 60000); return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min'; };
      kids.push(el('p', { class: 'good', text: now < today.legalStart ? 'Legal hunting starts in ' + left(today.legalStart - now) : now < today.legalEnd ? 'Legal hunting now: ' + left(today.legalEnd - now) + ' left' : 'Legal hunting has ended for today' }));
    }
    if (tomorrow) kids.push(el('p', { text: 'Tomorrow  ' + clock(tomorrow.legalStart) + ' – ' + clock(tomorrow.legalEnd) }));
    kids.push(el('p', { class: 'note', text: 'Indiana deer: half an hour before sunrise to half an hour after sunset. Some DNR properties and seasons set their own hours.' }));
    body.appendChild(card('Legal hunting hours', kids));

    var moon = moonAt(now), dayFmt = { weekday: 'short', month: 'short', day: 'numeric' };
    body.appendChild(card('Moon', [
      el('p', { class: 'big2', text: moon.emoji + '  ' + moon.name }),
      el('p', { text: Math.round(moon.lit * 100) + '% lit' }),
      el('p', { text: 'Next full moon ' + new Date(moonNext(now, SYNODIC / 2)).toLocaleDateString('en-US', dayFmt) + '  ·  next new moon ' + new Date(moonNext(now, 0)).toLocaleDateString('en-US', dayFmt) })
    ]));

    body.appendChild(standsCard(f, now, place));
    if (problem) body.appendChild(el('p', { class: 'note', text: problem }));

    var hours = f ? f.hours.filter(function (h) { return h.t >= now - 30 * 60000; }).slice(0, 24) : [];
    if (!hours.length) {
      body.appendChild(card('Next 24 hours', [el('p', { text: f ? 'The saved forecast has run out. It updates when the phone has a signal.' : 'No forecast saved yet. It downloads when the phone has a signal.' })]));
    } else {
      var strip = el('div', { class: 'hours' }, hours.map(function (h, i) {
        var w = describeWeather(h.code);
        return el('div', { class: 'hour', title: w[1] }, [
          el('div', { class: 'h-time', text: i === 0 ? 'Now' : new Date(h.t).toLocaleTimeString('en-US', { hour: 'numeric' }) }),
          el('div', { class: 'h-sky', text: w[0] }),
          el('div', { class: 'h-temp', text: h.temp !== null ? Math.round(h.temp) + '°' : '–' }),
          el('div', { class: 'h-rain', text: h.rain ? h.rain + '%' : ' ' }),
          el('div', { class: 'h-wind', text: windArrow(h.from) + ' ' + Math.round(h.mph) })
        ]);
      }));
      body.appendChild(card('Next 24 hours', [strip, el('p', { class: 'note', text: 'Rain chance in blue. Wind arrows point where the wind blows; numbers are mph.' })]));
    }

    var days = f ? f.days : [];
    body.appendChild(card('7 days', days.length ? days.map(function (d, i) {
      var w = describeWeather(d.code), noon = d.t + 12 * 3600000;
      var label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(noon).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      var temps = [d.high, d.low].filter(function (v) { return v !== null; }).map(function (v) { return Math.round(v) + '°'; }).join(' / ');
      var bits = [];
      if (d.rain !== null) bits.push('rain ' + d.rain + '%');
      if (d.windMax !== null) bits.push('wind ' + (d.from !== null ? 'from ' + windPoint(d.from) + ' ' : '') + 'up to ' + Math.round(d.windMax) + ' mph');
      var sun = sunFor(new Date(noon), place);
      return el('div', { class: 'dayrow' }, [
        el('p', { class: 'rowhead', text: label + '   ' + w[0] + ' ' + w[1] + '   ' + temps }),
        el('p', { text: bits.join(' · ') }),
        sun ? el('p', { class: 'good', style: 'font-weight:400', text: 'Hunting ' + clock(sun.legalStart) + ' – ' + clock(sun.legalEnd) }) : null
      ]);
    }) : [el('p', { text: 'No forecast saved yet.' })]));

    body.appendChild(el('p', { class: 'note', text: (f ? 'Weather from Open-Meteo.com (NOAA models), updated ' + timeAgo(f.fetched) + '. ' : 'Weather: Open-Meteo.com (NOAA models). ') + 'Sun and moon are worked out on the phone and need no signal.' }));
    return body;
  }

  function openConditions() {
    function show(problem) {
      openDialog('Hunting & weather', conditionsBody(problem), [{
        label: 'Refresh', onClick: function () {
          toast('Getting the latest forecast…');
          weather.refresh().then(function () { show(null); }, function () { show('Could not get a new forecast (no signal?). Showing the last one saved.'); });
        }
      }]);
    }
    show(null);
    if (weather.isStale()) weather.refresh().then(function () { if (dlg.open && $('dlg-title').textContent === 'Hunting & weather') show(null); }, function () {});
  }
  $('btn-weather').addEventListener('click', openConditions);

  // ------------------------------------------------------------------ menu, about, install hints

  $('btn-menu').addEventListener('click', function () {
    var body = el('div');
    var items = [
      ['Add a marker where I am', function () {
        closeDialog();
        if (me.est) myMarkers.edit(null, { lat: me.est.lat, lon: me.est.lon }); else toast('Waiting for GPS. You can also press and hold on the map.');
      }],
      ['Android app (download)', function () { location.href = 'download.html'; }],
      ['Check for a newer version', function () {
        closeDialog();
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
          navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); toast(r ? 'Checking… if there is a newer version, you will be asked to reload.' : 'You have the newest version.'); });
        } else location.reload();
      }],
      ['How to put it on your home screen', function () { closeDialog(); showInstallHelp(); }],
      ['About Haasewald', function () { closeDialog(); showAbout(); }]
    ];
    items.forEach(function (it) { body.appendChild(el('button', { type: 'button', class: 'btn', style: 'display:block;width:100%;text-align:left;margin:6px 0', text: it[0], onclick: it[1] })); });
    openDialog('More', body);
  });

  function showAbout() {
    var body = el('div', {}, [
      el('p', { text: 'Web version ' + BUILD.version + ' (build ' + BUILD.id + ').' }),
      el('p', { text: 'Property lines, aerial photos and contours come from public sources. They are for reference only and are not a legal survey; confirm boundaries with a licensed surveyor before building, fencing or cutting.' }),
      el('p', { class: 'note', text: 'Property data: Dearborn County, Indiana GIS. Aerial photos: Dearborn County (EagleView, 2023); Esri, Maxar, Earthstar Geographics. Topo maps, contours and elevation: U.S. Geological Survey, The National Map. Street map: © OpenStreetMap contributors. Map library: Leaflet.' })
    ]);
    openDialog('Haasewald', body);
  }

  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  function showInstallHelp() {
    var body = el('div', {}, isAndroid ? [
      el('p', { text: 'On Android, the full app is better: it keeps sharing and recording trails with the screen off.' }),
      el('a', { class: 'btn primary', href: 'download.html', text: 'Get the Android app' })
    ] : [
      el('p', { text: 'On iPhone or iPad, open this page in Safari, tap the Share button (the square with an arrow), then "Add to Home Screen". Haasewald then opens like an app, full screen.' }),
      el('p', { class: 'note', text: 'It always loads the newest version when you have a signal, and keeps working with the maps you have already looked at when you do not.' })
    ]);
    openDialog('Put Haasewald on your home screen', body);
  }

  function showBanner(html, key) {
    if (store.get('banner.' + key, false)) return;
    var b = $('banner');
    b.innerHTML = '<span class="grow">' + html + '</span>';
    var close = el('button', { type: 'button', class: 'btn', text: 'OK', onclick: function () { b.hidden = true; store.set('banner.' + key, true); } });
    b.appendChild(close);
    b.hidden = false;
  }

  // ------------------------------------------------------------------ updates (service worker)

  function setupServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      setInterval(function () { reg.update(); }, 30 * 60 * 1000);
    }).catch(function () {});
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) return;
      var b = $('banner');
      b.innerHTML = '<span class="grow">A newer version of Haasewald is ready.</span>';
      b.appendChild(el('button', { type: 'button', class: 'btn primary', text: 'Reload', onclick: function () { reloading = true; location.reload(); } }));
      b.hidden = false;
    });
  }

  // ------------------------------------------------------------------ start-up

  map.on('zoomend', function () {
    updateMartin();
    if (contourMinorShown !== null && contourMinorShown !== contourLevel()) buildContours();
  });

  applyTiles();
  landTrails.show(settings.landTrails);
  landTrails.loadCache();
  myMarkers.draw();
  landMarkers.show(settings.landMarkers);
  landMarkers.loadCache();
  weather.load();
  windLayer.update();
  elevation.load();
  renderStatus();
  setupServiceWorker();
  // Keep the wind current while the page is open and the layer is on.
  setInterval(function () { if (settings.wind && !document.hidden) { if (weather.isStale()) weather.refresh().catch(function () {}); else windLayer.update(); } }, 5 * 60000);

  function getJson(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); }); }

  Promise.all([
    getJson('data/parcels.json').then(function (fc) {
      loadParcels(fc);
      updateMartin();
      var owned = ownedParcels();
      if (owned.length && !me.est) {
        var b = L.latLngBounds([]);
        owned.forEach(function (p) { b.extend(L.geoJSON(p.feature).getBounds()); });
        map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
      }
    }).catch(function () { toast('Could not load the parcel lines.'); }),
    getJson('data/config.json').then(function (c) { if (c && c.apiKey && c.databaseUrl) config = { apiKey: c.apiKey, databaseUrl: c.databaseUrl.replace(/\/$/, '') }; }).catch(function () {})
  ]).then(function () {
    renderStatus();
    startGps();
    if (settings.wind && weather.isStale()) weather.refresh().catch(function () {});
    if (config && family.code) {
      landTrails.checkIfDue(); landMarkers.checkIfDue();
      if (store.get('share', false)) startSharingLoop();
    }
  });

  getJson('data/contours.json').then(function (fc) { contourData = fc; buildContours(); }).catch(function () { toast('Could not load the contour lines.'); });

  if (isIOS && !standalone) showBanner('Tip: put Haasewald on your home screen. In Safari tap Share, then <b>Add to Home Screen</b>.', 'ios-install');
  else if (isAndroid && !standalone) showBanner('On Android? <a href="download.html">Get the full app</a>: it keeps working with the screen off.', 'android-app');

  // For testing in a desktop browser.
  window.haasewald = { map: map, family: family, landTrails: landTrails, landMarkers: landMarkers, myMarkers: myMarkers, weather: weather, elevation: elevation, parcelAt: parcelAt, me: me };
})();
