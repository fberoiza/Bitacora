/* Bitácora Masónica — app móvil (PWA)
 * Datos en tu Google Sheet vía Apps Script. Funciona sin conexión:
 * los cambios quedan en cola y se sincronizan al volver la señal.
 */
(function () {
  'use strict';

  /* ===================== Estado y almacenamiento ===================== */
  var KEY = 'bitacora.v1';
  var DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  var DIAS_CORTO = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var DEFAULT_CONFIG = {
    miLogia: 202,
    tipos: ['Tenida', 'Tenida Blanca', 'Tenida Fúnebre', 'Tenida de Iniciación', 'Cámara', 'Aniversario', 'Fraternitas', 'Fiesta del Aprendiz', 'Ágape', 'Otro'],
    grados: ['1° Aprendiz', '2° Compañero', '3° Maestro', 'Tenida abierta'],
    participacion: ['Oyente', 'Presenté trabajo', 'Oficial / cargo']
  };

  var memoria = {};
  function cargar() {
    var base = { api: { url: '', token: '' }, data: { asistencias: [], logias: [], config: DEFAULT_CONFIG }, queue: [], lastSync: null, lastError: null, prefs: { valle: '' } };
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        return Object.assign(base, s, { prefs: Object.assign(base.prefs, s.prefs || {}) });
      }
    } catch (e) { /* almacenamiento no disponible */ }
    return memoria.state || base;
  }
  var S = cargar();
  function guardar() {
    memoria.state = S;
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* sin almacenamiento */ }
  }

  /* ===================== Utilidades ===================== */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function norm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2)); }
  function hoyISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parseISO(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fechaLarga(s) { var d = parseISO(s); return DIAS[d.getDay()].toLowerCase() + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()] + ' de ' + d.getFullYear(); }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function rl(nombre, numero) { return 'R∴L∴ ' + (nombre || '') + (numero !== '' && numero != null ? ' N° ' + numero : ''); }
  function config() { return Object.assign({}, DEFAULT_CONFIG, S.data.config || {}); }
  function logiaPorNumero(n) {
    if (n === '' || n == null) return null;
    for (var i = 0; i < S.data.logias.length; i++) if (Number(S.data.logias[i].n) === Number(n)) return S.data.logias[i];
    return null;
  }
  // Prefiere el nombre que tú usas en tus registros para ese número
  function nombrePropio(n, fallback) {
    var a = S.data.asistencias;
    for (var i = a.length - 1; i >= 0; i--) if (Number(a[i].numero) === Number(n) && a[i].logia) return a[i].logia;
    return fallback;
  }
  function trabajaHoy(l, fecha) {
    var d = fecha || new Date();
    if (norm(l.dia) !== norm(DIAS[d.getDay()])) return false;
    var semana = Math.ceil(d.getDate() / 7);
    var f = norm(l.frec);
    if (f.indexOf('1') === 0 && f.indexOf('3') > 0) return semana === 1 || semana === 3;
    if (f.indexOf('2') === 0 && f.indexOf('4') > 0) return semana === 2 || semana === 4;
    return true;
  }
  function valles() {
    var m = {};
    S.data.logias.forEach(function (l) { if (l.valle) m[l.valle] = 1; });
    return Object.keys(m).sort(function (a, b) { return a.localeCompare(b, 'es'); });
  }
  function asistenciasOrdenadas() {
    return S.data.asistencias.slice().sort(function (a, b) {
      return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : (Number(b.id) || 1e9) - (Number(a.id) || 1e9);
    });
  }

  /* ===================== API / Sincronización ===================== */
  function api(body) {
    if (!S.api.url || !S.api.token) return Promise.reject(new Error('Falta configurar la conexión'));
    body.token = S.api.token;
    return fetch(S.api.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) throw new Error('El servidor respondió ' + r.status);
      return r.text();
    }).then(function (txt) {
      var j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('Respuesta no válida. ¿La implementación está como "Cualquier usuario"?'); }
      if (!j.ok) throw new Error(j.error || 'Error desconocido');
      return j;
    });
  }

  var sincronizando = false;
  function sincronizar(silencioso) {
    if (sincronizando) return Promise.resolve();
    if (!S.api.url || !S.api.token) { pintarEstado(); return Promise.resolve(); }
    if (!navigator.onLine) { pintarEstado(); return Promise.resolve(); }
    sincronizando = true; pintarEstado();
    var enviados = S.queue.slice();
    var req = enviados.length ? { action: 'sync', ops: enviados.map(function (q) { return { op: q.op, uid: q.uid, record: q.record }; }) } : { action: 'bootstrap' };
    return api(req).then(function (j) {
      var errores = {};
      (j.resultados || []).forEach(function (r) { if (!r.ok) errores[r.uid] = r.error; });
      var idsEnviados = enviados.map(function (q) { return q.qid; });
      // Quitar de la cola lo enviado con éxito; marcar errores
      S.queue = S.queue.filter(function (q) {
        if (idsEnviados.indexOf(q.qid) < 0) return true; // agregado durante el envío
        if (errores[q.uid]) { q.error = errores[q.uid]; return true; }
        return false;
      });
      S.data = j.data;
      aplicarColaLocal();
      S.lastSync = new Date().toISOString();
      S.lastError = null;
      guardar();
      if (!silencioso) toast(enviados.length ? 'Sincronizado ✓' : 'Datos actualizados ✓');
      var conErr = S.queue.filter(function (q) { return q.error; }).length;
      if (conErr) toast(conErr + ' cambio(s) rechazados — revisa Ajustes');
    }).catch(function (e) {
      S.lastError = e.message;
      guardar();
      if (!silencioso) toast('Sin sincronizar: ' + e.message);
    }).then(function () {
      sincronizando = false; pintarEstado();
      // No re-dibujar si estás escribiendo o en el formulario
      var ae = document.activeElement;
      var escribiendo = ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && $('#view').contains(ae);
      if (vista !== 'registrar' && !escribiendo && $('#sheet').hidden) render();
    });
  }

  // Reaplica sobre los datos del servidor los cambios aún pendientes
  function aplicarColaLocal() {
    S.queue.forEach(function (q) {
      var a = S.data.asistencias;
      var i = a.findIndex(function (x) { return x.uid === q.uid; });
      if (q.op === 'delete') { if (i >= 0) a.splice(i, 1); return; }
      var rec = Object.assign({}, i >= 0 ? a[i] : { id: '' }, q.record, { uid: q.uid, _pend: true });
      if (i >= 0) a[i] = rec; else a.push(rec);
    });
  }

  function encolar(op, rec) {
    var u = rec.uid;
    // compactar: un upsert sobre otro upsert pendiente lo reemplaza
    S.queue = S.queue.filter(function (q) { return !(q.uid === u && (op === 'delete' || q.op === 'upsert')); });
    var esNuevoLocal = op === 'delete' && !S.data.asistencias.some(function (x) { return x.uid === u && x.id !== ''; });
    if (!(op === 'delete' && esNuevoLocal)) {
      S.queue.push({ qid: uid(), op: op, uid: u, record: op === 'upsert' ? limpiarRegistro(rec) : null, t: Date.now() });
    }
    var a = S.data.asistencias;
    var i = a.findIndex(function (x) { return x.uid === u; });
    if (op === 'delete') { if (i >= 0) a.splice(i, 1); }
    else {
      var r = Object.assign({}, i >= 0 ? a[i] : { id: '' }, rec, { _pend: true });
      if (i >= 0) a[i] = r; else a.push(r);
    }
    guardar();
    pintarEstado();
    sincronizar(true);
  }
  function limpiarRegistro(r) {
    return { fecha: r.fecha, tipo: r.tipo, logia: r.logia, numero: r.numero, valle: r.valle, obs: r.obs, grado: r.grado, condicion: r.condicion, participacion: r.participacion, trabajo: r.trabajo };
  }

  function pintarEstado() {
    var b = $('#sync-btn'), l = $('#sync-label');
    var pend = S.queue.length;
    var st, txt;
    if (!S.api.url) { st = 'error'; txt = 'Sin conectar'; }
    else if (sincronizando) { st = 'busy'; txt = 'Sincronizando'; }
    else if (!navigator.onLine) { st = 'pending'; txt = pend ? pend + ' sin enviar' : 'Sin conexión'; }
    else if (S.queue.some(function (q) { return q.error; })) { st = 'error'; txt = 'Revisar'; }
    else if (pend) { st = 'pending'; txt = pend + ' pendiente' + (pend > 1 ? 's' : ''); }
    else if (S.lastError) { st = 'error'; txt = 'Error'; }
    else { st = 'ok'; txt = S.lastSync ? 'Al día' : 'Conectado'; }
    b.dataset.state = st; l.textContent = txt;
  }

  /* ===================== Router ===================== */
  var vista = 'inicio';
  var estadoVista = { historial: { q: '', anio: '' }, logias: { q: '', valle: null, dia: '', rito: '', limite: 60 } };
  var form = null; // borrador del formulario de registro

  function ruta() {
    var h = (location.hash || '#inicio').slice(1);
    if (h.indexOf('vincular=') === 0) { vincularDesdeHash(h.slice(9)); return; }
    vista = ['inicio', 'historial', 'registrar', 'logias', 'ajustes'].indexOf(h) >= 0 ? h : 'inicio';
    if (vista === 'registrar' && !form) form = nuevoForm();
    $$('.tabs a').forEach(function (a) { a.setAttribute('aria-current', a.dataset.tab === vista ? 'page' : 'false'); });
    cerrarSheet();
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    var v = $('#view');
    if (!S.api.url && vista !== 'ajustes') { v.innerHTML = vistaBienvenida(); return; }
    var fn = { inicio: vistaInicio, historial: vistaHistorial, registrar: vistaRegistrar, logias: vistaLogias, ajustes: vistaAjustes }[vista];
    v.innerHTML = fn();
    var post = { registrar: montarRegistrar, logias: montarLogias, historial: montarHistorial, ajustes: montarAjustes, inicio: montarInicio }[vista];
    if (post) post();
  }

  /* ===================== Bienvenida ===================== */
  function vistaBienvenida() {
    return '<div class="welcome card">' +
      '<svg viewBox="0 0 64 64" style="width:46px;height:46px;color:var(--gold)"><use href="#mark"/></svg>' +
      '<h1>Bienvenido, Q∴H∴</h1>' +
      '<p class="muted">Conecta la app con tu planilla para comenzar.</p>' +
      '<ol><li>En la planilla: menú <b>△ App Masónica → Inicializar</b>.</li>' +
      '<li>Implementa el script como <b>Aplicación web</b> y copia la URL.</li>' +
      '<li>Menú <b>Ver token de acceso</b> y copia el token.</li>' +
      '<li>Pega ambos en <b>Ajustes</b>.</li></ol>' +
      '<a class="btn primary block" href="#ajustes">Ir a Ajustes</a>' +
      '<p class="hint">¿Ya lo configuraste en otro dispositivo? Allí ve a Ajustes → “Vincular otro dispositivo” y escanea el código QR.</p></div>';
  }

  /* ===================== Inicio ===================== */
  function vistaInicio() {
    var a = S.data.asistencias;
    var ahora = new Date();
    var anio = String(ahora.getFullYear());
    var mes = anio + '-' + pad(ahora.getMonth() + 1);
    var delAnio = a.filter(function (x) { return String(x.fecha).slice(0, 4) === anio; });
    var delMes = a.filter(function (x) { return String(x.fecha).slice(0, 7) === mes; });
    var distintas = {}; a.forEach(function (x) { if (x.numero !== '') distintas[x.numero] = 1; });
    var trabajos = a.filter(function (x) { return norm(x.participacion).indexOf('trabajo') >= 0; }).length;
    var html = '<div class="stats">' +
      stat(delAnio.length, 'Asistencias ' + anio, true) +
      stat(delMes.length, 'Este mes') +
      stat(Object.keys(distintas).length, 'Logias distintas') +
      stat(trabajos, 'Trabajos presentados') + '</div>';

    // Hoy trabajan
    var vs = valles();
    var valle = S.prefs.valle || '';
    var hoy = S.data.logias.filter(function (l) { return trabajaHoy(l) && (!valle || l.valle === valle); })
      .sort(function (x, y) { return (x.hora || '').localeCompare(y.hora || '') || x.n - y.n; });
    html += '<div class="section"><h2>Hoy trabajan</h2><span class="aside">' + esc(DIAS[ahora.getDay()]) + ' ' + ahora.getDate() + ' de ' + MESES[ahora.getMonth()] + '</span></div>';
    html += '<select class="input" id="hoy-valle" aria-label="Valle"><option value="">Todos los valles</option>' +
      vs.map(function (v) { return '<option' + (v === valle ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>';
    html += '<div class="list" style="margin-top:8px">' + (hoy.length ? hoy.slice(0, 12).map(itemLogia).join('') +
      (hoy.length > 12 ? '<a class="btn sm" href="#logias" data-hoy="1">Ver las ' + hoy.length + '</a>' : '')
      : '<div class="empty card">No hay logias con tenida hoy' + (valle ? ' en ' + esc(valle) : '') + '.</div>') + '</div>';

    // Últimas
    var ult = asistenciasOrdenadas().slice(0, 3);
    html += '<div class="section"><h2>Últimas asistencias</h2><a class="aside" href="#historial">Ver todas</a></div>';
    html += '<div class="list">' + (ult.length ? ult.map(itemAsistencia).join('') : '<div class="empty card">Aún no hay registros.</div>') + '</div>';

    // Estadísticas
    if (a.length) html += estadisticas(a);
    return html;
  }
  function stat(n, l, acc) { return '<div class="stat' + (acc ? ' accent' : '') + '"><div class="num">' + n + '</div><div class="lbl">' + esc(l) + '</div></div>'; }

  function estadisticas(a) {
    var html = '';
    // Por mes (últimos 12)
    var d = new Date(); var meses = [];
    for (var i = 11; i >= 0; i--) { var x = new Date(d.getFullYear(), d.getMonth() - i, 1); meses.push(x.getFullYear() + '-' + pad(x.getMonth() + 1)); }
    var cuenta = {}; a.forEach(function (r) { var k = String(r.fecha).slice(0, 7); cuenta[k] = (cuenta[k] || 0) + 1; });
    var max = Math.max.apply(null, meses.map(function (m) { return cuenta[m] || 0; }).concat([1]));
    html += '<div class="section"><h2>Últimos 12 meses</h2></div><div class="card"><div class="months">' + meses.map(function (m) {
      var c = cuenta[m] || 0;
      return '<div class="month" title="' + m + ': ' + c + '"><span class="c">' + (c || '') + '</span><div class="col' + (c ? '' : ' zero') + '" style="height:' + Math.max(2, Math.round(c / max * 70)) + 'px"></div><span class="m">' + MESES[+m.slice(5) - 1].slice(0, 3) + '</span></div>';
    }).join('') + '</div></div>';

    // Propia vs visita
    var propia = a.filter(function (r) { return norm(r.condicion) === 'logia propia'; }).length;
    var visita = a.filter(function (r) { return norm(r.condicion) === 'visita'; }).length;
    var tot = propia + visita || 1;
    html += '<div class="section"><h2>Logia propia y visitas</h2></div><div class="card">' +
      '<div class="split"><div style="width:' + (propia / tot * 100) + '%;background:var(--navy)"></div><div style="width:' + (visita / tot * 100) + '%;background:var(--gold)"></div></div>' +
      '<div class="legend"><span><i style="background:var(--navy)"></i>Logia propia · ' + propia + '</span><span><i style="background:var(--gold)"></i>Visitas · ' + visita + '</span></div></div>';

    html += '<div class="section"><h2>Por logia</h2></div><div class="card">' + barras(agrupar(a, function (r) { return rl(r.logia, r.numero).replace('R∴L∴ ', ''); }), 8) + '</div>';
    html += '<div class="section"><h2>Por tipo de evento</h2></div><div class="card">' + barras(agrupar(a, function (r) { return r.tipo || '—'; }), 10) + '</div>';
    return html;
  }
  function agrupar(a, f) { var m = {}; a.forEach(function (r) { var k = f(r); m[k] = (m[k] || 0) + 1; }); return Object.keys(m).map(function (k) { return [k, m[k]]; }).sort(function (x, y) { return y[1] - x[1]; }); }
  function barras(pares, n) {
    var max = pares.length ? pares[0][1] : 1;
    return '<div class="bars">' + pares.slice(0, n).map(function (p) {
      return '<div class="bar-row"><span class="name">' + esc(p[0]) + '</span><span class="val">' + p[1] + '</span><div class="track"><div class="fill" style="width:' + (p[1] / max * 100) + '%"></div></div></div>';
    }).join('') + '</div>';
  }
  function montarInicio() {
    var s = $('#hoy-valle');
    if (s) s.onchange = function () { S.prefs.valle = s.value; guardar(); render(); };
    var b = $('[data-hoy]');
    if (b) b.onclick = function () { estadoVista.logias.dia = 'hoy'; estadoVista.logias.valle = S.prefs.valle || ''; };
    enlazarItems();
  }

  /* ===================== Ítems ===================== */
  function itemAsistencia(r) {
    var d = parseISO(r.fecha);
    var tags = [];
    if (r.grado) tags.push('<span class="tag">' + esc(r.grado) + '</span>');
    if (r.condicion) tags.push('<span class="tag' + (norm(r.condicion) === 'visita' ? ' gold' : '') + '">' + esc(r.condicion) + '</span>');
    if (r.participacion) tags.push('<span class="tag' + (norm(r.participacion).indexOf('trabajo') >= 0 ? ' gold' : '') + '">' + esc(r.participacion) + '</span>');
    var q = S.queue.find(function (x) { return x.uid === r.uid; });
    if (q && q.error) tags.push('<span class="tag err">Rechazado</span>');
    else if (r._pend) tags.push('<span class="tag warn">Sin sincronizar</span>');
    return '<button class="item" data-asis="' + esc(r.uid) + '">' +
      '<div class="date-chip"><div class="d">' + (isNaN(d) ? '?' : d.getDate()) + '</div><div class="w">' + (isNaN(d) ? '' : DIAS_CORTO[d.getDay()]) + '</div></div>' +
      '<div class="item-body"><div class="item-title">' + esc(r.tipo || 'Asistencia') + ' · ' + esc(rl(r.logia, r.numero)) + '</div>' +
      '<div class="item-sub">' + esc(r.valle || '') + (isNaN(d) ? '' : ' · ' + MESES[d.getMonth()] + ' ' + d.getFullYear()) + '</div>' +
      (r.trabajo ? '<div class="item-note"><b>Trabajo:</b> ' + esc(r.trabajo) + '</div>' : '') +
      (r.obs ? '<div class="item-note">' + esc(r.obs) + '</div>' : '') +
      (tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '') + '</div></button>';
  }
  function itemLogia(l) {
    return '<button class="item" data-logia="' + esc(l.n) + '">' +
      '<div class="num-chip">' + esc(l.n) + '</div>' +
      '<div class="item-body"><div class="item-title">' + esc(l.nombre) + '</div>' +
      '<div class="item-sub">' + esc(l.valle) + ' · ' + esc(l.dia) + (l.frec && l.frec !== 'Semanal' ? ' (' + esc(l.frec) + ')' : '') + (l.hora ? ' · ' + esc(l.hora) : '') + (l.rito && l.rito !== 'REAA' ? ' · ' + esc(l.rito) : '') + '</div></div></button>';
  }
  function enlazarItems(root) {
    $$('[data-asis]', root).forEach(function (b) { b.onclick = function () { editar(b.dataset.asis); }; });
    $$('[data-logia]', root).forEach(function (b) { b.onclick = function () { verLogia(b.dataset.logia); }; });
  }

  /* ===================== Historial ===================== */
  function vistaHistorial() {
    var st = estadoVista.historial;
    var anios = {}; S.data.asistencias.forEach(function (r) { anios[String(r.fecha).slice(0, 4)] = 1; });
    var listaAnios = Object.keys(anios).sort().reverse();
    return '<input class="input" id="h-q" type="search" placeholder="Buscar logia, número, tipo, nota…" value="' + esc(st.q) + '" autocomplete="off">' +
      '<div class="chips scroll" style="margin-top:10px" id="h-anios">' +
      ['', ].concat(listaAnios).map(function (y) { return '<button class="chip" data-anio="' + y + '" aria-pressed="' + (st.anio === y) + '">' + (y || 'Todos') + '</button>'; }).join('') +
      '</div><div id="h-lista"></div>';
  }
  function montarHistorial() {
    var st = estadoVista.historial;
    function pintar() {
      var q = norm(st.q);
      var lista = asistenciasOrdenadas().filter(function (r) {
        if (st.anio && String(r.fecha).slice(0, 4) !== st.anio) return false;
        if (!q) return true;
        if (/^\d+$/.test(q)) return String(r.numero) === q || norm([r.obs, r.trabajo].join(' ')).indexOf(q) >= 0;
        return norm([r.tipo, r.logia, r.valle, r.obs, r.grado, r.condicion, r.participacion, r.trabajo].join(' ')).indexOf(q) >= 0;
      });
      var html = '';
      if (!lista.length) html = '<div class="empty card" style="margin-top:14px">Sin resultados.</div>';
      var mesActual = null, grupo = [];
      function cerrar() { if (grupo.length) html += '<div class="group-head">' + mesActual + '<span>' + grupo.length + '</span></div><div class="list">' + grupo.join('') + '</div>'; }
      lista.forEach(function (r) {
        var d = parseISO(r.fecha);
        var m = isNaN(d) ? 'Sin fecha' : MESES[d.getMonth()] + ' ' + d.getFullYear();
        if (m !== mesActual) { cerrar(); mesActual = m; grupo = []; }
        grupo.push(itemAsistencia(r));
      });
      cerrar();
      $('#h-lista').innerHTML = html;
      enlazarItems($('#h-lista'));
    }
    $('#h-q').oninput = function (e) { st.q = e.target.value; pintar(); };
    $$('#h-anios .chip').forEach(function (c) {
      c.onclick = function () { st.anio = c.dataset.anio; $$('#h-anios .chip').forEach(function (x) { x.setAttribute('aria-pressed', x === c); }); pintar(); };
    });
    pintar();
  }

  /* ===================== Registrar / editar ===================== */
  function nuevoForm(base) {
    var c = config();
    var ult = asistenciasOrdenadas()[0];
    return Object.assign({
      uid: null, fecha: hoyISO(), tipo: c.tipos[0] || 'Tenida', logia: '', numero: '', valle: '',
      grado: (ult && ult.grado) || c.grados[0] || '', condicion: '', participacion: c.participacion[0] || 'Oyente', trabajo: '', obs: ''
    }, base || {});
  }
  function editar(u) {
    var r = S.data.asistencias.find(function (x) { return x.uid === u; });
    if (!r) return;
    form = nuevoForm(Object.assign({}, r));
    form.uid = r.uid;
    if (location.hash === '#registrar') render(); else location.hash = '#registrar';
  }

  function vistaRegistrar() {
    var c = config(), f = form;
    var tipos = c.tipos.slice(); if (f.tipo && tipos.indexOf(f.tipo) < 0) tipos.push(f.tipo);
    var grados = c.grados.slice(); if (f.grado && grados.indexOf(f.grado) < 0) grados.push(f.grado);
    var parts = c.participacion.slice(); if (f.participacion && parts.indexOf(f.participacion) < 0) parts.push(f.participacion);
    return '<div class="section" style="margin-top:4px"><h2>' + (f.uid ? 'Editar asistencia' : 'Nueva asistencia') + '</h2>' +
      (f.uid ? '<a class="aside" href="#historial" id="f-cancel">Cancelar</a>' : '') + '</div>' +
      '<form id="f" novalidate>' +
      '<div class="field"><label for="f-fecha">Fecha</label><input class="input" type="date" id="f-fecha" value="' + esc(f.fecha) + '" required>' +
      '<div class="hint" id="f-fecha-l">' + esc(f.fecha ? fechaLarga(f.fecha) : '') + '</div></div>' +
      '<div class="field"><span class="label">Respetable Logia</span><div class="picker" id="f-picker"></div></div>' +
      '<div class="field"><span class="label">Tipo de evento</span><div class="chips" id="f-tipo">' +
      tipos.map(function (t) { return '<button type="button" class="chip" aria-pressed="' + (t === f.tipo) + '">' + esc(t) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span class="label">Grado en que se trabajó</span><div class="seg" id="f-grado">' +
      grados.map(function (t) { return '<button type="button" aria-pressed="' + (t === f.grado) + '">' + esc(t) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span class="label">Condición</span><div class="seg" id="f-cond">' +
      ['Logia propia', 'Visita'].map(function (t) { return '<button type="button" aria-pressed="' + (t === f.condicion) + '">' + t + '</button>'; }).join('') + '</div>' +
      '<div class="hint">Se calcula sola según tu logia (N° ' + esc(c.miLogia) + '); puedes cambiarla.</div></div>' +
      '<div class="field"><span class="label">Participación</span><div class="seg" id="f-part">' +
      parts.map(function (t) { return '<button type="button" aria-pressed="' + (t === f.participacion) + '">' + esc(t) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field" id="f-trabajo-w"' + (norm(f.participacion).indexOf('trabajo') >= 0 ? '' : ' hidden') + '><label for="f-trabajo">Título del trabajo</label><input class="input" id="f-trabajo" value="' + esc(f.trabajo) + '" placeholder="Ej.: El simbolismo de la piedra bruta"></div>' +
      '<div class="field"><label for="f-obs">Observaciones</label><textarea class="input" id="f-obs" placeholder="Plancha de…, iniciación, aniversario…">' + esc(f.obs) + '</textarea></div>' +
      '<div id="f-err"></div>' +
      '<div class="actions">' + (f.uid ? '<button type="button" class="btn danger" id="f-del">Eliminar</button>' : '') +
      '<button class="btn primary" type="submit">' + (f.uid ? 'Guardar cambios' : 'Registrar asistencia') + '</button></div>' +
      '</form>';
  }

  function montarRegistrar() {
    var f = form, c = config();
    $('#f-fecha').oninput = function (e) { f.fecha = e.target.value; $('#f-fecha-l').textContent = f.fecha ? fechaLarga(f.fecha) : ''; };
    seg('#f-tipo', function (v) { f.tipo = v; }, '.chip');
    seg('#f-grado', function (v) { f.grado = v; });
    seg('#f-cond', function (v) { f.condicion = v; });
    seg('#f-part', function (v) { f.participacion = v; $('#f-trabajo-w').hidden = norm(v).indexOf('trabajo') < 0; });
    $('#f-trabajo').oninput = function (e) { f.trabajo = e.target.value; };
    $('#f-obs').oninput = function (e) { f.obs = e.target.value; };
    pintarPicker();

    $('#f').onsubmit = function (e) {
      e.preventDefault();
      var err = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)) err.push('Indica la fecha.');
      if (!f.logia && f.numero === '') err.push('Elige la logia.');
      if (!f.tipo) err.push('Elige el tipo de evento.');
      if (err.length) { $('#f-err').innerHTML = '<div class="banner err">' + err.join(' ') + '</div>'; return; }
      if (!f.condicion && f.numero !== '') f.condicion = Number(f.numero) === Number(c.miLogia) ? 'Logia propia' : 'Visita';
      if (norm(f.participacion).indexOf('trabajo') < 0) f.trabajo = '';
      var editando = !!f.uid;
      var rec = Object.assign({}, f, { uid: f.uid || uid(), numero: f.numero === '' ? '' : Number(f.numero) });
      encolar('upsert', rec);
      form = null;
      toast(editando ? 'Cambios guardados' : 'Asistencia registrada ∴');
      location.hash = editando ? '#historial' : '#inicio';
    };
    var del = $('#f-del');
    if (del) del.onclick = function () {
      if (!del.dataset.confirm) { del.dataset.confirm = '1'; del.textContent = '¿Seguro? Toca otra vez'; return; }
      encolar('delete', { uid: f.uid });
      form = null; toast('Registro eliminado'); location.hash = '#historial';
    };
    var cancel = $('#f-cancel');
    if (cancel) cancel.onclick = function () { form = null; };
  }

  function seg(sel, cb, child) {
    var botones = $$(sel + ' ' + (child || 'button'));
    botones.forEach(function (b) {
      b.onclick = function () { botones.forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); cb(b.textContent); };
    });
  }

  function pintarPicker() {
    var f = form, cont = $('#f-picker'), c = config();
    if (f.logia || f.numero !== '') {
      cont.innerHTML = '<div class="picked"><div class="num-chip">' + esc(f.numero === '' ? '?' : f.numero) + '</div>' +
        '<div class="item-body"><div class="item-title">' + esc(f.logia || '—') + '</div><div class="item-sub">Valle ' + esc(f.valle || '—') + '</div></div>' +
        '<button type="button" class="x" id="p-x" aria-label="Cambiar logia">×</button></div>' +
        '<details class="details"><summary>Editar nombre, número o valle</summary>' +
        '<div class="row-3"><div><label class="label" for="p-num">N°</label><input class="input" id="p-num" inputmode="numeric" value="' + esc(f.numero) + '"></div>' +
        '<div><label class="label" for="p-nom">Nombre</label><input class="input" id="p-nom" value="' + esc(f.logia) + '"></div></div>' +
        '<div style="margin-top:10px"><label class="label" for="p-valle">Valle</label><input class="input" id="p-valle" value="' + esc(f.valle) + '"></div></details>';
      $('#p-x').onclick = function () { f.logia = ''; f.numero = ''; f.valle = ''; f.condicion = ''; actualizarCond(); pintarPicker(); setTimeout(function () { var i = $('#p-q'); if (i) i.focus(); }, 0); };
      $('#p-num').oninput = function (e) { f.numero = e.target.value.replace(/\D/g, ''); f.condicion = ''; autoCond(); };
      $('#p-nom').oninput = function (e) { f.logia = e.target.value; };
      $('#p-valle').oninput = function (e) { f.valle = e.target.value; };
      return;
    }
    // Sugerencias rápidas: logias recientes
    var recientes = []; var vistos = {};
    asistenciasOrdenadas().forEach(function (r) { if (r.numero !== '' && !vistos[r.numero] && recientes.length < 4) { vistos[r.numero] = 1; recientes.push(r); } });
    cont.innerHTML = '<input class="input" id="p-q" type="search" placeholder="Busca por número o nombre (ej.: 9 o Cóndor)" autocomplete="off">' +
      (recientes.length ? '<div class="chips" style="margin-top:8px" id="p-rec">' + recientes.map(function (r) {
        return '<button type="button" class="chip" data-n="' + esc(r.numero) + '">' + esc(r.logia) + ' ' + esc(r.numero) + '</button>';
      }).join('') + '</div>' : '') + '<div id="p-sug"></div>';
    $$('#p-rec .chip').forEach(function (b) { b.onclick = function () { elegirLogia(b.dataset.n); }; });
    $('#p-q').oninput = function (e) {
      var res = buscarLogias(e.target.value).slice(0, 8);
      var q = e.target.value.trim();
      $('#p-sug').innerHTML = q ? '<div class="suggest">' + res.map(function (l) {
        return '<button type="button" data-n="' + esc(l.n) + '"><span class="n">' + esc(l.n) + '</span><span><b>' + esc(l.nombre) + '</b><br><span class="small muted">' + esc(l.valle) + ' · ' + esc(l.dia) + '</span></span></button>';
      }).join('') + '<button type="button" id="p-manual"><span class="n">+</span><span>Usar “' + esc(q) + '” (no está en el directorio)</span></button></div>' : '';
      $$('#p-sug [data-n]').forEach(function (b) { b.onclick = function () { elegirLogia(b.dataset.n); }; });
      var m = $('#p-manual');
      if (m) m.onclick = function () {
        if (/^\d+$/.test(q)) { f.numero = Number(q); } else { f.logia = q; }
        autoCond(); pintarPicker();
        var d = $('#f-picker details'); if (d) d.open = true;
      };
    };
  }
  function elegirLogia(n) {
    var f = form, l = logiaPorNumero(n);
    f.numero = Number(n);
    f.logia = nombrePropio(n, l ? l.nombre : '');
    f.valle = l ? l.valle : '';
    // usa el valle que tú usaste si existe
    var prev = S.data.asistencias.filter(function (r) { return Number(r.numero) === Number(n) && r.valle; }).pop();
    if (prev) f.valle = prev.valle;
    f.condicion = '';
    autoCond();
    pintarPicker();
  }
  function autoCond() {
    var f = form, c = config();
    if (!f.condicion && f.numero !== '') f.condicion = Number(f.numero) === Number(c.miLogia) ? 'Logia propia' : 'Visita';
    actualizarCond();
  }
  function actualizarCond() { $$('#f-cond button').forEach(function (b) { b.setAttribute('aria-pressed', b.textContent === form.condicion); }); }

  function buscarLogias(q) {
    q = norm(q);
    if (!q) return S.data.logias.slice();
    var esNum = /^\d+$/.test(q);
    var res = S.data.logias.filter(function (l) {
      if (esNum) return String(l.n).indexOf(q) === 0;
      return norm(l.nombre + ' ' + l.valle + ' ' + l.jur + ' ' + l.dir).indexOf(q) >= 0;
    });
    res.sort(function (a, b) {
      if (esNum) return (String(a.n) === q ? -1 : 0) - (String(b.n) === q ? -1 : 0) || a.n - b.n;
      var an = norm(a.nombre).indexOf(q) === 0 ? 0 : norm(a.nombre).indexOf(q) >= 0 ? 1 : 2;
      var bn = norm(b.nombre).indexOf(q) === 0 ? 0 : norm(b.nombre).indexOf(q) >= 0 ? 1 : 2;
      return an - bn || a.n - b.n;
    });
    return res;
  }

  /* ===================== Directorio de logias ===================== */
  function vistaLogias() {
    var st = estadoVista.logias;
    if (st.valle === null) st.valle = S.prefs.valle || '';
    var ritos = {}; S.data.logias.forEach(function (l) { if (l.rito) ritos[l.rito] = 1; });
    var dias = [['', 'Todos'], ['hoy', 'Hoy']].concat([1, 2, 3, 4, 5, 6, 0].map(function (i) { return [DIAS[i], DIAS_CORTO[i]]; }));
    return '<input class="input" id="l-q" type="search" placeholder="Número, nombre, dirección…" value="' + esc(st.q) + '" autocomplete="off">' +
      '<div class="row" style="margin-top:10px"><select class="input" id="l-valle" aria-label="Valle"><option value="">Todos los valles</option>' +
      valles().map(function (v) { return '<option' + (v === st.valle ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>' +
      '<select class="input" id="l-rito" aria-label="Rito"><option value="">Todos los ritos</option>' +
      Object.keys(ritos).sort().map(function (r) { return '<option' + (r === st.rito ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></div>' +
      '<div class="chips scroll" style="margin-top:10px" id="l-dias">' + dias.map(function (d) {
        return '<button class="chip" data-dia="' + d[0] + '" aria-pressed="' + (st.dia === d[0]) + '">' + d[1] + '</button>';
      }).join('') + '</div><div class="hint" id="l-count"></div><div class="list" id="l-lista" style="margin-top:8px"></div>';
  }
  function montarLogias() {
    var st = estadoVista.logias;
    function pintar() {
      var res = buscarLogias(st.q).filter(function (l) {
        if (st.valle && l.valle !== st.valle) return false;
        if (st.rito && l.rito !== st.rito) return false;
        if (st.dia === 'hoy') return trabajaHoy(l);
        if (st.dia && norm(l.dia) !== norm(st.dia)) return false;
        return true;
      });
      $('#l-count').textContent = res.length + ' logia' + (res.length === 1 ? '' : 's');
      var html = res.slice(0, st.limite).map(itemLogia).join('');
      if (res.length > st.limite) html += '<button class="btn block" id="l-mas">Mostrar más</button>';
      if (!res.length) html = '<div class="empty card">Sin resultados.</div>';
      $('#l-lista').innerHTML = html;
      enlazarItems($('#l-lista'));
      var mas = $('#l-mas'); if (mas) mas.onclick = function () { st.limite += 60; pintar(); };
    }
    $('#l-q').oninput = function (e) { st.q = e.target.value; st.limite = 60; pintar(); };
    $('#l-valle').onchange = function (e) { st.valle = e.target.value; pintar(); };
    $('#l-rito').onchange = function (e) { st.rito = e.target.value; pintar(); };
    $$('#l-dias .chip').forEach(function (c) {
      c.onclick = function () { st.dia = c.dataset.dia; $$('#l-dias .chip').forEach(function (x) { x.setAttribute('aria-pressed', x === c); }); pintar(); };
    });
    pintar();
  }

  function verLogia(n) {
    var l = logiaPorNumero(n);
    if (!l) return;
    var mias = asistenciasOrdenadas().filter(function (r) { return Number(r.numero) === Number(n); });
    var maps = l.maps || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(l.dir + ', ' + l.valle + ', Chile'));
    var html = '<div class="grab"></div>' +
      '<div style="display:flex;gap:12px;align-items:center"><div class="num-chip">' + esc(l.n) + '</div><div><div class="small muted">R∴L∴</div><h2>' + esc(l.nombre) + '</h2></div></div>' +
      (trabajaHoy(l) ? '<div class="banner" style="margin:12px 0 0">Trabaja hoy' + (l.hora ? ' a las ' + esc(l.hora) : '') + '.</div>' : '') +
      '<dl class="kv"><dt>Día y hora</dt><dd>' + esc(l.dia) + (l.frec && l.frec !== 'Semanal' ? ' (' + esc(l.frec) + ')' : '') + (l.hora ? ' · ' + esc(l.hora) + ' h' : '') + '</dd>' +
      '<dt>Valle</dt><dd>' + esc(l.valle) + '</dd>' +
      '<dt>Dirección</dt><dd>' + esc(l.dir) + '</dd>' +
      '<dt>Jurisdicción</dt><dd>' + esc(l.jur) + '</dd>' +
      '<dt>Rito</dt><dd>' + esc(l.rito) + '</dd>' +
      '<dt>Mis asistencias</dt><dd>' + (mias.length ? mias.length + ' · última el ' + esc(fechaLarga(mias[0].fecha)) : 'Ninguna aún') + '</dd></dl>' +
      '<div class="actions" style="margin-top:4px"><a class="btn" href="' + esc(maps) + '" target="_blank" rel="noopener">Abrir en Maps</a>' +
      '<button class="btn primary" id="lg-reg">Registrar asistencia</button></div>';
    abrirSheet(html);
    $('#lg-reg').onclick = function () {
      form = nuevoForm();
      cerrarSheet();
      elegirLogiaEnForm(n);
      if (location.hash === '#registrar') render(); else location.hash = '#registrar';
    };
  }
  function elegirLogiaEnForm(n) {
    var l = logiaPorNumero(n), c = config();
    form.numero = Number(n);
    form.logia = nombrePropio(n, l ? l.nombre : '');
    var prev = S.data.asistencias.filter(function (r) { return Number(r.numero) === Number(n) && r.valle; }).pop();
    form.valle = prev ? prev.valle : (l ? l.valle : '');
    form.condicion = Number(n) === Number(c.miLogia) ? 'Logia propia' : 'Visita';
  }

  function abrirSheet(html) {
    var s = $('#sheet'), b = $('#sheet-backdrop');
    s.innerHTML = html; s.hidden = false; b.hidden = false;
    b.onclick = cerrarSheet;
  }
  function cerrarSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }

  /* ===================== Ajustes ===================== */
  function vistaAjustes() {
    var errores = S.queue.filter(function (q) { return q.error; });
    var html = '<div class="section" style="margin-top:4px"><h2>Conexión</h2></div><div class="card">' +
      '<div class="field"><label for="a-url">URL de la aplicación web (Apps Script)</label><input class="input" id="a-url" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(S.api.url) + '" autocomplete="off" autocapitalize="off"></div>' +
      '<div class="field"><label for="a-token">Token de acceso</label><input class="input" id="a-token" type="password" value="' + esc(S.api.token) + '" autocomplete="off" autocapitalize="off"></div>' +
      '<div id="a-msg"></div>' +
      '<div class="actions" style="margin-top:6px"><button class="btn primary" id="a-save">Guardar y conectar</button></div>' +
      '<p class="hint">' + (S.lastSync ? 'Última sincronización: ' + new Date(S.lastSync).toLocaleString('es-CL') : 'Aún no se sincroniza.') +
      (S.lastError ? '<br><span style="color:var(--danger)">Último error: ' + esc(S.lastError) + '</span>' : '') + '</p></div>';

    if (S.api.url) {
      html += '<div class="section"><h2>Sincronización</h2><span class="aside">' + S.queue.length + ' pendiente(s)</span></div><div class="card">' +
        '<button class="btn block" id="a-sync">Sincronizar ahora</button>' +
        (errores.length ? '<div style="margin-top:12px">' + errores.map(function (q) {
          return '<div class="banner err small"><b>Rechazado:</b> ' + esc(q.error) + '<br>' + esc(q.record ? (q.record.fecha + ' · ' + q.record.logia) : q.uid) +
            ' <button class="btn sm danger" data-descartar="' + esc(q.qid) + '" style="margin-top:6px">Descartar cambio</button></div>';
        }).join('') + '</div>' : '') + '</div>';

      html += '<div class="section"><h2>Vincular otro dispositivo</h2></div><div class="card">' +
        '<p class="small muted" style="margin-top:0">Escanea este código con la cámara del celular para conectarlo sin escribir nada. Contiene tu token: no lo muestres a otros.</p>' +
        '<button class="btn block" id="a-qr-btn">Mostrar código QR</button><div id="a-qr" style="text-align:center;margin-top:12px"></div></div>';

      html += '<div class="section"><h2>Datos</h2></div><div class="card">' +
        '<p class="small muted" style="margin-top:0">' + S.data.asistencias.length + ' asistencias · ' + S.data.logias.length + ' logias en el directorio · Tu logia: N° ' + esc(config().miLogia) + '</p>' +
        '<div class="actions" style="margin-top:0"><button class="btn" id="a-csv">Exportar CSV</button><button class="btn danger" id="a-reset">Desconectar</button></div>' +
        '<p class="hint">Tipos de evento, grados y tu logia se cambian en la pestaña <b>Config</b> de la planilla.</p></div>';
    }
    html += '<p class="hint" style="text-align:center;margin-top:22px">Bitácora Masónica · v1.0</p>';
    return html;
  }

  function montarAjustes() {
    $('#a-save').onclick = function () {
      var url = $('#a-url').value.trim(), tok = $('#a-token').value.trim();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { $('#a-msg').innerHTML = '<div class="banner err">La URL debe empezar con https://script.google.com/</div>'; return; }
      if (!tok) { $('#a-msg').innerHTML = '<div class="banner err">Falta el token.</div>'; return; }
      var prev = S.api;
      S.api = { url: url, token: tok };
      $('#a-msg').innerHTML = '<div class="banner">Conectando…</div>';
      api({ action: 'bootstrap' }).then(function (j) {
        S.data = j.data; aplicarColaLocal(); S.lastSync = new Date().toISOString(); S.lastError = null; guardar();
        toast('Conectado ∴ ' + j.data.asistencias.length + ' asistencias');
        if (S.queue.length) sincronizar(true);
        location.hash = '#inicio';
        pintarEstado();
      }).catch(function (e) {
        S.api = prev; guardar();
        $('#a-msg').innerHTML = '<div class="banner err">No se pudo conectar: ' + esc(e.message) + '</div>';
      });
    };
    var s = $('#a-sync'); if (s) s.onclick = function () { sincronizar(false); };
    $$('[data-descartar]').forEach(function (b) {
      b.onclick = function () { S.queue = S.queue.filter(function (q) { return q.qid !== b.dataset.descartar; }); guardar(); sincronizar(true); render(); };
    });
    var qb = $('#a-qr-btn'); if (qb) qb.onclick = mostrarQR;
    var csv = $('#a-csv'); if (csv) csv.onclick = exportarCSV;
    var rs = $('#a-reset'); if (rs) rs.onclick = function () {
      if (!rs.dataset.confirm) { rs.dataset.confirm = '1'; rs.textContent = '¿Seguro?'; return; }
      if (S.queue.length && !confirmarPerdida()) return;
      S = { api: { url: '', token: '' }, data: { asistencias: [], logias: [], config: DEFAULT_CONFIG }, queue: [], lastSync: null, lastError: null, prefs: S.prefs };
      guardar(); pintarEstado(); render();
    };
  }
  function confirmarPerdida() { return window.confirm ? window.confirm('Hay cambios sin sincronizar que se perderán. ¿Continuar?') : true; }

  function mostrarQR() {
    var cont = $('#a-qr');
    var payload = btoa(unescape(encodeURIComponent(JSON.stringify({ u: S.api.url, t: S.api.token }))));
    var link = location.origin + location.pathname + '#vincular=' + payload;
    function pintar() {
      cont.innerHTML = '<div class="qr" id="a-qr-c"></div>';
      /* global QRCode */
      new QRCode($('#a-qr-c'), { text: link, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
    }
    if (window.QRCode) return pintar();
    cont.textContent = 'Cargando…';
    var sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    sc.onload = pintar;
    sc.onerror = function () { cont.innerHTML = '<p class="small">Sin conexión para generar el QR. Copia este enlace al otro dispositivo:</p><code class="tok">' + esc(link) + '</code>'; };
    document.head.appendChild(sc);
  }

  function vincularDesdeHash(p) {
    try {
      var o = JSON.parse(decodeURIComponent(escape(atob(p))));
      S.api = { url: o.u, token: o.t }; guardar();
      history.replaceState(null, '', location.pathname + '#inicio');
      toast('Dispositivo vinculado ∴');
      sincronizar(true);
    } catch (e) {
      history.replaceState(null, '', location.pathname + '#ajustes');
      toast('El enlace de vinculación no es válido');
    }
    ruta();
  }

  function exportarCSV() {
    var cols = ['id', 'fecha', 'tipo', 'logia', 'numero', 'valle', 'grado', 'condicion', 'participacion', 'trabajo', 'obs'];
    var head = ['ID', 'Fecha', 'Tipo Evento', 'R.L. Nombre', 'R.L. Número', 'Valle', 'Grado', 'Condición', 'Participación', 'Trabajo presentado', 'obs'];
    var lines = [head.join(';')].concat(asistenciasOrdenadas().reverse().map(function (r) {
      return cols.map(function (c) { var v = String(r[c] == null ? '' : r[c]); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(';');
    }));
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'asistencias-' + hoyISO() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ===================== Arranque ===================== */
  window.addEventListener('hashchange', ruta);
  window.addEventListener('online', function () { pintarEstado(); sincronizar(true); });
  window.addEventListener('offline', pintarEstado);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sincronizar(true); });
  $('#sync-btn').onclick = function () { if (!S.api.url) location.hash = '#ajustes'; else sincronizar(false); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') cerrarSheet(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* opcional */ });
  }

  pintarEstado();
  ruta();
  sincronizar(true);

  // Exponer para pruebas
  window.__bitacora = { estado: function () { return S; }, sincronizar: sincronizar };
})();
