# Allovity

Allovity is an independent software engineering studio. Tagline: "Engineering what's next."

This repository is the production website: one Node application backed by Postgres.

Current version: 1.0.0 (foundation). See `docs/VERSIONS.md`.

## Where to look

| Need                                   | File                                     |
| -------------------------------------- | ---------------------------------------- |
| Deploy on any host                     | `docs/DEPLOYMENT.md`                     |
| Every environment variable             | `docs/ENVIRONMENT.md` and `.env.example` |
| How the code is organised and why      | `docs/ARCHITECTURE.md`                   |
| Replace the placeholder logo and icons | `brand/README.md`                        |
| Version history                        | `docs/VERSIONS.md`                       |

## Stack

Node 22, TypeScript (strict), Express 4, EJS views, Tailwind CSS 3.4, vanilla JavaScript on the client, PostgreSQL. No frontend framework and no client build step beyond CSS.

## Commands

These are for anyone with a terminal. Hosts that build from the Dockerfile run them for you.

| Command                                                     | What it does                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm install`                                               | Install dependencies                                                          |
| `npm run dev`                                               | Build assets and run the server with reload                                   |
| `npm run build`                                             | Compile TypeScript and build assets into `dist`                               |
| `npm start`                                                 | Run the compiled server                                                       |
| `npm test`                                                  | Run the automated tests (needs a Postgres server, see `docs/ARCHITECTURE.md`) |
| `npm run test:browser`                                      | Run the browser checks (needs Chrome or Chromium)                             |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Static checks                                                                 |

## Third-party material

- Space Grotesk, Inter and JetBrains Mono are used under the SIL Open Font License 1.1 and are self-hosted.
- Icons come from Lucide under the ISC licence.
