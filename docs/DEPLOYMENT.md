# Deployment guide

This guide is for whoever deploys the site. It does not assume a particular host. The app is a standard Node service that ships with a Dockerfile, needs a PostgreSQL database, and is configured only through environment variables.

## What any host must provide

| Requirement           | Detail                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A way to run the app  | Either the included `Dockerfile` (`docker build .`), or Node 22 or newer with `npm install`, `npm run build` and `npm start`. |
| PostgreSQL            | Any reasonably current version. The app creates its own tables on startup. No manual SQL is needed.                           |
| HTTPS                 | Terminate TLS at the host, load balancer or reverse proxy. The app sends strict transport security in production.             |
| Environment variables | The three required ones plus any optional ones. See `docs/ENVIRONMENT.md`.                                                    |
| A health check        | Point it at `/healthz` (process is alive). `/readyz` also checks the database.                                                |

## Settings you must choose

- **`PUBLIC_SITE_URL`**: the public address, for example `https://www.example.com`. It is used for canonical links, the social image and the sitemap. If you do not have a domain yet, use the address your host assigns and change it later.
- **`ADMIN_PATH_SLUG`**: a secret path segment for the admin entrance, 4 to 20 characters using letters, digits, underscore and hyphen. Longer and random is better: 12 or more characters is recommended and shorter values log a warning. Generate it with a password manager or any random generator. The app refuses values that still look like the example placeholder.
- **`DATABASE_URL`**: the connection string of your PostgreSQL database.
- **`TRUSTED_PROXY_HOPS`**: how many proxies sit between the internet and the app. Most platforms put exactly one in front (use `1`). Leave it at `0` only if visitors reach the app directly. A wrong value either lets visitors spoof their IP address or makes everyone look like one visitor to the rate limiter.
- **`NODE_ENV=production`**.
- **`ADMIN_SECRET_KEY`**: needed for the admin area. Generate a random value of at least 43 characters. On Render the blueprint generates it for you. Elsewhere, use your password manager's generator set to 64 characters with letters and digits. Do not change it once admin users have set up two-step verification.
- **`ADMIN_INITIAL_EMAIL` and `ADMIN_INITIAL_PASSWORD`**: create the first owner on first start. See "First admin sign-in" below.

## First admin sign-in

1. Set the two initial variables and deploy. The logs say the first owner was created.
2. Open `https://your-site/<ADMIN_PATH_SLUG>` and sign in with that email and password.
3. Choose a new password when asked, then set up two-step verification. Scan the QR code with an authenticator app (the app on your phone works; if you are on the same phone, use the manual key shown under the code). Save the ten recovery codes somewhere safe.
4. Go back to your host and **delete `ADMIN_INITIAL_PASSWORD`**. It is only used while no admin users exist, but it should not sit in your settings.

## If you lose access (emergency recovery)

Anyone who can edit your host's environment settings already controls the site, so recovery is done there, with no extra account to protect.

1. Set `ADMIN_INITIAL_EMAIL` to the owner's email and `ADMIN_INITIAL_PASSWORD` to a new passphrase.
2. Set `ADMIN_EMERGENCY_RESET` to `true` and restart. The logs print a loud notice. The owner's password is replaced, two-step verification is cleared, all their sessions end and they must choose a new password. No other account is touched.
3. Sign in, change the password, set up two-step verification again.
4. **Set `ADMIN_EMERGENCY_RESET` back to `false` and delete `ADMIN_INITIAL_PASSWORD`.** While it stays on, every restart repeats the reset.

If the encryption secret is lost or changed, people with two-step verification can no longer pass it. Use the emergency recovery above for the owner (it clears two-step), then the owner can reset others from the Users page.

## Generic deployment steps

1. Create a PostgreSQL database and note its connection string.
2. Create the service from this repository (container image or Node build) and set the environment variables above. Keep them in the host's secret or environment settings, never in the repository.
3. Set the health check path to `/healthz`.
4. Deploy. On first start the app applies its database migrations automatically.
5. Attach your domain and HTTPS certificate through your host, then set `PUBLIC_SITE_URL` to the final address and restart.

## Confirm it worked

In the service logs a healthy start shows, in this order:

- `"msg":"Migration applied"` for `0001_foundation.sql` and `0002_admin_auth.sql` (on later starts: `"msg":"Database schema is up to date"`)
- `"msg":"Server listening"`

Then request these paths on your address:

- `/healthz` returns `{"status":"ok"}`.
- `/readyz` returns `{"status":"ready"}`. `{"status":"unavailable"}` means the app cannot reach the database: check `DATABASE_URL` and database availability.
- `/` shows the home page.
- `/admin` shows the 404 page, and `/YOUR-SLUG/login` shows the admin sign-in page (or "Admin is not configured" if `ADMIN_SECRET_KEY` is missing or malformed).
- `/robots.txt` shows a sitemap line with your address.

If a required variable is missing or invalid, startup stops and the first log line names the variable. It never prints the value.

## Rolling back

Redeploy the previous image or commit using your host's mechanism. Rolling back changes code only and never reverses database changes. Migrations only add things, so an older version keeps working against a newer schema. Never edit a migration file after it has been applied anywhere: the app refuses to start if it detects that. Add a new numbered file instead.

## Production checklist

- The database is reachable only from the app, and its credentials are not committed anywhere.
- Backups are enabled, and you have restored one into a separate database at least once.
- `NODE_ENV=production`, `TRUSTED_PROXY_HOPS` matches your setup, and `PUBLIC_SITE_URL` uses `https`.
- Free or hobby tiers often sleep when idle or limit databases. Use a plan that fits a live site.
- Logs are kept somewhere you can read them. The app writes one JSON line per event to standard output.

## Platform notes

These are starting points. Platform interfaces change, so check each platform's own documentation.

- **Render.** `deploy/render.yaml` is an example Blueprint for one web service and one database. Render reads `render.yaml` from the repository root by default, so copy it there (or set the Blueprint file path) before choosing New, then Blueprint. It prompts for `PUBLIC_SITE_URL`, `ADMIN_PATH_SLUG`, `ADMIN_INITIAL_EMAIL` and `ADMIN_INITIAL_PASSWORD`, generates `ADMIN_SECRET_KEY` for you, wires `DATABASE_URL` from the database and sets `TRUSTED_PROXY_HOPS=1`. The plans in the file are free ones. Change them for production.
- **Railway.** Create a project from the repository, add a PostgreSQL service and reference its connection string in `DATABASE_URL`. Set `TRUSTED_PROXY_HOPS=1` and the health check path.
- **Fly.io.** Use the Dockerfile with `fly launch`, attach a Postgres database and set the variables as secrets. `TRUSTED_PROXY_HOPS=1`.
- **Any VPS or bare server.** Run the Docker image (or Node directly) behind a reverse proxy such as Caddy or Nginx that terminates HTTPS. Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app and take care of database backups yourself.
- **Shared hosting and website builders.** These generally cannot run a long-lived Node server with PostgreSQL and are not suitable.
