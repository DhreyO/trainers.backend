# Trainers Store: Learning Notes and Build Guide

My study guide for this project, built to practise the AWS Solutions Architect Associate (SAA) and to present in interviews.

- **Part 1: Concepts.** How each part works, what broke and why (Lessons 1–10).
- **Part 2: Step-by-step build guide.** Everything done from the beginning, in order, with the exact configuration (Phases 0–11).
- **Part 3: Reference.** Daily start/stop routine, configuration cheat sheet, interview Q&A, quiz.

> Secrets (passwords, admin key, account ID) are never written in these notes. Placeholders look like `<RDS-ENDPOINT>`.

---

## Session log

| Date | What we achieved |
|---|---|
| 1–2 Oct 2026 | Fixed "can't retrieve trainers" (CORS), got the React frontend building, connected it to EC2, moved the backend from hard-coded data to **RDS**, checkout working end to end |
| 8 Oct 2026 | Cost analysis (RDS ran 24/7), **Nginx** reverse proxy, port 3000 closed, admin key + rate limiting, frontend prepared for CloudFront |
| 2 Nov 2026 | Fixed pm2 auto-start and dependency vulnerabilities, production build, **S3 + CloudFront (OAC)** live over HTTPS, **EC2 locked to CloudFront only** |
| _Next session_ | Parameter Store + IAM role, Session Manager (remove SSH), Budgets, nightly stop, scripts, merge PR |

---

# Part 1: Concepts

## Lesson 1: The big picture (3-tier architecture behind a CDN)

```
                       HTTPS
  Browser ───────────► CloudFront (one domain: https://<id>.cloudfront.net)
                         │
                         ├── Default (*) ──────────────► S3 site bucket (private, OAC)
                         │                                 index.html + assets/ (React build)
                         │
                         └── /products* /orders* /health ─► EC2 (HTTP :80, CloudFront-only)
                                                             Nginx :80
                                                              └► Node/Express 127.0.0.1:3000 (pm2)
                                                                   │ MySQL :3306 (private)
                                                                   ▼
                                                             RDS MySQL trainers-db1
                                                               products, orders

  <img src> ─────────────────────────────────────────────► S3 images bucket (dhrey-store-v3)
```

**Why three tiers?** Each layer has one job and can be secured, scaled and paid for separately:

| Tier | Job | Who may reach it |
|---|---|---|
| Presentation | What users see (React files in S3) | Everyone, **via CloudFront only** |
| Application | Business rules (prices, stock, checkout) | **Only CloudFront** (security group prefix list) |
| Data | Stores the truth | **Only** the application tier (security group reference) |

**Key idea:** the browser never talks to the database. It can't (RDS doesn't speak HTTP), and it mustn't (anything in the browser is public, including passwords). The backend is the gatekeeper.

### Trace one click: "Browse trainers"
1. The browser opens `https://<id>.cloudfront.net`. CloudFront matches **Default (\*)** and serves `index.html` and `assets/` from the **private S3 site bucket** (allowed by OAC).
2. React runs `fetch("/products")`, a **relative** path, so the request goes to the same CloudFront domain.
3. CloudFront matches the behaviour **`/products*`** and forwards it to the origin **`ec2-api`** over HTTP :80, with caching disabled.
4. The **EC2 security group** allows port 80 only from CloudFront's prefix list, so it passes.
5. **Nginx** forwards it to `127.0.0.1:3000`.
6. **Express** runs `SELECT * FROM products` through the connection pool.
7. The **RDS security group** allows 3306 only from the EC2 security group, so it passes.
8. The rows come back as JSON along the same path.
9. React renders the cards. Each `<img src>` is a **separate request straight to the S3 images bucket**.

> If you can trace this in an interview, you understand the system.

---

## Lesson 2: CORS, the first bug

**Symptom:** `curl` returned trainers, but the browser said "Load failed".

**Why:** browsers enforce the **Same-Origin Policy**. An *origin* is scheme + host + port. `http://localhost:5173` (frontend) and `http://<EC2-IP>:3000` (API) are different origins, so the browser blocks JavaScript from reading the response **unless the server explicitly allows it** with:
```
Access-Control-Allow-Origin: *        (or the exact frontend URL)
```
`curl` isn't a browser and ignores CORS, which is why it "worked".

**Fix:** `app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }))`.

**Takeaways:**
- CORS protects **users**, not your server. Anyone can still call your API with curl. It is **not** an access control.
- `POST` with JSON triggers a **preflight** (`OPTIONS`) request first. That's why the CloudFront API behaviours must allow **OPTIONS**.
- **Now that CloudFront serves the site and the API from one domain, everything is the same origin and CORS no longer applies in production.** It's still needed for `npm run dev` on `localhost:5173`.

---

## Lesson 3: The frontend (React + Vite)

### How a React app starts
```
index.html  ──loads──►  src/main.tsx  ──renders──►  <App/> into <div id="root">
```
- `index.html` contains an empty `<div id="root">`.
- `main.tsx` calls `createRoot(document.getElementById('root'))`, finds that div, and renders `App`.
- `App.tsx` is the UI: it holds state (products, cart) and calls the API.

**Bugs we hit and what they teach:**

| Bug | Cause | Lesson |
|---|---|---|
| `Expected ')' but found EOF` | Start-up code pasted into `App.tsx` and cut off | Each file has one job: `main.tsx` starts the app, `App.tsx` is the UI |
| Blank white page | `<div id="app">` vs `getElementById('root')` | The ids must match exactly; React silently had nowhere to render |
| `Cannot use JSX unless '--jsx'` | Project created from Vite's **plain TS** template, not the React one | TypeScript needs `"jsx": "react-jsx"`, and Vite needs `@vitejs/plugin-react` |
| `npm run dev` works, `npm run build` fails | `build` runs `tsc` (strict type check); `dev` doesn't | Dev servers are forgiving; production builds are strict |
| `Missing script: "dev"` | Command run in the wrong folder | npm scripts live in the `package.json` of the folder you're in |
| `Expression expected` at `|| ??` | Both operators left on one line | Replace the whole line, don't merge old and new |
| Unused `ProductsPage.tsx` with a hard-coded IP | Leftover from an earlier attempt | Delete dead code; it still gets compiled and type-checked |

### dev vs build
- `npm run dev`: a live development server with hot reload, files compiled on the fly. Only for your laptop.
- `npm run build`: produces `dist/` with plain `index.html`, JS and CSS. This is what you **deploy**: static files that S3 can host without any server.

### Environment variables in the frontend: important
- Vite only exposes variables starting with `VITE_`.
- They are **baked into the JavaScript at build time**, so **anyone can read them** in the browser. **Never** put secrets in frontend `.env` files.
- `.env.development` is used by `npm run dev` and holds `VITE_API_URL=http://<EC2-IP>` (only for local testing).
- `.env.production` is used by `npm run build` and holds `VITE_API_URL=` (empty, so relative paths go through CloudFront).

### `||` vs `??`
```ts
import.meta.env.VITE_API_URL || 'http://localhost:3000'  // '' is falsy → falls back to localhost ❌
import.meta.env.VITE_API_URL ?? ''                       // only null/undefined fall back → '' kept ✅
```
In production we *want* an empty string, so calls become relative (`/products`). This only works with `??`.

### Why hard-coded IPs are a smell
Each stop/start changes the EC2 IP, so code containing it breaks. **Configuration belongs in config** (env files), not in code. Best of all, use relative paths behind one stable domain (CloudFront), which is what the project does now.

---

## Lesson 4: The backend (Node + Express)

### Endpoints (the API contract)
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Is the app up **and** can it reach the DB? (used by load balancers and monitoring) |
| GET | `/products` | List trainers |
| GET | `/products/:id` | One trainer |
| POST | `/products` | Add a trainer (**admin key required**) |
| POST | `/orders` | Checkout |

### Connection pool
`mysql.createPool({...connectionLimit: 10})` keeps up to 10 DB connections open and reuses them. Opening a new connection per request is slow and can exhaust RDS's connection limit.

### Parameterised queries: protection against SQL injection
```js
db.query('SELECT * FROM products WHERE id = ?', [id])   // ✅ value sent separately
db.query(`SELECT * FROM products WHERE id = ${id}`)     // ❌ attacker can inject SQL
```

### Transactions and row locks: why checkout is correct
Two people buy the last Yeezy at the same moment. Without care, both read `stock = 1`, both succeed, and stock goes to −1.
```
BEGIN TRANSACTION
  SELECT … FOR UPDATE      ← locks the row; the second buyer waits
  check stock ≥ qty
  UPDATE stock = stock - qty
  INSERT order
COMMIT                     ← all or nothing; on any error → ROLLBACK
```
This is **ACID** (Atomicity, Consistency, Isolation, Durability) in practice. It's a strong interview point, because most toy projects get this wrong.

### Seeding safely
`CREATE TABLE IF NOT EXISTS` and "seed only if empty" mean the code adapted to **your** existing RDS data (8 trainers in `trainers-db1`) without overwriting it. Only the `orders` table was new.

### Configuration (12-factor style)
Settings come from environment variables (`.env` + dotenv), not code. The same code runs on a laptop and on EC2; only the config differs. `.env` is in `.gitignore`, so secrets never reach GitHub. The DB password can come from **Parameter Store** instead (`DB_PASSWORD_PARAM`), so it isn't stored on disk at all (Phase 10).

### pm2 (process manager)
Keeps Node running after you log out and restarts it if it crashes. Two bugs we hit:
1. **Three processes** (`server`, `server`, `trainers`) fighting over port 3000. The old ones won, so the new CORS code never ran. **Only one process can listen on a port.**
2. **502 Bad Gateway after an EC2 restart:** pm2 had no saved process list and no boot service, so nothing started. Fix: `pm2 save` + `pm2 startup` (**and run the `sudo env PATH=…` line it prints**).

---

## Lesson 5: Networking and security (defence in depth)

### Security groups = stateful virtual firewalls
- **Inbound rules** control what can reach the resource. **Stateful** means replies to allowed requests are automatically allowed out.
- **Referencing another SG** as a source (RDS allows 3306 *from the EC2 SG*) is better than IPs: it keeps working when IPs change, and only instances in that SG get in.
- **Managed prefix lists** are AWS-maintained IP ranges. `com.amazonaws.global.cloudfront.origin-facing` contains CloudFront's origin-facing servers, so EC2 port 80 accepts **only CloudFront**.

### What's exposed now
| Port | Where | Open to | Why |
|---|---|---|---|
| 443 | CloudFront | Internet | The only public entry, over HTTPS |
| 80 | EC2 | **CloudFront prefix list only** | Direct `http://<EC2-IP>` times out |
| 3000 | EC2 | **Nobody** (no SG rule **and** Node bound to 127.0.0.1) | Two independent layers |
| 22 | EC2 | My IP only | Admin access (next session: Session Manager, then remove) |
| 3306 | RDS | EC2 SG only, Public access = No | DB never on the internet |

### `0.0.0.0` vs `127.0.0.1`
- `0.0.0.0`: listen on **all** network interfaces, so reachable from outside if the firewall allows.
- `127.0.0.1`: listen on **loopback only**, so only programs on the same machine (Nginx) can connect.

With `HOST=127.0.0.1`, even if someone re-opens 3000 in the SG by mistake, Node still isn't reachable. That is **defence in depth**: no single mistake exposes you.

### Reverse proxy (Nginx)
Sits in front of the app on port 80 and forwards requests to `127.0.0.1:3000`. The app isn't directly exposed, it's the standard place for HTTPS, compression and limits, and it passes the real visitor IP (`X-Forwarded-For`, used by the rate limiter via `trust proxy`).

### Application-level protections
- **Admin key** on `POST /products`: before this, *anyone* could add trainers to your DB.
- **Rate limiting:** 300 requests per 15 minutes per IP, which slows abuse and scraping.
- **Body size limit** (100 KB): stops giant payloads.
- `x-powered-by` disabled: don't advertise your tech stack.
- **Dependencies patched** (`npm audit fix`). One was **critical**: `proxy-addr` IP spoofing, which mattered because we trust the proxy's `X-Forwarded-For`.

### Still open (next session)
- DB password in `.env` on disk. Move it to **SSM Parameter Store**, read via an **IAM role**.
- SSH port 22 open to my IP. Replace with **Session Manager** and delete the rule.
- The images bucket `dhrey-store-v3` is public (optional: serve it via CloudFront + OAC too).

---

## Lesson 6: Cost thinking (FinOps)

### How we found the real cost driver
Cost Explorer: RDS was $16.80 in August with ~764 usage units. August has 744 hours, so **it ran 24/7**, at ~$0.019/hr (micro pricing).
**Conclusion:** the instance was already right-sized; the waste was **idle hours**. Measure first, then change the right thing.

| Month | RDS cost | Story |
|---|---|---|
| Jul | $11.52 | Running most of the month |
| Aug | $16.80 | Running 24/7 |
| Sep | $5.13 | Started stopping it |

### Rules worth remembering
- **Compute bills per hour running; storage bills per GB-month, even when stopped.**
- A **stopped RDS instance restarts automatically after 7 days.** This is a classic surprise bill. Fix it with an EventBridge Scheduler nightly stop, or snapshot and delete.
- **Public IPv4 addresses are billed** (~$0.005/hr each). An auto-assigned IP is released when EC2 stops, so it's free while stopped. An **Elastic IP is billed while the instance is stopped**. For a stop/start workflow, skipping the EIP is correct.
- **Snapshot + delete + restore with the same identifier** keeps the same endpoint at almost zero idle cost.
- CloudFront's free tier covers a demo like this; Parameter Store standard parameters are free.
- **AWS Budgets** alerts are the safety net.

### Trade-off you made consciously
No Elastic IP means the EC2 address changes on every start. Instead of paying to avoid that, the design removes the dependency: the frontend uses relative paths, CloudFront is the stable domain, and only one setting (the `ec2-api` origin domain) changes. `scripts/aws-start.sh` updates it automatically. **Design around constraints instead of paying them away.**

---

## Lesson 7: How we debugged (the method matters more than the fixes)

Go **hop by hop** from the user towards the database, and test each hop on its own:

| Hop | Test | What we learned |
|---|---|---|
| Page renders? | Blank page → browser **Console** | `id="app"` vs `root` |
| Browser → API? | DevTools **Network** tab | Wrong URL / CORS / unreachable |
| CloudFront → EC2? | `https://<id>.cloudfront.net/health` | 502/504 = wrong origin domain, protocol or SG |
| Laptop → EC2? | `curl http://<IP>/health` from Mac | Security group / IP changed (now *expected* to time out) |
| Nginx → Node? | `curl localhost/health` on EC2 | 502 = Node not running |
| Node running? | `pm2 status`, `pm2 logs` | Duplicate processes; not started on boot |
| Node → RDS? | `/health` returns `db: ok` | SG / credentials / DB name / RDS still starting |

**Rule:** change one thing, re-test, move one hop. Never guess across several layers at once.

---

## Lesson 8: Mapping to the SAA exam domains

| SAA domain | What you did |
|---|---|
| **Design Secure Architectures** | Private S3 + **OAC**, EC2 restricted to the **CloudFront prefix list**, SG referencing for RDS, private RDS, localhost bind + reverse proxy, secrets out of git, patched dependencies (next: IAM role + Parameter Store, Session Manager) |
| **Design Resilient Architectures** | Health check endpoint, pm2 auto-restart and boot start, DB transactions, stateless app tier (could sit behind ALB/ASG) |
| **Design High-Performing Architectures** | **CloudFront CDN** (edge caching for static files, caching disabled for live API), images direct from S3, connection pooling |
| **Design Cost-Optimized Architectures** | Cost Explorer analysis, right-size check, stop/start, 7-day restart awareness, IPv4/EIP trade-off, snapshot/restore, free-tier CloudFront, Budgets |

---

## Lesson 9: CloudFront, OAC and behaviours

### What CloudFront is doing here
A **CDN**: a global network of edge servers in front of your origins. For this project it provides:
1. **One domain** for site and API, so no CORS and no EC2 IP anywhere in the frontend.
2. **HTTPS** with a free default certificate (`*.cloudfront.net`).
3. **Caching** of static files at the edge (fast and cheap), with caching **off** for the API.
4. **A single front door**, where WAF, geo-blocking and logging can be added later.

### Origins and behaviours
- **Origin** = where CloudFront fetches from. We have two: the S3 site bucket and `ec2-api` (EC2's public DNS name, HTTP only, port 80).
- **Behaviour** = a rule that maps a **path pattern** to an origin plus settings. CloudFront checks them **top to bottom (precedence)**; **Default (\*)** is the catch-all, created with the distribution and never created twice.

| Precedence | Path | Origin | Cache policy | Origin request policy | Methods |
|---|---|---|---|---|---|
| 0 | `/products*` | ec2-api | CachingDisabled | AllViewerExceptHostHeader | all 7 |
| 1 | `/orders*` | ec2-api | CachingDisabled | AllViewerExceptHostHeader | all 7 |
| 2 | `/health` | ec2-api | CachingDisabled | AllViewerExceptHostHeader | GET, HEAD |
| 3 | Default (*) | S3 site bucket | CachingOptimized | (none) | GET, HEAD |

- **CachingDisabled:** stock and checkout must always be live, never a cached copy.
- **AllViewerExceptHostHeader:** forwards headers, query strings and the request body, but sends EC2's own hostname as `Host` (which is what the origin expects).
- **All 7 methods** on API paths: checkout is a **POST**, and the browser's CORS preflight is **OPTIONS**.

### OAC: is the site public?
**The website is public, the bucket is not.** The files have to reach every visitor's browser; that's what a website is. But:

| | Public bucket | Private bucket + OAC (ours) |
|---|---|---|
| Who reads files | Anyone, directly | **Only our distribution** |
| `https://<bucket>.s3…/index.html` | Works | **AccessDenied** |
| List or overwrite files | Possible if misconfigured | No (policy allows only `s3:GetObject`) |
| HTTPS, WAF, logging | No | Yes, via CloudFront |

The bucket policy allows the service principal `cloudfront.amazonaws.com` with the condition `AWS:SourceArn = <our distribution ARN>`. No other distribution, and no other account, can use it. The console wizard added it automatically.

### Default root object
Visiting `/` asks S3 for an empty key, which returns **AccessDenied** even with a correct policy. Setting **Default root object = `index.html`** fixes it.

### The cost of no Elastic IP
The `ec2-api` origin points at EC2's **public DNS**, which changes on every stop/start. After each start: update the origin domain (by hand, or `./scripts/aws-start.sh`).

---

## Lesson 10: Operations lessons (small things that cost time)

| Problem | Cause | Lesson |
|---|---|---|
| `502 Bad Gateway` after starting EC2 | Node wasn't running; pm2 not set to start on boot | `pm2 save` + `pm2 startup` + run the printed `sudo` line. Test with a reboot |
| `npm install` warned of 4 vulnerabilities (1 critical) | Old versions of Express's dependencies | Run `npm audit` and read it; `npm audit fix`; retest; commit the lockfile |
| `curl: Could not resolve host: no` on the Mac | zsh doesn't treat `#` as a comment by default, so the comment became arguments | Don't paste comments, or `setopt interactivecomments` |
| `ADMIN_KEY=<paste the random string>` | Placeholder pasted literally | Generate values with a command: `echo "ADMIN_KEY=$(openssl rand -hex 24)" >> .env` |
| `◇ injected env` in the pm2 *error* log | A dotenv notice, not an error | Silenced with `dotenv.config({ quiet: true })`; keep error logs for real errors |
| "Port 3000 isn't allowed" | It's *meant* to be closed | Know your own design: outside → 80 → Nginx → 127.0.0.1:3000 |
| A commit didn't reach GitHub | The push failed without an error message | Check with `git status -sb` that nothing is "ahead" |

---

# Part 2: Step-by-step build guide

Each phase: **goal → what was done (configuration) → how to verify → gotchas**.

## Phase 0: Starting point
- **RDS MySQL** `trainers-db1` with a `products` table (8 trainers, `image` column = full S3 URLs).
- **S3** bucket `dhrey-store-v3` (eu-west-2) with the trainer images.
- **EC2** (Amazon Linux, user `ec2-user`) running the backend from GitHub `trainers.backend`.
- The backend served a **hard-coded list** (no DB), with no CORS, so the new React frontend couldn't load trainers.

## Phase 1: Make the API callable from a browser (1 Oct)
**Goal:** the frontend can fetch trainers.
- Added the `cors` middleware, `PORT` from env, `npm start`, `/health`, and `POST /orders` (checkout).
- Added `.gitignore` (`node_modules/`, `.env`) and removed `node_modules` from git.

**Verify:** `curl -si -H "Origin: http://x.com" localhost:3000/products` includes `Access-Control-Allow-Origin`.
**Gotcha:** curl works without CORS; browsers don't.

## Phase 2: Fix the React project (1–2 Oct)
**Goal:** the frontend compiles and renders.
1. `src/main.tsx` only starts the app (`createRoot(...).render(<App/>)`); `src/App.tsx` is the UI.
2. `index.html`: `<div id="root"></div>` (it was `id="app"`).
3. Installed the React plugin: `npm install -D @vitejs/plugin-react @types/react @types/react-dom`.
4. `vite.config.ts`:
   ```ts
   import { defineConfig } from 'vite';
   import react from '@vitejs/plugin-react';
   export default defineConfig({ plugins: [react()] });
   ```
5. `tsconfig.json` → `compilerOptions`: `"jsx": "react-jsx"`, `"types": ["vite/client"]` (full file in Part 3).

**Verify:** `npm run dev` → `http://localhost:5173` shows "Trainers Store".

## Phase 3: Connect the frontend to EC2 (2 Oct)
**Goal:** trainers load from the backend on EC2.
1. On EC2: pull the branch, `npm install`. `pm2 status` showed **3 processes**; `pm2 delete` on the old ones, then `pm2 start server.js --name trainers`.
2. Frontend `.env`: `VITE_API_URL=http://<EC2-IP>:3000` (temporarily; later port 80, then CloudFront).
3. Security group: inbound 3000 (temporarily, closed in Phase 5).

**Verify:** `curl -m 5 http://<EC2-IP>:3000/products` from the Mac.
**Gotchas:** `npm run dev` must be run in `trainers-frontend`, not the parent folder; no `< >` around the IP.

## Phase 4: Backend on RDS (2 Oct)
**Goal:** trainers come from RDS; orders are saved in RDS.
1. Code: `mysql2` connection pool, `CREATE TABLE IF NOT EXISTS`, seed only if empty, transactional `/orders`.
2. Matched the existing schema: DB name `trainers-db1`; `image` with fallback to `image_url`; `sizes` as JSON or text.
3. EC2 `.env` (from `.env.example`):
   ```
   DB_HOST=<RDS-ENDPOINT>
   DB_PORT=3306
   DB_USER=<RDS-USER>
   DB_PASSWORD=<RDS-PASSWORD>
   DB_NAME=trainers-db1
   PORT=3000
   S3_BASE_URL=https://dhrey-store-v3.s3.eu-west-2.amazonaws.com
   ```
4. RDS security group: 3306 **from the EC2 security group**.

**Verify:** `curl localhost:3000/health` → `{"status":"ok","db":"ok"}`. Checkout → `SELECT * FROM orders;` shows the order and stock reduced.

## Phase 5: Hardening, part 1: Nginx, admin key, rate limit (8 Oct)
**Goal:** only port 80 public; Node unreachable from outside.
1. Code: `express-rate-limit` (300 requests / 15 min), 100 KB body limit, `trust proxy`, admin key on `POST /products`, `HOST` setting.
2. Nginx on EC2:
   ```bash
   sudo dnf install -y nginx
   sudo cp deploy/nginx-trainers.conf /etc/nginx/conf.d/trainers.conf
   sudo sed -i 's/ default_server//' /etc/nginx/nginx.conf
   sudo nginx -t && sudo systemctl enable --now nginx
   ```
   `deploy/nginx-trainers.conf`: `listen 80 default_server;` → `proxy_pass http://127.0.0.1:3000;` plus the `X-Forwarded-For` headers.
3. EC2 `.env` additions:
   ```bash
   echo "HOST=127.0.0.1" >> .env
   echo "ADMIN_KEY=$(openssl rand -hex 24)" >> .env
   pm2 restart trainers --update-env && pm2 save
   ```
4. Security groups: EC2 **+HTTP 80 (0.0.0.0/0)**, **−3000**, SSH 22 → **My IP**. RDS: Public access **No**.

**Verify:** `http://<IP>/health` works; `http://<IP>:3000/health` **times out**; the log says `Server running on 127.0.0.1:3000`.

## Phase 6: Cost analysis (8 Oct)
**Goal:** understand and cut the RDS bill.
1. Cost Explorer → Service = RDS → monthly. Found it ran **24/7** at micro pricing, so it was already right-sized.
2. Plan: stop when idle, EventBridge nightly stop, Budgets alert, snapshot/delete for long breaks (configured in Phase 11).

**Verify:** next month's RDS line drops (target ~$3–5).

## Phase 7: Production frontend build (8 Oct → 2 Nov)
**Goal:** `dist/` ready for S3, calling the API by relative path.
1. `App.tsx` line 3: `const API = import.meta.env.VITE_API_URL ?? '';`
2. Deleted the unused `src/ProductsPage.tsx` (it had a hard-coded IP) and leftover starter files.
3. Env files:
   ```bash
   echo "VITE_API_URL=http://<EC2-IP>" > .env.development
   echo "VITE_API_URL=" > .env.production
   rm -f .env
   ```
4. `npm run build` → `dist/index.html` + `dist/assets/`.

On EC2 the same day: `npm audit fix` (0 vulnerabilities), and pm2 boot start (`pm2 save`, `pm2 startup`, then the printed `sudo` line).

## Phase 8: S3 site bucket + CloudFront (2 Nov)
**Goal:** a public HTTPS website with a private bucket.
1. **S3 → Create bucket** `dhrey-trainers-site`, eu-west-2, **Block all public access ON**.
2. **Upload** the *contents* of `dist/` (`index.html` + `assets/`), not the `dist` folder itself.
3. **CloudFront → Create distribution** (newer wizard):
   - Name `trainers-store`; type: single website/app; no custom domain
   - Origin: Amazon S3 → `dhrey-trainers-site` → **private access via OAC** (bucket policy added automatically)
   - Security protections (WAF): off
   - Then **General → Settings → Default root object = `index.html`**
4. **Origins → Create origin**: domain = EC2 **Public IPv4 DNS**, **HTTP only**, port **80**, name **`ec2-api`**.
5. **Behaviors → Create behavior** ×3 (`/products*`, `/orders*`, `/health`), each with origin `ec2-api`, Redirect HTTP→HTTPS, CachingDisabled, AllViewerExceptHostHeader, methods as in the Lesson 9 table. The Default (\*) row already exists → S3.

**Verify:** `https://<id>.cloudfront.net` loads the store **with images**; `/health` → ok; checkout → "Order #… confirmed"; the direct S3 URL → AccessDenied.
**Gotchas:** no "copy policy" banner appears when the wizard already applied the policy (check S3 → Permissions → Bucket policy for `cloudfront.amazonaws.com`); don't create a second Default behaviour.

## Phase 9: Lock EC2 to CloudFront (2 Nov)
**Goal:** EC2 reachable only through CloudFront.
- EC2 security group: **+HTTP 80 from prefix list `com.amazonaws.global.cloudfront.origin-facing`**, **−HTTP 80 from 0.0.0.0/0**.

**Verify:** `curl -m 5 http://<EC2-IP>/health` from the Mac **times out**; `https://<id>.cloudfront.net/health` → ok.
**Gotcha:** the prefix list counts as many rules. If the quota is exceeded, put it in its own security group.

## Phase 10: Secrets and admin access ⏳ *next session*
**Goal:** no DB password on disk; no open SSH port.
1. **Systems Manager → Parameter Store → Create:** `/trainers/db-password`, Standard, **SecureString** (`alias/aws/ssm`).
2. **IAM → Roles → Create** `trainers-ec2-role` (trusted entity EC2) + **AmazonSSMManagedInstanceCore** + inline policy `read-db-password`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "ssm:GetParameter",
         "Resource": "arn:aws:ssm:eu-west-2:<ACCOUNT_ID>:parameter/trainers/db-password" },
       { "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*",
         "Condition": { "StringEquals": { "kms:ViaService": "ssm.eu-west-2.amazonaws.com" } } }
     ]
   }
   ```
3. EC2 → Actions → Security → **Modify IAM role** → `trainers-ec2-role`.
4. EC2 → **Connect → Session Manager**: a terminal in the browser (`sudo su - ec2-user`).
5. EC2 `.env`: remove `DB_PASSWORD`, add `DB_PASSWORD_PARAM=/trainers/db-password` and `AWS_REGION=eu-west-2` → `pm2 restart trainers --update-env`.
6. Delete the **SSH 22** rule.

**Verify:** the log says *"DB password loaded from Parameter Store (/trainers/db-password)"*; `/health` ok via CloudFront; SSH no longer connects, Session Manager does.
*Results and notes: to be added after the session.*

## Phase 11: Guardrails, automation, merge ⏳ *next session*
1. **AWS Budgets:** monthly cost budget $10, alert at 80%.
2. **EventBridge Scheduler:** daily 23:00 → RDS `StopDBInstance` `{"DbInstanceIdentifier":"trainers-db1"}`, and EC2 `StopInstances`.
3. **Scripts on the Mac:** `brew install jq`, `aws configure`, `cp scripts/aws.env.example scripts/aws.env` (instance ID, distribution ID, bucket) → first real run of `./scripts/aws-stop.sh` / `./scripts/aws-start.sh`.
4. **Merge** https://github.com/DhreyO/trainers.backend/pull/1 into `main`.

*Results and notes: to be added after the session.*

---

# Part 3: Reference

## Daily routine

**Start (manual, until the scripts are set up):**
1. RDS → Start → wait for **Available**.
2. EC2 → Start → copy the new **Public IPv4 DNS**.
3. CloudFront → `trainers-store` → Origins → `ec2-api` → Edit → paste the new domain → Save (~5 min).
4. Check `https://<id>.cloudfront.net/health`.

**Start (after Phase 11):** `./scripts/aws-start.sh`

**Stop:** EC2 → **Stop** (never Terminate), then RDS → **Stop temporarily**. Or run `./scripts/aws-stop.sh`. Remember the **7-day** RDS auto-restart.

**Deploy a frontend change:** `./scripts/deploy-frontend.sh` (build → S3 → invalidate `index.html`).

## Configuration cheat sheet

**Backend `.env` on EC2** (`.env.example` in the repo):

| Variable | Value | Purpose |
|---|---|---|
| `DB_HOST` | `<RDS-ENDPOINT>` | RDS address |
| `DB_PORT` | `3306` | |
| `DB_USER` | `<RDS-USER>` | |
| `DB_PASSWORD` *or* `DB_PASSWORD_PARAM` | secret / `/trainers/db-password` | Parameter Store preferred |
| `AWS_REGION` | `eu-west-2` | for Parameter Store |
| `DB_NAME` | `trainers-db1` | |
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1` | only Nginx can reach Node |
| `ADMIN_KEY` | random 48 hex chars | required for `POST /products` |
| `CORS_ORIGIN` | `*` | only matters for local dev now |
| `S3_BASE_URL` | images bucket URL | only for seeding an empty table |

**Frontend:** `.env.development` → `VITE_API_URL=http://<EC2-IP>`; `.env.production` → `VITE_API_URL=` (empty).

**`tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "types": ["vite/client"],
    "skipLibCheck": true, "noEmit": true, "isolatedModules": true,
    "allowImportingTsExtensions": true, "strict": true
  },
  "include": ["src"]
}
```

**Security groups (target state):**

| Group | Inbound |
|---|---|
| EC2 | HTTP 80 from `com.amazonaws.global.cloudfront.origin-facing` (SSH 22 from My IP until Phase 10) |
| RDS | MySQL 3306 from the EC2 security group |

**Useful commands:**
```bash
pm2 status | pm2 logs trainers --lines 20 --nostream | pm2 restart trainers --update-env | pm2 save
curl -s -m 5 -w "\nHTTP %{http_code}\n" localhost/health
sudo nginx -t && sudo systemctl reload nginx
npm audit
```

## Interview questions to practise

**"Walk me through your architecture."**
CloudFront is the single HTTPS entry point. The default behaviour serves the React build from a private S3 bucket through OAC; `/products*`, `/orders*` and `/health` go uncached to an Express API on EC2 behind Nginx; the API uses RDS MySQL, which isn't publicly accessible. Images load straight from S3. Then trace one request (Lesson 1).

**"How did you secure it?"**
The only public entry is CloudFront. EC2 port 80 accepts only CloudFront's managed prefix list, Nginx is a reverse proxy, and Node listens on localhost only. RDS isn't public and accepts 3306 only from the EC2 security group by SG reference. The site bucket is private with OAC. At the application level: parameterised queries, an admin key on writes, rate limiting, a body limit and patched dependencies. Next: secrets in Parameter Store via an IAM role, and Session Manager instead of SSH.

**"Is the S3 site public?"**
The website is public by definition, but the bucket is private: only my distribution can `GetObject`, and the direct S3 URL returns AccessDenied.

**"Why not let the frontend connect to RDS directly?"**
Credentials would be public in the browser bundle, RDS doesn't speak HTTP, and business rules like stock checks must run on a trusted server.

**"How do you prevent overselling?"**
A transaction with `SELECT … FOR UPDATE` row locks. Stock is checked and decremented atomically, and any failure rolls back.

**"Why did you disable caching for the API?"**
Stock and orders must be live; caching would show stale stock or replay responses. Static files are cached because their names are content-hashed.

**"How did you reduce cost?"**
Cost Explorer showed RDS ran 24/7, and hours times rate showed it was already right-sized. So I stop it when idle, scheduled automatic stops (because of the 7-day auto-restart), use snapshot/restore for long breaks, and set a Budgets alert. I avoided an Elastic IP because it bills while stopped, and designed around the changing address with CloudFront and a start script.

**"What would you change for production?"**
An ALB with an ACM certificate (HTTPS to the origin) and an Auto Scaling group across two AZs; Multi-AZ RDS; Secrets Manager with rotation; CI/CD (GitHub Actions to S3 and EC2); CloudWatch alarms and logs; WAF on CloudFront; Infrastructure as Code (CloudFormation/Terraform).

**"What was the hardest bug?"**
"Load failed" in the browser while curl worked. I learned the browser enforces CORS and curl doesn't, then found old pm2 processes still holding port 3000, so the fixed code never ran. I solved it by testing each hop separately.

## Self-check quiz
1. Why did `curl` work when the browser failed?
2. What's the difference between binding to `0.0.0.0` and `127.0.0.1`?
3. Why reference the EC2 security group in the RDS rule instead of the EC2 IP?
4. What happens to a stopped RDS instance after 7 days?
5. Why is `?? ''` correct and `|| 'http://localhost:3000'` wrong for production?
6. Why must you never put a password in a `VITE_` variable?
7. What does `SELECT … FOR UPDATE` protect against?
8. Is an Elastic IP cheaper or more expensive than an auto-assigned IP *for your stop/start pattern*? Why?
9. Why do images load from S3 directly instead of through EC2?
10. Which two independent layers stop someone reaching port 3000?
11. Why does visiting `/` give AccessDenied if the default root object isn't set?
12. Why do the API behaviours need POST and OPTIONS?
13. What stops someone bypassing CloudFront and calling EC2 directly?
14. After restarting EC2, what's the one CloudFront setting you must update, and why?
15. What caused the 502 after restarting EC2, and how was it fixed for good?

<details><summary>Answers</summary>

1. The Same-Origin Policy is enforced by browsers only; the server didn't send CORS headers.
2. All interfaces (reachable from outside) vs loopback only (same machine only).
3. IPs change; an SG reference allows exactly the members of that group, whatever their IPs.
4. AWS starts it again automatically, and billing resumes.
5. `''` is falsy, so `||` would replace it with localhost; `??` only replaces null/undefined.
6. Vite bakes it into the public JavaScript bundle, so anyone can read it.
7. Race conditions: two checkouts selling the same last item (overselling).
8. More expensive: an EIP is billed while the instance is stopped; an auto-assigned IP is released (free) when stopped.
9. To offload bandwidth and CPU from EC2; S3 is built for static content and scales automatically.
10. The security group has no rule for 3000, and Node only listens on 127.0.0.1.
11. CloudFront asks S3 for an empty key, which doesn't exist; with a private bucket S3 answers AccessDenied rather than 404.
12. Checkout sends a POST, and the browser sends an OPTIONS preflight before cross-origin JSON requests (in local dev).
13. EC2 port 80 only allows CloudFront's managed prefix list, so direct requests time out.
14. The `ec2-api` origin domain, because EC2's public DNS changes on every stop/start (no Elastic IP).
15. pm2 had no saved process list and no boot service, so Node didn't start; fixed with `pm2 save` + `pm2 startup` + the printed `sudo` command.
</details>
