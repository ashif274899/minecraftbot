const http = require('http')
const fs = require('fs')
const path = require('path')
const net = require('net')
const mineflayer = require('mineflayer')

const PORT = Number(process.env.PORT || 10000)
const HOST = process.env.MINECRAFT_HOST || 'sarifon-ki-minecraft.aternos.me'
const MC_PORT = Number(process.env.MINECRAFT_PORT || 42934)
const USERNAME = process.env.MINECRAFT_USERNAME || 'BotPlayer'
const VERSION = process.env.MINECRAFT_VERSION || '26.2'
const AUTH = process.env.MINECRAFT_AUTH || 'offline'
const RESTART_KEY = process.env.RESTART_KEY || '' // optional: set karoge to restart/stop/start/schedule ke liye key maangega
const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'Asia/Kolkata' // schedule is timezone me chalega
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json')
const MAX_LOGS = 200
const RECONNECT_MS = 5000

let bot = null
let botId = 0
let connectWatchdog = null
let reconnectTimer = null
let restartTimer = null
let stopping = false
let manualStop = false // true = bot website/schedule se stop kiya gaya hai
let schedule = { enabled: false, slots: [] } // slots: [{ join: 'HH:MM', leave: 'HH:MM' }]
let lastDesired = null // schedule ne pichli baar kya chaha tha (true = bot online)
const clients = new Set()
const logs = []

const state = {
  status: 'starting', // starting | connecting | online | offline | error | stopped
  message: 'Starting bot...',
  since: new Date().toISOString(),
  lastConnected: null,
  lastDisconnected: null,
  lastError: null,
  username: USERNAME,
  server: `${HOST}:${MC_PORT}`,
  version: VERSION,
  players: 0,
  playerNames: [],
  maxPlayers: null
}

function addLog(level, message, details = null) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message: String(message),
    details: details ? String(details) : null
  }
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.shift()
  console.log(`[${entry.level.toUpperCase()}] ${entry.message}${entry.details ? ` | ${entry.details}` : ''}`)
  broadcast()
}

function setState(status, message, extra = {}) {
  state.status = status
  state.message = message
  state.since = new Date().toISOString()
  Object.assign(state, extra)
  broadcast()
}

// ---------- Schedule ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))

function cleanSlots(slots) {
  if (!Array.isArray(slots)) return []
  return slots
    .filter(s => s && TIME_RE.test(s.join) && TIME_RE.test(s.leave) && s.join !== s.leave)
    .slice(0, 12)
    .map(s => ({ join: s.join, leave: s.leave }))
}

function loadSchedule() {
  try {
    const s = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'))
    schedule = { enabled: !!s.enabled, slots: cleanSlots(s.slots) }
  } catch (_) {}
}

function saveSchedule() {
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2)) }
  catch (e) { addLog('warn', 'Schedule file save nahi hui', e.message) }
}

function nowParts() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date())
  const h = Number(parts.find(p => p.type === 'hour').value) % 24
  const m = Number(parts.find(p => p.type === 'minute').value)
  return { h, m, min: h * 60 + m, text: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
}

// Slot overnight bhi ho sakta hai (jaise 22:00 -> 02:00)
function inWindow(min) {
  return schedule.slots.some(s => {
    const j = toMin(s.join), l = toMin(s.leave)
    return j < l ? (min >= j && min < l) : (min >= j || min < l)
  })
}

function nextEvent() {
  if (!schedule.enabled || !schedule.slots.length) return null
  const now = nowParts().min
  let best = null
  for (const s of schedule.slots) {
    for (const [type, t] of [['join', s.join], ['leave', s.leave]]) {
      const inMin = ((toMin(t) - now + 1440) % 1440) || 1440
      if (!best || inMin < best.inMin) best = { type, time: t, inMin }
    }
  }
  return best
}

function evaluateSchedule(force = false) {
  if (stopping) return
  if (!schedule.enabled || !schedule.slots.length) { lastDesired = null; return }
  const desired = inWindow(nowParts().min)
  if (!force && desired === lastDesired) return
  lastDesired = desired
  if (desired && manualStop) {
    addLog('info', 'Schedule: join time ho gaya', 'Bot Minecraft me join kar raha hai')
    startBotManual()
  } else if (!desired && !manualStop) {
    addLog('info', 'Schedule: leave time ho gaya', 'Bot Minecraft se leave kar raha hai')
    stopBotManual('Bot left (schedule)')
  }
}

function publicState() {
  return {
    ...state,
    botPresentInMinecraft: state.status === 'online',
    schedule: { ...schedule, tz: SCHEDULE_TZ, now: nowParts().text, next: nextEvent() },
    logs
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`
  for (const res of clients) {
    try { res.write(payload) } catch (_) { clients.delete(res) }
  }
}

// Bot khud tab-list se players count karta hai (bot ko chhodkar)
function updatePlayers() {
  let names = []
  if (bot && state.status === 'online' && bot.players) {
    names = Object.keys(bot.players).filter(n => n !== bot.username)
  }
  const max = bot && bot.game ? (bot.game.maxPlayers || null) : null
  if (state.players === names.length && state.maxPlayers === max && state.playerNames.join() === names.join()) return
  state.players = names.length
  state.playerNames = names
  state.maxPlayers = max
  broadcast()
}
setInterval(updatePlayers, 5000)
setInterval(() => { evaluateSchedule(); broadcast() }, 20000) // schedule check + "next event" refresh

function scheduleReconnect() {
  if (stopping || manualStop || reconnectTimer || restartTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectBot()
  }, RECONNECT_MS)
}

function killBot() {
  botId++ // purane bot ke saare events ab ignore honge
  if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null }
  if (!bot) return
  const old = bot
  bot = null
  old.on('error', () => {}) // end() ke baad aane wale errors se crash na ho
  try { old.end() } catch (_) {}
}

// Sab kuch stop karke bot ko fresh start karta hai
function restartBot() {
  if (stopping || restartTimer) return false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  manualStop = false
  killBot()
  setState('starting', 'Restarting bot...', {
    lastConnected: null,
    lastDisconnected: new Date().toISOString(),
    lastError: null,
    players: 0,
    playerNames: [],
    maxPlayers: null
  })
  addLog('warn', 'Restart requested from website', 'Bot stopped, starting fresh in 6s')
  restartTimer = setTimeout(() => {
    restartTimer = null
    connectBot()
  }, 6000) // server ko purana session band karne ka time
  return true
}

// Bot ko poori tarah band karta hai (reconnect bhi nahi hoga)
function stopBotManual(reason = 'Bot stopped from website') {
  if (stopping || manualStop) return false
  manualStop = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  killBot()
  setState('stopped', reason, {
    lastDisconnected: new Date().toISOString(),
    lastConnected: null,
    lastError: null,
    players: 0,
    playerNames: [],
    maxPlayers: null
  })
  addLog('warn', reason, 'Bot Minecraft se disconnect ho gaya, start hone tak offline rahega')
  return true
}

// Stopped bot ko dobara online karta hai
function startBotManual() {
  if (stopping || !manualStop) return false
  manualStop = false
  addLog('info', 'Start requested', 'Bot dobara connect ho raha hai')
  connectBot()
  return true
}

// Pehle check karta hai ki server ka port is host se khul raha hai ya nahi
function probe(host, port, ms = 8000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port })
    let finished = false
    const done = r => { if (finished) return; finished = true; try { s.destroy() } catch (_) {}; resolve(r) }
    s.setTimeout(ms, () => done('timeout'))
    s.once('connect', () => done('open'))
    s.once('error', e => done(e.code || e.message))
  })
}

function connectBot() {
  if (stopping || manualStop) return

  killBot()
  const myId = botId
  const alive = () => myId === botId && !stopping && !manualStop

  setState('connecting', `Checking ${HOST}:${MC_PORT}...`)
  addLog('info', `Checking if server port is reachable: ${HOST}:${MC_PORT}`)

  probe(HOST, MC_PORT).then(result => {
    if (!alive()) return
    if (result !== 'open') {
      setState('offline', `Server unreachable (${result})`, {
        lastDisconnected: new Date().toISOString(),
        lastError: `Port check failed: ${result}`
      })
      addLog('warn', 'Server port not reachable from this host', `Result: ${result}. Retrying in ${RECONNECT_MS / 1000}s`)
      scheduleReconnect()
      return
    }
    addLog('success', 'Server port is reachable, joining now')
    startBot(alive)
  })
}

function startBot(alive) {
  setState('connecting', `Connecting to ${HOST}:${MC_PORT}...`)
  addLog('info', `Connecting to Minecraft server ${HOST}:${MC_PORT}`)

  try {
    const b = mineflayer.createBot({
      host: HOST,
      port: MC_PORT,
      username: USERNAME,
      version: VERSION,
      auth: AUTH
    })
    bot = b

    // Agar 45s me join nahi hua to hang maanke dobara try karo
    connectWatchdog = setTimeout(() => {
      connectWatchdog = null
      if (!alive() || state.status !== 'connecting') return
      addLog('warn', 'Connect timeout', 'No response in 45s, retrying')
      killBot()
      scheduleReconnect()
    }, 45000)

    b.once('spawn', () => {
      if (!alive()) return
      if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null }
      setState('online', 'Bot is inside Minecraft', {
        lastConnected: new Date().toISOString(),
        lastError: null
      })
      addLog('success', `Bot joined Minecraft as ${b.username}`)
      try { b.chat(`Hello! Main ${b.username} hoon 😎`) } catch (_) {}
      updatePlayers()
    })

    b.on('playerJoined', () => { if (alive()) updatePlayers() })
    b.on('playerLeft', () => { if (alive()) updatePlayers() })

    b.on('chat', (username, message) => {
      if (!alive() || username === b.username) return
      if (message === '!hello') {
        try { b.chat(`Hello ${username}! 👋`) } catch (_) {}
        addLog('info', `Replied to ${username} with !hello`)
      }
    })

    b.on('kicked', reason => {
      if (!alive()) return
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      setState('offline', 'Bot was kicked from Minecraft', {
        lastDisconnected: new Date().toISOString(),
        lastError: text
      })
      addLog('warn', 'Bot kicked from Minecraft', text)
    })

    b.on('end', reason => {
      if (!alive()) return
      if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null }
      const text = reason ? String(reason) : 'Connection ended'
      setState('offline', 'Minecraft connection ended', {
        lastDisconnected: new Date().toISOString(),
        lastError: text
      })
      addLog('warn', 'Minecraft connection ended', text)
      scheduleReconnect()
    })

    b.on('error', error => {
      if (!alive()) return
      const text = error && error.message ? error.message : String(error)
      setState('error', 'Minecraft bot error', { lastError: text })
      addLog('error', 'Mineflayer error', text)
      scheduleReconnect()
    })
  } catch (error) {
    const text = error && error.message ? error.message : String(error)
    setState('error', 'Could not create Minecraft bot', { lastError: text })
    addLog('error', 'Bot startup exception', text)
    scheduleReconnect()
  }
}

function readBody(req, limit = 10000) {
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
  const keyOk = () => !RESTART_KEY || url.searchParams.get('key') === RESTART_KEY

  if (url.pathname === '/health') {
    // Web service alive hai ya nahi (bot ki state JSON me alag se milti hai)
    res.writeHead(200, json)
    return res.end(JSON.stringify({ ok: true, ...publicState() }))
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    return res.end(JSON.stringify(publicState()))
  }

  if (['/api/restart', '/api/stop', '/api/start'].includes(url.pathname)) {
    if (req.method !== 'POST') { res.writeHead(405, json); return res.end('{"ok":false}') }
    if (!keyOk()) { res.writeHead(403, json); return res.end('{"ok":false,"error":"key"}') }
    const action = { '/api/restart': restartBot, '/api/stop': () => stopBotManual(), '/api/start': startBotManual }[url.pathname]
    const ok = action()
    res.writeHead(ok ? 200 : 409, json)
    return res.end(JSON.stringify({ ok }))
  }

  if (url.pathname === '/api/schedule') {
    if (req.method === 'GET') {
      res.writeHead(200, json)
      return res.end(JSON.stringify(publicState().schedule))
    }
    if (req.method !== 'POST') { res.writeHead(405, json); return res.end('{"ok":false}') }
    if (!keyOk()) { res.writeHead(403, json); return res.end('{"ok":false,"error":"key"}') }
    try {
      const body = JSON.parse(await readBody(req))
      const slots = cleanSlots(body.slots)
      if (Array.isArray(body.slots) && slots.length !== body.slots.length) {
        res.writeHead(400, json)
        return res.end('{"ok":false,"error":"invalid slots"}')
      }
      schedule = { enabled: !!body.enabled && slots.length > 0, slots }
      saveSchedule()
      lastDesired = null
      addLog('info', schedule.enabled ? 'Schedule saved (ON)' : 'Schedule saved (OFF)',
        schedule.slots.map(s => `${s.join} -> ${s.leave}`).join(', ') || 'No slots')
      evaluateSchedule(true) // abhi ke time ke hisaab se turant apply karo
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

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return fs.createReadStream(file).pipe(res)
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

server.listen(PORT, '0.0.0.0', () => {
  addLog('success', `Status website listening on 0.0.0.0:${PORT}`)
  loadSchedule()
  if (schedule.enabled) addLog('info', 'Schedule loaded', schedule.slots.map(s => `${s.join} -> ${s.leave}`).join(', '))
  evaluateSchedule(true) // agar abhi schedule ke bahar ho to bot start hi nahi hoga
  if (!manualStop) connectBot()
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.on('uncaughtException', err => {
  addLog('error', 'Uncaught exception', err && err.stack ? err.stack : err)
  killBot()
  scheduleReconnect()
})
process.on('unhandledRejection', err => {
  addLog('error', 'Unhandled rejection', err && err.message ? err.message : err)
})

function shutdown() {
  if (stopping) return
  stopping = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (restartTimer) clearTimeout(restartTimer)
  if (connectWatchdog) clearTimeout(connectWatchdog)
  try { if (bot) bot.end() } catch (_) {}
  for (const res of clients) {
    try { res.end() } catch (_) {}
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
