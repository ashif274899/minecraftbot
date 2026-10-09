// ================= WEBSITE SERVER (Render par chalega) =================
// Isme ab mineflayer / bot NAHI hai. Bot tumhare PC par chalta hai (bot.js)
// aur har 5s me apni state yahan push karta hai. Dashboard (public/index.html)
// bilkul pehle jaisa chalega.
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 10000)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ashif@2011' // admin panel password (Render me ADMIN_PASSWORD env se badal sakte ho)
const BOT_TOKEN = process.env.BOT_TOKEN || '895093849035857820970927'       // PC bot aur website ke beech secret token (zaroor set karo)
const PC_TIMEOUT_MS = 20000                         // itne time tak PC se push na aaye to "offline"

if (!BOT_TOKEN) console.warn('WARNING: BOT_TOKEN set nahi hai - koi bhi fake state push kar sakta hai!')

let remote = null        // PC bot ki latest state
let lastPush = 0
let wasOnline = false
const queue = []         // PC bot ke liye pending commands
const clients = new Set()

// ---------- Admin auth (server-side, password JS me kahin nahi hai) ----------
const sha = s => crypto.createHash('sha256').update(String(s)).digest()
const passOk = p => crypto.timingSafeEqual(sha(p), sha(ADMIN_PASSWORD))
const sessions = new Map()          // token -> expiry
const fails = new Map()             // ip -> { n, until }
const gfail = { n: 0, t: 0 }        // sabhi IPs ka total
const SESSION_MS = 8 * 3600 * 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cookieOf = req => (/(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1]
const authed = req => (sessions.get(cookieOf(req)) || 0) > Date.now()
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim()
setInterval(() => {
  const n = Date.now()
  for (const [k, v] of sessions) if (v < n) sessions.delete(k)
  for (const [k, v] of fails) if (v.until < n) fails.delete(k)
}, 60000)

const pcOnline = () => remote && Date.now() - lastPush < PC_TIMEOUT_MS

function publicState() {
  const base = remote || {
    status: 'offline', message: '', since: new Date().toISOString(),
    lastConnected: null, lastDisconnected: null, lastError: null,
    username: 'Bot', server: '—', version: null,
    players: 0, playerNames: [], maxPlayers: null,
    schedule: { enabled: false, slots: [], tz: 'Asia/Kolkata', now: '—', next: null },
    logs: []
  }
  if (pcOnline()) return { ...base, pcOnline: true }
  return {
    ...base,
    status: 'offline',
    message: 'PC wala bot connect nahi hai (PC ya bot.js band hai)',
    lastError: 'PC bot se koi signal nahi mil raha',
    players: 0, playerNames: [], maxPlayers: null,
    botPresentInMinecraft: false,
    pcOnline: false,
    schedule: { ...base.schedule, next: null }
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`
  for (const res of clients) {
    try { res.write(payload) } catch (_) { clients.delete(res) }
  }
}

// PC online/offline badalte hi dashboard ko turant update karo
setInterval(() => {
  const on = !!pcOnline()
  if (on !== wasOnline) { wasOnline = on; broadcast() }
}, 3000)
// SSE connection zinda rakhne ke liye
setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n') } catch (_) { clients.delete(res) } }
}, 25000)

// ---------- schedule validation ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
function cleanSlots(slots) {
  if (!Array.isArray(slots)) return []
  return slots
    .filter(s => s && TIME_RE.test(s.join) && TIME_RE.test(s.leave) && s.join !== s.leave)
    .slice(0, 12)
    .map(s => ({ join: s.join, leave: s.leave }))
}

function readBody(req, limit = 600000) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > limit) { reject(new Error('too big')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const json = { 'Content-Type': 'application/json; charset=utf-8' }
  const keyOk = () => authed(req)
  const botOk = () => !BOT_TOKEN || req.headers['x-bot-token'] === BOT_TOKEN

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://mc-heads.net; media-src 'self' https://www.image2url.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  // CSRF: browser se aaya POST sirf isi site se allowed
  if (req.method === 'POST' && req.headers.origin) {
    let okOrigin = false
    try { okOrigin = new URL(req.headers.origin).host === req.headers.host } catch (_) {}
    if (!okOrigin) { res.writeHead(403, json); return res.end('{"ok":false,"error":"origin"}') }
  }

  if (url.pathname === '/api/admin/session') {
    res.writeHead(200, { ...json, 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ ok: authed(req) }))
  }
  if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
    sessions.delete(cookieOf(req))
    res.writeHead(200, { ...json, 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' })
    return res.end('{"ok":true}')
  }
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = ipOf(), now = Date.now(), rec = fails.get(ip) || { n: 0, until: 0 }
    if (now - gfail.t > 900000) { gfail.n = 0; gfail.t = now }
    if (rec.until > now || gfail.n >= 40) {
      res.writeHead(429, json)
      return res.end(JSON.stringify({ ok: false, error: 'locked', wait: Math.ceil(Math.max(rec.until - now, 60000) / 1000) }))
    }
    let pw = ''
    try { pw = String(JSON.parse(await readBody(req, 2000)).password || '') } catch (_) {}
    if (pw && passOk(pw)) {
      fails.delete(ip)
      const tok = crypto.randomBytes(32).toString('hex')
      sessions.set(tok, Date.now() + SESSION_MS)
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
      res.writeHead(200, { ...json, 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` })
      return res.end('{"ok":true}')
    }
    rec.n++; gfail.n++
    if (rec.n >= 5) { rec.until = Date.now() + 15 * 60000; rec.n = 0 } // 5 galat = 15 min lock
    fails.set(ip, rec)
    await sleep(800) // brute-force slow
    res.writeHead(401, json)
    return res.end('{"ok":false,"error":"wrong"}')
  }

  if (url.pathname === '/health') {
    res.writeHead(200, json)
    return res.end(JSON.stringify({ ok: true, pcOnline: !!pcOnline() }))
  }

  // ----- PC bot -> website: state push -----
  if (url.pathname === '/api/bot/push') {
    if (req.method !== 'POST') { res.writeHead(405, json); return res.end('{"ok":false}') }
    if (!botOk()) { res.writeHead(403, json); return res.end('{"ok":false,"error":"token"}') }
    try {
      const body = JSON.parse(await readBody(req))
      if (!body || typeof body !== 'object' || !body.status) throw new Error('bad')
      remote = body
      lastPush = Date.now()
      wasOnline = true
      broadcast()
      res.writeHead(200, json)
      return res.end('{"ok":true}')
    } catch (_) {
      res.writeHead(400, json)
      return res.end('{"ok":false,"error":"bad request"}')
    }
  }

  // ----- PC bot -> website: pending commands uthao -----
  if (url.pathname === '/api/bot/commands') {
    if (!botOk()) { res.writeHead(403, json); return res.end('{"ok":false,"error":"token"}') }
    const commands = queue.splice(0, queue.length)
    res.writeHead(200, { ...json, 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ ok: true, commands }))
  }

  // ----- Dashboard -----
  if (url.pathname === '/api/status') {
    res.writeHead(200, { ...json, 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(publicState()))
  }

  if (['/api/restart', '/api/stop', '/api/start'].includes(url.pathname)) {
    if (req.method !== 'POST') { res.writeHead(405, json); return res.end('{"ok":false}') }
    if (!keyOk()) { res.writeHead(403, json); return res.end('{"ok":false,"error":"key"}') }
    if (!pcOnline()) { res.writeHead(409, json); return res.end('{"ok":false,"error":"pc offline"}') }
    queue.push({ type: url.pathname.slice('/api/'.length) })
    res.writeHead(200, json)
    return res.end('{"ok":true}')
  }

  if (url.pathname === '/api/schedule') {
    if (req.method === 'GET') {
      res.writeHead(200, json)
      return res.end(JSON.stringify(publicState().schedule))
    }
    if (req.method !== 'POST') { res.writeHead(405, json); return res.end('{"ok":false}') }
    if (!keyOk()) { res.writeHead(403, json); return res.end('{"ok":false,"error":"key"}') }
    if (!pcOnline()) { res.writeHead(409, json); return res.end('{"ok":false,"error":"pc offline"}') }
    try {
      const body = JSON.parse(await readBody(req, 10000))
      const slots = cleanSlots(body.slots)
      if (Array.isArray(body.slots) && slots.length !== body.slots.length) {
        res.writeHead(400, json)
        return res.end('{"ok":false,"error":"invalid slots"}')
      }
      const enabled = !!body.enabled && slots.length > 0
      queue.push({ type: 'schedule', data: { enabled, slots } })
      remote.schedule = { ...remote.schedule, enabled, slots } // turant dikhane ke liye; PC baad me confirm karega
      broadcast()
      res.writeHead(200, json)
      return res.end(JSON.stringify({ ok: true, schedule: publicState().schedule }))
    } catch (_) {
      res.writeHead(400, json)
      return res.end('{"ok":false,"error":"bad request"}')
    }
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(`data: ${JSON.stringify(publicState())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (['/', '/index.html', '/admin', '/admin.html'].includes(url.pathname)) {
    const file = path.join(__dirname, 'public', url.pathname.startsWith('/admin') ? 'admin.html' : 'index.html')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    return fs.createReadStream(file).pipe(res)
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

server.listen(PORT, '0.0.0.0', () => console.log(`Website listening on 0.0.0.0:${PORT}`))

process.on('SIGTERM', () => { for (const r of clients) { try { r.end() } catch (_) {} } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref() })
process.on('uncaughtException', e => console.error('Uncaught', e))
process.on('unhandledRejection', e => console.error('Unhandled', e))
