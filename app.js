/* ============================================================
   Agenda Escolar — lógica de la app
   Almacenamiento: IndexedDB (con respaldo automático a localStorage
   si el navegador no soporta IndexedDB).
   ============================================================ */

const DB_NAME = 'agenda-escolar-db';
const DB_VERSION = 2;
const STORES = ['clases', 'tareas', 'eventos', 'recordatorios'];
const OUTBOX_STORE = 'pendientes_sincronizacion';
const SYNC_TAG = 'agenda-sync';
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIA_LABEL = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado' };

/* ---------- Capa de almacenamiento ---------- */

let db = null;
let useLocalStorageFallback = false;

const syncUrl = document.querySelector('meta[name="agenda-sync-url"]')?.content?.trim() || '';
const pushSubscribeUrl = document.querySelector('meta[name="agenda-push-subscribe-url"]')?.content?.trim() || '';
const vapidPublicKey = document.querySelector('meta[name="agenda-vapid-public-key"]')?.content?.trim() || '';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      useLocalStorageFallback = true;
      return resolve(null);
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      [OUTBOX_STORE, ...STORES].forEach((store) => {
        if (!_db.objectStoreNames.contains(store)) {
          _db.createObjectStore(store, { keyPath: 'id' });
        }
      });
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => { useLocalStorageFallback = true; resolve(null); };
  });
}

function lsKey(store) { return `agenda-escolar:${store}`; }

function lsGetAll(store) {
  try { return JSON.parse(localStorage.getItem(lsKey(store)) || '[]'); }
  catch { return []; }
}
function lsSaveAll(store, items) {
  localStorage.setItem(lsKey(store), JSON.stringify(items));
}

function getAll(store) {
  return new Promise((resolve) => {
    if (useLocalStorageFallback || !db) return resolve(lsGetAll(store));
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve(lsGetAll(store));
  });
}

function put(store, item) {
  return new Promise((resolve) => {
    if (useLocalStorageFallback || !db) {
      const items = lsGetAll(store);
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx >= 0) items[idx] = item; else items.push(item);
      lsSaveAll(store, items);
      addToOutbox('upsert', store, item).then(() => {
        registrarSincronizacionEnSegundoPlano();
        resolve(item);
      });
      return;
    }
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => addToOutbox('upsert', store, item).then(() => {
      registrarSincronizacionEnSegundoPlano();
      resolve(item);
    });
    tx.onerror = () => resolve(item);
  });
}

function remove(store, id) {
  return new Promise((resolve) => {
    if (useLocalStorageFallback || !db) {
      lsSaveAll(store, lsGetAll(store).filter((i) => i.id !== id));
      addToOutbox('delete', store, { id }).then(() => {
        registrarSincronizacionEnSegundoPlano();
        resolve();
      });
      return;
    }
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => addToOutbox('delete', store, { id }).then(() => {
      registrarSincronizacionEnSegundoPlano();
      resolve();
    });
    tx.onerror = () => resolve();
  });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function getOutbox() {
  return new Promise((resolve) => {
    if (useLocalStorageFallback || !db) return resolve(lsGetAll(OUTBOX_STORE));
    const tx = db.transaction(OUTBOX_STORE, 'readonly');
    const req = tx.objectStore(OUTBOX_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve(lsGetAll(OUTBOX_STORE));
  });
}

function addToOutbox(action, store, item) {
  if (!syncUrl) return Promise.resolve();
  const entry = {
    id: uid(),
    action,
    store,
    item: item ? JSON.parse(JSON.stringify(item)) : null,
    url: syncUrl,
    createdAt: new Date().toISOString(),
  };
  return new Promise((resolve) => {
    if (useLocalStorageFallback || !db) {
      lsSaveAll(OUTBOX_STORE, [...lsGetAll(OUTBOX_STORE), entry]);
      resolve(entry);
      return;
    }
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).put(entry);
    tx.oncomplete = () => resolve(entry);
    tx.onerror = () => resolve(entry);
  });
}

function deleteOutboxEntry(id) {
  return new Promise((resolve) => {
    if (useLocalStorageFallback || !db) {
      lsSaveAll(OUTBOX_STORE, lsGetAll(OUTBOX_STORE).filter((entry) => entry.id !== id));
      resolve();
      return;
    }
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    tx.objectStore(OUTBOX_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/* ---------- Utilidades de fecha ---------- */

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function diaSemanaHoy() {
  const map = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  return map[new Date().getDay()];
}
function formatFechaCorta(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${d} ${meses[m - 1]}`;
}
function diasRestantes(iso) {
  if (!iso) return null;
  const hoy = new Date(todayStr() + 'T00:00:00');
  const meta = new Date(iso + 'T00:00:00');
  return Math.round((meta - hoy) / 86400000);
}

/* ---------- Estado en memoria ---------- */

const state = { clases: [], tareas: [], eventos: [], recordatorios: [] };

async function cargarTodo() {
  const [clases, tareas, eventos, recordatorios] = await Promise.all([
    getAll('clases'), getAll('tareas'), getAll('eventos'), getAll('recordatorios'),
  ]);
  state.clases = clases;
  state.tareas = tareas;
  state.eventos = eventos;
  state.recordatorios = recordatorios;
}

/* ---------- Navegación entre pestañas ---------- */

function irAPagina(nombre) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${nombre}`));
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const activo = b.dataset.page === nombre;
    b.setAttribute('aria-current', activo ? 'true' : 'false');
  });
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (btn) irAPagina(btn.dataset.page);
});

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- Modales ---------- */

function abrirModal(id) { document.getElementById(id).classList.add('show'); }
function cerrarModal(id) {
  document.getElementById(id).classList.remove('show');
  document.getElementById(id).querySelector('form')?.reset();
}
document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => cerrarModal(btn.dataset.closeModal));
});
document.querySelectorAll('.modal-backdrop').forEach((bg) => {
  bg.addEventListener('click', (e) => { if (e.target === bg) cerrarModal(bg.id); });
});

/* ---------- Render: INICIO ---------- */

function renderWidget() {
  const widget = document.getElementById('home-widget');
  if (!widget) return;

  const hoyDia = diaSemanaHoy();
  const clasesHoy = state.clases.filter((c) => c.dia === hoyDia).sort((a, b) => a.hora.localeCompare(b.hora));

  widget.innerHTML = `
    <div class="widget-head">
      <h3>Horarios de hoy</h3>
      <span class="widget-badge">${clasesHoy.length} clases</span>
    </div>
    <div class="widget-list">
      ${clasesHoy.length
        ? clasesHoy.map((clase) => `
            <div class="widget-item widget-schedule-item">
              <span class="widget-label">${clase.hora}</span>
              <div class="widget-value">${escapeHTML(clase.materia)}</div>
              <span class="widget-meta">${clase.salon ? escapeHTML(clase.salon) : 'Sin salón'}</span>
            </div>
          `).join('')
        : '<div class="widget-item empty-widget-item">No tienes clases programadas para hoy.</div>'}
    </div>
  `;
}

function renderInicio() {
  const horaActual = new Date().getHours();
  const saludo = horaActual < 12 ? 'Buenos días' : horaActual < 19 ? 'Buenas tardes' : 'Buenas noches';
  document.getElementById('saludo').textContent = saludo;
  document.getElementById('fecha-hoy').textContent =
    new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });

  const pendientes = state.tareas.filter((t) => !t.hecha);
  const hoyDia = diaSemanaHoy();
  const clasesHoy = state.clases.filter((c) => c.dia === hoyDia).sort((a, b) => a.hora.localeCompare(b.hora));
  const proximosEventos = state.eventos.filter((e) => diasRestantes(e.fecha) >= 0);

  document.getElementById('stat-tareas').textContent = pendientes.length;
  document.getElementById('stat-clases').textContent = clasesHoy.length;
  document.getElementById('stat-eventos').textContent = proximosEventos.length;
  document.getElementById('stat-recordatorios').textContent = state.recordatorios.length;

  renderWidget();

  const contClases = document.getElementById('home-clases');
  contClases.innerHTML = clasesHoy.length
    ? clasesHoy.map((c) => `
        <div class="item-row">
          <div class="item-main">
            <div class="item-title">${escapeHTML(c.materia)}</div>
            <div class="item-meta">${c.hora}${c.salon ? ' · ' + escapeHTML(c.salon) : ''}</div>
          </div>
        </div>`).join('')
    : vacio('Hoy no tienes clases registradas.');

  const pendOrdenadas = pendientes
    .slice()
    .sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999'))
    .slice(0, 4);
  const contTareas = document.getElementById('home-tareas');
  contTareas.innerHTML = pendOrdenadas.length
    ? pendOrdenadas.map((t) => filaTarea(t)).join('')
    : vacio('No tienes tareas pendientes. Buen trabajo.');

  ligarChecksYBorrados(contTareas, 'tareas');
}

function vacio(msg) {
  return `<div class="empty-state"><div class="glyph">·</div><p>${msg}</p></div>`;
}
function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Render: HORARIO ---------- */

function renderHorario() {
  const grid = document.getElementById('week-grid');
  grid.innerHTML = DIAS.map((dia) => {
    const clasesDelDia = state.clases
      .filter((c) => c.dia === dia)
      .sort((a, b) => a.hora.localeCompare(b.hora));
    return `
      <div class="day-col">
        <h3>${DIA_LABEL[dia]}</h3>
        ${clasesDelDia.length
          ? clasesDelDia.map((c) => `
              <div class="class-item">
                <div class="time">${c.hora}</div>
                <div class="subject">${escapeHTML(c.materia)}</div>
                ${c.salon ? `<div class="room">${escapeHTML(c.salon)}</div>` : ''}
              </div>`).join('')
          : `<div class="class-empty">Sin clases</div>`}
      </div>`;
  }).join('');
}

/* ---------- Render: TAREAS ---------- */

function filaTarea(t) {
  const dr = diasRestantes(t.fecha);
  let etiqueta = '';
  if (t.fecha) {
    if (dr < 0) etiqueta = `<span class="tag due-soon">Vencida</span>`;
    else if (dr === 0) etiqueta = `<span class="tag due-soon">Hoy</span>`;
    else if (dr <= 2) etiqueta = `<span class="tag due-soon">${formatFechaCorta(t.fecha)}</span>`;
    else etiqueta = `<span class="tag due-ok">${formatFechaCorta(t.fecha)}</span>`;
  }
  return `
    <div class="item-row ${t.hecha ? 'done' : ''}" data-id="${t.id}">
      <div class="item-check ${t.hecha ? 'checked' : ''}" data-action="toggle">${t.hecha ? '✓' : ''}</div>
      <div class="item-main">
        <div class="item-title">${escapeHTML(t.titulo)}</div>
        ${t.materia ? `<div class="item-meta">${escapeHTML(t.materia)}</div>` : ''}
      </div>
      ${etiqueta}
      <button class="item-del" data-action="del" aria-label="Eliminar">✕</button>
    </div>`;
}

function renderTareas() {
  const cont = document.getElementById('lista-tareas');
  const ordenadas = state.tareas.slice().sort((a, b) => {
    if (a.hecha !== b.hecha) return a.hecha ? 1 : -1;
    return (a.fecha || '9999').localeCompare(b.fecha || '9999');
  });
  cont.innerHTML = ordenadas.length ? ordenadas.map(filaTarea).join('') : vacio('Sin tareas por ahora. Agrega la primera.');
  ligarChecksYBorrados(cont, 'tareas');

  const pendientes = state.tareas.filter((t) => !t.hecha).length;
  const badge = document.getElementById('count-tareas');
  badge.textContent = pendientes;
  badge.hidden = pendientes === 0;
}

/* ---------- Render: EVENTOS ---------- */

function renderEventos() {
  const cont = document.getElementById('lista-eventos');
  const ordenados = state.eventos.slice().sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999'));
  cont.innerHTML = ordenados.length
    ? ordenados.map((e) => {
        const dr = diasRestantes(e.fecha);
        const tag = dr < 0 ? `<span class="tag due-soon">Pasó</span>`
          : dr <= 2 ? `<span class="tag due-soon">${formatFechaCorta(e.fecha)}</span>`
          : `<span class="tag due-ok">${formatFechaCorta(e.fecha)}</span>`;
        return `
          <div class="item-row" data-id="${e.id}">
            <div class="item-main">
              <div class="item-title">${escapeHTML(e.titulo)}</div>
              <div class="item-meta">${e.hora ? e.hora + ' · ' : ''}${escapeHTML(e.lugar || '')}</div>
            </div>
            ${tag}
            <button class="item-del" data-action="del" aria-label="Eliminar">✕</button>
          </div>`;
      }).join('')
    : vacio('No hay eventos programados.');
  ligarBorrados(cont, 'eventos');
}

/* ---------- Render: RECORDATORIOS ---------- */

function renderRecordatorios() {
  const cont = document.getElementById('lista-recordatorios');
  const ordenados = state.recordatorios.slice().sort((a, b) => (a.fecha || '9999').localeCompare(b.fecha || '9999'));
  cont.innerHTML = ordenados.length
    ? ordenados.map((r) => `
        <div class="item-row" data-id="${r.id}">
          <div class="item-main">
            <div class="item-title">${escapeHTML(r.texto)}</div>
            ${r.fecha ? `<div class="item-meta">${formatFechaCorta(r.fecha)}</div>` : ''}
          </div>
          <button class="item-del" data-action="del" aria-label="Eliminar">✕</button>
        </div>`).join('')
    : vacio('No tienes recordatorios guardados.');
  ligarBorrados(cont, 'recordatorios');

  const badge = document.getElementById('count-recordatorios');
  badge.textContent = state.recordatorios.length;
  badge.hidden = state.recordatorios.length === 0;
}

/* ---------- Acciones en filas (marcar / borrar) ---------- */

function ligarBorrados(cont, store) {
  cont.querySelectorAll('[data-action="del"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('[data-id]');
      const id = row.dataset.id;
      await remove(store, id);
      state[store] = state[store].filter((i) => i.id !== id);
      renderTodo();
      toast('Eliminado');
    });
  });
}

function ligarChecksYBorrados(cont, store) {
  ligarBorrados(cont, store);
  cont.querySelectorAll('[data-action="toggle"]').forEach((chk) => {
    chk.addEventListener('click', async () => {
      const row = chk.closest('[data-id]');
      const id = row.dataset.id;
      const item = state[store].find((i) => i.id === id);
      item.hecha = !item.hecha;
      await put(store, item);
      renderTodo();
    });
  });
}

function renderTodo() {
  renderInicio();
  renderHorario();
  renderTareas();
  renderEventos();
  renderRecordatorios();
}

/* ---------- Widget externo ---------- */

function abrirWidgetHorario() {
  const ventana = window.open('widget.html', 'agenda-widget-horario', 'width=420,height=720,resizable=yes,scrollbars=no');
  if (ventana) {
    ventana.focus();
  } else {
    toast('Permite ventanas emergentes para abrir el widget del horario.');
  }
}

document.getElementById('btn-widget-horario')?.addEventListener('click', abrirWidgetHorario);

/* ---------- Formularios ---------- */

document.getElementById('btn-add-clase').addEventListener('click', () => abrirModal('modal-clase'));
document.getElementById('btn-add-tarea').addEventListener('click', () => abrirModal('modal-tarea'));
document.getElementById('btn-add-evento').addEventListener('click', () => abrirModal('modal-evento'));
document.getElementById('btn-add-recordatorio').addEventListener('click', () => abrirModal('modal-recordatorio'));

document.getElementById('form-clase').addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = {
    id: uid(),
    materia: document.getElementById('clase-materia').value.trim(),
    dia: document.getElementById('clase-dia').value,
    hora: document.getElementById('clase-hora').value,
    salon: document.getElementById('clase-salon').value.trim(),
  };
  await put('clases', item);
  state.clases.push(item);
  cerrarModal('modal-clase');
  renderTodo();
  toast('Clase guardada');
});

document.getElementById('form-tarea').addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = {
    id: uid(),
    titulo: document.getElementById('tarea-titulo').value.trim(),
    materia: document.getElementById('tarea-materia').value.trim(),
    fecha: document.getElementById('tarea-fecha').value,
    hecha: false,
  };
  await put('tareas', item);
  state.tareas.push(item);
  cerrarModal('modal-tarea');
  renderTodo();
  toast('Tarea guardada');
});

document.getElementById('form-evento').addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = {
    id: uid(),
    titulo: document.getElementById('evento-titulo').value.trim(),
    fecha: document.getElementById('evento-fecha').value,
    hora: document.getElementById('evento-hora').value,
    lugar: document.getElementById('evento-lugar').value.trim(),
  };
  await put('eventos', item);
  state.eventos.push(item);
  cerrarModal('modal-evento');
  renderTodo();
  toast('Evento guardado');
});

document.getElementById('form-recordatorio').addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = {
    id: uid(),
    texto: document.getElementById('recordatorio-texto').value.trim(),
    fecha: document.getElementById('recordatorio-fecha').value,
  };
  await put('recordatorios', item);
  state.recordatorios.push(item);
  cerrarModal('modal-recordatorio');
  renderTodo();
  toast('Recordatorio guardado');
});

/* ---------- Estado de conexión ---------- */

function actualizarEstadoConexion() {
  const online = navigator.onLine;
  [
    ['status-pill', 'status-text'],
    ['status-pill-mobile', 'status-text-mobile'],
  ].forEach(([pillId, textId]) => {
    const pill = document.getElementById(pillId);
    const text = document.getElementById(textId);
    if (!pill) return;
    pill.classList.toggle('offline', !online);
    text.textContent = online ? 'En línea' : 'Sin conexión · modo offline';
  });
}
window.addEventListener('online', () => {
  actualizarEstadoConexion();
  sincronizarPendientes();
  registrarSincronizacionEnSegundoPlano();
});
window.addEventListener('offline', actualizarEstadoConexion);

/* ---------- Sincronización y notificaciones ---------- */

async function sincronizarPendientes() {
  if (!navigator.onLine || !syncUrl) return 0;

  const pending = await getOutbox();
  let synchronized = 0;
  for (const entry of pending) {
    try {
      const response = await fetch(entry.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      if (!response.ok) throw new Error(`Sincronización rechazada: ${response.status}`);
      await deleteOutboxEntry(entry.id);
      synchronized += 1;
    } catch (error) {
      console.warn(error);
      break;
    }
  }
  return synchronized;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function registrarSincronizacionEnSegundoPlano() {
  if (!('serviceWorker' in navigator) || !navigator.onLine) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if ('sync' in registration) {
      await registration.sync.register(SYNC_TAG);
    }
  } catch (error) {
    console.warn('No se pudo registrar Background Sync:', error);
  }
}

async function registrarRevisionPeriodica() {
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!('periodicSync' in registration)) return;
    await registration.periodicSync.register('agenda-daily-check', {
      minInterval: 12 * 60 * 60 * 1000,
    });
  } catch (error) {
    console.warn('Periodic Sync no disponible:', error);
  }
}

async function actualizarEstadoNotificaciones() {
  const button = document.getElementById('notification-btn');
  if (!button) return;
  if (!('Notification' in window)) {
    button.textContent = 'Notificaciones no compatibles';
    button.disabled = true;
    return;
  }
  button.textContent =
    Notification.permission === 'granted'
      ? 'Desactivar notificaciones'
      : Notification.permission === 'denied'
        ? 'Notificaciones bloqueadas'
        : 'Activar notificaciones';
  button.disabled = Notification.permission === 'denied';
}

async function activarNotificaciones() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    toast('Este navegador no admite notificaciones push.');
    return;
  }

  let permission = Notification.permission;
  if (permission !== 'granted') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    toast('Permiso de notificaciones denegado');
    await actualizarEstadoNotificaciones();
    return;
  }

  const registration = await navigator.serviceWorker.ready;

  if (pushSubscribeUrl && vapidPublicKey) {
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }
    const response = await fetch(pushSubscribeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });
    if (!response.ok) throw new Error(`No se pudo registrar la suscripción push: ${response.status}`);
  }

  await registrarRevisionPeriodica();
  await actualizarEstadoNotificaciones();
  await registration.showNotification('Agenda Escolar', {
    body: 'Las notificaciones están activadas.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'agenda-activada',
  });
  toast('Notificaciones activadas');
}

async function desactivarNotificaciones() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    if (pushSubscribeUrl) {
      await fetch(pushSubscribeUrl, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });
    }
    await subscription.unsubscribe();
  }
  await actualizarEstadoNotificaciones();
  toast('Notificaciones desactivadas');
}

document.getElementById('notification-btn')?.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'granted') {
    desactivarNotificaciones().catch((error) => {
      console.warn(error);
      toast('No se pudieron desactivar las notificaciones');
    });
  } else {
    activarNotificaciones().catch((error) => {
      console.warn(error);
      toast('No se pudieron activar las notificaciones');
    });
  }
});

/* ---------- Instalación como app (PWA) ---------- */

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('install-btn').classList.add('show');
});
document.getElementById('install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  document.getElementById('install-btn').classList.remove('show');
});
window.addEventListener('appinstalled', () => {
  document.getElementById('install-btn').classList.remove('show');
  toast('Agenda instalada');
});

/* ---------- Service worker (funcionamiento sin internet) ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* Si el registro falla (p. ej. sirviendo desde file://), la app
         sigue funcionando; solo no habrá caché offline del "app shell". */
    });
  });
}

/* ---------- Arranque ---------- */

(async function init() {
  await openDB();
  await cargarTodo();
  actualizarEstadoConexion();
  await actualizarEstadoNotificaciones();
  renderTodo();
  if (navigator.onLine) {
    sincronizarPendientes();
    registrarSincronizacionEnSegundoPlano();
  }
})();
