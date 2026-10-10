# Render e ApiRouter deploy korar guide (A to Z)

Ei guide e GitHub repo ke Render er sathe connect kore, free te ApiRouter ke
24 ghonta online rakhar shob step ache. Fele-asha jinis (build/start command,
env variable, keep-alive, UptimeRobot, problem solving) shob ekhane.

> Ei file e kono real API key ba token likho na. Shob secret shudhu Render er
> **Environment** page e rakhbe, kokhono GitHub e commit korbe na.

---

## 1. Ki ki lagbe

- Ekta **GitHub account** (ei repo te access ache)
- Ekta **Render account** (free): https://render.com
- Je provider gulo use korba tar **API key** (Groq, Gemini, OpenRouter etc.)
- (Optional) **UptimeRobot** free account, sleep thekate

Node version: `>=20` (Render default ei version dey, kichu korte hobe na).

---

## 2. GitHub ke Render er sathe connect kora

1. https://dashboard.render.com e jao.
2. **Get Started / Sign in with GitHub** click koro.
3. GitHub authorize page ashle **Authorize Render** click koro.
4. Repo access dite bolle **Only select repositories** → `ApiRouter` select
   koro → **Install**.

Repo **private** hole ei access dewa **must**, noyto Render clone korte parbe na.

Pore repo list e na dekhale: GitHub → Settings → Applications → Render →
**Configure** → Repository access e `ApiRouter` add koro.

---

## 3. Web Service banano

1. Render Dashboard → **New +** → **Web Service**.
2. **Build and deploy from a Git repository** → `ApiRouter` → **Connect**.
3. Ei setting gulo dao:

| Field | Value |
|---|---|
| Name | `apirouter` (ei nam theke URL banay) |
| Region | Singapore (Bangladesh theke fast) |
| Branch | `main` |
| Root Directory | (faka rakho) |
| Runtime | Node |
| Build Command | `npm install --include=dev && npm run ui:build` |
| Start Command | `npm start` |
| Instance Type | **Free** |

**Keno `--include=dev`?** UI build er `vite` ta `devDependencies` e ache. Eta
chara `ui:build` fail korbe ar Control Panel UI thakbe na.

4. **Environment Variables** section e ekhon-i dite paro (step 4 dekho), ba
   pore dite paro.
5. **Create Web Service** click koro.

Prothom build e 3-5 minute lage. Logs e eta dekhle bujhbe thik ache:

```
Build successful
ApiRouter listening on http://localhost:10000
Keep-alive enabled: https://<tomar-service>.onrender.com/health every 10 min
Your service is live
```

---

## 4. Environment Variables

Render Dashboard → tomar service → **Environment** → **Add Environment Variable**.

### Must dite hobe

| Key | Value | Keno |
|---|---|---|
| `APIROUTER_API_KEYS` | nijer banano lomba secret token | Gateway password. Eta na dile jaar-tar hate tomar URL cholbe |

Token banaite (terminal e):

```bash
echo "sk-router-$(openssl rand -hex 24)"
```

### Provider key (jegulo use korba)

Ek-er beshi key hole **comma** diye alada koro.

```
GROQ_API_KEYS=gsk_xxx,gsk_yyy
GEMINI_API_KEYS=AIza...
OPENROUTER_API_KEYS=sk-or-...
MISTRAL_API_KEYS=...
CEREBRAS_API_KEYS=...
```

Shob provider er list ar default model `.env.example` e ache. Model bodlate:

```
GROQ_MODELS=openai/gpt-oss-120b,qwen/qwen3.8-27b
```

Cloudflare use korle `CLOUDFLARE_API_KEYS` er sathe `CLOUDFLARE_ACCOUNT_IDS` o lagbe.

### Dio na

- `PORT`: Render nijei set kore dey (code ta `PORT` pore).
- `RENDER_EXTERNAL_URL`: Render auto dey, keep-alive eta use kore.

Variable save korle Render **auto redeploy** kore.

---

## 5. Tomar link gulo

Deploy hole Render service page er upore URL dekhabe, jemon
`https://apirouter-xxxx.onrender.com`.

| Ki | Kothay |
|---|---|
| Frontend UI (Control Panel) | `https://<tomar-service>.onrender.com/` |
| Base URL (client e dibe) | `https://<tomar-service>.onrender.com/v1` |
| API Key (client e dibe) | step 4 er `APIROUTER_API_KEYS` token |
| Health check | `https://<tomar-service>.onrender.com/health` |

UI khulle token chabe, same `APIROUTER_API_KEYS` token dao.

### Test

```bash
curl https://<tomar-service>.onrender.com/health

curl https://<tomar-service>.onrender.com/v1/models

curl https://<tomar-service>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer <TOMAR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<MODEL_NAME>","messages":[{"role":"user","content":"hi"}]}'
```

`<MODEL_NAME>` `/v1/models` er list theke nao.

Cursor, Cline, Open WebUI ba kono OpenAI-compatible app e shudhu **Base URL** ar
**API Key** boshao.

---

## 6. GitHub theke auto deploy

Default e **Auto-Deploy: On** thake. Mane `main` branch e `git push` korlei
Render nijei notun deploy kore.

```bash
git add .
git commit -m "your change"
git push origin main
```

Bondho korte: service → **Settings** → **Build & Deploy** → **Auto-Deploy** → `No`.
Tokhon manually: service page → **Manual Deploy** → **Deploy latest commit**.

---

## 7. Free plan e sleep thekano (24 ghonta online)

Render free service **15 minute inbound request na ashle sleep kore**, abar
request ashle ~30-50 second e jaage.

### Layer 1: Repo er built-in keep-alive (auto)

`src/keepalive.js` prottek **10 minute** e nijer public `/health` e request
pathay. Render e eta **auto chalu** hoy (`RENDER_EXTERNAL_URL` thekei).

| Env | Kaj |
|---|---|
| `KEEPALIVE_URL` | Onno host e public URL dite (Render e lagbe na) |
| `KEEPALIVE_INTERVAL_MS` | Interval (default `600000` = 10 min, minimum 60000) |
| `KEEPALIVE_URL=off` | Bondho korte |

Eta shudhu supplementary, Render er guarantee nei.

### Layer 2: UptimeRobot (recommended backup)

1. https://uptimerobot.com e free account.
2. **+ New monitor**.
3. Monitor Type: **HTTP(s)**
4. Friendly Name: `ApiRouter`
5. URL: `https://<tomar-service>.onrender.com/health`
6. Monitoring Interval: **5 minutes**
7. **Create Monitor**.

Service down hole email alert-o pabe.

`/health` open endpoint, eta API key ba upstream response expose kore na, tai
public monitor er jonno safe.

---

## 8. Free plan er limit gulo (jana dorkar)

- **Disk persistent na.** Control Panel theke Fallback Chain / Manual Selection
  save korle (`data/*.json`) **restart ba redeploy e hariye jete pare.**
  Solution: Render paid disk, ba Oracle Cloud Free VM, ba config ta env/repo te
  rakha (shudhu **private** repo te, kokhono key chhara).
- **750 ghonta/month** free instance hour. Ekta service 24/7 cholle month ta
  prai bhore jay, tai ekta-i free service rakho.
- Sleep theke uthte prothom request e 30-50s lagte pare.
- Bina request e shob in-memory state (cooldown, session) restart e reset hoy.

---

## 9. Problem solving

| Problem | Karon / Fix |
|---|---|
| Build fail: `vite: not found` | Build Command e `--include=dev` ache kina dekho |
| UI khule na, `Not found` | `npm run ui:build` hoy ni. Build command thik kore redeploy koro |
| Repo list e nai | GitHub → Settings → Applications → Render → repo access dao |
| `401 Unauthorized` | `Authorization: Bearer <token>` thik ache kina, `APIROUTER_API_KEYS` match kore kina |
| Kono model chole na | Provider key `*_API_KEYS` e boshano hoy ni, ba key thik na. Control Panel er Health page dekho |
| Service sleep kore | UptimeRobot add koro (step 7) |
| Deploy fail kintu ager kaj korto | Logs e error dekho: Dashboard → service → **Logs** |
| `Port scan timeout` | `PORT` env nijer hate dio na, Render er-ta e chalte dao |

Logs dekhte: Dashboard → tomar service → **Logs** tab.

---

## 10. Security checklist

- [ ] `APIROUTER_API_KEYS` set kora ache (public URL e khola gateway rakho na)
- [ ] Kono API key / GitHub token repo te commit hoy ni
- [ ] `.env` `.gitignore` e ache
- [ ] Kono token chat/screenshot e share hole **sathe sathe revoke** kore notun banao
  (GitHub → Settings → Developer settings → Personal access tokens)
- [ ] Provider key leak hole provider dashboard e giye regenerate koro

---

## 11. Shortcut

1. GitHub diye Render e login, `ApiRouter` repo connect
2. Web Service: Node, Singapore, `main`, **Free**
3. Build: `npm install --include=dev && npm run ui:build`
4. Start: `npm start`
5. Env: `APIROUTER_API_KEYS` + provider keys
6. Deploy hole `https://<service>.onrender.com/` (UI) ar `.../v1` (Base URL)
7. UptimeRobot e `/health` 5 min por por
