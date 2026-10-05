# Minecraft Bot + Public Status Page

This version keeps the Mineflayer bot and a public status website in the same Render Web Service.

## What it does

- Connects to the Minecraft server with Mineflayer.
- Automatically reconnects after a kick, disconnect or error.
- Shows whether the bot is actually inside Minecraft.
- Public `/` page with live status and event/error logs.
- JSON status endpoint at `/api/status`.
- Render health endpoint at `/health`.
- Uses Render's `PORT` and binds to `0.0.0.0`.
- Minecraft connection settings can be changed with environment variables.

## Render deployment

Create a **Web Service** from this repository.

Build Command:

```text
npm ci
```

Start Command:

```text
npm start
```

The included `render.yaml` already defines the required Minecraft environment variables.

### Important: truly always online

Render's Free Web Services can spin down after 15 minutes without inbound traffic. That means a free service is **not guaranteed to keep the Minecraft bot online 24/7**. For a bot that must remain connected continuously, use a paid Render compute plan (or another always-on worker/VM).

The public status page itself is part of the same service, so its URL will be the Render `onrender.com` URL.
