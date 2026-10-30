// cIRCo.chat server — Cloudflare Worker + two Durable Objects.
// Hub  (one instance): room list, people counts, strikes, reports, bans.
// Room (one per room): WebSockets, last 24 hours of messages.
import { DurableObject } from "cloudflare:workers";
import { checkText } from "./words.js";

const RULES = {
  historyMs: 24 * 3600e3, maxHistory: 300, maxLen: 400, minGapMs: 600,
  strikesToBan: 3, strikeWindowMs: 3600e3,          // 3 rude messages within an hour
  reportsToBan: 3, reportWindowMs: 3600e3,          // 3 different people within an hour
  banLevelsMs: [3600e3, 24 * 3600e3, 7 * 24 * 3600e3], banMemoryMs: 30 * 24 * 3600e3,
  roomIdleMs: 24 * 3600e3, maxCustomRooms: 60,
  voiceMaxBytes: 700000, voiceMaxSec: 60, voiceGapMs: 4000
};
const SITE = "https://emillion-lab.github.io/CIRCO/";
const VOICE_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/x-m4a"];
// official rooms; false = behind the curtain
const OFFICIAL = { sofia: true, plovdiv: true, london: true, global: true, night: true, dating: false, confessions: false, random: true, music: true, tech: true };
const ORIGINS = ["https://emillion-lab.github.io", "https://circo.chat", "https://www.circo.chat"];
const NICK_RE = /^[A-Za-z][A-Za-z0-9_-]{1,15}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,19}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,48}$/;
const RESERVED_NICKS = ["circo", "admin", "administrator", "mod", "moderator", "op", "root", "system", "server", "nickserv", "chanserv"];
const RESERVED_ROOMS = ["admin", "api", "help", "circo", "mod", "moderators", "staff", "support", "official"];
const PALETTE = ["#F0483E", "#EE8A2A", "#E8B33C", "#3BB273", "#1BA9BF", "#2457C5", "#5A3FC9", "#C9466F", "#F2668B"];

const allowOrigin = o => (o && (ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))) ? o : null;
const json = (data, status = 200, origin = null) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}) }
});
const hashStr = s => { let h = 0x811c9dc5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const hubOf = env => env.HUB.get(env.HUB.idFromName("hub"));

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    const origin = allowOrigin(req.headers.get("origin"));
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin || "", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization", "access-control-max-age": "86400", vary: "origin" } });
    }
    const hub = hubOf(env);
    const ip = req.headers.get("cf-connecting-ip") || "127.0.0.1";
    try {
      if (path === "/" || path === "/health") return json({ ok: true, service: "circo", time: Date.now() }, 200, origin);
      if (path === "/api/rooms" && req.method === "GET") return json(await hub.listRooms(), 200, origin);
      if (path === "/api/rooms" && req.method === "POST") {
        if (!origin) return json({ error: "origin" }, 403);
        const body = await req.json().catch(() => ({}));
        const r = await hub.createRoom(String(body.name || ""), String(body.topic || ""), String(body.device || ""), ip);
        return json(r, r.error ? 400 : 200, origin);
      }
      const m = path.match(/^\/api\/room\/([a-z0-9-]{1,20})\/ws$/);
      if (m) {
        if (req.headers.get("upgrade") !== "websocket") return json({ error: "websocket_only" }, 426, origin);
        if (!origin) return new Response("origin not allowed", { status: 403 });
        const room = await hub.roomInfo(m[1]);
        if (!room || !room.open) return new Response("no such room", { status: 404 });
        const headers = new Headers(req.headers);
        headers.set("x-room", m[1]);
        headers.set("x-ip", ip);
        return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(new Request(req, { headers }));
      }
      const v = path.match(/^\/api\/room\/([a-z0-9-]{1,20})\/voice\/([a-f0-9]{16})$/);
      if (v && req.method === "GET") {
        const headers = new Headers({ "x-voice": v[2] });
        return env.ROOM.get(env.ROOM.idFromName(v[1])).fetch(new Request(req.url, { headers }));
      }
      const share = path.match(/^\/r\/([a-z0-9-]{1,20})\/?$/);
      if (share) return sharePage(share[1], await hub.roomInfo(share[1]));
      if (path.startsWith("/api/admin/")) {
        if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "unauthorized" }, 401);
        if (path === "/api/admin/bans") return json(await hub.adminBans());
        if (path === "/api/admin/unban" && req.method === "POST") { const b = await req.json().catch(() => ({})); return json(await hub.unban(String(b.key || ""))); }
      }
      return json({ error: "not_found" }, 404, origin);
    } catch (e) {
      return json({ error: "server", detail: String((e && e.message) || e) }, 500, origin);
    }
  }
};

/* share link: a small page whose preview card names the room, then it opens the room */
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function sharePage(id, room) {
  const target = room && room.open ? `${SITE}#${id}` : SITE;
  const title = room ? `#${id} · cIRCo.chat` : "cIRCo.chat";
  const desc = room && room.topic ? room.topic : "Всяка стая е различно шоу. Every room is a different show.";
  const html = `<!doctype html><html lang="bg"><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="website"><meta property="og:site_name" content="cIRCo.chat">
<meta property="og:title" content="${escHtml(title)}"><meta property="og:description" content="${escHtml(desc)}">
<meta property="og:url" content="${escHtml(target)}"><meta name="twitter:card" content="summary">
<meta name="description" content="${escHtml(desc)}"><meta name="theme-color" content="#120E1A">
<meta http-equiv="refresh" content="0;url=${escHtml(target)}"></head>
<body style="background:#120E1A;color:#F4E8CF;font-family:monospace;padding:24px"><a style="color:#FFD27A" href="${escHtml(target)}">${escHtml(title)}</a>
<script>location.replace(${JSON.stringify(target)})</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of [
      "CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, topic TEXT, color TEXT, created INTEGER, last_active INTEGER, creator TEXT, creator_ip TEXT)",
      "CREATE TABLE IF NOT EXISTS counts(id TEXT PRIMARY KEY, people INTEGER)",
      "CREATE TABLE IF NOT EXISTS bans(key TEXT PRIMARY KEY, until INTEGER, level INTEGER, reason TEXT, at INTEGER)",
      "CREATE TABLE IF NOT EXISTS strikes(key TEXT, at INTEGER)",
      "CREATE TABLE IF NOT EXISTS reports(target TEXT, reporter TEXT, at INTEGER, PRIMARY KEY(target, reporter))",
      "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)",
      "CREATE TABLE IF NOT EXISTS devices(key TEXT PRIMARY KEY, first INTEGER)"
    ]) this.sql.exec(q);
  }
  rows(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  count(q, ...a) { return this.sql.exec(q, ...a).one().n; }

  /* identity: the device id from the browser + a salted hash of the IP.
     A ban sits on the device. The IP part only stops devices first seen after the ban
     (someone clearing the browser to come back), so people sharing a mobile network's IP are not hit. */
  salt() {
    const r = this.rows("SELECT v FROM meta WHERE k='salt'")[0];
    if (r) return r.v;
    const s = crypto.randomUUID() + crypto.randomUUID();
    this.sql.exec("INSERT INTO meta(k,v) VALUES('salt',?)", s);
    return s;
  }
  async keys(ip, device) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.salt() + "|" + ip));
    const ipKey = "i:" + [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
    return DEVICE_RE.test(device) ? ["d:" + device, ipKey] : [ipKey];
  }
  activeBan(keys) {
    const now = Date.now();
    const dev = keys[0].startsWith("d:") ? keys[0] : null;
    const ipKey = keys.find(k => k.startsWith("i:"));
    if (dev) {
      const r = this.rows("SELECT until, reason FROM bans WHERE key=?", dev)[0];
      if (r && r.until > now) return { until: r.until, reason: r.reason };
    }
    const r = ipKey && this.rows("SELECT until, reason, at FROM bans WHERE key=?", ipKey)[0];
    if (r && r.until > now) {
      const first = dev ? this.rows("SELECT first FROM devices WHERE key=?", dev)[0]?.first : null;
      if (!dev || first == null || first >= r.at) return { until: r.until, reason: r.reason };
    }
    return null;
  }
  async gate(ip, device) {
    const keys = await this.keys(ip, device);
    const ban = this.activeBan(keys);
    if (keys[0].startsWith("d:")) this.sql.exec("INSERT INTO devices(key,first) VALUES(?,?) ON CONFLICT(key) DO NOTHING", keys[0], Date.now());
    return { keys, ban, strikes: this.strikeCount(keys) };
  }
  strikeCount(keys) { return this.count("SELECT COUNT(*) AS n FROM strikes WHERE key=? AND at>?", keys[0], Date.now() - RULES.strikeWindowMs); }
  banKeys(keys, reason) {
    const now = Date.now();
    let level = 0;
    for (const k of keys) {
      const r = this.rows("SELECT level, at FROM bans WHERE key=?", k)[0];
      if (r && now - r.at < RULES.banMemoryMs) level = Math.max(level, r.level + 1);
    }
    level = Math.min(level, RULES.banLevelsMs.length - 1);
    const until = now + RULES.banLevelsMs[level];
    for (const k of keys) {
      this.sql.exec("INSERT INTO bans(key,until,level,reason,at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET until=excluded.until, level=excluded.level, reason=excluded.reason, at=excluded.at", k, until, level, reason, now);
      this.sql.exec("DELETE FROM strikes WHERE key=?", k);
    }
    this.ensureAlarm();
    return { until, reason, level };
  }
  strike(keys, reason) {
    this.sql.exec("INSERT INTO strikes(key,at) VALUES(?,?)", keys[0], Date.now());
    const strikes = this.strikeCount(keys);
    this.ensureAlarm();
    return { strikes, ban: strikes >= RULES.strikesToBan ? this.banKeys(keys, reason) : null };
  }
  report(target, reporter) {
    // distinct reporters are counted by IP, so one person with three browsers is still one report
    if (target[0] === reporter[0]) return { self: true };
    const who = reporter.find(k => k.startsWith("i:")) || reporter[0], now = Date.now();
    this.sql.exec("INSERT INTO reports(target,reporter,at) VALUES(?,?,?) ON CONFLICT(target,reporter) DO UPDATE SET at=excluded.at", target[0], who, now);
    const reports = this.count("SELECT COUNT(*) AS n FROM reports WHERE target=? AND at>?", target[0], now - RULES.reportWindowMs);
    this.ensureAlarm();
    if (reports < RULES.reportsToBan) return { reports, ban: null };
    this.sql.exec("DELETE FROM reports WHERE target=?", target[0]);
    return { reports, ban: this.banKeys(target, "reports") };
  }

  /* rooms */
  listRooms() {
    const people = Object.fromEntries(this.rows("SELECT id, people FROM counts").map(r => [r.id, r.people]));
    const official = Object.entries(OFFICIAL).map(([id, open]) => ({ id, official: true, open, people: people[id] || 0 }));
    const custom = this.rows("SELECT id, topic, color FROM rooms ORDER BY created DESC").map(r => ({ id: r.id, official: false, open: true, topic: r.topic, color: r.color, people: people[r.id] || 0 }));
    return { rooms: [...official, ...custom], rules: { strikesToBan: RULES.strikesToBan, reportsToBan: RULES.reportsToBan, banLevelsMs: RULES.banLevelsMs } };
  }
  roomInfo(id) {
    if (id in OFFICIAL) return { id, official: true, open: OFFICIAL[id] };
    const r = this.rows("SELECT id, topic, color FROM rooms WHERE id=?", id)[0];
    return r ? { ...r, official: false, open: true } : null;
  }
  async createRoom(name, topic, device, ip) {
    name = name.trim().replace(/^#/, "").toLowerCase();
    topic = topic.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!ROOM_RE.test(name)) return { error: "bad_name" };
    if (RESERVED_ROOMS.includes(name) || this.roomInfo(name)) return { error: "taken" };
    if (checkText(name).level || checkText(name.replace(/-/g, " ")).level || checkText(topic).level) return { error: "rude" };
    const { keys, ban } = await this.gate(ip, device);
    if (ban) return { error: "banned", until: ban.until };
    if (!keys[0].startsWith("d:")) return { error: "device" };
    const now = Date.now();
    if (this.count("SELECT COUNT(*) AS n FROM rooms") >= RULES.maxCustomRooms) return { error: "full" };
    if (this.count("SELECT COUNT(*) AS n FROM rooms WHERE creator=? AND created>?", keys[0], now - 6 * 3600e3) >= 1) return { error: "too_many" };
    if (this.count("SELECT COUNT(*) AS n FROM rooms WHERE creator_ip=? AND created>?", keys[1], now - 24 * 3600e3) >= 3) return { error: "too_many" };
    const color = PALETTE[hashStr(name) % PALETTE.length];
    this.sql.exec("INSERT INTO rooms(id,topic,color,created,last_active,creator,creator_ip) VALUES(?,?,?,?,?,?,?)", name, topic, color, now, now, keys[0], keys[1]);
    this.ensureAlarm();
    return { room: { id: name, official: false, open: true, topic, color, people: 0 } };
  }
  setCount(id, n) { this.sql.exec("INSERT INTO counts(id,people) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET people=excluded.people", id, n); }
  touch(id) { this.sql.exec("UPDATE rooms SET last_active=? WHERE id=?", Date.now(), id); }

  /* housekeeping: quiet people's rooms close after 24 hours, old strikes and reports expire */
  async ensureAlarm() { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 3600e3); }
  async alarm() {
    const now = Date.now();
    const gone = this.rows("SELECT r.id FROM rooms r LEFT JOIN counts c ON c.id=r.id WHERE r.last_active<? AND COALESCE(c.people,0)=0", now - RULES.roomIdleMs).map(r => r.id);
    for (const id of gone) { this.sql.exec("DELETE FROM rooms WHERE id=?", id); this.sql.exec("DELETE FROM counts WHERE id=?", id); }
    this.sql.exec("DELETE FROM strikes WHERE at<?", now - RULES.strikeWindowMs);
    this.sql.exec("DELETE FROM reports WHERE at<?", now - RULES.reportWindowMs);
    this.sql.exec("DELETE FROM bans WHERE at<? AND until<?", now - RULES.banMemoryMs, now);
    this.sql.exec("DELETE FROM devices WHERE first<?", now - 90 * 24 * 3600e3);
    if (this.count("SELECT COUNT(*) AS n FROM rooms") + this.count("SELECT COUNT(*) AS n FROM bans") + this.count("SELECT COUNT(*) AS n FROM strikes")) await this.ctx.storage.setAlarm(now + 3600e3);
  }
  adminBans() { return this.rows("SELECT key, until, level, reason, at FROM bans ORDER BY at DESC LIMIT 200"); }
  unban(key) { this.sql.exec("UPDATE bans SET until=0 WHERE key=?", key); return { ok: true }; }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS msgs(id TEXT PRIMARY KEY, t INTEGER, nick TEXT, kind TEXT, text TEXT, rude INTEGER, author TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS voices(id TEXT PRIMARY KEY, t INTEGER, mime TEXT, data BLOB)");
    // keep-alive pings are answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  hub() { return hubOf(this.env); }
  roomId() { return this.sql.exec("SELECT v FROM meta WHERE k='id'").toArray()[0]?.v; }
  live(except) { return this.ctx.getWebSockets().filter(w => w !== except && w.readyState === 1 && w.deserializeAttachment()?.ok); }
  people(except) { return [...new Set(this.live(except).map(w => w.deserializeAttachment().nick))]; }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj, except) { const s = JSON.stringify(obj); for (const w of this.live(except)) { try { w.send(s); } catch {} } }
  async sync(except) {
    const id = this.roomId();
    this.broadcast({ type: "people", people: this.people(except) }, except);
    if (id) await this.hub().setCount(id, this.people(except).length);
  }
  prune() {
    this.sql.exec("DELETE FROM msgs WHERE t<?", Date.now() - RULES.historyMs);
    this.sql.exec("DELETE FROM msgs WHERE id NOT IN (SELECT id FROM msgs ORDER BY t DESC LIMIT ?)", RULES.maxHistory);
    this.sql.exec("DELETE FROM voices WHERE id NOT IN (SELECT id FROM msgs)");
  }

  async fetch(req) {
    const vid = req.headers.get("x-voice");
    if (vid) {
      const r = this.sql.exec("SELECT mime, data, t FROM voices WHERE id=?", vid).toArray()[0];
      if (!r || r.t < Date.now() - RULES.historyMs) return new Response("gone", { status: 404 });
      return new Response(r.data, { headers: { "content-type": r.mime, "cache-control": "public, max-age=86400, immutable", "access-control-allow-origin": "*" } });
    }
    const url = new URL(req.url);
    const id = req.headers.get("x-room"), ip = req.headers.get("x-ip") || "127.0.0.1";
    if (id) this.sql.exec("INSERT INTO meta(k,v) VALUES('id',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", id);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const done = () => new Response(null, { status: 101, webSocket: client });
    const refuse = (code, extra = {}) => { this.send(server, { type: "refused", code, ...extra }); server.close(4000, code); return done(); };
    const nick = url.searchParams.get("nick") || "", device = url.searchParams.get("device") || "";
    if (!NICK_RE.test(nick) || RESERVED_NICKS.includes(nick.toLowerCase())) return refuse("bad_nick");
    if (checkText(nick).level) return refuse("rude_nick");
    const { keys, ban, strikes } = await this.hub().gate(ip, device);
    if (ban) return refuse("banned", ban);
    if (this.people().some(n => n.toLowerCase() === nick.toLowerCase())) return refuse("nick_taken");
    server.serializeAttachment({ ok: true, nick, keys, last: 0 });
    this.prune();
    const history = this.sql.exec("SELECT id, t, nick, kind, text, rude FROM msgs ORDER BY t ASC").toArray().map(m => ({ ...m, rude: !!m.rude }));
    this.send(server, { type: "hello", room: id, nick, history, people: this.people(), strikes, rules: { strikesToBan: RULES.strikesToBan, reportsToBan: RULES.reportsToBan } });
    this.broadcast({ type: "join", nick }, server);
    await this.sync();
    return done();
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    if (!a || !a.ok || typeof raw !== "string") return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "msg") return this.onMsg(ws, a, m);
    if (m.type === "nick") return this.onNick(ws, a, m);
    if (m.type === "report") return this.onReport(ws, a, m);
    if (m.type === "voice") return this.onVoice(ws, a, m);
  }

  /* voice: base64 over the socket, kept 24 hours like text. Reports work on it like on any message. */
  async onVoice(ws, a, m) {
    const now = Date.now();
    if (now - (a.lastVoice || 0) < RULES.voiceGapMs || now - a.last < RULES.minGapMs) return this.send(ws, { type: "error", code: "slow" });
    const mime = String(m.mime || "").split(";")[0].trim().toLowerCase();
    const dur = Math.round(Number(m.dur));
    if (!VOICE_TYPES.includes(mime) || !(dur >= 1 && dur <= RULES.voiceMaxSec + 1) || typeof m.data !== "string") return this.send(ws, { type: "error", code: "voice_bad" });
    let bytes;
    try { const bin = atob(m.data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch { return this.send(ws, { type: "error", code: "voice_bad" }); }
    if (bytes.length < 200) return this.send(ws, { type: "error", code: "voice_bad" });
    if (bytes.length > RULES.voiceMaxBytes) return this.send(ws, { type: "error", code: "voice_big" });
    a.last = now; a.lastVoice = now;
    ws.serializeAttachment(a);
    const msg = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), t: now, nick: a.nick, kind: "voice", text: String(Math.min(dur, RULES.voiceMaxSec)), rude: false };
    this.sql.exec("INSERT INTO msgs(id,t,nick,kind,text,rude,author) VALUES(?,?,?,?,?,?,?)", msg.id, msg.t, msg.nick, msg.kind, msg.text, 0, JSON.stringify(a.keys));
    this.sql.exec("INSERT INTO voices(id,t,mime,data) VALUES(?,?,?,?)", msg.id, now, mime, bytes.buffer);
    this.broadcast({ type: "msg", msg });
    const id = this.roomId();
    if (id) await this.hub().touch(id);
  }

  async onMsg(ws, a, m) {
    const kind = m.kind === "act" ? "act" : "msg"; // "voice" only arrives through onVoice
    const text = String(m.text || "").trim().slice(0, RULES.maxLen);
    if (!text) return;
    const now = Date.now();
    if (now - a.last < RULES.minGapMs) return this.send(ws, { type: "error", code: "slow" });
    const check = checkText(text);
    const hub = this.hub();
    if (check.level >= 2) {
      const r = await hub.strike(a.keys, "slur");
      this.send(ws, { type: "blocked", words: check.words, strikes: r.strikes, limit: RULES.strikesToBan });
      if (r.ban) await this.expel(a.keys[0], a.nick, r.ban);
      return;
    }
    if (check.level === 1 && !m.confirmed) {
      return this.send(ws, { type: "confirm", kind, text, words: check.words, strikes: await hub.strikeCount(a.keys), limit: RULES.strikesToBan });
    }
    a.last = now;
    ws.serializeAttachment(a);
    const msg = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), t: now, nick: a.nick, kind, text, rude: check.level === 1 };
    this.sql.exec("INSERT INTO msgs(id,t,nick,kind,text,rude,author) VALUES(?,?,?,?,?,?,?)", msg.id, msg.t, msg.nick, msg.kind, msg.text, msg.rude ? 1 : 0, JSON.stringify(a.keys));
    this.broadcast({ type: "msg", msg });
    const id = this.roomId();
    if (id) await hub.touch(id);
    if (msg.rude) {
      const r = await hub.strike(a.keys, "language");
      this.send(ws, { type: "strike", strikes: r.strikes, limit: RULES.strikesToBan });
      if (r.ban) await this.expel(a.keys[0], a.nick, r.ban);
    }
  }

  async onNick(ws, a, m) {
    const nick = String(m.nick || "");
    if (!NICK_RE.test(nick) || RESERVED_NICKS.includes(nick.toLowerCase())) return this.send(ws, { type: "error", code: "bad_nick" });
    if (checkText(nick).level) return this.send(ws, { type: "error", code: "rude_nick" });
    if (this.people(ws).some(n => n.toLowerCase() === nick.toLowerCase())) return this.send(ws, { type: "error", code: "nick_taken", nick });
    const old = a.nick;
    a.nick = nick;
    ws.serializeAttachment(a);
    this.broadcast({ type: "nick", old, nick });
    await this.sync();
  }

  async onReport(ws, a, m) {
    const row = this.sql.exec("SELECT id, nick, author FROM msgs WHERE id=?", String(m.id || "")).toArray()[0];
    if (!row) return this.send(ws, { type: "error", code: "no_msg" });
    const target = JSON.parse(row.author);
    const r = await this.hub().report(target, a.keys);
    if (r.self) return this.send(ws, { type: "error", code: "self_report" });
    this.send(ws, { type: "reported", id: row.id, nick: row.nick });
    if (r.ban) await this.expel(target[0], row.nick, r.ban);
  }

  /* a ban: their messages leave the history, their sockets get the reason and close */
  async expel(devKey, nick, ban) {
    const ids = this.sql.exec("SELECT id, author FROM msgs").toArray().filter(r => { try { return JSON.parse(r.author)[0] === devKey; } catch { return false; } }).map(r => r.id);
    for (const id of ids) { this.sql.exec("DELETE FROM msgs WHERE id=?", id); this.sql.exec("DELETE FROM voices WHERE id=?", id); }
    for (const w of this.ctx.getWebSockets()) {
      const b = w.deserializeAttachment();
      if (!b || !b.ok || b.keys[0] !== devKey) continue;
      this.send(w, { type: "banned", until: ban.until, reason: ban.reason });
      b.ok = false;
      w.serializeAttachment(b);
      try { w.close(4003, "banned"); } catch {}
    }
    this.broadcast({ type: "expelled", nick, ids, reason: ban.reason });
    await this.sync();
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment();
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {}
    if (!a || !a.ok) return;
    this.broadcast({ type: "part", nick: a.nick }, ws);
    await this.sync(ws);
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011); }
}
