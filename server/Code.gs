/**
 * Хранилище для «Молодежь DJ календарь».
 * Диджеи присылают сюда своё свободное время, администраторы получают сводку
 * и публикуют расписание, которое видят все диджеи.
 * Всё хранится в Google Таблице, к которой привязан этот скрипт.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   BOT_TOKEN — токен бота из @BotFather (нужен, чтобы проверять, что запрос пришёл из Telegram)
 *   ADMIN_IDS — Telegram ID администраторов через запятую, например: 123456789, 987654321
 */

const DJ_SHEET = 'Диджеи';
const SLOTS_SHEET = 'Свободное время';
const SCHEDULE_SHEET = 'Расписание';
const WEEKENDS_SHEET = 'Выходные';
const BLOCKED_SHEET = 'Закрытые дни';
const REMOVED_SHEET = 'Удалённые';
const MAX_AGE_SEC = 7 * 24 * 3600; // подпись Telegram действительна неделю
const ALL_SLOTS = ['21:00–00:00', '00:00–03:00', '03:00–06:00',
  '20:00–22:00', '22:00–00:00', '00:00–02:00', '02:00–04:00', '04:00–06:00', '06:00–09:00'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const BUSY_LABEL = 'занят весь день';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Проверка, что скрипт опубликован: откройте ссылку в браузере
function doGet() {
  return ContentService.createTextOutput('Хранилище «Молодежь DJ календарь» работает');
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse(e.postData.contents);
    const user = verifyInitData(req.initData);
    res = user ? handle(req, user) : { ok: false, error: 'auth' };
    if (res.ok) { // дни, которые админ сделал выходными или закрыл для отметок, — всем
      res.weekends = readWeekends();
      res.blocked = readBlocked();
    }
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req, user) {
  const admin = isAdmin(user.id);
  const id = String(user.id);
  // Удалённый админом диджей: заблокированному — отказ во всём,
  // остальным — команда стереть старые отметки (wipe), пока приложение не подтвердит
  const gone = admin ? null : findRemoved(id);
  if (gone && gone.blocked) return { ok: false, error: 'blocked' };
  if (gone && req.action === 'save' && String(req.wipeAck) === gone.stamp) {
    unremove(id);
  } else if (gone) {
    if (req.action === 'save') return { ok: true, admin, wipe: gone.stamp };
    const res = handle2(req, user, admin);
    if (res.ok) res.wipe = gone.stamp;
    return res;
  }
  return handle2(req, user, admin);
}

function handle2(req, user, admin) {
  if (req.action === 'hello') {
    ensureDj(user, req.nick);
    return withNick({ ok: true, admin }, user);
  }
  if (req.action === 'save') {
    saveDj(user, req.nick, req.sets, req.busy, Number(req.nickAt) || 0);
    return withNick({ ok: true, admin }, user);
  }
  if (req.action === 'admin') {
    if (!admin) return { ok: false, error: 'forbidden' };
    return { ok: true, admin, djs: readDjs(), removed: readRemoved() };
  }
  if (req.action === 'rename') {
    if (!admin) return { ok: false, error: 'forbidden' };
    renameDj(req.id, req.nick);
    return { ok: true, admin, djs: readDjs(), removed: readRemoved() };
  }
  if (req.action === 'remove') {
    if (!admin) return { ok: false, error: 'forbidden' };
    if (isAdmin(req.id)) return { ok: false, error: 'admin' };
    removeDj(req.id, !!req.block);
    return { ok: true, admin, djs: readDjs(), removed: readRemoved() };
  }
  if (req.action === 'unblock') {
    if (!admin) return { ok: false, error: 'forbidden' };
    unblockDj(req.id);
    return { ok: true, admin, djs: readDjs(), removed: readRemoved() };
  }
  if (req.action === 'schedule') return { ok: true, admin, schedule: readSchedule() };
  if (req.action === 'publish') {
    if (!admin) return { ok: false, error: 'forbidden' };
    publishSchedule(req.dates, req.entries);
    return { ok: true, admin, schedule: readSchedule() };
  }
  if (req.action === 'weekend') {
    if (!admin) return { ok: false, error: 'forbidden' };
    setWeekend(req.date, !!req.on);
    return { ok: true, admin };
  }
  if (req.action === 'block') {
    if (!admin) return { ok: false, error: 'forbidden' };
    setBlocked(req.date, !!req.on);
    return { ok: true, admin };
  }
  return { ok: false, error: 'unknown action' };
}

// ---------- Проверка подписи Telegram ----------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  if (!initData) return null;
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) throw new Error('В свойствах скрипта не задан BOT_TOKEN');
  const params = {};
  String(initData).split('&').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const decode = s => decodeURIComponent(s.replace(/\+/g, ' '));
    params[decode(part.slice(0, i))] = decode(part.slice(i + 1));
  });
  const hash = params.hash;
  delete params.hash;
  const check = Object.keys(params).sort().map(k => k + '=' + params[k]).join('\n');
  const bytes = s => Utilities.newBlob(s).getBytes();
  const secret = Utilities.computeHmacSha256Signature(bytes(token), bytes('WebAppData'));
  const sign = Utilities.computeHmacSha256Signature(bytes(check), secret);
  if (!hash || toHex(sign) !== hash) return null;
  if (Date.now() / 1000 - Number(params.auth_date) > MAX_AGE_SEC) return null;
  return JSON.parse(params.user);
}

function toHex(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function isAdmin(id) {
  const ids = (PropertiesService.getScriptProperties().getProperty('ADMIN_IDS') || '')
    .split(/[\s,;]+/).filter(Boolean);
  return ids.indexOf(String(id)) >= 0;
}

// ---------- Таблица ----------
function sheet(name, headers) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

const djSheet = () => sheet(DJ_SHEET, ['Telegram ID', 'Ник', 'Имя в Telegram', 'Username', 'Обновлено', 'Данные']);
const slotsSheet = () => sheet(SLOTS_SHEET, ['Дата', 'День', 'Слот', 'Ник', 'Telegram ID']);
const scheduleSheet = () => sheet(SCHEDULE_SHEET, ['Дата', 'День', 'Время', 'Ник', 'Telegram ID']);
const weekdayOf = ds => WEEKDAYS[new Date(ds + 'T12:00:00').getDay()];

// Переписывает строки листа ниже заголовка; всё храним как текст, чтобы таблица не переделывала даты
function writeRows(sh, rows, width) {
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, width).clearContent();
  if (rows.length) {
    const range = sh.getRange(2, 1, rows.length, width);
    range.setNumberFormat('@');
    range.setValues(rows);
  }
}

// Оставляем только правильные даты и известные слоты
function cleanSets(sets) {
  const res = {};
  Object.keys(sets || {}).slice(0, 1000).forEach(ds => {
    if (!DATE_RE.test(ds) || !Array.isArray(sets[ds])) return;
    const slots = sets[ds].filter(s => ALL_SLOTS.indexOf(s) >= 0);
    if (slots.length) res[ds] = slots;
  });
  return res;
}

// Даты «занят весь день»; день не может быть одновременно свободным и занятым
function cleanBusy(busy, sets) {
  return (Array.isArray(busy) ? busy : []).slice(0, 1000)
    .filter((ds, i, all) => DATE_RE.test(ds) && !sets[ds] && all.indexOf(ds) === i).sort();
}

function saveDj(user, nick, sets, busy, nickAt) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const id = String(user.id);
    const clean = cleanSets(sets);
    const dj = djSheet();
    const ids = dj.getRange(1, 1, dj.getLastRow(), 1).getValues().map(r => String(r[0]));
    const at = ids.indexOf(id);
    // В закрытые админом дни диджей ничего не меняет: оставляем то, что было
    const blocked = readBlocked();
    if (blocked.length) {
      let before = {};
      try { const d = at > 0 ? JSON.parse(dj.getRange(at + 1, 6).getValue() || '{}') : {}; before = cleanSets(d.sets || (d.busy ? {} : d)); } catch (e) {}
      blocked.forEach(ds => { if (before[ds]) clean[ds] = before[ds]; else delete clean[ds]; });
    }
    const off = cleanBusy(busy, clean);
    const tgName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    // Ник, который админ поменял позже, чем диджей свой, не перезаписываем
    let name = String(nick || '').trim().slice(0, 40) || tgName || id;
    let savedNickAt = 0;
    if (at > 0) {
      const prev = dj.getRange(at + 1, 1, 1, 6).getValues()[0];
      try { savedNickAt = Number(JSON.parse(prev[5] || '{}').nickAt) || 0; } catch (e) {}
      if (savedNickAt && nickAt < savedNickAt) name = String(prev[1]);
      else savedNickAt = Math.max(savedNickAt, nickAt);
    }
    const row = [id, name, tgName, user.username ? '@' + user.username : '', new Date(), JSON.stringify({ sets: clean, busy: off, nickAt: savedNickAt })];

    // Лист «Диджеи»: одна строка на диджея
    if (at > 0) dj.getRange(at + 1, 1, 1, row.length).setValues([row]);
    else dj.appendRow(row);

    // Лист «Свободное время»: по строке на каждый слот, удобно фильтровать и сортировать
    const sl = slotsSheet();
    const old = sl.getLastRow() > 1 ? sl.getRange(2, 1, sl.getLastRow() - 1, 5).getDisplayValues() : [];
    const rows = old.filter(r => r[4] !== id);
    Object.keys(clean).forEach(ds => clean[ds].forEach(slot => rows.push([ds, weekdayOf(ds), slot, name, id])));
    off.forEach(ds => rows.push([ds, weekdayOf(ds), BUSY_LABEL, name, id]));
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : ALL_SLOTS.indexOf(a[2]) - ALL_SLOTS.indexOf(b[2]));
    writeRows(sl, rows, 5);
  } finally {
    lock.releaseLock();
  }
}

function readDjs() {
  const dj = djSheet();
  if (dj.getLastRow() < 2) return [];
  const res = [];
  dj.getRange(2, 1, dj.getLastRow() - 1, 6).getValues().forEach(r => {
    if (!r[0]) return;
    let sets = {}, busy = {};
    try {
      const data = JSON.parse(r[5] || '{}');
      // старый формат — только слоты, новый — { sets, busy }
      sets = cleanSets(data.sets || (data.busy ? {} : data));
      cleanBusy(data.busy, sets).forEach(ds => busy[ds] = true);
    } catch (e) {} // строку поправили руками — не ломаем всю сводку
    res.push({
      id: String(r[0]),
      nick: String(r[1]),
      tgName: String(r[2]),
      username: String(r[3]),
      updated: r[4] instanceof Date ? r[4].getTime() : 0,
      admin: isAdmin(r[0]),
      sets,
      busy,
    });
  });
  return res;
}

// ---------- Расписание ----------
// Ночь до полудня относится к вечеру: 00:00 идёт после 22:00
function timeKey(t) {
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  if (!m) return 99999;
  const h = Number(m[1]);
  return (h < 12 ? h + 24 : h) * 60 + Number(m[2]);
}

// Публикация заменяет только те даты, что есть в тексте админа; дата без сетов — очищается
function publishSchedule(dates, entries) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const touched = {};
    (Array.isArray(dates) ? dates : []).slice(0, 400).forEach(ds => { if (DATE_RE.test(ds)) touched[ds] = true; });
    const fresh = (Array.isArray(entries) ? entries : []).slice(0, 3000)
      .filter(e => e && DATE_RE.test(e.date) && String(e.time || '').trim() && String(e.nick || '').trim())
      .map(e => {
        touched[e.date] = true;
        const id = /^\d+$/.test(String(e.id || '')) ? String(e.id) : '';
        return [e.date, weekdayOf(e.date), String(e.time).trim().slice(0, 20), String(e.nick).trim().slice(0, 40), id];
      });
    const sh = scheduleSheet();
    const old = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 5).getDisplayValues() : [];
    const rows = old.filter(r => r[0] && !touched[r[0]]).concat(fresh);
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : timeKey(a[2]) - timeKey(b[2]));
    writeRows(sh, rows, 5);
  } finally {
    lock.releaseLock();
  }
}

function readSchedule() {
  const sh = scheduleSheet();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getDisplayValues()
    .filter(r => DATE_RE.test(r[0]) && r[2] && r[3])
    .map(r => ({ date: r[0], time: r[2], nick: r[3], id: r[4] }));
}

// ---------- Дни, отмеченные админом: выходные (праздники) и закрытые для отметок ----------
// В дополнительные выходные у всех диджеев слоты как в пятницу и субботу,
// в закрытые дни диджеи не могут менять своё свободное время
const weekendsSheet = () => sheet(WEEKENDS_SHEET, ['Дата', 'День']);
const blockedSheet = () => sheet(BLOCKED_SHEET, ['Дата', 'День']);

function readDates(sh) {
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues()
    .map(r => r[0]).filter(ds => DATE_RE.test(ds));
}

function setDate(sh, ds, on) {
  if (!DATE_RE.test(String(ds))) throw new Error('bad date');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const dates = readDates(sh).filter(d => d !== ds);
    if (on) dates.push(ds);
    dates.sort();
    writeRows(sh, dates.map(d => [d, weekdayOf(d)]), 2);
  } finally {
    lock.releaseLock();
  }
}

const readWeekends = () => readDates(weekendsSheet());
const setWeekend = (ds, on) => setDate(weekendsSheet(), ds, on);
const readBlocked = () => readDates(blockedSheet());
const setBlocked = (ds, on) => setDate(blockedSheet(), ds, on);

// ---------- Управление диджеями (только админ) ----------
// Текущий ник диджея и когда его менял админ — приложение диджея подхватывает его
function withNick(res, user) {
  const dj = djSheet();
  if (dj.getLastRow() < 2) return res;
  const row = dj.getRange(2, 1, dj.getLastRow() - 1, 6).getValues().find(r => String(r[0]) === String(user.id));
  if (!row) return res;
  let nickAt = 0;
  try { nickAt = Number(JSON.parse(row[5] || '{}').nickAt) || 0; } catch (e) {}
  res.nick = String(row[1]);
  res.nickAt = nickAt;
  return res;
}

function djRowIndex(dj, id) {
  if (dj.getLastRow() < 2) return -1;
  const ids = dj.getRange(1, 1, dj.getLastRow(), 1).getValues().map(r => String(r[0]));
  return ids.indexOf(String(id));
}

// Новый ник — в листе «Диджеи», в «Свободном времени» и в опубликованном расписании
function renameDj(id, nick) {
  id = String(id || '');
  nick = String(nick || '').trim().slice(0, 40);
  if (!nick) throw new Error('empty nick');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const dj = djSheet();
    const at = djRowIndex(dj, id);
    if (at < 1) throw new Error('not found');
    let data = {};
    try { data = JSON.parse(dj.getRange(at + 1, 6).getValue() || '{}'); } catch (e) {}
    data.nickAt = Date.now();
    dj.getRange(at + 1, 2).setValue(nick);
    dj.getRange(at + 1, 6).setValue(JSON.stringify(data));
    [[slotsSheet(), 5, 4], [scheduleSheet(), 5, 4]].forEach(([sh, width, nickCol]) => {
      if (sh.getLastRow() < 2) return;
      const rows = sh.getRange(2, 1, sh.getLastRow() - 1, width).getDisplayValues();
      let changed = false;
      rows.forEach(r => { if (r[width - 1] === id && r[nickCol - 1] !== nick) { r[nickCol - 1] = nick; changed = true; } });
      if (changed) writeRows(sh, rows, width);
    });
  } finally {
    lock.releaseLock();
  }
}

// Каждый, кто открыл календарь, есть в листе «Диджеи» — даже без отметок
function ensureDj(user, nick) {
  const id = String(user.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const dj = djSheet();
    if (djRowIndex(dj, id) > 0) return;
    const tgName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const name = String(nick || '').trim().slice(0, 40) || tgName || id;
    dj.appendRow([id, name, tgName, user.username ? '@' + user.username : '', new Date(), JSON.stringify({ sets: {}, busy: [], nickAt: 0 })]);
  } finally {
    lock.releaseLock();
  }
}

const removedSheet = () => sheet(REMOVED_SHEET, ['Telegram ID', 'Ник', 'Удалён', 'Доступ закрыт', 'Имя в Telegram', 'Username']);

function readRemoved() {
  const sh = removedSheet();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getDisplayValues()
    .filter(r => r[0])
    .map(r => ({ id: r[0], nick: r[1], stamp: r[2], blocked: r[3] === 'да', tgName: r[4], username: r[5] }));
}

const findRemoved = id => readRemoved().find(r => r.id === String(id)) || null;

function writeRemoved(list) {
  writeRows(removedSheet(), list.map(r => [r.id, r.nick, r.stamp, r.blocked ? 'да' : '', r.tgName || '', r.username || '']), 6);
}

// Удаляет диджея и его свободное время; опубликованное расписание не трогаем
function removeDj(id, block) {
  id = String(id || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const dj = djSheet();
    const at = djRowIndex(dj, id);
    let nick = id, tgName = '', username = '';
    if (at > 0) {
      const row = dj.getRange(at + 1, 1, 1, 4).getValues()[0];
      nick = String(row[1]) || id;
      tgName = String(row[2]);
      username = String(row[3]);
      dj.deleteRow(at + 1);
    }
    const sl = slotsSheet();
    if (sl.getLastRow() > 1) writeRows(sl, sl.getRange(2, 1, sl.getLastRow() - 1, 5).getDisplayValues().filter(r => r[0] && r[4] !== id), 5);
    const list = readRemoved().filter(r => r.id !== id);
    list.push({ id, nick, stamp: String(Date.now()), blocked: block, tgName, username });
    writeRemoved(list);
  } finally {
    lock.releaseLock();
  }
}

// Разблокированный диджей сразу возвращается в список без отметок,
// а при следующем входе его старые отметки сотрутся и в календаре
function unblockDj(id) {
  id = String(id || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const list = readRemoved();
    const r = list.find(x => x.id === id);
    if (!r) return;
    r.blocked = false;
    writeRemoved(list);
    const dj = djSheet();
    if (djRowIndex(dj, id) < 1) dj.appendRow([id, r.nick || id, r.tgName || '', r.username || '', new Date(), JSON.stringify({ sets: {}, busy: [], nickAt: 0 })]);
  } finally {
    lock.releaseLock();
  }
}

// Приложение диджея стёрло старые отметки — дальше он обычный диджей
function unremove(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    writeRemoved(readRemoved().filter(r => r.id !== String(id)));
  } finally {
    lock.releaseLock();
  }
}
