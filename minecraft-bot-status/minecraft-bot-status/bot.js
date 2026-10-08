// ================= PC BOT (tumhare computer par chalega) =================
// Run: node bot.js
// Ye bot Minecraft me khud join karta hai, aur apni state website ko push karta hai.
// Website ke buttons (restart/stop/start/schedule) yahan commands ban ke aate hain.
const fs = require('fs')
const path = require('path')
const net = require('net')
const mineflayer = require('mineflayer')

// ---------- Settings (env se ya yahan seedha likh do) ----------
const WEBSITE_URL = (process.env.WEBSITE_URL || 'https://minecraftbot-aslr.onrender.com').replace(/\/+$/, '')
const BOT_TOKEN = process.env.BOT_TOKEN || '895093849035857820970927'   // website ke BOT_TOKEN se same hona chahiye
const HOST = process.env.MINECRAFT_HOST || 'sarifon-ki-minecraft.aternos.me'
const MC_PORT = Number(process.env.MINECRAFT_PORT || 42934)
const USERNAME = process.env.MINECRAFT_USERNAME || 'BotPlayer'
const VERSION = process.env.MINECRAFT_VERSION || '26.2'
const AUTH = process.env.MINECRAFT_AUTH || 'offline'
const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'Asia/Kolkata'
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json')
const MAX_LOGS = 200

const RECONNECT_MIN_MS = 5000
const RECONNECT_MAX_MS = 60000
const KEEPALIVE_TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS || 120000)

const MOVE_EVERY_MIN_MS = 20000
const MOVE_EVERY_MAX_MS = 45000
const MOVE_HOLD_MIN_MS = 300
const MOVE_HOLD_MAX_MS = 700
const LOOK_EVERY_MS = 3000

if (typeof fetch !== 'function') { console.error('Node 18 ya naya version chahiye (node -v check karo)'); process.exit(1) }
if (WEBSITE_URL.includes('YOUR-SITE')) { console.error('WEBSITE_URL set karo (apni Render website ka link)'); process.exit(1) }

let bot = null
let botId = 0
let connectWatchdog = null
let reconnectTimer = null
let restartTimer = null
let reconnectAttempts = 0
let stopping = false
let manualStop = false
let schedule = { enabled: false, slots: [] }
let lastDesired = null
let stopActivity = null
const logs = []

const state = {
  status: 'starting',
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
  const entry = { time: new Date().toISOString(), level, message: String(message), details: details ? String(details) : null }
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
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
  const h = Number(parts.find(p => p.type === 'hour').value) % 24
  const m = Number(parts.find(p => p.type === 'minute').value)
  return { h, m, min: h * 60 + m, text: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
}

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

function applySchedule(body) {
  const slots = cleanSlots(body && body.slots)
  schedule = { enabled: !!(body && body.enabled) && slots.length > 0, slots }
  saveSchedule()
  lastDesired = null
  addLog('info', schedule.enabled ? 'Schedule saved (ON)' : 'Schedule saved (OFF)',
    schedule.slots.map(s => `${s.join} -> ${s.leave}`).join(', ') || 'No slots')
  evaluateSchedule(true)
}

function publicState() {
  return {
    ...state,
    botPresentInMinecraft: state.status === 'online',
    schedule: { ...schedule, tz: SCHEDULE_TZ, now: nowParts().text, next: nextEvent() },
    logs
  }
}

// ---------- Website ko state bhejna ----------
let pushTimer = null
let linkOk = null
function broadcast() {
  if (pushTimer) return
  pushTimer = setTimeout(() => { pushTimer = null; pushState() }, 300)
}

function setLink(ok, why = '') {
  if (ok === linkOk) return
  linkOk = ok
  console.log(ok ? '[LINK] Website se connection ban gaya' : `[LINK] Website tak nahi pahunch pa raha (${why}) - retry chalta rahega`)
}

async function pushState() {
  try {
    const r = await fetch(`${WEBSITE_URL}/api/bot/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-token': BOT_TOKEN },
      body: JSON.stringify(publicState()),
      signal: AbortSignal.timeout(10000)
    })
    if (r.status === 403) return setLink(false, 'BOT_TOKEN galat hai')
    setLink(r.ok, 'HTTP ' + r.status)
  } catch (e) {
    setLink(false, e.message)
  }
}

// Website ke buttons se aaye commands (har 2s me check)
async function pollCommands() {
  try {
    const r = await fetch(`${WEBSITE_URL}/api/bot/commands`, {
      headers: { 'x-bot-token': BOT_TOKEN },
      signal: AbortSignal.timeout(10000)
    })
    if (r.ok) {
      const j = await r.json()
      for (const c of j.commands || []) runCommand(c)
    }
  } catch (_) {}
  setTimeout(pollCommands, 2000)
}

function runCommand(c) {
  try {
    if (c.type === 'restart') restartBot()
    else if (c.type === 'stop') stopBotManual()
    else if (c.type === 'start') startBotManual()
    else if (c.type === 'schedule') applySchedule(c.data)
  } catch (e) {
    addLog('error', 'Command fail hua: ' + c.type, e.message)
  }
}

setInterval(pushState, 5000) // heartbeat: website ko pata rahe PC zinda hai

// ---------- Bot logic ----------
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
setInterval(() => { evaluateSchedule(); broadcast() }, 20000)

function scheduleReconnect() {
  if (stopping || manualStop || reconnectTimer || restartTimer) return
  const delay = Math.min(RECONNECT_MIN_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS)
  reconnectAttempts++
  addLog('info', `Reconnect ${Math.round(delay / 1000)}s me`, `Attempt #${reconnectAttempts}`)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBot() }, delay)
}

function killBot() {
  botId++
  if (stopActivity) { stopActivity(); stopActivity = null }
  if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null }
  if (!bot) return
  const old = bot
  bot = null
  old.on('error', () => {})
  try { old.end() } catch (_) {}
}

function restartBot() {
  if (stopping || restartTimer) return false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  manualStop = false
  reconnectAttempts = 0
  killBot()
  setState('starting', 'Restarting bot...', {
    lastConnected: null, lastDisconnected: new Date().toISOString(), lastError: null,
    players: 0, playerNames: [], maxPlayers: null
  })
  addLog('warn', 'Restart requested from website', 'Bot stopped, starting fresh in 6s')
  restartTimer = setTimeout(() => { restartTimer = null; connectBot() }, 6000)
  return true
}

function stopBotManual(reason = 'Bot stopped from website') {
  if (stopping || manualStop) return false
  manualStop = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
  killBot()
  setState('stopped', reason, {
    lastDisconnected: new Date().toISOString(), lastConnected: null, lastError: null,
    players: 0, playerNames: [], maxPlayers: null
  })
  addLog('warn', reason, 'Bot Minecraft se disconnect ho gaya, start hone tak offline rahega')
  return true
}

function startBotManual() {
  if (stopping || !manualStop) return false
  manualStop = false
  reconnectAttempts = 0
  addLog('info', 'Start requested', 'Bot dobara connect ho raha hai')
  connectBot()
  return true
}

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
      addLog('warn', 'Server port not reachable from this host', `Result: ${result}`)
      scheduleReconnect()
      return
    }
    addLog('success', 'Server port is reachable, joining now')
    startBot(alive)
  })
}

function startActivity(b, alive) {
  const DIRS = ['forward', 'back', 'left', 'right']
  const rand = (min, max) => min + Math.random() * (max - min)
  let moveTimer = null, holdTimer = null, lookTimer = null, stopped = false

  const clearControls = () => {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      try { b.setControlState(c, false) } catch (_) {}
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    if (moveTimer) clearTimeout(moveTimer)
    if (holdTimer) clearTimeout(holdTimer)
    if (lookTimer) clearInterval(lookTimer)
    clearControls()
  }
  const dead = () => stopped || !alive() || bot !== b || !b.entity

  lookTimer = setInterval(() => {
    if (dead()) return stop()
    try {
      const target = b.nearestEntity(e => e.type === 'player' && e.username !== b.username)
      if (target && b.entity.position.distanceTo(target.position) < 32) {
        b.lookAt(target.position.offset(0, 1.62, 0), false).catch(() => {})
      } else if (Math.random() < 0.3) {
        b.look(b.entity.yaw + (Math.random() - 0.5), (Math.random() - 0.5) * 0.4, false).catch(() => {})
      }
    } catch (_) {}
  }, LOOK_EVERY_MS)

  const smallMove = () => {
    if (dead()) return stop()
    try {
      const dir = DIRS[Math.floor(Math.random() * DIRS.length)]
      b.setControlState(dir, true)
      if (Math.random() < 0.25) b.setControlState('jump', true)
      holdTimer = setTimeout(() => { if (!dead()) clearControls() }, rand(MOVE_HOLD_MIN_MS, MOVE_HOLD_MAX_MS))
    } catch (_) {}
    moveTimer = setTimeout(smallMove, rand(MOVE_EVERY_MIN_MS, MOVE_EVERY_MAX_MS))
  }
  moveTimer = setTimeout(smallMove, rand(5000, 10000))

  stopActivity = stop
}

function startBot(alive) {
  setState('connecting', `Connecting to ${HOST}:${MC_PORT}...`)
  addLog('info', `Connecting to Minecraft server ${HOST}:${MC_PORT}`)

  try {
    const b = mineflayer.createBot({
      host: HOST, port: MC_PORT, username: USERNAME, version: VERSION, auth: AUTH,
      checkTimeoutInterval: KEEPALIVE_TIMEOUT_MS
    })
    bot = b

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
      reconnectAttempts = 0
      setState('online', 'Bot is inside Minecraft', { lastConnected: new Date().toISOString(), lastError: null })
      addLog('success', `Bot joined Minecraft as ${b.username}`)
      try { b.chat(`Hello! Main ${b.username} hoon 😎`) } catch (_) {}
      updatePlayers()
      startActivity(b, alive)
    })

    b.on('playerJoined', () => { if (alive()) updatePlayers() })
    b.on('playerLeft', () => { if (alive()) updatePlayers() })

    b.on('death', () => {
      if (!alive()) return
      addLog('warn', 'Bot mar gaya, respawn ho raha hai')
      setTimeout(() => { try { if (alive() && bot === b) b.respawn() } catch (_) {} }, 2000)
    })

    b.on('chat', (username, message) => {
      if (!alive() || username === b.username) return
      if (message === '!hello') {
        try { b.chat(`Hello ${username}! 👋`) } catch (_) {}
        addLog('info', `Replied to ${username} with !hello`)
      }
    })

    b.on('kicked', reason => {
      if (!alive()) return
      if (stopActivity) { stopActivity(); stopActivity = null }
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      setState('offline', 'Bot was kicked from Minecraft', { lastDisconnected: new Date().toISOString(), lastError: text })
      addLog('warn', 'Bot kicked from Minecraft', text)
    })

    b.on('end', reason => {
      if (!alive()) return
      if (stopActivity) { stopActivity(); stopActivity = null }
      if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null }
      const text = reason ? String(reason) : 'Connection ended'
      setState('offline', 'Minecraft connection ended', { lastDisconnected: new Date().toISOString(), lastError: text })
      addLog('warn', 'Minecraft connection ended', text)
      scheduleReconnect()
    })

    b.on('error', error => {
      if (!alive()) return
      const text = error && error.message ? error.message : String(error)
      if (state.status === 'online') {
        addLog('warn', 'Mineflayer error (bot online hi hai)', text)
        return
      }
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

// ---------- Start ----------
addLog('success', 'PC bot started', `Website: ${WEBSITE_URL}`)
loadSchedule()
if (schedule.enabled) addLog('info', 'Schedule loaded', schedule.slots.map(s => `${s.join} -> ${s.leave}`).join(', '))
evaluateSchedule(true)
if (!manualStop) connectBot()
pushState()
pollCommands()

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.on('uncaughtException', err => {
  addLog('error', 'Uncaught exception', err && err.stack ? err.stack : err)
  if (state.status !== 'online') { killBot(); scheduleReconnect() }
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
  if (stopActivity) { stopActivity(); stopActivity = null }
  try { if (bot) bot.end() } catch (_) {}
  setTimeout(() => process.exit(0), 500)
}
