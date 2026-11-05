# Deploying

The monitor needs an always-on machine with a public HTTPS address, because Twilio
sends your keypad and text answers to it. A $5–6/month server (DigitalOcean,
Hetzner, Lightsail) plus a domain or subdomain works.

## Accounts to set up first

1. **Twilio:** buy a phone number with voice + SMS. Complete A2P 10DLC registration
   (required for US texting). Note the Account SID and Auth Token.
2. **Duffel:** sign up and create a **test** access token to start.
3. **Domain:** point an A record (e.g. `flights.yourdomain.com`) at the server's IP.

## On the server (Ubuntu)

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone <this repo> flightmon && cd flightmon
cp config.example.toml config.toml
cp .env.example .env
cp Caddyfile.example Caddyfile
cp travelers.example.toml travelers.toml
mkdir -p data
```

Edit:
- `.env`: Twilio keys, Duffel token, `PUBLIC_BASE_URL=https://flights.yourdomain.com`,
  both phone numbers
- `Caddyfile`: your domain
- `config.toml`: start with `dry_run = true`
- `travelers.toml`: only needed once booking is enabled

```bash
sudo docker compose up -d --build
curl https://flights.yourdomain.com/health
sudo docker compose logs -f flightmon
```

## Point Twilio at it

In the Twilio console, under your number → Messaging, set "A message comes in" to a
webhook: `https://flights.yourdomain.com/sms` (HTTP POST). Calls need no setting
there: each outbound call tells Twilio which URL to use.

## Going live

Edit `config.toml`, then `sudo docker compose restart flightmon`:

1. `dry_run = false`, `provider = "duffel"`, `booking_enabled = false`. Do a supervised
   first run with both of you around.
2. With a Duffel test token, set `booking_enabled = true`. Test bookings move no money.
3. Swap in a live Duffel token, fund the Duffel balance, and double-check `travelers.toml`.

Requests not signed by Twilio are rejected (HTTP 403) in live mode, so random visitors
can't trigger a booking.

## Backups

Everything lives in `data/flightmon.sqlite3`. Copy it off the server occasionally if
you care about the deal history.
