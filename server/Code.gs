/**
 * STF Portal (Google Apps Script web app) - rev P0.8.2, Oct 23 2026. Owner: FAB - Apps.
 *
 * P0.8.2: faster opening ("Checking access"): each table is read once per request, and the owner's list of published reviews is kept for 5 minutes.
 * P0.8.1: owner-only preview of any published review (STF Portal Reviews/<code>/review.json), even before the job is in the portal;
 *   the owner's menu lists them under Jobs and People, shops and jobs offers "Add as job" (not sent).
 * P0.8: menu + help + sign-off routes (Apps Spec P19).
 *   - boot gives each person "Needs my attention" items and their new help answers (the pages' menu shows them).
 *   - help(): "Help: common questions" (STF Portal Help/help.md in Drive), Ask Ski Town Fabricators (help tab + a
 *     submissions row for FAB - Help), my questions + answers (FAB - Help drops answers/<id>.json in Drive), owner answers.
 *   - Client signature: per-job STF switch (clientSign, default off) OR the shop manager's own switch on their approval.
 *     Either on -> the client signs. Both off -> the shop manager's signed approval is enough (client only answers what was passed).
 *   - The review moves itself: shop approves -> client (when something was passed or a client signature is needed) or
 *     READY TO SHIP; any change route -> "With STF". Client approves -> READY TO SHIP; client change -> "With STF".
 *   - New table columns are added automatically on the first call after a new rev (no upgrade() run needed).
 *
 * P0.7: approve mode (Apps Spec P18). A job chat publishes review.json + images to Drive "STF Portal Reviews/<JOB CODE>/".
 *   Justin opens the review per job: off -> shop -> client. The review page (review.html, template A2.10) saves answers,
 *   approval and signature straight into the portal (rv/<job>/p/<uid>/...); each Submit adds a readable "submissions" row.
 *   The client page gets the shop manager's answers (shopAnswers), so it shows only what the shop delegated.
 *
 * P0.6: shops, saved people and jobs (Apps Spec P17).
 *   - Roles: owner (Justin) | manager ("Shop manager") | crew ("Shop crew") | client. Old "shop" links read as manager.
 *   - Shops are walled off: a job belongs to one shop; only that shop's managers/crew can be on it; nobody sees another shop.
 *   - One link per person, kept for good. A job shows in someone's portal only after Justin presses "Send to portal".
 *   - Email gate: a person with an email must enter a 6-digit code (emailed from this account) once per device; the device
 *     is then remembered 90 days. Script property CODE_OFF = true switches the gate off in an emergency.
 *   - Shop managers add their own crew, pick each one's level (questions | requests) and which jobs they can see.
 *     Crew items wait for their manager; only approved ones reach STF (the "submissions" sheet).
 *   - Delete = the link stops for good and its row moves to "links_history" (nothing is erased).
 * P0.5: edit links. P0.4: pages on GitHub Pages (https://skitownfabricators.github.io/stf-portal/), JSON over doPost.
 *
 * Storage ("STF Portal Data" spreadsheet, created by setup()/upgrade()):
 *   docs, links (people), shops, jobs, submissions, devices, codes, links_history.  Files: "STF Portal Files" folder.
 * Nothing here shares a file or folder. Deploying the web app ("Anyone") is Justin's own action.
 */

var REV = 'P0.8.2';
var POLL_MAX_OPS = 60;
var FRONT_URL = 'https://skitownfabricators.github.io/stf-portal/';
var ROLE_NAMES = { owner: 'Owner', manager: 'Shop manager', crew: 'Shop crew', client: 'Client' };
var LEVELS = { questions: 'Questions only', requests: 'Questions + change requests' };
var LINK_COLS = ['token', 'uid', 'name', 'role', 'job', 'app', 'created', 'active', 'email', 'shop', 'company', 'level', 'crewJobs', 'deleted'];

/* Access rules per app. '*' = one segment, '**' = the rest, '{self}' = the caller's uid, '{crew}' = a crew member of the
   caller's shop (managers only). read/write: 'any' | 'self' | 'crew' | 'owner'. Owner may always do everything. */
var RULES = {
  configurator: [
    { path: 'config/**', read: 'any', write: 'owner' },
    { path: 'access/**', read: 'any', write: 'owner' },
    { path: 'requests/{self}', read: 'self', write: 'self' },
    { path: 'requests/{self}/items/*', read: 'self', write: 'self' },
    { path: 'requests/{crew}', read: 'crew', write: 'none' },
    { path: 'requests/{crew}/items/*', read: 'crew', write: 'none' },
    { path: 'submissions/*', read: 'owner', write: 'any' }
  ],
  /* review pages: each person reads/writes only their own answers for a job (rv/<job>/p/<uid>/...); job + stage checked too */
  review: [
    { path: 'rv/*/p/{self}/**', read: 'self', write: 'self' }
  ]
};
var STAGES = { '': 'Review off', shop: 'With the shop', client: 'With the client', stf: 'With STF (changes)', done: 'Approved: ready to ship' };

var CTX = { device: '' }; /* set per request by doPost */

/* ---------------- web entry ---------------- */
/* JSON entry for the GitHub Pages front end. Body (text/plain, so no CORS preflight):
   {"fn": "...", "k": "<link key>", "d": "<device key>", "args": [...]}  ->  {"ok": true, "result": ...} | {"ok": false, "error": "..."} */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var k = String(req.k || ''), a = req.args || [];
    ROWS_ = {};
    CTX.device = String(req.d || '');
    var fns = {
      boot: function () { return boot_(k, a[0]); },
      code: function () { return code(k, a[0], a[1] || {}); },
      api: function () { return api(k, String(a[0] || 'configurator'), a[1] || []); },
      profiles: function () { return profiles(k, a[0] || []); },
      links: function () { return links(k, a[0], a[1] || {}); },
      admin: function () { return admin(k, a[0], a[1] || {}); },
      team: function () { return team(k, a[0], a[1] || {}); },
      upload: function () { return upload(k, a[0], a[1], a[2]); },
      asset: function () { return asset(k, a[0]); },
      review: function () { return review(k, a[0], a[1] || {}); },
      help: function () { return help(k, a[0], a[1] || {}); },
      nav: function () { return nav_(whoFromToken_(k)); }
    };
    if (!fns.hasOwnProperty(req.fn)) throw new Error('invalid_argument');
    out = { ok: true, result: fns[req.fn]() };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* The old script.google.com page is retired (it can't do the email check). It only points people to their new address. */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.ping) return ContentService.createTextOutput(JSON.stringify({ ok: true, rev: REV })).setMimeType(ContentService.MimeType.JSON);
  var url = FRONT_URL + (p.k && /^[a-f0-9]{40}$/.test(p.k) ? '?k=' + p.k : '');
  return HtmlService.createHtmlOutput('<p style="font:16px system-ui;margin:24px">The Ski Town Fabricators portal moved. <a href="' + url + '" target="_top">Open it here</a> and bookmark the new address.</p>')
    .setTitle('STF Portal moved').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function boot_(token, appParam) {
  var who = whoFromToken_(token);
  var app = appParam || 'configurator';
  var b = { app: app, role: who.role, uid: who.uid, name: who.name || '', owner: who.role === 'owner', pollMs: 15000, rev: REV };
  if (who.role === 'locked') { b.needCode = true; b.emailHint = hint_(who.email); b.role = 'guest'; b.uid = null; return b; }
  if (who.role === 'guest') return b;
  b.roleName = ROLE_NAMES[who.role] || who.role;
  b.shop = who.shop || ''; b.shopName = who.shop ? shopName_(who.shop) : '';
  b.level = who.role === 'crew' ? (who.level || 'questions') : 'requests';
  b.jobs = visibleJobs_(who).map(function (j) { return { code: j.code, title: j.title || '', shop: j.shop, shopName: shopName_(j.shop) }; });
  b.job = b.jobs.length ? b.jobs[0].code : '';
  b.reviews = jobs_().map(function (j) { var a = reviewAudience_(who, j); return a && (j.review || who.role !== 'owner') ? { job: j.code, title: j.title || '', stage: j.review, stageName: STAGES[j.review] || '', audience: a } : null; }).filter(Boolean);
  if (who.role === 'owner') { try { b.drafts = unlistedReviews_(); } catch (e) { b.drafts = []; } }
  if (who.role === 'crew') b.managers = findLinks_({ role: 'manager', shop: who.shop }).filter(function (l) { return l.active; }).map(function (l) { return l.name; });
  try { var n = nav_(who); b.attention = n.attention; b.helpNew = n.helpNew; } catch (e) { b.attention = []; b.helpNew = 0; }
  return b;
}

/* ---------------- setup / upgrade (run from the editor) ---------------- */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ssId = props.getProperty('SS_ID');
  var ss = ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.create('STF Portal Data');
  props.setProperty('SS_ID', ss.getId());
  ensureTables_(ss);
  var first = ss.getSheetByName('Sheet1'); if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  var folderId = props.getProperty('FOLDER_ID');
  if (!folderId) { folderId = DriveApp.createFolder('STF Portal Files').getId(); props.setProperty('FOLDER_ID', folderId); }
  var owner = findLinks_({ role: 'owner' })[0];
  if (!owner) owner = makeLink_({ name: 'Justin (owner)', role: 'owner' });
  Logger.log('Data spreadsheet: ' + ss.getUrl());
  Logger.log('Files folder: https://drive.google.com/drive/folders/' + folderId);
  Logger.log('Your owner link (keep private): ' + linkUrl_(owner.token));
}

/** P0.6: run once after pasting. Adds the new tabs/columns, renames old "shop" links to Shop manager,
    puts this account's email on the owner link (so the owner link needs a code too) and sends a test email. */
function upgrade() {
  ensureTables_(ss_());
  ROWS_ = {};
  var sh = sheet_('links'), h = header_(sh);
  rows_('links').forEach(function (l) {
    if (l.role === 'shop') sh.getRange(l._row, h.indexOf('role') + 1).setValue('manager');
    if (l.role === 'owner' && !l.email) sh.getRange(l._row, h.indexOf('email') + 1).setValue(Session.getEffectiveUser().getEmail());
  });
  var me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, 'STF Portal ' + REV + ' is set up', 'This is a test from your STF Portal script. Portal codes will come from this account.');
  Logger.log('Upgraded to ' + REV + '. Test email sent to ' + me + '. Your owner link now asks for a code on each new device.');
}

/** Logs every active link (run from the editor). */
function myLinks() {
  findLinks_({}).forEach(function (l) { if (l.active) Logger.log((ROLE_NAMES[l.role] || l.role) + ' | ' + l.name + ' | ' + (l.email || '-') + ' | ' + linkUrl_(l.token)); });
}

function ensureTables_(ss) {
  ensureSheet_(ss, 'docs', ['path', 'json', 'updatedAt', 'updatedBy']);
  ensureSheet_(ss, 'links', LINK_COLS);
  ensureSheet_(ss, 'shops', ['id', 'name', 'created', 'active']);
  ensureSheet_(ss, 'jobs', ['code', 'title', 'shop', 'people', 'sent', 'created', 'updated', 'review', 'stageAt', 'clientSeen', 'clientSign', 'shopClientSign']);
  ensureSheet_(ss, 'submissions', ['at', 'app', 'job', 'title', 'from', 'role', 'summary', 'path']);
  ensureSheet_(ss, 'devices', ['hash', 'uid', 'expires', 'created']);
  ensureSheet_(ss, 'codes', ['uid', 'hash', 'expires', 'tries', 'sentAt']);
  ensureSheet_(ss, 'links_history', LINK_COLS.concat(['deletedAt']));
  ensureSheet_(ss, 'help', HELP_COLS);
}
function ensureSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); return sh; }
  var h = header_(sh);
  header.forEach(function (c) { if (h.indexOf(c) < 0) { sh.getRange(1, h.length + 1).setValue(c); h.push(c); } });
  return sh;
}
function header_(sh) { return sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String); }
function ss_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SS_ID')); }
var SHEETS_ = {};
var SCHEMA_OK_ = false;
function sheet_(name) {
  if (!SCHEMA_OK_) { SCHEMA_OK_ = true; var pr = PropertiesService.getScriptProperties(); if (pr.getProperty('SCHEMA') !== REV) { ensureTables_(ss_()); pr.setProperty('SCHEMA', REV); } }
  if (!SHEETS_[name]) { var ss = ss_(); var sh = ss.getSheetByName(name); if (!sh) { ensureTables_(ss); sh = ss.getSheetByName(name); } SHEETS_[name] = sh; }
  return SHEETS_[name];
}
function linkUrl_(token) {
  var fu = PropertiesService.getScriptProperties().getProperty('FRONT_URL') || FRONT_URL;
  return fu + '?k=' + token;
}

/* ---------------- tables ---------------- */
var ROWS_ = {}; /* P0.8.2: each table is read once per request; any write clears it */
function rows_(name) {
  if (!ROWS_[name]) ROWS_[name] = sheet_(name).getDataRange().getValues();
  var v = ROWS_[name]; var h = v[0].map(String); var out = [];
  for (var i = 1; i < v.length; i++) { var o = { _row: i + 1 }; for (var j = 0; j < h.length; j++) o[h[j]] = v[i][j]; out.push(o); }
  return out;
}
function setCells_(name, row, obj) {
  ROWS_ = {};
  var sh = sheet_(name), h = header_(sh);
  for (var k in obj) { var c = h.indexOf(k); if (c >= 0) sh.getRange(row, c + 1).setValue(obj[k]); }
}
function appendObj_(name, obj) {
  ROWS_ = {};
  var sh = sheet_(name), h = header_(sh);
  sh.appendRow(h.map(function (c) { return obj[c] === undefined ? '' : obj[c]; }));
}
function bool_(v) { return v === true || v === 'TRUE' || v === 'true'; }
function list_(v) { try { var a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

/* ---------------- people (links) ---------------- */
function findLinks_(q) {
  return rows_('links').map(function (l) {
    l.active = bool_(l.active) && !bool_(l.deleted);
    if (l.role === 'shop') l.role = 'manager';
    l.crewJobs = list_(l.crewJobs); l.email = String(l.email || ''); l.shop = String(l.shop || '');
    return l;
  }).filter(function (l) { if (bool_(l.deleted)) return false; for (var k in q) if (String(l[k]) !== String(q[k])) return false; return true; });
}
function newToken_() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function makeLink_(p) {
  var l = { token: newToken_(), uid: 'p_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), name: p.name, role: p.role, job: '', app: 'configurator',
    created: new Date().toISOString(), active: true, email: p.email || '', shop: p.shop || '', company: p.company || '', level: p.level || '',
    crewJobs: JSON.stringify(p.crewJobs || []), deleted: false };
  appendObj_('links', l);
  return l;
}
function whoFromToken_(token) {
  if (!token || !/^[a-f0-9]{40}$/.test(token)) return { role: 'guest', uid: null, name: '' };
  var hit = findLinks_({ token: token })[0];
  if (!hit || !hit.active) return { role: 'guest', uid: null, name: '' };
  var who = { role: hit.role, uid: hit.uid, name: hit.name, email: hit.email, shop: hit.shop, level: hit.level, crewJobs: hit.crewJobs, job: hit.job };
  if (hit.email && !codeOff_() && !deviceOk_(hit.uid)) return { role: 'locked', uid: hit.uid, email: hit.email, name: '' };
  return who;
}
function codeOff_() { return String(PropertiesService.getScriptProperties().getProperty('CODE_OFF') || '') === 'true'; }
function cleanEmail_(v) {
  v = String(v || '').trim().toLowerCase().slice(0, 120);
  if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error('bad_email');
  return v;
}
function hint_(email) { var p = String(email || '').split('@'); return p.length === 2 ? p[0].slice(0, 1) + '***@' + p[1] : ''; }

/* ---------------- email code + remembered devices ---------------- */
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s)).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function deviceOk_(uid) {
  if (!CTX.device || !/^[a-f0-9]{40}$/.test(CTX.device)) return false;
  var h = sha_(CTX.device), now = Date.now();
  return rows_('devices').some(function (d) { return d.hash === h && d.uid === uid && Number(d.expires) > now; });
}
/** code(token, 'send') emails a 6-digit code; code(token, 'verify', {code}) returns {device} to keep for 90 days. */
function code(token, action, args) {
  if (!token || !/^[a-f0-9]{40}$/.test(token)) throw new Error('permission_denied');
  var hit = findLinks_({ token: token })[0];
  if (!hit || !hit.active || !hit.email) throw new Error('permission_denied');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var now = Date.now(), mine = rows_('codes').filter(function (c) { return c.uid === hit.uid; });
    if (action === 'send') {
      var recent = mine.filter(function (c) { return now - Number(c.sentAt) < 3600000; });
      if (recent.length >= 5) throw new Error('too_many_codes');
      if (recent.some(function (c) { return now - Number(c.sentAt) < 45000; })) throw new Error('wait_a_minute');
      var c = String(Math.floor(100000 + Math.random() * 900000));
      appendObj_('codes', { uid: hit.uid, hash: sha_(hit.uid + ':' + c), expires: now + 10 * 60000, tries: 0, sentAt: now });
      MailApp.sendEmail({ to: hit.email, subject: 'Your Ski Town Fabricators portal code: ' + c,
        body: 'Hi ' + hit.name + ',\n\nYour code for the Ski Town Fabricators portal is ' + c + '\nIt works for 10 minutes. This device will then be remembered for 90 days.\n\nIf you didn\'t ask for this code, you can ignore this email.\n\nSki Town Fabricators',
        name: 'Ski Town Fabricators' });
      return { sent: true, hint: hint_(hit.email) };
    }
    if (action === 'verify') {
      var live = mine.filter(function (x) { return Number(x.expires) > now && Number(x.tries) < 5; });
      var last = live[live.length - 1];
      if (!last) throw new Error('code_expired');
      if (sha_(hit.uid + ':' + String(args.code || '').replace(/\D/g, '')) !== last.hash) { setCells_('codes', last._row, { tries: Number(last.tries) + 1 }); throw new Error('wrong_code'); }
      setCells_('codes', last._row, { expires: 0 });
      var dev = newToken_();
      appendObj_('devices', { hash: sha_(dev), uid: hit.uid, expires: now + 90 * 86400000, created: new Date().toISOString() });
      return { device: dev };
    }
    throw new Error('invalid_argument');
  } finally { lock.releaseLock(); }
}

/* ---------------- shops + jobs ---------------- */
function shops_() { return rows_('shops').filter(function (s) { return s.active === '' || bool_(s.active); }); }
function shopName_(id) { var s = rows_('shops').filter(function (x) { return x.id === id; })[0]; return s ? s.name : ''; }
function jobs_() { return rows_('jobs').map(function (j) { j.code = String(j.code); j.people = list_(j.people); j.sent = bool_(j.sent); j.review = String(j.review || ''); j.clientSign = bool_(j.clientSign); j.shopClientSign = bool_(j.shopClientSign); j.clientSeen = bool_(j.clientSeen); return j; }); }
/** Must the client approve and sign this job's review? STF's per-job switch OR the shop manager's own switch. */
function clientSignNeeded_(j) { return !!(j && (j.clientSign || j.shopClientSign)); }
function setStage_(j, st) { var c = { review: st, stageAt: new Date().toISOString(), updated: new Date().toISOString() }; if (st === 'client') c.clientSeen = true; if (!st) { c.clientSeen = false; c.shopClientSign = false; } setCells_('jobs', j._row, c); j.review = st; }
/* Which review audience this person gets for a job right now ('' = none). Manager: from the shop stage on (they keep seeing
   what they sent). Client: client stage. Crew: none (approvals are the shop manager's). Owner: any open review (preview). */
function reviewAudience_(who, j) {
  if (j && who.role === 'owner') return 'justin'; /* P0.8.1: the owner can preview any job's review, sent or not, open or not */
  if (!j || !j.review) return '';
  if (!canSeeJob_(who, j.code)) return '';
  if (who.role === 'manager') return 'shop'; /* every open stage; they can only change answers while it's with the shop */
  if (who.role === 'client' && (j.review === 'client' || (j.clientSeen && (j.review === 'stf' || j.review === 'done')))) return 'client';
  return '';
}
/** Jobs this person may see. Owner: all. Manager/client: sent jobs they're on. Crew: sent jobs of their shop their manager turned on. */
function visibleJobs_(who) {
  var js = jobs_();
  if (who.role === 'owner') return js;
  if (who.role === 'manager' || who.role === 'client') return js.filter(function (j) { return j.sent && j.people.indexOf(who.uid) >= 0 && (who.role === 'client' || j.shop === who.shop); });
  if (who.role === 'crew') return js.filter(function (j) { return j.sent && j.shop === who.shop && (who.crewJobs || []).indexOf(j.code) >= 0; });
  return [];
}
function canSeeJob_(who, code) { return who.role === 'owner' || visibleJobs_(who).some(function (j) { return j.code === code; }); }

/* ---------------- rules ---------------- */
function crewOf_(who, uid) {
  if (who.role !== 'manager' || !uid) return false;
  var c = findLinks_({ uid: uid })[0];
  return !!(c && c.role === 'crew' && c.shop === who.shop);
}
function match_(pattern, path, who) {
  var p = pattern.split('/'), s = path.split('/'), tag = '';
  for (var i = 0; i < p.length; i++) {
    if (p[i] === '**') return { ok: s.length >= i, tag: tag };
    if (i >= s.length) return { ok: false };
    if (p[i] === '*') continue;
    if (p[i] === '{self}') { if (!who.uid || s[i] !== who.uid) return { ok: false }; tag = 'self'; continue; }
    if (p[i] === '{crew}') { if (!crewOf_(who, s[i])) return { ok: false }; tag = 'crew'; continue; }
    if (p[i] !== s[i]) return { ok: false };
  }
  return { ok: p.length === s.length, tag: tag };
}
function allowed_(who, app, path, mode) {
  if (who.role === 'owner') return true;
  if (who.role === 'guest' || who.role === 'locked') return false;
  if (who.role === 'crew' && !visibleJobs_(who).length) return false; /* crew see nothing until their manager turns a job on */
  if (app === 'review') { var rj = /^rv\/([^/]+)\//.exec(path); if (!rj || !reviewAudience_(who, jobs_().filter(function (x) { return x.code === rj[1]; })[0])) return false; }
  var rules = RULES[app] || [];
  for (var i = 0; i < rules.length; i++) {
    var m = match_(rules[i].path, path, who); if (!m.ok) continue;
    var need = rules[i][mode];
    if (need === 'any') return true;
    if (need === 'self' || need === 'crew') return m.tag === need;
    return false;
  }
  return false;
}
function reviewWritable_(who, path) {
  var m = /^rv\/([^/]+)\//.exec(path); if (!m) return false;
  var j = jobs_().filter(function (x) { return x.code === m[1]; })[0];
  var a = reviewAudience_(who, j);
  return (a === 'client' && j.review === 'client') || (a === 'shop' && j.review === 'shop'); /* answers lock once the review moves on */
}
function validPath_(path) { return typeof path === 'string' && /^[A-Za-z0-9_\-.:@+]+(\/[A-Za-z0-9_\-.:@+]+)*$/.test(path) && path.length < 400 && path.split('/').every(function (x) { return x !== '.' && x !== '..'; }); }

/* ---------------- document store ---------------- */
function readDocs_() {
  var v = sheet_('docs').getDataRange().getValues(); var map = {};
  for (var i = 1; i < v.length; i++) map[v[i][0]] = { row: i + 1, json: v[i][1], at: v[i][2] };
  return map;
}
function writeDoc_(map, path, obj, uid) {
  var json = JSON.stringify(obj); if (json.length > 45000) throw new Error('too_large');
  var sh = sheet_('docs'), now = new Date().toISOString();
  if (map[path]) sh.getRange(map[path].row, 1, 1, 4).setValues([[path, json, now, uid || '']]);
  else { sh.appendRow([path, json, now, uid || '']); map[path] = { row: sh.getLastRow(), json: json, at: now }; }
  map[path].json = json; map[path].at = now;
}
function children_(map, col) {
  var pre = col + '/', n = col.split('/').length + 1, out = [];
  for (var k in map) if (k.indexOf(pre) === 0 && k.split('/').length === n) out.push({ id: k.slice(pre.length), data: JSON.parse(map[k].json), at: map[k].at });
  return out;
}

/** The pages call this for every read and write. ops: [{op, path, data}] -> results in the same order. */
function api(token, app, ops) {
  var who = whoFromToken_(token);
  if (!Array.isArray(ops) || ops.length > POLL_MAX_OPS) throw new Error('invalid_argument');
  var writes = ops.some(function (o) { return o.op !== 'get' && o.op !== 'list'; });
  var lock = writes ? LockService.getScriptLock() : null; if (lock) lock.waitLock(20000);
  try {
    var map = readDocs_();
    return ops.map(function (o) {
      try {
        if (!validPath_(o.path)) return { error: 'invalid_argument' };
        var segs = o.path.split('/').length;
        if (o.op === 'get') {
          if (segs % 2 !== 0) return { error: 'invalid_argument' };
          if (!allowed_(who, app, o.path, 'read')) return { error: 'permission_denied' };
          var d = map[o.path]; return { exists: !!d, data: d ? JSON.parse(d.json) : null };
        }
        if (o.op === 'list') {
          if (segs % 2 !== 1) return { error: 'invalid_argument' };
          if (who.role !== 'owner' && !allowed_(who, app, o.path + '/x', 'read')) {
            if (o.path === 'requests' && who.role !== 'guest' && who.role !== 'locked') {
              var ids = [who.uid].concat(who.role === 'manager' ? findLinks_({ role: 'crew', shop: who.shop }).map(function (c) { return c.uid; }) : []);
              return { docs: ids.filter(function (id) { return map['requests/' + id] && allowed_(who, app, 'requests/' + id, 'read'); }).map(function (id) { return { id: id, data: JSON.parse(map['requests/' + id].json) }; }) };
            }
            if (!allowed_(who, app, o.path + '/' + who.uid, 'read')) return { error: 'permission_denied' };
            var mine = map[o.path + '/' + who.uid]; return { docs: mine ? [{ id: who.uid, data: JSON.parse(mine.json) }] : [] };
          }
          return { docs: children_(map, o.path).map(function (c) { return { id: c.id, data: c.data }; }) };
        }
        var path = o.path;
        if (o.op === 'add') { if (segs % 2 !== 1) return { error: 'invalid_argument' }; path = o.path + '/' + Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
        else if (segs % 2 !== 0) return { error: 'invalid_argument' };
        if (!allowed_(who, app, path, 'write')) return { error: 'permission_denied' };
        if (app === 'review' && who.role !== 'owner' && !reviewWritable_(who, path)) return { error: 'permission_denied' };
        if (o.op === 'delete') { if (map[path]) { sheet_('docs').getRange(map[path].row, 2).setValue('{"_deleted":true}'); delete map[path]; } return { ok: true }; }
        var data = o.data || {};
        if (who.role !== 'owner' && app !== 'review' && data && typeof data === 'object' && 'job' in data) { /* review paths carry the job already */
          if (!canSeeJob_(who, String(data.job))) return { error: 'permission_denied' }; /* only jobs sent to this person */
        }
        if (who.role === 'crew' && /^requests\/[^/]+\/items\//.test(path) && o.op !== 'update') {
          if ((who.level || 'questions') !== 'requests') data.changes = []; /* "Questions only" crew can't send changes */
          data.status = 'Waiting on shop manager'; data.held = true;
        }
        if (o.op === 'update') {
          if (!map[path]) return { error: 'not_found' };
          if (who.role === 'crew' && /^requests\//.test(path)) { delete data.status; delete data.held; }
          if (JSON.parse(map[path].json).held && /^requests\//.test(path) && 'status' in data) return { error: 'held' }; /* waiting on the shop manager: read-only for everyone (they decide via team 'decide') */
          data = merge_(JSON.parse(map[path].json), data);
        }
        if (who.role === 'crew' && /^submissions\//.test(path)) { data.held = true; data.crewUid = who.uid; data.crewShop = who.shop; }
        writeDoc_(map, path, data, who.uid);
        afterWrite_(who, app, path, data, map);
        return { ok: true, id: path.split('/').pop() };
      } catch (err) { return { error: String(err && err.message || err) === 'too_large' ? 'too_large' : 'internal' }; }
    });
  } finally { if (lock) lock.releaseLock(); }
}
function merge_(a, b) { var o = {}; for (var k in a) o[k] = a[k]; for (var j in b) o[j] = b[j]; return o; }

/* Every Submit lands as a readable row in "submissions" (what the chats and the hourly check read).
   Crew submissions are held: they're linked to the crew member's newest item and logged only when their manager approves. */
function afterWrite_(who, app, path, data, map) {
  var rv = /^rv\/([^/]+)\/p\/([^/]+)\/(submissions|comments)\//.exec(path);
  if (rv) { reviewRow_(who, rv[1], rv[2], rv[3], data, map); return; }
  if (!/^submissions\//.test(path)) return;
  if (data.held) {
    var items = children_(map, 'requests/' + who.uid + '/items').filter(function (c) { return !c.data.sub; });
    items.sort(function (a, b) { return String(a.data.createdAt || a.at) < String(b.data.createdAt || b.at) ? 1 : -1; });
    if (items[0]) { var ip = 'requests/' + who.uid + '/items/' + items[0].id; writeDoc_(map, ip, merge_(items[0].data, { sub: path }), who.uid); }
    return;
  }
  sheet_('submissions').appendRow([new Date().toISOString(), app, data.job || '', data.title || '', who.name || '', ROLE_NAMES[who.role] || who.role, String(data.summary || '').slice(0, 45000), path]);
}

/* ---------------- people ---------------- */
function profiles(token, ids) {
  var w = whoFromToken_(token); if (w.role === 'guest' || w.role === 'locked') return {};
  var out = {}; findLinks_({}).forEach(function (l) {
    if (ids.indexOf(l.uid) < 0) return;
    if (w.role !== 'owner' && l.uid !== w.uid && !(w.shop && l.shop === w.shop)) return; /* no names across shops */
    out[l.uid] = { name: l.name, role: l.role, roleName: ROLE_NAMES[l.role] || l.role };
  });
  return out;
}
function personOut_(l) {
  return { uid: l.uid, name: l.name, role: l.role, roleName: ROLE_NAMES[l.role] || l.role, email: l.email, shop: l.shop, company: l.company || '',
    level: l.level || '', crewJobs: l.crewJobs || [], active: l.active, created: l.created, url: linkUrl_(l.token) };
}

/** Owner: people (links), shops and jobs. Kept as links() for the old page code: list | make | edit | off | on | delete. */
function links(token, action, args) { return admin(token, action, args); }
function admin(token, action, args) {
  var w = whoFromToken_(token); if (w.role !== 'owner') throw new Error('permission_denied');
  args = args || {};
  var lock = action === 'list' || action === 'state' ? null : LockService.getScriptLock(); if (lock) lock.waitLock(20000);
  try {
    if (action === 'state') return { shops: shops_().map(function (s) { return { id: s.id, name: s.name }; }), people: findLinks_({}).filter(function (l) { return l.role !== 'owner'; }).map(personOut_),
      jobs: jobs_().map(function (j) { return { code: j.code, title: j.title, shop: j.shop, people: j.people, sent: j.sent, review: j.review, stageAt: j.stageAt ? String(j.stageAt) : '', clientSign: j.clientSign, shopClientSign: j.shopClientSign }; }), levels: LEVELS, roles: ROLE_NAMES, stages: STAGES, drafts: unlistedReviews_() };
    if (action === 'list') return findLinks_({}).map(personOut_);
    if (action === 'addshop') {
      var nm = String(args.name || '').trim().slice(0, 80); if (!nm) throw new Error('invalid_argument');
      if (shops_().some(function (s) { return s.name.toLowerCase() === nm.toLowerCase(); })) throw new Error('exists');
      var id = 'sh_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
      appendObj_('shops', { id: id, name: nm, created: new Date().toISOString(), active: true }); return { id: id };
    }
    if (action === 'renameshop') {
      var s = rows_('shops').filter(function (x) { return x.id === args.id; })[0]; if (!s) throw new Error('not_found');
      setCells_('shops', s._row, { name: String(args.name || '').trim().slice(0, 80) || s.name }); return { ok: true };
    }
    if (action === 'make') {
      var p = checkPerson_(args, null);
      var l = makeLink_(p);
      return { uid: l.uid, url: linkUrl_(l.token) };
    }
    var e = findLinks_({ uid: args.uid })[0];
    if (action === 'edit') {
      if (!e) throw new Error('not_found');
      if (e.role === 'owner') { if (args.email !== undefined) setCells_('links', e._row, { email: cleanEmail_(args.email) }); if (args.name) setCells_('links', e._row, { name: String(args.name).trim().slice(0, 80) }); return { ok: true }; }
      var q = checkPerson_(merge_({ name: e.name, email: e.email, role: e.role, shop: e.shop, company: e.company, level: e.level, crewJobs: e.crewJobs }, args), e);
      var cells = { name: q.name, email: q.email, role: q.role, shop: q.shop, company: q.company, level: q.level, crewJobs: JSON.stringify(q.crewJobs || []) };
      setCells_('links', e._row, cells);
      if (q.shop !== e.shop || q.role !== e.role) dropFromOtherShops_(e.uid, q.role === 'client' ? '' : q.shop);
      return { ok: true };
    }
    if (action === 'off' || action === 'on') {
      if (!e) throw new Error('not_found'); if (e.role === 'owner') throw new Error('invalid_argument');
      setCells_('links', e._row, { active: action === 'on' }); return { ok: true };
    }
    if (action === 'delete') {
      if (!e) throw new Error('not_found'); if (e.role === 'owner') throw new Error('invalid_argument');
      var raw = rows_('links').filter(function (x) { return x.uid === e.uid; })[0];
      raw.deletedAt = new Date().toISOString(); raw.active = false; raw.deleted = true;
      appendObj_('links_history', raw);
      setCells_('links', e._row, { active: false, deleted: true, token: 'deleted_' + e.uid }); /* the old key can never match again */
      dropFromOtherShops_(e.uid, '__none__');
      return { ok: true };
    }
    if (action === 'addjob' || action === 'editjob') {
      var code = String(args.code || '').trim().toUpperCase().slice(0, 60);
      if (!/^[A-Z0-9][A-Z0-9_.\-]*$/.test(code)) throw new Error('bad_code');
      var ex = jobs_().filter(function (j) { return j.code === code; })[0];
      if (action === 'addjob' && ex) throw new Error('exists');
      if (action === 'editjob' && !ex) throw new Error('not_found');
      var shop = args.shop !== undefined ? String(args.shop) : (ex ? ex.shop : '');
      if (shop && !shops_().some(function (s) { return s.id === shop; })) throw new Error('invalid_argument');
      var people = (args.people !== undefined ? args.people : (ex ? ex.people : [])).filter(function (uid) {
        var pl = findLinks_({ uid: uid })[0];
        return pl && (pl.role === 'client' || (pl.role === 'manager' && pl.shop === shop)); /* walls: only that shop's managers (crew are turned on by their manager) */
      });
      var row = { code: code, title: String(args.title !== undefined ? args.title : (ex ? ex.title : '')).slice(0, 120), shop: shop, people: JSON.stringify(people), updated: new Date().toISOString() };
      if (ex) setCells_('jobs', ex._row, row); else { row.sent = false; row.created = row.updated; appendObj_('jobs', row); }
      if (ex && shop !== ex.shop) findLinks_({ role: 'crew' }).forEach(function (c) { if (c.crewJobs.indexOf(code) >= 0 && c.shop !== shop) setCells_('links', c._row, { crewJobs: JSON.stringify(c.crewJobs.filter(function (x) { return x !== code; })) }); });
      return { code: code, people: people };
    }
    if (action === 'stage') {
      var jr = jobs_().filter(function (x) { return x.code === String(args.code); })[0]; if (!jr) throw new Error('not_found');
      var st = String(args.stage || ''); if (!STAGES.hasOwnProperty(st)) throw new Error('invalid_argument');
      if (st && !jr.sent) throw new Error('not_sent');
      if (st && !reviewJson_(jr.code)) throw new Error('no_review_file');
      setStage_(jr, st); return { ok: true };
    }
    if (action === 'clientsign') {
      var jc = jobs_().filter(function (x) { return x.code === String(args.code); })[0]; if (!jc) throw new Error('not_found');
      setCells_('jobs', jc._row, { clientSign: !!args.on, updated: new Date().toISOString() }); return { ok: true };
    }
    if (action === 'send') {
      var j = jobs_().filter(function (x) { return x.code === String(args.code); })[0]; if (!j) throw new Error('not_found');
      if (args.sent && !j.shop) throw new Error('no_shop');
      setCells_('jobs', j._row, { sent: !!args.sent, updated: new Date().toISOString() }); return { ok: true };
    }
    throw new Error('invalid_argument');
  } finally { if (lock) lock.releaseLock(); }
}
function checkPerson_(a, existing) {
  var role = a.role === 'shop' ? 'manager' : a.role;
  if (['manager', 'crew', 'client'].indexOf(role) < 0) throw new Error('invalid_argument');
  var name = String(a.name || '').trim().slice(0, 80); if (!name) throw new Error('invalid_argument');
  var email = cleanEmail_(a.email);
  if (!email) throw new Error('email_required');
  var dupe = findLinks_({}).filter(function (l) { return l.email === email && (!existing || l.uid !== existing.uid); })[0];
  if (dupe) throw new Error('email_in_use');
  var shop = role === 'client' ? '' : String(a.shop || '');
  if (role !== 'client' && !shops_().some(function (s) { return s.id === shop; })) throw new Error('shop_required');
  var level = role === 'crew' ? (LEVELS[a.level] ? a.level : 'questions') : '';
  var crewJobs = role === 'crew' ? (a.crewJobs || []).filter(function (c) { return jobs_().some(function (j) { return j.code === c && j.shop === shop; }); }) : [];
  return { name: name, email: email, role: role, shop: shop, company: role === 'client' ? String(a.company || '').trim().slice(0, 80) : '', level: level, crewJobs: crewJobs };
}
/* Keep the walls: after a person changes shop (or is deleted) take them off jobs of other shops. */
function dropFromOtherShops_(uid, keepShop) {
  jobs_().forEach(function (j) {
    if (j.people.indexOf(uid) < 0) return;
    var pl = findLinks_({ uid: uid })[0];
    var keep = keepShop !== '__none__' && pl && (pl.role === 'client' || (pl.role === 'manager' && j.shop === keepShop));
    if (!keep) setCells_('jobs', j._row, { people: JSON.stringify(j.people.filter(function (x) { return x !== uid; })) });
  });
}

/** Shop manager: their own crew. list | addcrew | editcrew | off | on | decide | permreq. Never reaches outside their shop. */
function team(token, action, args) {
  var w = whoFromToken_(token); if (w.role !== 'manager' || !w.shop) throw new Error('permission_denied');
  args = args || {};
  var myJobs = visibleJobs_(w).map(function (j) { return j.code; });
  var mine = function (uid) { var c = findLinks_({ uid: uid })[0]; if (!c || c.role !== 'crew' || c.shop !== w.shop) throw new Error('not_found'); return c; };
  var jobsOk = function (js) { return (js || []).map(String).filter(function (c) { return myJobs.indexOf(c) >= 0; }); };
  var lock = action === 'list' ? null : LockService.getScriptLock(); if (lock) lock.waitLock(20000);
  try {
    if (action === 'list') {
      var map = readDocs_(), crew = findLinks_({ role: 'crew', shop: w.shop });
      var waiting = [];
      crew.forEach(function (c) {
        children_(map, 'requests/' + c.uid + '/items').forEach(function (it) {
          if (!it.data.held) return;
          var sub = it.data.sub && map[it.data.sub] ? JSON.parse(map[it.data.sub].json) : null;
          waiting.push({ item: 'requests/' + c.uid + '/items/' + it.id, from: c.name, job: it.data.job || '', at: it.data.createdAt || it.at,
            summary: sub ? sub.summary : '', message: it.data.message || '', changes: it.data.changes || [], notes: (it.data.notes || []).length });
        });
      });
      return { shop: w.shop, shopName: shopName_(w.shop), levels: LEVELS, jobs: visibleJobs_(w).map(function (j) { return { code: j.code, title: j.title }; }),
        crew: crew.map(function (c) { return { uid: c.uid, name: c.name, email: c.email, level: c.level || 'questions', crewJobs: c.crewJobs.filter(function (x) { return myJobs.indexOf(x) >= 0; }), active: c.active, url: linkUrl_(c.token) }; }),
        waiting: waiting };
    }
    if (action === 'addcrew') {
      var p = checkPerson_({ name: args.name, email: args.email, role: 'crew', shop: w.shop, level: args.level, crewJobs: jobsOk(args.crewJobs) }, null);
      var l = makeLink_(p); return { uid: l.uid, url: linkUrl_(l.token) };
    }
    if (action === 'editcrew') {
      var c = mine(args.uid);
      var keepOther = c.crewJobs.filter(function (x) { return myJobs.indexOf(x) < 0; }); /* jobs this manager can't see stay as they are */
      var q = checkPerson_({ name: args.name !== undefined ? args.name : c.name, email: args.email !== undefined ? args.email : c.email, role: 'crew', shop: w.shop,
        level: args.level !== undefined ? args.level : c.level, crewJobs: (args.crewJobs !== undefined ? jobsOk(args.crewJobs) : c.crewJobs).concat(args.crewJobs !== undefined ? keepOther : []) }, c);
      setCells_('links', c._row, { name: q.name, email: q.email, level: q.level, crewJobs: JSON.stringify(q.crewJobs) }); return { ok: true };
    }
    if (action === 'off' || action === 'on') { var c2 = mine(args.uid); setCells_('links', c2._row, { active: action === 'on' }); return { ok: true }; }
    if (action === 'decide') {
      var m = /^requests\/([^/]+)\/items\/[^/]+$/.exec(String(args.item || '')); if (!m) throw new Error('invalid_argument');
      var cr = mine(m[1]), dm = readDocs_(), it = dm[args.item]; if (!it) throw new Error('not_found');
      var d = JSON.parse(it.json); if (!d.held) throw new Error('already_decided');
      var note = String(args.note || '').slice(0, 2000);
      d.held = false; d.decidedBy = w.uid; d.decidedAt = new Date().toISOString(); if (note) d.managerNote = note;
      if (args.ok) {
        d.status = 'New';
        var sub = d.sub && dm[d.sub] ? JSON.parse(dm[d.sub].json) : { job: d.job, title: 'Configurator change request', summary: d.message || '' };
        sub.held = false; sub.approvedBy = w.name;
        writeDoc_(dm, d.sub || ('submissions/crew-' + Date.now()), sub, w.uid);
        sheet_('submissions').appendRow([new Date().toISOString(), 'configurator', sub.job || d.job || '', sub.title || '', cr.name + ' (approved by ' + w.name + ')', 'Shop crew',
          String((sub.summary || '') + (note ? '\nShop manager note: ' + note : '')).slice(0, 45000), d.sub || '']);
      } else d.status = 'Not sent (shop manager)';
      writeDoc_(dm, args.item, d, w.uid);
      return { ok: true };
    }
    if (action === 'permreq') {
      var text = String(args.text || '').trim().slice(0, 4000); if (!text) throw new Error('invalid_argument');
      sheet_('submissions').appendRow([new Date().toISOString(), 'portal', '', 'Permissions settings request', w.name, 'Shop manager',
        'Shop: ' + shopName_(w.shop) + '\n' + (args.crew ? 'About: ' + mine(args.crew).name + '\n' : '') + text, '']);
      return { ok: true };
    }
    throw new Error('invalid_argument');
  } finally { if (lock) lock.releaseLock(); }
}

/* ---------------- files ---------------- */
function upload(token, b64, mime, name) {
  var w = whoFromToken_(token); if (w.role === 'guest' || w.role === 'locked') throw new Error('permission_denied');
  if (w.role === 'crew' && !visibleJobs_(w).length) throw new Error('permission_denied');
  if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(mime)) throw new Error('unsupported_type');
  var bytes = Utilities.base64Decode(b64); if (bytes.length > 20 * 1024 * 1024) throw new Error('too_large');
  var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('FOLDER_ID'));
  var safe = String(name || 'attachment').replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 80);
  var f = folder.createFile(Utilities.newBlob(bytes, mime, new Date().toISOString().slice(0, 10) + '_' + (w.name || 'viewer').replace(/[^A-Za-z0-9]/g, '') + '_' + safe));
  f.setDescription('Uploaded via STF Portal by ' + w.name + ' (' + w.role + ', ' + w.uid + ', shop ' + (w.shop || '-') + ')');
  return { id: f.getId(), contentType: mime, sizeBytes: bytes.length };
}
function asset(token, id) {
  var w = whoFromToken_(token); if (w.role === 'guest' || w.role === 'locked') throw new Error('permission_denied');
  var f = DriveApp.getFileById(id);
  var folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID'); var inFolder = false;
  var ps = f.getParents(); while (ps.hasNext()) if (ps.next().getId() === folderId) inFolder = true;
  if (!inFolder) throw new Error('not_found');
  var b = f.getBlob(); return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
}


/* ---------------- approve mode (P0.7) ---------------- */
/* Drive: "STF Portal Reviews" folder (made on first use) > one folder per job code > review.json + the images it names (img/x.jpg -> x.jpg). */
function reviewsFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('REVIEWS_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var it = DriveApp.getFoldersByName('STF Portal Reviews'); var f = it.hasNext() ? it.next() : DriveApp.createFolder('STF Portal Reviews');
  props.setProperty('REVIEWS_ID', f.getId()); return f;
}
/** Reviews a job chat published to Drive whose code isn't a portal job yet (owner only sees these). */
function unlistedReviews_() {
  var cache = null; try { cache = CacheService.getScriptCache(); var hit = cache.get('drafts'); if (hit) { var have0 = jobs_().map(function (j) { return j.code; }); return JSON.parse(hit).filter(function (d) { return have0.indexOf(d.code) < 0; }); } } catch (e) { cache = null; }
  var out0 = unlistedReviewsNow_(); try { if (cache) cache.put('drafts', JSON.stringify(out0), 300); } catch (e) {}
  return out0;
}
function unlistedReviewsNow_() {
  var have = jobs_().map(function (j) { return j.code; }), out = [], it = reviewsFolder_().getFolders();
  while (it.hasNext()) {
    var f = it.next(), code = f.getName(); if (have.indexOf(code) >= 0 || !/^[A-Z0-9][A-Z0-9_.\-]*$/.test(code)) continue;
    var title = ''; try { var R = reviewJson_(code); if (!R) continue; title = R.title || ''; } catch (e) { title = '(review.json unreadable)'; }
    out.push({ code: code, title: title });
  }
  return out;
}
function reviewFolder_(job) { var it = reviewsFolder_().getFoldersByName(job); return it.hasNext() ? it.next() : null; }
function reviewJson_(job) {
  var f = reviewFolder_(job); if (!f) return null;
  var it = f.getFilesByName('review.json'); var best = null;
  while (it.hasNext()) { var x = it.next(); if (!best || x.getLastUpdated() > best.getLastUpdated()) best = x; } /* newest wins if a chat uploaded twice */
  if (!best) return null;
  return JSON.parse(best.getBlob().getDataAsString('UTF-8'));
}
/** The latest decisions a shop manager saved on this job's review, as the client page's shopAnswers. */
/** The shop manager's latest saved placements (size/position/color on a photo) for the client page to start from. */
function shopPlacements_(job, map) {
  map = map || readDocs_();
  var mgrs = findLinks_({ role: 'manager' }).map(function (l) { return l.uid; }), best = {};
  for (var k in map) {
    var m = /^rv\/([^/]+)\/p\/([^/]+)\/placements\/([^/]+)$/.exec(k);
    if (!m || m[1] !== job || mgrs.indexOf(m[2]) < 0) continue;
    var d = JSON.parse(map[k].json); if (d._deleted) continue;
    var key = (d.fig || '') + '::' + (d.obj || m[3]);
    if (!best[key] || d.at > best[key].at) best[key] = { fig: d.fig || '', obj: d.obj || '', xIn: d.xIn, yIn: d.yIn, wIn: d.wIn, hIn: d.hIn, color: d.color || null, changed: !!d.changed, at: d.at };
  }
  return Object.keys(best).map(function (k) { return best[k]; });
}
function shopAnswers_(job, map) {
  map = map || readDocs_();
  var mgrs = findLinks_({ role: 'manager' }).map(function (l) { return l.uid; });
  var best = {}, bestAt = {};
  for (var k in map) {
    var m = /^rv\/([^/]+)\/p\/([^/]+)\/decisions\/([^/]+)$/.exec(k);
    if (!m || m[1] !== job || mgrs.indexOf(m[2]) < 0) continue;
    var d = JSON.parse(map[k].json); if (d._deleted) continue;
    if (!bestAt[m[3]] || d.at > bestAt[m[3]]) { bestAt[m[3]] = d.at; best[m[3]] = { title: d.question, choice: d.choice, label: d.choiceLabel, note: d.note || '', delegated: d.choice === 'delegate' }; }
  }
  return best;
}
/** review(token, 'get', {job, as}) -> {review, images, stage}; review(token, 'img', {job, name}) -> data URL. */
function review(token, action, args) {
  var who = whoFromToken_(token); if (who.role === 'guest' || who.role === 'locked') throw new Error('permission_denied');
  var job = String(args.job || '');
  var j = jobs_().filter(function (x) { return x.code === job; })[0];
  if (!j && who.role === 'owner' && reviewFolder_(job)) j = { code: job, review: '', clientSign: false, shopClientSign: false, title: '' }; /* published, not a portal job yet */
  var aud = reviewAudience_(who, j); if (!aud) throw new Error('no_review');
  if (who.role === 'owner' && (args.as === 'shop' || args.as === 'client')) aud = args.as;
  var f = reviewFolder_(job);
  if (action === 'img') {
    var name = String(args.name || '').split('/').pop(); if (!f || !/^[A-Za-z0-9_.\-]+$/.test(name)) throw new Error('not_found');
    var it = f.getFilesByName(name); if (!it.hasNext()) throw new Error('not_found');
    var b = it.next().getBlob(); return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
  }
  if (action !== 'get') throw new Error('invalid_argument');
  var R = reviewJson_(job); if (!R) throw new Error('no_review_file');
  R.audience = aud;
  R.job = R.job || job;
  if (aud === 'client') { R.shopAnswers = shopAnswers_(job); R.shopPlacements = shopPlacements_(job); R.clientSignRequired = clientSignNeeded_(j); }
  if (aud === 'shop') R.stfRequiresClientSign = !!j.clientSign;
  R.stage = j.review; R.stageName = STAGES[j.review] || j.review;
  R.viewer = who.role === 'owner' ? 'owner-' + aud : who.uid; /* drafts in the browser are kept per person */
  /* signer name comes from the person's saved profile, never from the page */
  if (aud === 'shop' || aud === 'client') {
    R.signers = (R.signers || []).map(function (s) { if (s.audience === aud && who.role !== 'owner') { s = merge_(s, { name: who.name }); if (aud === 'shop' && who.shop) s.company = s.company || shopName_(who.shop); } return s; });
  }
  R.notifyTrigger = ''; R.artifactUrl = '';
  var images = [], fit = f.getFiles(); while (fit.hasNext()) { var n = fit.next().getName(); if (/\.(png|jpe?g|webp|gif|svg)$/i.test(n)) images.push(n); }
  var locked = who.role !== 'owner' && !((aud === 'client' && j.review === 'client') || (aud === 'shop' && j.review === 'shop'));
  return { review: R, images: images, stage: j.review, stageName: STAGES[j.review] || j.review, preview: who.role === 'owner', locked: locked };
}
/* A readable "submissions" row for every review Submit (and every "send now" comment), for the chats and the hourly check. */
function reviewRow_(who, job, uid, kind, data, map) {
  if (kind === 'comments') {
    if (!data.now) return;
    sheet_('submissions').appendRow([new Date().toISOString(), 'review', job, 'Review comment', who.name || '', ROLE_NAMES[who.role] || who.role, '[' + (data.slide || '') + '] ' + String(data.text || '').slice(0, 4000), 'rv/' + job + '/p/' + uid]);
    return;
  }
  var pre = 'rv/' + job + '/p/' + uid + '/', L = [];
  var aud = data.audience || '';
  L.push('ANSWERS from ' + (who.name || '') + ' (' + (ROLE_NAMES[who.role] || who.role) + ') · ' + (data.title || '') + ' · review ' + (data.review || '') + ' · job ' + job);
  var ds = [], ap = null, pl = [], cm = [];
  for (var k in map) {
    if (k.indexOf(pre) !== 0) continue;
    var d = JSON.parse(map[k].json); if (d._deleted || (data.review && d.review && d.review !== data.review)) continue;
    var rest = k.slice(pre.length);
    if (/^decisions\//.test(rest) && d.at === data.at) ds.push(d);
    else if (/^approvals\//.test(rest) && d.at === data.at) ap = d;
    else if (/^placements\//.test(rest) && d.at === data.at) pl.push(d);
    else if (/^comments\//.test(rest) && d.at === data.at && !d.now) cm.push(d);
  }
  ds.forEach(function (d) { L.push(d.question + ': ' + (d.choiceLabel || d.choice || '(no answer)') + (d.choice === 'delegate' ? ' [DELEGATED to the client]' : '') + (d.note ? ' | Note: ' + d.note : '') + (d.decidedBy ? ' | Decided by: ' + d.decidedBy : '')); });
  pl.forEach(function (r) { L.push('Placement ' + (r.label || r.obj || '') + ': ' + [r.wIn, r.hIn].join(' x ') + ' in' + (r.changed ? ' (moved/resized)' : ' (as proposed)') + (r.cantMake && r.cantMake.length ? ' | CAN\'T MAKE: ' + r.cantMake.join(', ') : '')); });
  cm.forEach(function (c) { L.push('Comment [' + (c.slide || '') + ']: ' + c.text); });
  if (ap) {
    var OL = { approve: 'OUTCOME: APPROVED as shown', change: 'OUTCOME: APPROVED WITH THIS CHANGE: ', notready: 'OUTCOME: NOT READY, needs changes: ',
      toclient: 'OUTCOME: SHOP APPROVED, send the rest to the client', stf_then_shop: 'OUTCOME: SHOP WANTS CHANGES, then back to the shop before the client: ',
      stf_then_client: 'OUTCOME: SHOP APPROVED WITH CHANGES, then send the rest to the client: ',
      answers: 'OUTCOME: CLIENT ANSWERS ARE FINAL (no signature needed on this job)', question: 'OUTCOME: CLIENT HAS A QUESTION OR WANTS A CHANGE: ' };
    L.push((OL[ap.outcome] || ('OUTCOME: ' + ap.outcome + ': ')) + (ap.outcome === 'approve' || ap.outcome === 'toclient' || ap.outcome === 'answers' ? '' : (ap.change || '')));
    if (aud === 'shop' && ap.clientSign !== undefined) L.push('Client signature: ' + (ap.clientSign ? 'the shop manager wants the client to approve and sign' : 'not asked for by the shop manager'));
    if (ap.note) L.push('Note for the record: ' + ap.note);
    if (ap.signed) L.push('Signed: ' + (ap.signer && ap.signer.name ? ap.signer.name + ', ' : '') + (ap.signer ? ap.signer.company + ' (' + ap.signer.role + ')' : '') + ', ' + new Date(ap.at).toISOString() + ', via STF portal, ' + (ap.rev || '') + ' (signature saved in the portal: ' + pre + 'approvals/)');
  }
  var TT = { approve: 'Review: APPROVED', change: 'Review: APPROVED with a change', notready: 'Review: NOT READY', toclient: 'Review: APPROVED, send the rest to the client',
    stf_then_shop: 'Review: CHANGES FIRST, then back to the shop', stf_then_client: 'Review: APPROVED with changes, then the client',
    answers: 'Review: CLIENT ANSWERS IN', question: 'Review: CLIENT QUESTION OR CHANGE' };
  var title = ap ? (TT[ap.outcome] || 'Review: ' + ap.outcome) : 'Review answers';
  /* P0.8: the review moves itself on. STF only steps in for changes, and gets READY TO SHIP when every needed sign-off is in. */
  var j = jobs_().filter(function (x) { return x.code === job; })[0], next = '';
  if (ap && j && who.role !== 'owner') {
    var o = ap.outcome, nDel = ds.filter(function (d) { return d.choice === 'delegate'; }).length;
    if (aud === 'shop' && j.review === 'shop') {
      if (ap.clientSign !== undefined) { setCells_('jobs', j._row, { shopClientSign: !!ap.clientSign }); j.shopClientSign = !!ap.clientSign; }
      if (o === 'approve' || o === 'toclient') next = (nDel || clientSignNeeded_(j)) ? 'client' : 'done';
      else next = 'stf';
    } else if (aud === 'client' && j.review === 'client') next = (o === 'approve' || o === 'answers') ? 'done' : 'stf';
    if (next) setStage_(j, next);
  }
  if (next === 'done') { title = 'Review: READY TO SHIP'; L.push('NEXT: every sign-off this job needs is in' + (clientSignNeeded_(j) ? ' (shop manager + client)' : ' (shop manager; no client signature needed)') + '. Ready to ship.'); }
  else if (next === 'client') { title = 'Review: SHOP APPROVED, now with the client'; L.push('NEXT: the portal sent the review to the client' + (clientSignNeeded_(j) ? ' (client must approve and sign)' : ' (client answers what was passed to them; no signature needed)') + '. Nothing for STF to do yet.'); }
  else if (next === 'stf') { title += ' (STF: your move)'; L.push('NEXT: the review is with STF. Make the changes, then use the job\'s Approval buttons to send it ' + (o === 'stf_then_client' ? 'to the client' : o === 'question' ? 'back to the client' : 'back to the shop') + (o === 'change' ? ' (or mark it ready to ship if nobody else has to see the change)' : '') + '.'); }
  sheet_('submissions').appendRow([new Date().toISOString(), 'review', job, title + ' (' + (aud || who.role) + ')', who.name || '', ROLE_NAMES[who.role] || who.role, L.join('\n').slice(0, 45000), pre + 'submissions/']);
}


/* ---------------- menu + help (P0.8) ---------------- */
var HELP_COLS = ['id', 'at', 'uid', 'name', 'role', 'shop', 'page', 'job', 'question', 'answer', 'answeredBy', 'answeredAt', 'status', 'seen', 'addToFaq'];
var HELP_SECTIONS = { 'everyone': '*', 'stf': 'owner', 'shop manager': 'manager', 'shop crew': 'crew', 'client': 'client' };
/* Drive: "STF Portal Help" > help.md (the common questions, written by FAB - Apps, grown by FAB - Help) + answers/<id>.json (FAB - Help's replies). */
function helpFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('HELP_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var it = DriveApp.getFoldersByName('STF Portal Help'); var f = it.hasNext() ? it.next() : DriveApp.createFolder('STF Portal Help');
  props.setProperty('HELP_ID', f.getId()); return f;
}
function helpSub_(name) { var f = helpFolder_(), it = f.getFoldersByName(name); return it.hasNext() ? it.next() : f.createFolder(name); }
/** help.md -> [{id, section, role, q, a}]. "## <who>" starts a section (Everyone | STF | Shop manager | Shop crew | Client), "### <question>" starts an entry. */
function faq_() {
  var cache = null; try { cache = CacheService.getScriptCache(); var hit = cache.get('faq_' + REV); if (hit) return JSON.parse(hit); } catch (e) { cache = null; }
  var it = helpFolder_().getFilesByName('help.md'), best = null;
  while (it.hasNext()) { var x = it.next(); if (!best || x.getLastUpdated() > best.getLastUpdated()) best = x; }
  var out = [];
  if (best) {
    var sec = 'Everyone', role = '*', cur = null;
    best.getBlob().getDataAsString('UTF-8').split(/\r?\n/).forEach(function (line) {
      var m2 = /^##\s+(.+?)\s*$/.exec(line), m3 = /^###\s+(.+?)\s*$/.exec(line);
      if (m3) { cur = { id: 'q' + out.length, section: sec, role: role, q: m3[1], a: '' }; out.push(cur); return; }
      if (m2 && !/^###/.test(line)) { sec = m2[1]; role = HELP_SECTIONS[sec.toLowerCase()] || '*'; cur = null; return; }
      if (cur) cur.a += line + '\n';
    });
    out.forEach(function (e) { e.a = e.a.replace(/^\s+|\s+$/g, ''); });
  }
  try { if (cache) cache.put('faq_' + REV, JSON.stringify(out), 600); } catch (e) {}
  return out;
}
/* FAB - Help leaves answers/<id>.json ({answer, by, status: "answered" | "to_stf"}); copy any new ones into the help tab. */
function helpPickup_(rows, limit) {
  var waiting = rows.filter(function (r) { return r.status === 'new'; }).slice(0, limit || 20); if (!waiting.length) return;
  var af = helpSub_('answers');
  waiting.forEach(function (r) {
    var it = af.getFilesByName(r.id + '.json'); if (!it.hasNext()) return;
    try {
      var a = JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
      var c = { answer: String(a.answer || '').slice(0, 8000), answeredBy: String(a.by || 'STF Help').slice(0, 80), answeredAt: new Date().toISOString(), status: a.status === 'to_stf' ? 'to_stf' : 'answered', seen: false };
      setCells_('help', r._row, c); for (var k in c) r[k] = c[k];
    } catch (e) {}
  });
}
function helpOut_(r) { return { id: r.id, at: String(r.at), name: r.name, role: ROLE_NAMES[r.role] || r.role, page: r.page, job: r.job, question: r.question, answer: r.answer, answeredBy: r.answeredBy, answeredAt: String(r.answeredAt || ''), status: r.status, seen: bool_(r.seen) }; }
/** help(token, action, args): faq | ask {question, page, job} | mine {seen} | list (owner) | answer (owner) {id, answer, addToFaq} */
function help(token, action, args) {
  var w = whoFromToken_(token); if (w.role === 'guest' || w.role === 'locked') throw new Error('permission_denied');
  args = args || {};
  if (action === 'faq') return faq_().filter(function (e) { return w.role === 'owner' || e.role === '*' || e.role === w.role; });
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var rows = rows_('help').map(function (r) { r.id = String(r.id); r.uid = String(r.uid); r.status = String(r.status || 'new'); return r; });
    if (action === 'ask') {
      var q = String(args.question || '').trim().slice(0, 4000); if (!q) throw new Error('invalid_argument');
      var hour = Date.now() - 3600000;
      if (rows.filter(function (r) { return r.uid === w.uid && Date.parse(r.at) > hour; }).length >= 10) throw new Error('too_many');
      var job = String(args.job || ''); if (job && !canSeeJob_(w, job)) job = '';
      var id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      appendObj_('help', { id: id, at: new Date().toISOString(), uid: w.uid, name: w.name, role: w.role, shop: w.shop || '', page: String(args.page || '').slice(0, 60), job: job, question: q, status: 'new', seen: false });
      sheet_('submissions').appendRow([new Date().toISOString(), 'help', job, 'Help question', w.name || '', ROLE_NAMES[w.role] || w.role,
        'Help id: ' + id + '\nAsked on: ' + String(args.page || '') + (w.shop ? '\nShop: ' + shopName_(w.shop) : '') + '\nQuestion: ' + q, 'help/' + id]);
      return { id: id };
    }
    if (action === 'mine') {
      var mine = rows.filter(function (r) { return r.uid === w.uid; }); helpPickup_(mine);
      if (args.seen) mine.forEach(function (r) { if (r.status !== 'new' && !bool_(r.seen)) { setCells_('help', r._row, { seen: true }); } });
      return mine.reverse().slice(0, 30).map(helpOut_);
    }
    if (w.role !== 'owner') throw new Error('permission_denied');
    if (action === 'list') { helpPickup_(rows, 40); return rows.reverse().slice(0, 100).map(helpOut_); }
    if (action === 'answer') {
      var r = rows.filter(function (x) { return x.id === String(args.id); })[0]; if (!r) throw new Error('not_found');
      var ans = String(args.answer || '').trim().slice(0, 8000); if (!ans) throw new Error('invalid_argument');
      setCells_('help', r._row, { answer: ans, answeredBy: 'Ski Town Fabricators', answeredAt: new Date().toISOString(), status: 'answered', seen: false, addToFaq: !!args.addToFaq });
      sheet_('submissions').appendRow([new Date().toISOString(), 'help', r.job || '', 'Help answer from STF' + (args.addToFaq ? ' (add to common questions)' : ''), w.name || '', 'Owner',
        'Help id: ' + r.id + '\nAsked by: ' + r.name + ' (' + (ROLE_NAMES[r.role] || r.role) + ')\nQuestion: ' + r.question + '\nAnswer: ' + ans, 'help/' + r.id]);
      return { ok: true };
    }
    throw new Error('invalid_argument');
  } finally { lock.releaseLock(); }
}
/** The menu's "Needs my attention" list and new help answers for this person. */
function nav_(who) {
  if (!who || who.role === 'guest' || who.role === 'locked') return { attention: [], helpNew: 0 };
  var map = readDocs_(), att = [];
  var signedSince = function (j) {
    var since = Date.parse(j.stageAt || '') || 0, pre = 'rv/' + j.code + '/p/' + who.uid + '/approvals/';
    for (var k in map) if (k.indexOf(pre) === 0) { var d = JSON.parse(map[k].json); if (!d._deleted && Number(d.at) >= since) return true; }
    return false;
  };
  var js = jobs_();
  js.forEach(function (j) {
    var a = reviewAudience_(who, j); if (!a) return;
    if ((a === 'shop' && j.review === 'shop') || (a === 'client' && j.review === 'client')) { if (!signedSince(j)) att.push({ kind: 'review', job: j.code, title: j.title || '', text: 'Review ready for your approval' }); }
    if (who.role === 'owner' && j.review === 'stf') att.push({ kind: 'stf', job: j.code, title: j.title || '', text: 'Changes asked for: your move' });
    if (who.role === 'owner' && j.review === 'done') att.push({ kind: 'ship', job: j.code, title: j.title || '', text: 'Approved: ready to ship' });
  });
  if (who.role === 'manager') {
    var n = 0; findLinks_({ role: 'crew', shop: who.shop }).forEach(function (c) { n += children_(map, 'requests/' + c.uid + '/items').filter(function (it) { return it.data.held; }).length; });
    if (n) att.push({ kind: 'crew', n: n, view: 'people', text: n + ' crew item' + (n > 1 ? 's' : '') + ' waiting on you' });
  }
  var hr = [];
  try { hr = rows_('help').map(function (r) { r.id = String(r.id); r.uid = String(r.uid); r.status = String(r.status || 'new'); return r; }); } catch (e) {}
  if (who.role === 'owner') {
    var nr = 0; for (var k in map) { var m = /^requests\/[^/]+\/items\/[^/]+$/.exec(k); if (m) { var d = JSON.parse(map[k].json); if (!d._deleted && !d.held && (d.status || 'New') === 'New') nr++; } }
    if (nr) att.push({ kind: 'requests', n: nr, text: nr + ' new change request' + (nr > 1 ? 's' : '') + ' or question' + (nr > 1 ? 's' : '') });
    var nh = hr.filter(function (r) { return r.status === 'to_stf'; }).length;
    if (nh) att.push({ kind: 'help', n: nh, view: 'help', text: nh + ' help question' + (nh > 1 ? 's' : '') + ' passed to you' });
  }
  var mine = hr.filter(function (r) { return r.uid === who.uid; });
  try { helpPickup_(mine, 10); } catch (e) {}
  return { attention: att, helpNew: mine.filter(function (r) { return (r.status === 'answered' || r.status === 'to_stf') && !bool_(r.seen); }).length };
}
