/**
 * Хранилище для «Молодежь DJ календарь».
 * Диджеи присылают сюда своё свободное время, администраторы получают сводку.
 * Всё хранится в Google Таблице, к которой привязан этот скрипт.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   BOT_TOKEN — токен бота из @BotFather (нужен, чтобы проверять, что запрос пришёл из Telegram)
 *   ADMIN_IDS — Telegram ID администраторов через запятую, например: 123456789, 987654321
 */

const DJ_SHEET = 'Диджеи';
const SLOTS_SHEET = 'Свободное время';
const MAX_AGE_SEC = 7 * 24 * 3600; // подпись Telegram действительна неделю
const ALL_SLOTS = ['21:00–00:00', '00:00–03:00', '03:00–06:00',
  '20:00–22:00', '22:00–00:00', '00:00–02:00', '02:00–04:00', '04:00–06:00', '06:00–09:00'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

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
    saveDj(user, req.nick, req.sets);
    return { ok: true, admin };
  }
  if (req.action === 'admin') {
    if (!admin) return { ok: false, error: 'forbidden' };
    return { ok: true, admin, djs: readDjs() };
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

// Оставляем только правильные даты и известные слоты
function cleanSets(sets) {
  const res = {};
  Object.keys(sets || {}).slice(0, 1000).forEach(ds => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) || !Array.isArray(sets[ds])) return;
    const slots = sets[ds].filter(s => ALL_SLOTS.indexOf(s) >= 0);
    if (slots.length) res[ds] = slots;
  });
  return res;
}

function saveDj(user, nick, sets) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const id = String(user.id);
    const clean = cleanSets(sets);
    const tgName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const name = String(nick || '').trim().slice(0, 40) || tgName || id;
    const row = [id, name, tgName, user.username ? '@' + user.username : '', new Date(), JSON.stringify(clean)];

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
    Object.keys(clean).forEach(ds => clean[ds].forEach(slot => {
      const d = new Date(ds + 'T12:00:00');
      rows.push([ds, WEEKDAYS[d.getDay()], slot, name, id]);
    }));
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : ALL_SLOTS.indexOf(a[2]) - ALL_SLOTS.indexOf(b[2]));
    if (sl.getLastRow() > 1) sl.getRange(2, 1, sl.getLastRow() - 1, 5).clearContent();
    if (rows.length) {
      const range = sl.getRange(2, 1, rows.length, 5);
      range.setNumberFormat('@'); // даты храним как текст, чтобы таблица их не переделывала
      range.setValues(rows);
    }
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
    let sets = {};
    try { sets = cleanSets(JSON.parse(r[5] || '{}')); } catch (e) {} // строку поправили руками — не ломаем всю сводку
    res.push({
      id: String(r[0]),
      nick: String(r[1]),
      tgName: String(r[2]),
      username: String(r[3]),
      updated: r[4] instanceof Date ? r[4].getTime() : 0,
      sets,
    });
  });
  return res;
}
