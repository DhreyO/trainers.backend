# Trainers Store: What We Built and Why

A study guide for the project: how each part works, what broke and why, and how it maps to the AWS Solutions Architect Associate (SAA) and to interview questions.

---

## Lesson 1: The big picture (3-tier architecture)

```
 ┌──────────── Presentation tier ────────────┐
 │ Browser running React (built by Vite)     │
 └──────┬──────────────────────────┬─────────┘
        │ fetch /products, /orders │ <img src="https://…s3…">
        ▼                          ▼
 ┌──────────── Application tier ─┐   ┌── Static storage ──┐
 │ EC2                           │   │ S3 dhrey-store-v3  │
 │  Nginx :80  (public)          │   │ (trainer images)   │
 │   └► Node/Express 127.0.0.1:3000  └────────────────────┘
 └──────┬────────────────────────┘
        │ MySQL protocol :3306 (private)
        ▼
 ┌──────────── Data tier ────────┐
 │ RDS MySQL  trainers-db1       │
 │  products, orders tables      │
 └───────────────────────────────┘
```

**Why three tiers?** Each layer has one job and can be secured, scaled and paid for separately:

| Tier | Job | Who may reach it |
|---|---|---|
| Presentation | What users see | Everyone |
| Application | Business rules (prices, stock, checkout) | Everyone, but only via Nginx on port 80 |
| Data | Stores the truth | **Only** the application tier |

**Key idea:** the browser never talks to the database. It can't (RDS doesn't speak HTTP), and it mustn't (anything in the browser is public, including passwords). The backend is the gatekeeper.

### Trace one click: "Browse trainers"
1. The browser loads the React app.
2. React runs `fetch("http://<EC2-IP>/products")`.
3. The request reaches the **EC2 security group**: port 80 is allowed, so it passes.
4. **Nginx** on port 80 forwards it to `127.0.0.1:3000`.
5. **Express** matches `GET /products` and runs `SELECT * FROM products` through the connection pool.
6. The request reaches the **RDS security group**: port 3306 from the EC2 security group is allowed, so it passes.
7. **MySQL** returns the rows, Express converts them to JSON and adds CORS headers, and Nginx passes the response back.
8. React renders the cards. Each `<img src>` is a **separate request straight to S3**; images never pass through EC2.

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
- `POST` with JSON triggers a **preflight** (`OPTIONS`) request first; the `cors` middleware answers it.
- Production: set `CORS_ORIGIN` to your real site, not `*`.
- Once CloudFront serves the site *and* the API from **one** domain, everything is the same origin and CORS stops mattering. That's one of the benefits of step 5.

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

### dev vs build
- `npm run dev`: a live development server with hot reload, files compiled on the fly. Only for your laptop.
- `npm run build`: produces `dist/` with plain `index.html`, JS and CSS. This is what you **deploy**: static files that S3 can host without any server.

### Environment variables in the frontend: important
- Vite only exposes variables starting with `VITE_`.
- They are **baked into the JavaScript at build time**, so **anyone can read them** in the browser. **Never** put secrets in frontend `.env` files.
- `.env.development` is used by `npm run dev`; `.env.production` by `npm run build`.

### `||` vs `??` (the last bug)
```ts
import.meta.env.VITE_API_URL || 'http://localhost:3000'  // '' is falsy → falls back to localhost ❌
import.meta.env.VITE_API_URL ?? ''                       // only null/undefined fall back → '' kept ✅
```
In production we *want* an empty string, so calls become relative (`/products`). This only works with `??`.

### Why hard-coded IPs are a smell
`ProductsPage.tsx` had the EC2 IP inside the code. Each stop/start changes the IP, so the code breaks. **Configuration belongs in config** (env files), not in code. Best of all, use relative paths behind one stable domain (CloudFront).

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
`CREATE TABLE IF NOT EXISTS` and "seed only if empty" mean the code adapted to **your** existing RDS data without overwriting it.

### Configuration (12-factor style)
Settings come from environment variables (`.env` + dotenv), not code: `DB_HOST`, `DB_PASSWORD`, `HOST`, `ADMIN_KEY`… The same code runs on your laptop and EC2; only the config differs. `.env` is in `.gitignore`, so secrets never reach GitHub.

### pm2 (process manager)
Keeps Node running after you log out, restarts it if it crashes, and starts it on boot (`pm2 save` + `pm2 startup`).
**Bug we hit:** three processes (`server`, `server`, `trainers`) fighting over port 3000. The old ones won, so the new CORS code never ran.
**Lesson:** only one process can listen on a port. Always check `pm2 status` after deploying.

---

## Lesson 5: Networking and security (defence in depth)

### Security groups = stateful virtual firewalls
- **Inbound rules** control what can reach the resource. **Stateful** means replies to allowed requests are automatically allowed out.
- **Referencing another SG** as a source (RDS allows 3306 *from the EC2 SG*) is better than IPs: it keeps working when IPs change, and only instances in that SG get in.

### What's exposed now
| Port | Where | Open to | Why |
|---|---|---|---|
| 80 | EC2 | Internet | Nginx: the only public entry |
| 3000 | EC2 | **Nobody** (closed in SG **and** Node bound to 127.0.0.1) | Two independent layers |
| 22 | EC2 | My IP only | Admin access (later: Session Manager, so no open port) |
| 3306 | RDS | EC2 SG only, Public access = No | DB never on the internet |

### `0.0.0.0` vs `127.0.0.1`
- `0.0.0.0`: listen on **all** network interfaces, so reachable from outside if the firewall allows.
- `127.0.0.1`: listen on **loopback only**, so only programs on the same machine (Nginx) can connect.

With `HOST=127.0.0.1`, even if someone re-opens 3000 in the SG by mistake, Node still isn't reachable. That is **defence in depth**: no single mistake exposes you.

### Reverse proxy (Nginx)
Sits in front of the app on port 80 and forwards requests to `127.0.0.1:3000`. Benefits: the app isn't directly exposed, it's a standard place to add HTTPS, compression, caching and request limits, and it passes the real visitor IP (`X-Forwarded-For`, used by our rate limiter via `trust proxy`).

### Application-level protections
- **Admin key** on `POST /products`: before this, *anyone* could add trainers to your DB.
- **Rate limiting:** 300 requests per 15 minutes per IP, which slows abuse and scraping.
- **Body size limit** (100 KB): stops giant payloads.
- `x-powered-by` disabled: don't advertise your tech stack.

### Still open (next steps)
- **HTTP, not HTTPS:** traffic isn't encrypted. Fixed by CloudFront (free certificate).
- Port 80 is open to the whole internet. Restrict it to CloudFront's **managed prefix list**.
- DB password in `.env` on disk. Move it to **SSM Parameter Store** and read it via an **IAM role**.

---

## Lesson 6: Cost thinking (FinOps)

### How we found the real cost driver
Cost Explorer: RDS was $16.80 in August with ~764 usage units. August has 744 hours, so **it ran 24/7**, at ~$0.019/hr (micro pricing).
**Conclusion:** the instance was already right-sized; the waste was **idle hours**. Measure first, then change the right thing.

### Rules worth remembering
- **Compute bills per hour running; storage bills per GB-month, even when stopped.**
- A **stopped RDS instance restarts automatically after 7 days.** This is a classic surprise bill. Fix it with an EventBridge Scheduler nightly stop, or snapshot and delete.
- **Public IPv4 addresses are billed** (~$0.005/hr each). An auto-assigned IP is released when EC2 stops, so it's free while stopped. An **Elastic IP is billed while the instance is stopped**. For a stop/start workflow, skipping the EIP is correct.
- **Snapshot + delete + restore with the same identifier** keeps the same endpoint at almost zero idle cost.
- **AWS Budgets** alerts are the safety net.

### Trade-off you made consciously
No Elastic IP means the IP changes on every start. Instead of paying to avoid that, the design removes the dependency: CloudFront gives one stable domain, and the frontend uses relative paths. **Design around constraints instead of paying them away.**

---

## Lesson 7: How we debugged (the method matters more than the fixes)

Go **hop by hop** from the user towards the database, and test each hop on its own:

| Hop | Test | What we learned |
|---|---|---|
| Page renders? | Blank page → browser **Console** | `id="app"` vs `root` |
| Browser → API? | DevTools **Network** tab | Wrong URL / CORS / unreachable |
| Laptop → EC2? | `curl http://<IP>/health` from Mac | Security group / IP changed |
| Nginx → Node? | `curl localhost/health` on EC2 | Nginx config |
| Node running? | `pm2 status`, `pm2 logs` | Duplicate processes on port 3000 |
| Node → RDS? | `/health` returns `db: ok` | SG / credentials / DB name |

**Rule:** change one thing, re-test, move one hop. Never guess across several layers at once.

---

## Lesson 8: Mapping to the SAA exam domains

| SAA domain | What you did |
|---|---|
| **Design Secure Architectures** | SG referencing, private RDS, localhost bind + reverse proxy, least exposure, secrets out of git (next: IAM role + Parameter Store, OAC, Session Manager) |
| **Design Resilient Architectures** | Health check endpoint, pm2 auto-restart, DB transactions, stateless app tier (could sit behind ALB/ASG) |
| **Design High-Performing Architectures** | Images served direct from S3 (offloads EC2), connection pooling, CDN next (CloudFront) |
| **Design Cost-Optimized Architectures** | Cost Explorer analysis, right-size check, stop/start, 7-day restart awareness, IPv4/EIP trade-off, snapshot/restore, Budgets |

---

## Lesson 9: Interview questions to practise

**"Walk me through your architecture."**
Three tiers: a React SPA, an Express API on EC2 behind Nginx, and RDS MySQL in a private setup. Images are served directly from S3. Then trace one request (Lesson 1).

**"How did you secure it?"**
Only port 80 is public. Nginx is a reverse proxy, Node listens on localhost only, RDS isn't public and accepts 3306 only from the EC2 security group by SG reference, and SSH is limited to my IP. At the application level: parameterised queries, an admin key on writes, rate limiting and a body size limit. Next: HTTPS via CloudFront, the origin restricted to CloudFront's prefix list, secrets in Parameter Store via an IAM role, and Session Manager instead of SSH.

**"Why not let the frontend connect to RDS directly?"**
Credentials would be public in the browser bundle, RDS doesn't speak HTTP, and business rules like stock checks must run on a trusted server.

**"How do you prevent overselling?"**
A transaction with `SELECT … FOR UPDATE` row locks. Stock is checked and decremented atomically, and any failure rolls back.

**"How did you reduce cost?"**
I used Cost Explorer to show RDS ran 24/7, while hours times rate showed it was already right-sized. So I stopped it when idle, scheduled automatic stops (because of the 7-day auto-restart), used snapshot/restore for long breaks, and set a Budgets alert. I avoided an Elastic IP because it bills while stopped, and designed around the changing IP with CloudFront.

**"What would you change for production?"**
HTTPS everywhere; Multi-AZ RDS; an ALB plus an Auto Scaling group across two AZs; secrets in Secrets Manager with rotation; CI/CD (GitHub Actions to S3 and EC2); CloudWatch alarms and logs; WAF on CloudFront; Infrastructure as Code (CloudFormation/Terraform).

**"What was the hardest bug?"**
"Load failed" in the browser while curl worked. I learned the browser enforces CORS and curl doesn't, then found old pm2 processes still holding port 3000, so the fixed code never ran. I solved it by testing each hop separately.

---

## Lesson 10: Self-check quiz
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
</details>
