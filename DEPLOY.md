# Wheel Strategy — Deployment Guide

## Project Structure

```
wheel-strategy/
├── index.html          ← HTML entry point
├── package.json        ← Node dependencies
├── vite.config.js      ← Build config
├── render.yaml         ← Render deployment config
├── .gitignore
└── src/
    ├── main.jsx        ← React mount point
    └── App.jsx         ← Full application
```

---

## Step 1 — Test locally first

You need Node.js installed (v18+). Check with:
```bash
node --version
```

Install and run:
```bash
cd wheel-strategy
npm install
npm run dev
```

Open http://localhost:5173 — the app should load with the entry form.
Confirm the form works, data saves to localStorage, and all seven tabs render.

Build to verify the production bundle compiles cleanly:
```bash
npm run build
```
This creates a `dist/` folder. If no errors, you're ready to deploy.

---

## Step 2 — Push to GitHub

If this is replacing your existing options analyzer repo:

### Option A — Replace files in existing repo
```bash
# From inside your existing repo root
cp -r /path/to/wheel-strategy/* .
git add .
git commit -m "Replace Flask options analyzer with React wheel strategy app"
git push
```

### Option B — New repo
```bash
cd wheel-strategy
git init
git add .
git commit -m "Initial commit — wheel strategy app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/wheel-strategy.git
git push -u origin main
```

---

## Step 3 — Deploy on Render

### If replacing your existing Render service (options.jamescolletti.com):

1. Go to https://dashboard.render.com
2. Find your existing service (the Flask/Python one)
3. Click **Settings**
4. Change the following:

| Setting | Old value (Flask) | New value (React) |
|---|---|---|
| Environment | Python | **Static Site** |
| Build Command | `pip install -r requirements.txt` | `npm install && npm run build` |
| Start Command | `gunicorn app:app` (delete this) | *(not needed for static)* |
| Publish Directory | *(not set)* | `dist` |

5. Click **Save Changes**
6. Click **Manual Deploy → Deploy latest commit**

### If starting fresh on Render:

1. Go to https://dashboard.render.com → **New → Static Site**
2. Connect your GitHub repo
3. Configure:
   - **Name:** `wheel-strategy` (or keep `options-jc` for same URL)
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `dist`
4. Click **Create Static Site**

Render will build and deploy. Takes ~2 minutes.

---

## Step 4 — Custom domain (if keeping options.jamescolletti.com)

Your existing domain should carry over automatically if you're modifying the
existing service rather than creating a new one. If you created a new service:

1. In Render dashboard → your new service → **Settings → Custom Domains**
2. Add `options.jamescolletti.com`
3. Update your DNS CNAME to point to the new Render URL
4. Render handles SSL automatically

---

## Replacing vs. keeping the old Flask app

The old `app.py` (Polygon.io-powered Flask analyzer) is a completely separate
codebase. You have two choices:

**Replace it entirely** (same service, same URL):
- Change the existing Render service from Web Service (Python) to Static Site
- The URL stays the same, the old app is gone

**Keep both** (different URLs):
- Leave the Flask app running on its current Render service
- Deploy the React app as a new Static Site service on a different subdomain
  e.g. `wheel.jamescolletti.com`

---

## Storage note

The Claude.ai artifact version used `window.storage` (Claude-specific API).
The deployed version uses `localStorage` instead — this is standard browser
storage, works on all browsers, is private to each user's browser, and
persists across sessions. Data never leaves the user's device.

---

## Auto-deploys

Once connected, every `git push` to `main` triggers an automatic rebuild and
redeploy on Render. No manual steps needed for updates.
