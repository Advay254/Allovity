# Deployment guide

Written for a phone. Everything happens in the Render dashboard and on GitHub. Nothing needs a terminal.

## Before you start

You need a Render account connected to your GitHub account, and the Allovity repository on GitHub. Decide two values first:

1. **Site address.** Before you point a domain, use the address Render gives the service (it ends in `.onrender.com`). You can change it later.
2. **Admin path slug.** A long random value of at least 16 characters, using only letters, digits, underscore and hyphen. Use your password manager's generator with symbols turned off, length 24 or more. Save it in the password manager. Do not use the example from `.env.example`: the app refuses it.

## Deploy on Render

1. In the Render dashboard, tap **New**, then **Blueprint**.
2. Pick the Allovity repository. Render reads `render.yaml` and shows one web service (`allovity`) and one database (`allovity-db`).
3. Render asks for the values that are not stored in the repository:
   - `PUBLIC_SITE_URL`: your site address, for example `https://allovity.onrender.com` for now. Include `https://` and no trailing path.
   - `ADMIN_PATH_SLUG`: the slug you saved.
4. Tap **Apply**. Render creates the database, builds the Docker image and starts the service. The first build takes a few minutes.
5. The connection string (`DATABASE_URL`) and `TRUSTED_PROXY_HOPS=1` are filled in by the Blueprint. You do not need to enter them.

Nothing else is needed: the database schema creates itself when the app starts.

### Confirm it worked

Open the service, then **Logs**. A healthy first start shows these lines, in this order:

- `"msg":"Migration applied","migration":"0001_foundation.sql"` (on later starts: `"msg":"Database schema is up to date"`)
- `"msg":"Server listening"`

Then check in your phone browser:

- `https://YOUR-ADDRESS/healthz` shows `{"status":"ok"}`.
- `https://YOUR-ADDRESS/readyz` shows `{"status":"ready"}`. If it shows `{"status":"unavailable"}`, the app cannot reach the database: check the database is available and that `DATABASE_URL` is set.
- `https://YOUR-ADDRESS/` shows the home page.
- `https://YOUR-ADDRESS/admin` shows the 404 page. `https://YOUR-ADDRESS/YOUR-SLUG` shows the admin placeholder.

Startup stops with a message naming the variable if a required setting is missing or invalid. The message appears at the top of the logs. It never contains the value.

### Point your domain

1. In the service, open **Settings**, then **Custom Domains**, then add your domain.
2. Render shows the DNS records to create. Add exactly those at your domain registrar's DNS page (usually a CNAME for `www`, and an A or ALIAS record for the bare domain).
3. Wait for DNS to update. Render issues the HTTPS certificate automatically once it can verify the records.
4. Change `PUBLIC_SITE_URL` in **Environment** to your final address (for example `https://www.example.com`). Save. Render restarts the service.
5. Check `https://YOUR-DOMAIN/robots.txt`: the sitemap line should show your domain.

### Roll back

1. Open the service, then **Deploys** (or **Events**).
2. Find the last deploy that worked, open it and choose **Rollback**. If you do not see that option, use **Manual Deploy** with an earlier commit.
3. Rolling back changes the code only. It never reverses database changes. Migrations only add things, so an older version keeps working against a newer schema.

## Free plans and production

`render.yaml` uses free plans so a first deploy costs nothing. Free plans are not suitable for a real site:

- A free web service sleeps when idle, so the first visit after a quiet period is slow.
- A free database can expire and has limited backups. Check Render's current pricing page for the exact limits.

For production, change the plans in `render.yaml` (web to a paid plan such as `starter`, database to a paid plan such as `basic-256mb`) and commit. Then confirm that backups exist and that you have restored one into a separate database to prove it works. A backup that has never been restored is not a backup you can count on.

## Other hosts

The app is a standard Docker image with a health check, so it runs anywhere containers run. On any host set the variables in `docs/ENVIRONMENT.md` and keep these in mind:

- **Railway.** Create a project from the GitHub repository and add a Postgres service. Set the variables, with `DATABASE_URL` referencing the Postgres service. Health check path `/healthz`. Set `TRUSTED_PROXY_HOPS=1`.
- **Fly.io.** Needs the `flyctl` command line tool, so it is awkward from a phone. Use a Fly Postgres or an external one, set the variables as secrets, and set `TRUSTED_PROXY_HOPS=1`.
- **VPS.** Run the Docker image behind a reverse proxy such as Caddy or Nginx that terminates HTTPS. Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app. Back up the database yourself.
- **Hostinger.** Only a Hostinger VPS plan suits this app. Shared and website-builder plans cannot run a Node server with Postgres.

Whatever the host: the database must be reachable only from the app, `DATABASE_URL` must never be committed, and the health check should point at `/healthz`.
