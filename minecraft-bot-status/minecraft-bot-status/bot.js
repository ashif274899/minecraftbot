const http = require('http')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')

const PORT = Number(process.env.PORT || 10000)
const HOST = process.env.MINECRAFT_HOST || 'sarifon-ki-minecraft.aternos.me'
const MC_PORT = Number(process.env.MINECRAFT_PORT || 42934)
const USERNAME = process.env.MINECRAFT_USERNAME || 'BotPlayer'
const VERSION = process.env.MINECRAFT_VERSION || '26.2'
const AUTH = process.env.MINECRAFT_AUTH || 'offline'
const MAX_LOGS = 200
const RECONNECT_MS = 5000

let bot = null
let reconnectTimer = null
let stopping = false
const clients = new Set()
const logs = []

const state = {
  status: 'starting', // starting | connecting | online | offline | error
  message: 'Starting bot...',
  since: new Date().toISOString(),
  lastConnected: null,
  lastDisconnected: null,
  lastError: null,
  username: USERNAME,
  server: `${HOST}:${MC_PORT}`,
  version: VERSION
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

function publicState() {
  return {
    ...state,
    botPresentInMinecraft: state.status === 'online',
    logs
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`
  for (const res of clients) {
    try { res.write(payload) } catch (_) { clients.delete(res) }
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectBot()
  }, RECONNECT_MS)
}

function connectBot() {
  if (stopping) return

  if (bot) {
    try { bot.removeAllListeners() } catch (_) {}
    try { bot.end() } catch (_) {}
    bot = null
  }

  setState('connecting', `Connecting to ${HOST}:${MC_PORT}...`)
  addLog('info', `Connecting to Minecraft server ${HOST}:${MC_PORT}`)

  try {
    bot = mineflayer.createBot({
      host: HOST,
      port: MC_PORT,
      username: USERNAME,
      version: VERSION,
      auth: AUTH
    })

    bot.once('spawn', () => {
      setState('online', 'Bot is inside Minecraft', {
        lastConnected: new Date().toISOString(),
        lastError: null
      })
      addLog('success', `Bot joined Minecraft as ${bot.username}`)
      try { bot.chat(`Hello! Main ${bot.username} hoon 😎`) } catch (_) {}
    })

    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      if (message === '!hello') {
        try { bot.chat(`Hello ${username}! 👋`) } catch (_) {}
        addLog('info', `Replied to ${username} with !hello`)
      }
    })

    bot.on('kicked', reason => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      setState('offline', 'Bot was kicked from Minecraft', {
        lastDisconnected: new Date().toISOString(),
        lastError: text
      })
      addLog('warn', 'Bot kicked from Minecraft', text)
    })

    bot.on('end', reason => {
      if (stopping) return
      const text = reason ? String(reason) : 'Connection ended'
      setState('offline', 'Minecraft connection ended', {
        lastDisconnected: new Date().toISOString(),
        lastError: text
      })
      addLog('warn', 'Minecraft connection ended', text)
      scheduleReconnect()
    })

    bot.on('error', error => {
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/health') {
    // Render health checks should verify that the web service is alive.
    // The Minecraft bot state is returned separately in the JSON payload.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: healthy, ...publicState() }))
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    return res.end(JSON.stringify(publicState()))
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
  connectBot()
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

function shutdown() {
  if (stopping) return
  stopping = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  try { if (bot) bot.end() } catch (_) {}
  for (const res of clients) {
    try { res.end() } catch (_) {}
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
