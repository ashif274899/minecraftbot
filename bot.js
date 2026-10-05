const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
    host: 'sarifon-ki-minecraft.aternos.me',
    port: 42934,
    username: 'BotPlayer',
    version: '26.2',
    auth: 'offline'
})

bot.once('spawn', () => {
    console.log('Bot server mein join ho gaya!')
    bot.chat('Hello! Main BotPlayer hoon 😎')
})

bot.on('chat', (username, message) => {
    if (username === bot.username) return

    if (message === '!hello') {
        bot.chat(`Hello ${username}! 👋`)
    }
})

bot.on('kicked', reason => {
    console.log('Bot kicked:', reason)
})

bot.on('error', error => {
    console.log('Error:', error.message)
})