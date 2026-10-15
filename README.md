# Kelia

A small, beautiful browser MMO-lite: a hand-shaped valley of about a square
kilometre, up to 10 players at once, built with Babylon.js (WebGPU with a
WebGL2 fallback).

| Part | Where it runs | Folder |
| --- | --- | --- |
| Game client and assets | Vercel | `client/` |
| Authoritative game server (20 Hz, WebSocket) | Render (free web service) | `server/` |
| Shared rules, data and world generation | both | `shared/` |
| Sign-in and saved characters | Firebase Auth + Firestore | — |

## Playing locally

```sh
npm ci
npm run dev        # server on :8787, client on http://localhost:5173
```

Without any Firebase settings the game runs in guest mode and the server saves
characters to `server/data/characters.json`.

## Deploying

### 1. Firebase

1. Create a project at <https://console.firebase.google.com>.
2. **Authentication → Sign-in method**: enable **Email/Password** and **Google**.
3. **Authentication → Settings → Authorized domains**: add your Vercel domain
   (for example `kelia.vercel.app`).
4. **Firestore Database**: create a database (production mode), then paste
   [`firestore.rules`](firestore.rules) into its **Rules** tab. Clients never
   read Firestore directly; only the server does.
5. **Project settings → General → Your apps**: add a Web app. Its config gives
   you the four `VITE_FIREBASE_*` values below.
6. **Project settings → Service accounts → Generate new private key**. This JSON
   file is the server's `FIREBASE_SERVICE_ACCOUNT`.

### 2. Render (game server)

Create a **Blueprint** from this repository; it reads [`render.yaml`](render.yaml).
Then set, under the `kelia-server` service's **Environment**:

| Variable | Value |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | The whole service-account JSON, pasted as one line |
| `ALLOWED_ORIGINS` | Your client origin(s), comma-separated, e.g. `https://kelia.vercel.app,*.vercel.app` |
| `ALLOW_GUESTS` | `true` to allow guest play (default), `false` to require sign-in |

The free service sleeps when idle; the client wakes it on the login screen and
shows its progress. Without `FIREBASE_SERVICE_ACCOUNT` the server falls back
to a local file, which Render wipes on every restart.

The server runs in **Frankfurt** (`region` in `render.yaml`), the closest
Render region to Portugal. Render can't move an existing service to another
region: to switch, copy the env vars above, delete the old service, create
the Blueprint again, then point `VITE_SERVER_URL` on Vercel at the new
service's URL and redeploy the client.

### 3. Vercel (client)

Import the repository. Either root directory works: left as the repo root,
[`vercel.json`](vercel.json) builds `client/` into `client/dist`; set to
`client`, [`client/vercel.json`](client/vercel.json) does the same. Set these
under **Settings → Environment Variables**, then redeploy:

| Variable | Value |
| --- | --- |
| `VITE_SERVER_URL` | `wss://<your-render-service>.onrender.com` (copy the URL from the Render dashboard; change it here whenever the server moves) |
| `VITE_FIREBASE_API_KEY` | From the Firebase web app config |
| `VITE_FIREBASE_AUTH_DOMAIN` | e.g. `<project-id>.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | Your Firebase project id |
| `VITE_FIREBASE_APP_ID` | From the Firebase web app config |

The same four also work without the `VITE_` prefix (`FIREBASE_API_KEY`, …), which avoids Vercel's "public prefix" warning. These values are public by design; only the server's `FIREBASE_SERVICE_ACCOUNT` is secret, and it never goes on Vercel.

Without the Firebase variables the login screen offers guest play only.

## Assets

Everything is either generated in code or CC0. `npm run assets` downloads and
optimizes the CC0 packs (KayKit by Kay Lousberg and others); the results are
committed under `client/public/assets`, with credits in
[`client/public/assets/LICENSES.txt`](client/public/assets/LICENSES.txt).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server and client with hot reload |
| `npm run build` | Production build of both |
| `npm run typecheck` | Type-check every workspace |
| `npm test` | Shared and server unit tests |
