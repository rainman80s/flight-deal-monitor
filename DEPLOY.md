# Deploying to Cloudflare

## Accounts first

1. **Cloudflare:** a free account works for dry runs. Upgrade to Workers Paid ($5/mo)
   before going live with Duffel.
2. **Twilio:** buy a number with voice + SMS. Start A2P 10DLC registration (required for
   US texting; can take days). Note the Account SID and Auth Token.
3. **Duffel:** create a **test** access token (`duffel_test_...`).

## One-time setup

```bash
npm install --legacy-peer-deps
npx wrangler login
npx wrangler d1 create flightmon
```

Paste the `database_id` that prints into `wrangler.toml`, then:

```bash
npm run db:migrate
```

Set the secrets. Each command prompts for the value:

```bash
npx wrangler secret put ADMIN_TOKEN
```

```bash
npx wrangler secret put CONTACT_RAN_PHONE
```

```bash
npx wrangler secret put CONTACT_BROCK_PHONE
```

```bash
npm run deploy
```

The deploy prints your Worker's address, e.g. `https://flight-deal-monitor.<you>.workers.dev`.
To use your own domain instead, add a custom domain to the Worker in the Cloudflare
dashboard (Workers & Pages → the Worker → Settings → Domains & Routes).

Check it:

```bash
curl https://<your-worker-address>/health
```

```bash
npx wrangler tail
```

It's now in dry run: it searches fake fares every 30 minutes and logs alerts.

## Going live, in stages

**1. Real texts and calls, no buying.** Add the Twilio and Duffel secrets:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
```

```bash
npx wrangler secret put TWILIO_AUTH_TOKEN
```

```bash
npx wrangler secret put TWILIO_FROM_NUMBER
```

```bash
npx wrangler secret put PUBLIC_BASE_URL
```

```bash
npx wrangler secret put DUFFEL_ACCESS_TOKEN
```

`PUBLIC_BASE_URL` is the Worker's address, with no trailing slash.

In the Twilio console, set your number's "A message comes in" webhook to
`https://<your-worker-address>/sms` (HTTP POST). Calls need no console setting.

In `config.json`, set `"dry_run": false` and `"provider": "duffel"`, keep
`"booking_enabled": false`, then `npm run deploy`. Do the first run with both of you
around. To trigger a cycle immediately:

```bash
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<your-worker-address>/admin/run
```

**2. Test bookings.** Still on the Duffel *test* token, add passenger details as one JSON
secret. Names must match each person's ID exactly:

```bash
npx wrangler secret put TRAVELERS_JSON
```

Paste a value like this (one line is fine):

```json
{"RAN":{"title":"mr","given_name":"First","family_name":"Last","born_on":"1995-01-31","gender":"m","email":"you@example.com","phone_number":"+12065550111"},
 "BROCK":{"title":"mr","given_name":"First","family_name":"Last","born_on":"1995-01-31","gender":"m","email":"brock@example.com","phone_number":"+12065550122"}}
```

Set `"booking_enabled": true` and deploy. Test bookings move no money.

**3. Real bookings.** Replace `DUFFEL_ACCESS_TOKEN` with a live token and fund your
Duffel balance (bookings are paid from it).

## Safety notes

- In live mode, Twilio webhooks without a valid Twilio signature are rejected (403).
- `/admin/*` needs `Authorization: Bearer <ADMIN_TOKEN>`.
- To pause everything: set `"dry_run": true` and deploy, or comment out the cron in
  `wrangler.toml` and deploy.
