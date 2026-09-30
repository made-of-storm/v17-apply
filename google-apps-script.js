/**
 * V17 — приём заявок квалификационной формы.
 *
 * Что делает:
 *  1. Принимает POST от формы (index.html) → пишет строку в Google Таблицу (журнал/резерв)
 *     и создаёт страницу в базе Notion (заказчик работает в Notion).
 *  2. Шлёт уведомление в Telegram-чат с кнопками «Отказ (стандарт)»,
 *     «Отказ (потенциал)», «Отказ (с правкой)» и «Взяли в работу».
 *  3. По нажатию кнопки отправляет письмо-отказ заявителю и помечает сообщение
 *     в чате. «С правкой» — сначала присылает черновик: его можно отправить
 *     как есть или ответить на сообщение своим текстом.
 *
 * Установка — см. README-НАСТРОЙКА.md. Кратко:
 *  - создать Google Таблицу → Расширения → Apps Script → вставить этот код
 *  - заполнить CONFIG ниже
 *  - Развернуть → Веб-приложение (Выполнять как: я; Доступ: все) → URL в SUBMIT_URL формы
 *  - один раз запустить setupTelegramPolling() и выдать нужные разрешения
 */

var CONFIG = {
  // Notion: токен интеграции и data source базы «V17 dealflow».
  // Оставить пустым — писать только в таблицу.
  NOTION_TOKEN: '',           // ntn_... (выдал заказчик)
  NOTION_DATA_SOURCE_ID: '',  // id источника данных базы (не самой базы!)

  // Telegram
  TELEGRAM_TOKEN: '',      // токен бота от @BotFather
  TELEGRAM_CHAT_ID: '',    // id чата заявок (см. README, шаг 3)

  // Почта для отказов: noreply@v17.vc (решение Леры 13.08 — на неё не отвечают).
  // Ящик должен быть добавлен в Gmail владельца скрипта: Настройки → Аккаунты
  // → «Отправлять письма как» → noreply@v17.vc (SMTP smtp.gmail.com:587).
  // Пока алиас не подтверждён — sendDeclineMail вернёт usedFallback: true
  // и в Telegram придёт предупреждение (см. README-НАСТРОЙКА.md, шаг 4).
  MAIL_FROM_ALIAS: 'noreply@v17.vc',
  MAIL_FROM_NAME: 'V17 Team',
  // Reply-To не ставим: письма идут с noreply, ответы не предполагаются.
  MAIL_REPLY_TO: '',

  SHEET_NAME: 'Applications',
  SETTINGS_SHEET: 'Settings',
  TEMPLATES_SHEET: 'Decline templates',
  /* Тестовые заявки (см. isTestSubmission) пишутся сюда, без Notion и Telegram. */
  TEST_SHEET_NAME: 'Tests'
};

var BACKEND_VERSION = '2026-09-02b';

/* ==========================================================================
   НАСТРОЙКИ БЕЗ ПРОГРАММИСТА.
   При первом запуске скрипт сам создаёт листы «Settings» (ключ / значение)
   и «Decline templates» (Label / Subject / Body) с значениями по умолчанию.
   Дальше пороги MRR, список вертикалей и тексты отказов правятся прямо
   в таблице — форма подтягивает их при каждой загрузке страницы,
   письма-отказы читают тексты в момент отправки. Ничего передеплоивать не надо.
   ========================================================================== */
var DEFAULT_SETTINGS = [
  ['MRR_THRESHOLD_B2C', 10000, 'Мягкий порог MRR для B2C: ниже — предупреждение, анкета открывается'],
  ['MRR_THRESHOLD_OTHER', 30000, 'Мягкий порог MRR для B2B и B2B2C'],
  ['MRR_HARD_B2C', 5000, 'Жёсткий порог MRR для B2C: ниже — финальный отказ, заявка не сохраняется'],
  ['MRR_HARD_OTHER', 15000, 'Жёсткий порог MRR для B2B и B2B2C'],
  ['VERTICALS', 'HealthTech, Wellbeing, Productivity Tools, Future of Work, FinTech, EdTech, Entertainment, Lifestyle, MarTech, DIY-Marketing Tools, AI Operators, AI Assistants for Business, Gaming, Gambling / Betting, Other', 'Список вертикалей через запятую — порядок сохраняется на форме']
];

/* Шаблоны отказов — тексты Леры от 14.08. Копируются в лист «Decline templates»
   при первом запуске, дальше источник истины — таблица; {{name}} и {{company}}
   подставляются, если их куда-то впишут. Тема одна на все письма.
   В Telegram к этим двум шаблонам добавляется третья кнопка «Отказ (с правкой)»:
   тот же стандартный текст, но сначала приходит черновик в чат. */
var TEMPLATES_VERSION = 'lera-2026-08-14';
var DECLINE_MAIL_SUBJECT = 'Thank you for your interest in V17';
var DECLINE_TEMPLATES = [
  {
    label: 'Отказ (стандарт)',
    subject: DECLINE_MAIL_SUBJECT,
    body: 'Dear Team,\n\n' +
      'Thank you for taking the time to share your company with V17 and for your interest in working together.\n\n' +
      'After reviewing your submission, we\'ve decided not to move forward at this time. This isn\'t a reflection of your team or what you\'re building — it simply isn\'t the right fit for our current investment focus.\n\n' +
      'We wish you continued success, and we\'d welcome the opportunity to reconnect in the future as your company grows.\n\n' +
      'Best regards,\nThe V17 Team'
  },
  {
    label: 'Отказ (потенциал)',
    subject: DECLINE_MAIL_SUBJECT,
    body: 'Dear Team,\n\n' +
      'Thank you for sharing your company with V17 — we genuinely enjoyed learning more about what you\'re building.\n\n' +
      'While it\'s not the right time for us to move forward, this was not an easy no — your traction and direction stood out to us. We\'d love to stay in touch and take another look as you continue to grow.\n\n' +
      'Feel free to reach back out once you hit your next milestone — we\'ll be glad to reconnect.\n\n' +
      'Best regards,\nThe V17 Team'
  }
];

/* ============================ приём запросов ============================ */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    // Апдейты Telegram сюда больше не приходят (webhook не используем —
    // GAS отвечает на POST редиректом 302, Telegram считает это ошибкой
    // и зацикливает повторы). Кнопки обрабатывает pollTelegram по таймеру.
    if (body.update_id !== undefined) {
      return jsonResponse({ ok: true, ignored: 'telegram update' });
    }
    // Заявка обязана содержать хотя бы название компании или email.
    if (!body.company_name && !body.contact_email) {
      return jsonResponse({ ok: false, error: 'empty submission ignored' });
    }
    return handleFormSubmission(body);
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'config') {
    var s = getSettings();
    return jsonResponse({
      ok: true,
      backend_version: BACKEND_VERSION,
      thresholds: {
        b2c: Number(s.MRR_THRESHOLD_B2C) || 10000,
        other: Number(s.MRR_THRESHOLD_OTHER) || 30000,
        hard_b2c: Number(s.MRR_HARD_B2C) || 5000,
        hard_other: Number(s.MRR_HARD_OTHER) || 15000
      },
      verticals: String(s.VERTICALS || '').split(',').map(function (v) { return v.trim(); }).filter(Boolean)
    });
  }
  return jsonResponse({
    ok: true,
    service: 'v17-apply',
    backend_version: BACKEND_VERSION,
    time: new Date().toISOString()
  });
}

/* ==================== настройки и шаблоны из таблицы ==================== */

function getSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SETTINGS_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['Ключ (не менять)', 'Значение (можно менять)', 'Что это']]);
    sheet.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 3);
  }
  var rows = sheet.getDataRange().getValues();
  var out = {};
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0]) out[String(rows[i][0]).trim()] = rows[i][1];
  }
  /* Лист уже существовал, а настройки в коде добавились (так было с жёсткими
     порогами) — дописываем недостающие строки, иначе их нельзя было бы
     поменять из таблицы. */
  var missing = DEFAULT_SETTINGS.filter(function (d) { return out[d[0]] === undefined; });
  if (missing.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
    missing.forEach(function (d) { out[d[0]] = d[1]; });
  }
  return out;
}

function writeDefaultTemplates(sheet) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 3).setValues([['Label (кнопка в TG)', 'Subject', 'Body ({{name}}, {{company}})']]);
  var seed = DECLINE_TEMPLATES.map(function (t) { return [t.label, t.subject, t.body]; });
  sheet.getRange(2, 1, seed.length, 3).setValues(seed);
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(3, 600);
  PropertiesService.getScriptProperties().setProperty('templates_version', TEMPLATES_VERSION);
}

function getDeclineTemplates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.TEMPLATES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TEMPLATES_SHEET);
    writeDefaultTemplates(sheet);
  } else if (PropertiesService.getScriptProperties().getProperty('templates_version') !== TEMPLATES_VERSION) {
    /* Один раз заменяем прежние шаблоны на тексты Леры от 14.08 — дальше
       правки в листе сохраняются (версия уже записана в свойствах скрипта). */
    writeDefaultTemplates(sheet);
  }
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] && rows[i][2]) {
      out.push({ label: String(rows[i][0]), subject: String(rows[i][1] || DECLINE_MAIL_SUBJECT), body: String(rows[i][2]) });
    }
  }
  return out.length ? out : DECLINE_TEMPLATES;
}

/* ============================ заявка с формы ============================ */

/* Порядок колонок менять нельзя (по нему пишутся строки и ищется заявка);
   новые колонки — только в конец. 'Below threshold' — прежний
   'Hard filter failed': теперь тут отмечаются заявки soft-зоны
   (MRR ниже мягкого порога, но выше жёсткого). */
var SHEET_HEADERS = [
  'Submitted at', 'Below threshold', 'Company', 'Website', 'Segment', 'Stage',
  'Top user markets', 'MRR $', 'Interested in', 'Amount raising $', 'Post-money $',
  'Verticals', 'Problem', 'Pitch deck', 'ICP', 'Team',
  'Ret D30 %', 'Ret D60 %', 'Ret D90 %', 'CAC $', 'LTV $', 'Avg session min',
  'Payback', 'Monetization', 'Organic %', 'MRR growth', 'Marketing spend $/mo',
  'Contact name', 'Contact email', 'Notes', 'Status', 'Notion URL', 'Source'
];

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.setFrozenRows(1);
  }
  /* Шапку переписываем всегда: порядок колонок в коде фиксирован, а названия
     со временем менялись (добавился Source, 'Hard filter failed' стал
     'Below threshold'). Данные при этом не двигаются. */
  var head = sheet.getRange(1, 1, 1, SHEET_HEADERS.length);
  if (String(head.getValues()[0]) !== String(SHEET_HEADERS)) head.setValues([SHEET_HEADERS]);
  return sheet;
}

/* Тестовые заявки не попадают в Applications / Notion / Telegram — только
   на лист Tests. Признаки: тестовый email, «test/e2e/тест» в названии компании,
   source с пометкой test (cursor-agent-test, node-test и т.п.). */
function isTestSubmission(d) {
  var email = String((d && d.contact_email) || '').trim().toLowerCase();
  var company = String((d && d.company_name) || '').trim();
  var source = String((d && d.source) || '').trim().toLowerCase();

  if (/^e2e-test-/.test(email) || /@example\.com$/.test(email) || /@acme\.test$/.test(email)) {
    return 'test email: ' + email;
  }
  if (/\b(e2e|test|тест)\b/i.test(company)) {
    return 'test company: ' + company;
  }
  if (source === 'test' || source === 'node-test' || /^cursor-.*test/.test(source) || /-test$/.test(source)) {
    return 'test source: ' + source;
  }
  return '';
}

function getTestSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var headers = SHEET_HEADERS.concat(['Test reason']);
  var sheet = ss.getSheetByName(CONFIG.TEST_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TEST_SHEET_NAME);
    sheet.setFrozenRows(1);
  }
  var head = sheet.getRange(1, 1, 1, headers.length);
  if (String(head.getValues()[0]) !== String(headers)) head.setValues([headers]);
  return sheet;
}

function buildSubmissionRow(d, joined, safe) {
  return [
    d.submitted_at || new Date().toISOString(),
    d.below_threshold ? 'YES' : '',
    d.company_name || '', d.website || '',
    joined(d.segment).toUpperCase(), d.stage || '', d.market_text,
    d.mrr || '', joined(d.interested_in), d.amount_raising || '', d.post_money || '',
    d.verticals_text, safe(d.problem || ''), d.pitch_deck || '', safe(d.icp || ''), safe(d.team || ''),
    d.ret30 || '', d.ret60 || '', d.ret90 || '', d.cac || '', d.ltv || '', d.session || '',
    safe(d.payback || ''), safe(d.sub_model || ''), d.organic_pct || '', safe(d.mrr_growth || ''), d.marketing_spend || '',
    safe(d.contact_name || ''), d.contact_email || '', safe(d.notes || ''),
    'new', '', sourceLabel(d)
  ];
}

/* Пометка источника — просьба Леры от 14.08. Сайт шлёт source=site_form,
   публичный Telegram-бот шлёт source=telegram_bot. */
var SOURCE_LABEL = 'Website form (v17.vc/apply)';
var SOURCE_LABEL_TG = 'Telegram bot (V17_apply)';

function sourceLabel(d) {
  var s = String((d && d.source) || '');
  if (s === 'telegram_bot' || s === 'telegram') return SOURCE_LABEL_TG;
  return SOURCE_LABEL;
}

/* «Other» в мультивыборе: к выбранным значениям добавляем уточнение. */
function withOther(list, other) {
  var extra = String(other || '').trim();
  return extra ? (list ? list + ' (other: ' + extra + ')' : 'Other: ' + extra) : list;
}

function handleFormSubmission(d) {
  var joined = function (v) { return Array.isArray(v) ? v.join(', ') : (v || ''); };
  /* Строки, начинающиеся с = + -, Sheets парсит как формулы (например
     «+18%/mo» превращается в #NAME?) — экранируем апострофом. */
  var safe = function (v) {
    return (typeof v === 'string' && /^[=+\-]/.test(v)) ? "'" + v : v;
  };
  var testReason = isTestSubmission(d);

  /* Pitch deck по ТЗ — ссылка ИЛИ файл. Файл приходит base64 → кладём
     на Google Drive и дальше везде используем ссылку. */
  var deck = d.pitch_deck || '';
  if (!testReason && d.pitch_deck_file && d.pitch_deck_file.data) {
    try {
      var fileUrl = saveDeckFile(d);
      deck = deck ? deck + ' · ' + fileUrl : fileUrl;
    } catch (err) {
      deck = deck || ('file upload failed: ' + err);
    }
  }
  d.pitch_deck = deck;

  /* Уточнения по «Other» пишем в ту же клетку, что и сам выбор. */
  d.market_text = withOther(joined(d.market), d.market_other);
  d.verticals_text = withOther(joined(d.verticals), d.verticals_other);
  /* Совместимость: старое поле формы называлось hard_filter_failed, теперь
     из формы приходит below_soft_threshold (жёсткий отказ до отправки
     вообще не доходит — заявка не сохраняется). */
  d.below_threshold = !!(d.below_soft_threshold || d.hard_filter_failed);

  if (testReason) {
    var testSheet = getTestSheet();
    var testRow = buildSubmissionRow(d, joined, safe);
    testRow[SHEET_HEADERS.indexOf('Status')] = 'test';
    testRow.push(testReason);
    testSheet.appendRow(testRow);
    Logger.log('Test submission isolated: ' + testReason);
    return jsonResponse({
      ok: true,
      test: true,
      test_reason: testReason,
      backend_version: BACKEND_VERSION,
      telegram_notified: false,
      notion_created: false
    });
  }

  var sheet = getSheet();
  var statusCol = SHEET_HEADERS.indexOf('Status') + 1;
  var row = buildSubmissionRow(d, joined, safe);
  sheet.appendRow(row);
  var rowNum = sheet.getLastRow();

  var notionUrl = '';
  try {
    notionUrl = createNotionPage(d);
    if (notionUrl) {
      sheet.getRange(rowNum, SHEET_HEADERS.indexOf('Notion URL') + 1).setValue(notionUrl);
    }
  } catch (err) {
    sheet.getRange(rowNum, SHEET_HEADERS.indexOf('Notion URL') + 1).setValue('ERROR: ' + err);
  }

  var telegramNotified = false;
  var telegramError = '';
  try {
    notifyTelegram(d, rowNum, notionUrl);
    telegramNotified = true;
  } catch (err) {
    // Заявка сохранена, но сбой больше не прячем: виден в таблице и ответе API.
    telegramError = String(err);
    sheet.getRange(rowNum, statusCol).setValue('new (Telegram notification failed)');
    Logger.log('notifyTelegram failed: ' + telegramError);
  }

  return jsonResponse({
    ok: true,
    backend_version: BACKEND_VERSION,
    telegram_notified: telegramNotified,
    telegram_error: telegramError
  });
}

/* Письмо-отказ. Только с noreply@v17.vc — без fallback на личный ящик
   владельца скрипта (иначе письма уходят «от V17» с личной почты).
   Алиас настраивается в Gmail: Настройки → Отправлять письма как. */
function sendDeclineMail(email, subject, body) {
  if (!CONFIG.MAIL_FROM_ALIAS) {
    return { ok: false, error: 'MAIL_FROM_ALIAS не задан' };
  }
  var opts = {
    from: CONFIG.MAIL_FROM_ALIAS,
    name: CONFIG.MAIL_FROM_NAME,
    htmlBody: declineHtmlBody(body)
  };
  if (CONFIG.MAIL_REPLY_TO) opts.replyTo = CONFIG.MAIL_REPLY_TO;
  try {
    GmailApp.sendEmail(email, subject, body, opts);
    return { ok: true, from: CONFIG.MAIL_FROM_ALIAS, usedFallback: false };
  } catch (e) {
    Logger.log('sendDeclineMail failed: ' + e);
    return {
      ok: false,
      error: 'Не удалось отправить с ' + CONFIG.MAIL_FROM_ALIAS +
        '. Добавьте ящик в Gmail владельца скрипта: Настройки → Аккаунты → ' +
        '«Отправлять письма как» → noreply@v17.vc (SMTP smtp.gmail.com:587).'
    };
  }
}

function mailResultNote(result) {
  if (!result || result.ok) {
    return result && result.from ? ' · от ' + result.from : '';
  }
  return ' ⚠️ ' + result.error;
}

/* Тест отправки: Apps Script → выбрать testDeclineMail → Выполнить.
   Впишите TEST_DECLINE_TO ниже свой email перед запуском. */
var TEST_DECLINE_TO = '';

function testDeclineMail() {
  var to = TEST_DECLINE_TO || Session.getActiveUser().getEmail();
  if (!to) throw new Error('Укажите TEST_DECLINE_TO или запустите под Google-аккаунтом');
  var tpl = DECLINE_TEMPLATES[0];
  var who = { company: 'Test Co', name: 'Test Founder' };
  var result = sendDeclineMail(
    to,
    '[TEST] ' + tpl.subject,
    fillTemplate(tpl.body, who) + '\n\n— test message, please ignore'
  );
  if (!result.ok) throw new Error(result.error);
  Logger.log(JSON.stringify(result));
  return result;
}

function declineHtmlBody(text) {
  var safe = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return '<div style="font-family:Manrope,Arial,sans-serif;font-size:15px;line-height:1.6;color:#010101;">'
    + safe + '</div>';
}

/* Приложенный pitch deck → папка «V17 pitch decks» на Drive владельца скрипта.
   Доступ «всем по ссылке (просмотр)», чтобы ссылка работала из Notion/таблицы. */
function saveDeckFile(d) {
  var f = d.pitch_deck_file;
  var blob = Utilities.newBlob(
    Utilities.base64Decode(f.data),
    f.mime || 'application/octet-stream',
    (d.company_name ? d.company_name + ' — ' : '') + (f.name || 'pitch-deck')
  );
  var it = DriveApp.getFoldersByName('V17 pitch decks');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('V17 pitch decks');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

/* Питчдек в колонку Notion «Files & media»: сначала сам файл через File Upload API,
   если не вышло — прямая ссылка (Drive или та, что прислали). */
function buildNotionFiles(d) {
  var files = [];
  var uploadId = uploadDeckToNotion(d);
  if (uploadId) {
    files.push({
      type: 'file_upload',
      name: (d.pitch_deck_file && d.pitch_deck_file.name) || 'pitch-deck',
      file_upload: { id: uploadId }
    });
    return files;
  }
  var urls = String(d.pitch_deck || '').split(' · ');
  for (var i = 0; i < urls.length; i++) {
    var url = urls[i].trim();
    if (/^https?:\/\//i.test(url)) {
      files.push({ name: 'Pitch deck', external: { url: url } });
      break;
    }
  }
  return files.length ? files : null;
}

function uploadDeckToNotion(d) {
  if (!CONFIG.NOTION_TOKEN || !d.pitch_deck_file || !d.pitch_deck_file.data) return '';
  try {
    var name = d.pitch_deck_file.name || 'pitch-deck';
    var mime = d.pitch_deck_file.mime || 'application/octet-stream';
    var blob = Utilities.newBlob(Utilities.base64Decode(d.pitch_deck_file.data), mime, name);
    var created = JSON.parse(UrlFetchApp.fetch('https://api.notion.com/v1/file_uploads', {
      method: 'post',
      contentType: 'application/json',
      headers: notionHeaders(),
      payload: JSON.stringify({ filename: name, content_type: mime }),
      muteHttpExceptions: true
    }).getContentText());
    if (!created.id) {
      Logger.log('Notion file_uploads create: ' + JSON.stringify(created));
      return '';
    }
    blob.setName(name);
    var sent = UrlFetchApp.fetch('https://api.notion.com/v1/file_uploads/' + created.id + '/send', {
      method: 'post',
      headers: notionHeaders(),
      payload: { file: blob },
      muteHttpExceptions: true
    });
    var out = JSON.parse(sent.getContentText());
    if (out.object === 'error') {
      Logger.log('Notion file send: ' + sent.getContentText());
      return '';
    }
    return created.id;
  } catch (e) {
    Logger.log('uploadDeckToNotion: ' + e);
    return '';
  }
}

function notionHeaders() {
  return {
    'Authorization': 'Bearer ' + CONFIG.NOTION_TOKEN,
    'Notion-Version': '2025-09-03'
  };
}

function notionPageId(url) {
  var m = String(url || '').match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!m) return '';
  var id = m[1].replace(/-/g, '');
  return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

/* Отказ из Telegram → статус Declined в карточке Notion. */
function markNotionDeclined(notionUrl) {
  var id = notionPageId(notionUrl);
  if (!id) return { ok: false, error: 'Notion page id not found' };
  if (!CONFIG.NOTION_TOKEN) return { ok: false, error: 'Notion token is not configured' };
  var payloads = [
    { properties: { Status: { status: { name: 'Declined' } } } },
    { properties: { Status: { select: { name: 'Declined' } } } }
  ];
  var lastError = '';
  for (var i = 0; i < payloads.length; i++) {
    try {
      var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + id, {
        method: 'patch',
        contentType: 'application/json',
        headers: notionHeaders(),
        payload: JSON.stringify(payloads[i]),
        muteHttpExceptions: true
      });
      var out = JSON.parse(resp.getContentText());
      if (out.object !== 'error') return { ok: true };
      lastError = out.message || 'unknown Notion error';
    } catch (e) {
      lastError = String(e);
    }
    Logger.log('markNotionDeclined: ' + lastError);
  }
  return { ok: false, error: lastError };
}

/* ============================ Notion ============================
   Заявка становится карточкой в CRM заказчика «V17 dealflow».
   Маппинг на их реальные колонки (у 'Industry ' и 'Revenue ' в названии
   хвостовой пробел — так в их базе, не «чинить»!):
     Name ← компания · Email ← email · Type ← сегмент · Industry ← вертикали
     Revenue ← MRR · Estimated Value ← сумма раунда · Financing ← инструмент
     Lead Source ← 'Website form'. Остальные детали — в тело карточки. */

function moneyFmt(v) {
  var n = parseFloat(v);
  return isNaN(n) ? (v || '') : n.toLocaleString('en-US');
}

function createNotionPage(d) {
  if (!CONFIG.NOTION_TOKEN || !CONFIG.NOTION_DATA_SOURCE_ID) return '';

  var rt = function (s) { return [{ text: { content: String(s || '').slice(0, 1900) } }]; };
  var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };

  // Сегменты формы → варианты их селекта Type.
  var seg = (d.segment || []).map(function (s) { return String(s).toLowerCase(); });
  var type = null;
  if (seg.indexOf('b2b2c') !== -1) type = 'B2B2C';
  else if (seg.indexOf('b2b') !== -1 && seg.indexOf('b2c') !== -1) type = 'B2B & B2C';
  else if (seg.indexOf('b2c') !== -1) type = 'B2C';
  else if (seg.indexOf('b2b') !== -1) type = 'B2B';
  else if (seg.length) type = seg[0].toUpperCase();

  // Наши вертикали → их опции Industry (несовпадающие Notion создаст сам).
  var industryRename = { 'Productivity Tools': 'Productivity tools' };
  var industries = (d.verticals || []).map(function (v) {
    return { name: industryRename[v] || v };
  });

  /* Лера 17.08 завела в Notion опцию «Marketing-for-Equity» — имя должно
     совпасть один в один, иначе Financing не матчится и в фильтре пусто. */
  var finMap = { investment: 'Equity', cohort: 'Cohort financing', media: 'Marketing-for-Equity' };
  var financing = (d.interested_in || []).map(function (v) { return { name: finMap[v] || v }; });

  var notionLeadSource = sourceLabel(d) === SOURCE_LABEL_TG ? 'Telegram bot' : 'Website form';
  var properties = {
    'Name':            { title: rt((d.below_threshold ? '⚠️ ' : '') + (d.company_name || '(no name)')) },
    'Email':           { email: d.contact_email || null },
    'Revenue ':        { number: num(d.mrr) },
    'Estimated Value': { number: num(d.amount_raising) },
    'Status':          { status: { name: 'Lead' } },
    'Lead Source':     { select: { name: notionLeadSource } }
  };
  if (type) properties['Type'] = { select: { name: type } };
  if (industries.length) properties['Industry '] = { multi_select: industries };
  if (financing.length) properties['Financing'] = { multi_select: financing };
  var files = buildNotionFiles(d);
  if (files) properties['Files & media'] = { files: files };

  var children = [];
  /* Первая строка карточки — откуда заявка (просьба Леры от 14.08). */
  children.push({ callout: {
    icon: { emoji: '🌐' },
    rich_text: rt('Submitted through ' + sourceLabel(d))
  }});
  if (d.below_threshold) {
    children.push({ callout: {
      icon: { emoji: '⚠️' },
      rich_text: rt('MRR below our soft threshold — separate pool for cohort financing / reconsideration. No automatic reply was sent.')
    }});
  }
  var line = function (label, value) {
    if (value === undefined || value === null || value === '') return;
    children.push({ bulleted_list_item: { rich_text: [
      { text: { content: label + ': ' }, annotations: { bold: true } },
      { text: { content: String(value).slice(0, 1800) } }
    ]}});
  };
  line('Source', sourceLabel(d));
  line('Telegram', d.telegram);
  line('MRR, $', d.mrr ? moneyFmt(d.mrr) : '');
  line('Amount raising, $', d.amount_raising ? moneyFmt(d.amount_raising) : '');
  line('Website', d.website);
  line('Stage', d.stage);
  line('Top user markets', d.market_text || (Array.isArray(d.market) ? d.market.join(', ') : d.market));
  line('Other vertical', d.verticals_other);
  line('Post-money, $', moneyFmt(d.post_money));
  line('Pitch deck', d.pitch_deck);
  line('Contact', (d.contact_name || '') + ' · ' + (d.contact_email || ''));
  children.push({ heading_3: { rich_text: rt('Metrics') } });
  line('Retention D30/D60/D90, %', (d.ret30 || '—') + ' / ' + (d.ret60 || '—') + ' / ' + (d.ret90 || '—'));
  line('CAC / LTV, $', (d.cac ? moneyFmt(d.cac) : '—') + ' / ' + (d.ltv ? moneyFmt(d.ltv) : '—'));
  line('Avg session, min', d.session);
  line('Payback', d.payback);
  line('Monetization', d.sub_model);
  line('Organic traffic, %', d.organic_pct);
  line('MRR & MoM growth', d.mrr_growth);
  line('Marketing spend, $/mo', d.marketing_spend ? moneyFmt(d.marketing_spend) : '');
  var block = function (title, text) {
    if (!text) return;
    children.push({ heading_3: { rich_text: rt(title) } });
    children.push({ paragraph: { rich_text: rt(text) } });
  };
  block('What & problem', d.problem);
  block('ICP', d.icp);
  block('Team', d.team);
  block('Notes', d.notes);

  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.NOTION_TOKEN,
      'Notion-Version': '2025-09-03'
    },
    payload: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: CONFIG.NOTION_DATA_SOURCE_ID },
      properties: properties,
      children: children
    }),
    muteHttpExceptions: true
  });
  var out = JSON.parse(resp.getContentText());
  if (out.object === 'error') throw new Error(out.message);
  return out.url || '';
}

/* ============================ Telegram ============================ */

/* Актуальный id чата. Telegram меняет id группы при апгрейде до супергруппы
   (например, после изменения настроек чата) — тогда старый id перестаёт
   работать. Новый id запоминаем в Script Properties (см. tg ниже). */
function tgChatId() {
  return PropertiesService.getScriptProperties().getProperty('tg_chat_id') || CONFIG.TELEGRAM_CHAT_ID;
}

function tg(method, payload) {
  var call = function () {
    return UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  };
  var resp = call();
  /* Группу апгрейдили до супергруппы → Telegram вернул новый chat_id.
     Запоминаем его и повторяем запрос, чтобы уведомление не потерялось. */
  try {
    var out = JSON.parse(resp.getContentText());
    var newId = out && !out.ok && out.parameters && out.parameters.migrate_to_chat_id;
    if (newId && payload && payload.chat_id) {
      PropertiesService.getScriptProperties().setProperty('tg_chat_id', String(newId));
      payload.chat_id = String(newId);
      resp = call();
    }
  } catch (e) { /* не-JSON ответ — отдаём как есть */ }
  return resp;
}

/* Если заявитель приложил pitch deck файлом, во внутренний чат он тоже
   приходит настоящим документом. При ссылке отдельного документа нет —
   ссылка остаётся в основном сообщении заявки. */
function sendTelegramDeck(d, replyToMessageId) {
  var f = d.pitch_deck_file;
  if (!f || !f.data) return true;
  var blob = Utilities.newBlob(
    Utilities.base64Decode(f.data),
    f.mime || 'application/octet-stream',
    f.name || 'pitch-deck'
  );
  var resp = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/sendDocument',
    {
      method: 'post',
      payload: {
        chat_id: String(tgChatId()),
        document: blob,
        caption: 'Pitch deck — ' + String(d.company_name || 'без названия'),
        reply_to_message_id: String(replyToMessageId)
      },
      muteHttpExceptions: true
    }
  );
  var out = JSON.parse(resp.getContentText());
  if (!out.ok) throw new Error(out.description || 'Telegram sendDocument failed');
  return true;
}

function notifyTelegram(d, rowNum, notionUrl) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

  var joined = function (v) { return Array.isArray(v) ? v.join(', ') : (v || '—'); };
  var money = function (v) { return v ? '$' + Number(v).toLocaleString('en-US') : '—'; };

  var lines = [
    (d.below_threshold ? '⚠️ <b>Новая заявка (MRR ниже порога — пул cohort)</b>' : '✅ <b>Новая заявка</b>'),
    '🌐 Источник: ' + (sourceLabel(d) === SOURCE_LABEL_TG ? 'Telegram-бот V17_apply' : 'форма на сайте (v17.vc/apply)'),
    '',
    '<b>' + esc(d.company_name || '(без названия)') + '</b> — ' + esc(d.website || ''),
    esc(joined(d.segment).toUpperCase()) + ' · ' + esc(d.stage || '—') + ' · рынки: ' + esc(d.market_text || joined(d.market) || '—'),
    'MRR: ' + money(d.mrr) + ' · Raising: ' + money(d.amount_raising) + ' · Post-money: ' + money(d.post_money),
    'Интерес: ' + esc(joined(d.interested_in)),
    'Вертикали: ' + esc(d.verticals_text || joined(d.verticals)),
    'Retention 30/60/90: ' + esc((d.ret30 || '—') + '/' + (d.ret60 || '—') + '/' + (d.ret90 || '—') + '%') +
      ' · CAC ' + money(d.cac) + ' · LTV ' + money(d.ltv),
    'Organic: ' + esc(d.organic_pct || '—') + '% · Spend: ' + money(d.marketing_spend) + '/мес',
    (d.pitch_deck_file && d.pitch_deck_file.data
      ? 'Deck: файл приложен следующим сообщением'
      : (d.pitch_deck ? 'Deck: ' + esc(d.pitch_deck) : '')),
    '',
    '👤 ' + esc(d.contact_name || '—') + ' · ' + esc(d.contact_email || '—') +
      (d.telegram ? ' · ' + esc(d.telegram) : ''),
    (notionUrl ? '📄 <a href="' + notionUrl + '">Открыть в Notion</a>' : '')
  ];

  /* В callback_data кладём номер строки + отпечаток email. Если строки
     в таблице удалят/отсортируют и номер «съедет», строка будет найдена
     заново по отпечатку — письмо не уйдёт не тому человеку. */
  var key = rowKey(d.contact_email, d.company_name);
  var keyboard = { inline_keyboard: declineKeyboard(rowNum, key) };

  var resp = tg('sendMessage', {
    chat_id: tgChatId(),
    text: lines.filter(Boolean).join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
  var out = JSON.parse(resp.getContentText());
  if (!out.ok) throw new Error(out.description || 'Telegram sendMessage failed');
  sendTelegramDeck(d, out.result.message_id);
  return true;
}

/* Кнопки под заявкой (набор Леры от 14.08):
   письма-отказы из листа «Decline templates» — «стандарт» и «потенциал»
   уходят сразу; «с правкой» — бот сначала присылает черновик в чат, его можно
   отправить как есть или ответить своим текстом. */
function declineKeyboard(rowNum, key) {
  var suffix = ':' + rowNum + ':' + key;
  var templates = getDeclineTemplates().map(function (t, i) {
    return { text: '✉️ ' + t.label, callback_data: 'd:' + rowNum + ':' + i + ':' + key };
  });
  return [
    templates,
    [{ text: '✏️ Отказ (с правкой)', callback_data: 'e' + suffix }],
    [{ text: '✔️ Взяли в работу', callback_data: 'p' + suffix }]
  ];
}

/* Опрос Telegram по таймеру (каждую минуту). Забирает нажатия кнопок и ответы
   на черновики через getUpdates. Оффсет хранится в Script Properties,
   поэтому каждое событие обрабатывается ровно один раз. */
function pollTelegram() {
  if (!CONFIG.TELEGRAM_TOKEN) return;
  var props = PropertiesService.getScriptProperties();
  var offset = Number(props.getProperty('tg_offset') || 0);
  var resp = tg('getUpdates', { offset: offset + 1, allowed_updates: ['callback_query', 'message'] });
  var out = JSON.parse(resp.getContentText());
  if (!out.ok) return;
  out.result.forEach(function (u) {
    if (u.update_id > offset) offset = u.update_id;
    try {
      if (u.callback_query) handleCallback(u.callback_query);
      else if (u.message) handleDraftReply(u.message);
    } catch (e) { /* не роняем остальные */ }
  });
  props.setProperty('tg_offset', String(offset));
}

/* Короткий отпечаток заявки (email+компания) для проверки, что номер строки
   всё ещё указывает на ту же заявку. */
function rowKey(email, company) {
  var raw = String(email || '') + '|' + String(company || '');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < 4; i++) {
    hex += ((digest[i] + 256) % 256).toString(16).padStart(2, '0');
  }
  return hex;
}

/* Находит строку заявки: сначала проверяет сохранённый номер, при несовпадении
   отпечатка ищет по всей таблице. Возвращает номер строки или 0. */
function findRow(sheet, rowNum, key) {
  var emailCol = SHEET_HEADERS.indexOf('Contact email');
  var companyCol = SHEET_HEADERS.indexOf('Company');
  var last = sheet.getLastRow();
  if (rowNum >= 2 && rowNum <= last) {
    var row = sheet.getRange(rowNum, 1, 1, SHEET_HEADERS.length).getValues()[0];
    if (rowKey(row[emailCol], row[companyCol]) === key) return rowNum;
  }
  if (last < 2) return 0;
  var all = sheet.getRange(2, 1, last - 1, SHEET_HEADERS.length).getValues();
  for (var i = 0; i < all.length; i++) {
    if (rowKey(all[i][emailCol], all[i][companyCol]) === key) return i + 2;
  }
  return 0;
}

/* Заявитель из строки таблицы. */
function applicantAt(sheet, rowNum) {
  var row = sheet.getRange(rowNum, 1, 1, SHEET_HEADERS.length).getValues()[0];
  return {
    email: row[SHEET_HEADERS.indexOf('Contact email')],
    name: row[SHEET_HEADERS.indexOf('Contact name')] || 'there',
    company: row[SHEET_HEADERS.indexOf('Company')] || 'your company'
  };
}

function fillTemplate(s, who) {
  return String(s).replace(/{{name}}/g, who.name).replace(/{{company}}/g, who.company);
}

function handleCallback(cb) {
  var parts = (cb.data || '').split(':');
  var kind = parts[0];
  var sheet = getSheet();
  var statusCol = SHEET_HEADERS.indexOf('Status') + 1;

  if (kind === 'dx') {
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отменено' });
    appendToMessage(cb, '\n\n✖️ <b>Отменено</b> (' + esc(cb.from.first_name || '') + ')');
    return;
  }

  var isTemplate = (kind === 'd');
  var rowNum = parseInt(parts[1], 10);
  var tplIdx = isTemplate ? parseInt(parts[2], 10) : 0;
  var key = isTemplate ? parts[3] : parts[2];
  if (key) rowNum = findRow(sheet, rowNum, key);
  if (!rowNum) {
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Строка заявки не найдена (удалена?)', show_alert: true });
    return;
  }

  if (kind === 'p') {
    sheet.getRange(rowNum, statusCol).setValue('in progress');
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Помечено: в работе' });
    /* Кнопки отказа оставляем — отказать можно и после «взяли в работу». */
    appendToMessage(cb, '\n\n✔️ <b>Взято в работу</b> (' + esc(cb.from.first_name || '') + ')',
      { inline_keyboard: declineKeyboard(rowNum, key) });
    return;
  }

  var who = applicantAt(sheet, rowNum);
  var templates = getDeclineTemplates();

  /* «Отказ (с правкой)»: черновик стандартного письма приходит в чат,
     дальше его либо отправляют как есть, либо отвечают своим текстом. */
  if (kind === 'e') {
    var draftTpl = templates[0];
    if (!who.email || !draftTpl) {
      tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет email или шаблона', show_alert: true });
      return;
    }
    var resp = tg('sendMessage', {
      chat_id: cb.message.chat.id,
      text: '✏️ <b>Черновик отказа</b> — ' + esc(who.company) + ' (' + esc(who.email) + ')\n' +
        '<i>Тема:</i> ' + esc(draftTpl.subject) + '\n\n' +
        esc(fillTemplate(draftTpl.body, who)) + '\n\n' +
        '👉 Ответьте на это сообщение своим текстом — отправлю его вместо черновика. Или «Отправить как есть».',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Отправить как есть', callback_data: 'ds:' + rowNum + ':' + key },
        { text: '✖️ Отмена', callback_data: 'dx' }
      ]]}
    });
    /* Запоминаем id черновика: по нему поймём, что ответ в чате — правка письма. */
    try {
      var sent = JSON.parse(resp.getContentText());
      if (sent.ok) {
        PropertiesService.getScriptProperties()
          .setProperty('draft_' + sent.result.message_id, rowNum + '|' + key);
      }
    } catch (e) { /* черновик всё равно виден в чате */ }
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Черновик в чате — можно поправить' });
    return;
  }

  if (kind === 'd' || kind === 'ds') {
    var tpl = templates[tplIdx];
    if (!who.email || !tpl) {
      tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет email или шаблона', show_alert: true });
      return;
    }
    var mailResult = sendDeclineMail(who.email, fillTemplate(tpl.subject, who), fillTemplate(tpl.body, who));
    if (!mailResult.ok) {
      tg('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: mailResult.error,
        show_alert: true
      });
      return;
    }
    sheet.getRange(rowNum, statusCol).setValue('declined (' + tpl.label + ')');
    var notionResult = markNotionDeclined(
      sheet.getRange(rowNum, SHEET_HEADERS.indexOf('Notion URL') + 1).getValue()
    );
    var notionNote = notionResult.ok ? ' · Notion → Declined' : ' · ⚠️ Notion не обновлён';
    var mailNote = mailResultNote(mailResult);
    tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'Отказ отправлен на ' + who.email + mailNote + notionNote,
      show_alert: !notionResult.ok
    });
    if (kind === 'ds') {
      PropertiesService.getScriptProperties().deleteProperty('draft_' + cb.message.message_id);
    }
    appendToMessage(
      cb,
      '\n\n❌ <b>Отказ отправлен</b> («' + esc(tpl.label) + '», ' +
        esc(cb.from.first_name || '') + ')' + esc(mailNote) + esc(notionNote)
    );
  }
}

/* Ответ на черновик = «отправь письмо этим текстом». Реагируем только на реплаи
   к сообщениям-черновикам (их id лежат в свойствах скрипта), остальную
   переписку в чате игнорируем. */
function handleDraftReply(msg) {
  if (!msg.reply_to_message || !msg.text) return;
  var props = PropertiesService.getScriptProperties();
  var propKey = 'draft_' + msg.reply_to_message.message_id;
  var stored = props.getProperty(propKey);
  if (!stored) return;

  var sheet = getSheet();
  var saved = stored.split('|');
  var rowNum = findRow(sheet, parseInt(saved[0], 10), saved[1]);
  if (!rowNum) {
    tg('sendMessage', {
      chat_id: msg.chat.id,
      reply_to_message_id: msg.message_id,
      text: 'Строка заявки не найдена — письмо не отправлено.'
    });
    return;
  }

  var who = applicantAt(sheet, rowNum);
  var templates = getDeclineTemplates();
  var subject = (templates[0] && templates[0].subject) || DECLINE_MAIL_SUBJECT;
  var mailResult = sendDeclineMail(who.email, subject, msg.text);
  if (!mailResult.ok) {
    tg('sendMessage', {
      chat_id: msg.chat.id,
      reply_to_message_id: msg.message_id,
      text: '⚠️ ' + mailResult.error
    });
    return;
  }
  sheet.getRange(rowNum, SHEET_HEADERS.indexOf('Status') + 1).setValue('declined (с правкой)');
  var notionResult = markNotionDeclined(
    sheet.getRange(rowNum, SHEET_HEADERS.indexOf('Notion URL') + 1).getValue()
  );
  props.deleteProperty(propKey);
  tg('editMessageReplyMarkup', {
    chat_id: msg.chat.id,
    message_id: msg.reply_to_message.message_id,
    reply_markup: { inline_keyboard: [] }
  });
  tg('sendMessage', {
    chat_id: msg.chat.id,
    reply_to_message_id: msg.message_id,
    text: '❌ Отказ отправлен на ' + who.email + ' — вашим текстом.' +
      mailResultNote(mailResult) +
      (notionResult.ok ? ' Notion → Declined.' : ' ⚠️ Notion не обновлён: ' + notionResult.error)
  });
}

/* Дописывает строку к сообщению заявки. Если keyboard не передать, Telegram
   при редактировании убирает кнопки — это нужно после отправки отказа. */
function appendToMessage(cb, suffix, keyboard) {
  try {
    var payload = {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: cb.message.text + suffix,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (keyboard) payload.reply_markup = keyboard;
    tg('editMessageText', payload);
  } catch (e) { /* не критично */ }
}

/* ============================ утилиты ============================ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Одноразовый запуск: включает обработку кнопок Telegram.
   Удаляет webhook (несовместим с GAS — тот отвечает 302, Telegram зацикливает
   повторы) и ставит таймер, который раз в минуту опрашивает getUpdates. */
function setupTelegramPolling() {
  if (!CONFIG.TELEGRAM_TOKEN) throw new Error('Сначала впиши TELEGRAM_TOKEN в CONFIG');
  tg('deleteWebhook', { drop_pending_updates: true });

  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'pollTelegram';
  });
  if (!exists) {
    ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  }
  Logger.log('Polling включён: триггер pollTelegram раз в минуту.');
}
