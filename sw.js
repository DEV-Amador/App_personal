const CACHE_NAME = 'agenda-escolar-v2';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Instala el service worker y precarga el "app shell" completo.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Limpia versiones de caché anteriores.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Estrategia: cache-first para el app shell, con actualización en segundo
// plano; así la app abre al instante y funciona sin conexión.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached || caches.match('./index.html'));

      return cached || fetchPromise;
    })
  );
});

function openAgendaDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('IndexedDB no disponible'));
    const request = indexedDB.open('agenda-escolar-db', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function deleteOutboxEntry(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendientes_sincronizacion', 'readwrite');
    tx.objectStore('pendientes_sincronizacion').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function syncOutbox() {
  let db;
  try {
    db = await openAgendaDB();
    const pending = await readStore(db, 'pendientes_sincronizacion');
    for (const entry of pending) {
      const response = await fetch(entry.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      if (!response.ok) throw new Error(`Sincronización rechazada: ${response.status}`);
      await deleteOutboxEntry(db, entry.id);
    }
  } catch (error) {
    console.warn('Background Sync pospuesto:', error);
  } finally {
    if (db) db.close();
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'agenda-sync') {
    event.waitUntil(syncOutbox());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'agenda-daily-check') {
    event.waitUntil(checkDueItems());
  }
});

async function checkDueItems() {
  if (Notification.permission !== 'granted') return;
  let db;
  try {
    db = await openAgendaDB();
    const [tareas, eventos, recordatorios] = await Promise.all([
      readStore(db, 'tareas'),
      readStore(db, 'eventos'),
      readStore(db, 'recordatorios'),
    ]);
    const hoy = new Date();
    const today = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;

    const tareasHoy = tareas.filter((item) => !item.hecha && item.fecha === today);
    if (tareasHoy.length) {
      await self.registration.showNotification('Tareas para hoy', {
        body: tareasHoy.slice(0, 3).map((item) => item.titulo).join(' · '),
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: `agenda-tareas-${today}`,
      });
    }

    const eventosHoy = eventos.filter((item) => item.fecha === today);
    if (eventosHoy.length) {
      await self.registration.showNotification('Eventos de hoy', {
        body: eventosHoy.slice(0, 3).map((item) => item.titulo).join(' · '),
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: `agenda-eventos-${today}`,
      });
    }

    const recordatoriosHoy = recordatorios.filter((item) => item.fecha === today);
    if (recordatoriosHoy.length) {
      await self.registration.showNotification('Recordatorios de hoy', {
        body: recordatoriosHoy.slice(0, 3).map((item) => item.texto).join(' · '),
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: `agenda-recordatorios-${today}`,
      });
    }
  } catch (error) {
    console.warn('Revisión periódica fallida:', error);
  } finally {
    if (db) db.close();
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Agenda Escolar';
  const options = {
    body: data.body || 'Tienes una actualización nueva.',
    icon: data.icon || './icons/icon-192.png',
    badge: data.badge || './icons/icon-192.png',
    data: data.url ? { url: data.url } : { url: './index.html' },
    tag: data.tag || 'agenda-push',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
