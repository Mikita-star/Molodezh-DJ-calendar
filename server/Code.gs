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
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req, user) {
  const admin = isAdmin(user.id);
  if (req.action === 'hello') return { ok: true, admin };
  if (req.action === 'save') {
    saveDj(user, req.nick, req.sets, req.busy);
    return { ok: true, admin };
  }
  if (req.action === 'admin') {
    if (!admin) return { ok: false, error: 'forbidden' };
    return { ok: true, admin, djs: readDjs() };
  }
  if (req.action === 'schedule') return { ok: true, admin, schedule: readSchedule() };
  if (req.action === 'publish') {
    if (!admin) return { ok: false, error: 'forbidden' };
    publishSchedule(req.dates, req.entries);
    return { ok: true, admin, schedule: readSchedule() };
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

function saveDj(user, nick, sets, busy) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const id = String(user.id);
    const clean = cleanSets(sets);
    const off = cleanBusy(busy, clean);
    const tgName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const name = String(nick || '').trim().slice(0, 40) || tgName || id;
    const row = [id, name, tgName, user.username ? '@' + user.username : '', new Date(), JSON.stringify({ sets: clean, busy: off })];

    // Лист «Диджеи»: одна строка на диджея
    const dj = djSheet();
    const ids = dj.getRange(1, 1, dj.getLastRow(), 1).getValues().map(r => String(r[0]));
    const at = ids.indexOf(id);
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
