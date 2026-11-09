# Trainers Store — Progress & Next Steps

## Done ✅
- Backend (Express) on EC2 under pm2, reading/writing **RDS MySQL** (`trainers-db1`)
- Trainer images served from **S3** (`dhrey-store-v3`)
- Frontend (React + Vite) works locally: browse, details, images, cart, checkout
- Orders saved to RDS `orders` table, stock decremented
- CORS, `/health` (checks DB), rate limiting, admin key on `POST /products`, `HOST` setting for Nginx
- All backend work is merged into `main`

## Before the break 💤
- [ ] Stop EC2, then stop RDS
- [ ] Remember: **stopped RDS auto-restarts after 7 days**. If the break is longer, snapshot and delete it (restore with the same DB identifier later)
- [ ] Set an AWS Budgets alert (e.g. $5)

## When resuming ▶️
**Start-up order:** start RDS → wait until "Available" → start EC2 → note the **new public IP**
(it changes on every stop/start, because there's no Elastic IP)

1. ✅ **Bring it back up** (done 2026-10-08)
   - Session Manager into EC2 (EC2 → Connect → Session Manager; SSH is closed) → `pm2 status` → `curl localhost:3000/health` should return `{"status":"ok","db":"ok"}`
   - Frontend `.env`: `VITE_API_URL=http://<new-IP>:3000` (or `http://<new-IP>` once Nginx is in place)

2. ✅ **Cut RDS cost** (done 2026-10-08). Finding: already a right-sized micro instance; the cost (~$17 in Aug) came from running 24/7
   - Fix: EventBridge Scheduler nightly `StopDBInstance` (+ EC2 `StopInstances`), Budgets alert, snapshot+delete for breaks over 7 days
   - Expected: ~$3/month
   - Cost Explorer → Service = RDS → Group by **Usage type**: find the driver
   - Modify: `db.t4g.micro`, Single-AZ, 20 GB gp3, backup retention 1 day, Performance Insights and Enhanced Monitoring off, Public access **No**
   - Check the engine version: if MySQL 5.7/8.0, check for Extended Support charges and upgrade to 8.4

3. ✅ **Close port 3000 with Nginx** (done 2026-10-08). Verified: `http://<IP>/health` OK, `:3000` times out
   - `git pull && npm install` in `~/trainers.backend`
   - Install Nginx → `sudo cp deploy/nginx-trainers.conf /etc/nginx/conf.d/trainers.conf` → `sudo nginx -t && sudo systemctl enable --now nginx`
   - `.env`: add `HOST=127.0.0.1` and `ADMIN_KEY=<openssl rand -hex 24>` → `pm2 restart trainers --update-env && pm2 save`
   - Security group: allow **80**, remove **3000**, set SSH 22 to **My IP**
   - RDS security group: 3306 **only from the EC2 security group**

4. ✅ **Fix the frontend build** (done 2026-11-02): `npm run build` → `dist/`; API uses `?? ''` (relative paths in production)
   - Also fixed on EC2: pm2 wasn't set to start on boot (502 after restart) → `pm2 save` + `pm2 startup`
   - Dependency audit fixed (proxy-addr, body-parser, qs, ip-address) → 0 vulnerabilities

5. ✅ **Host the frontend: S3 + CloudFront** (done 2026-11-02): site + images load via `https://<id>.cloudfront.net`; OAC bucket policy auto-added by the console wizard
   - Private bucket `dhrey-trainers-site` + CloudFront (OAC), EC2 origin named **`ec2-api`**, behaviours `/products*`, `/orders*`, `/health` (CachingDisabled + AllViewerExceptHostHeader)
   - `cp scripts/aws.env.example scripts/aws.env`, fill in IDs → `./scripts/deploy-frontend.sh`
   - Test: `https://<id>.cloudfront.net` → browse, details, images, cart, checkout

6. ✅ **Harden** (done 2026-11-08)
   - ✅ 6A: EC2 port 80 only from prefix list `com.amazonaws.global.cloudfront.origin-facing`
   - ✅ 6B: reused existing SecureString `/trainersdb1/dev/db-password`; IAM role `trainers-ec2-role` = AmazonSSMManagedInstanceCore + inline policy (GetParameter on that one parameter, kms:Decrypt via SSM)
   - ✅ 6C: `.env` has `DB_PASSWORD_PARAM=/trainersdb1/dev/db-password` + `AWS_REGION=eu-west-2`, no password on disk; log shows "DB password loaded from Parameter Store"
   - ✅ 6D: Session Manager connected; SSH 22 rule deleted. EC2 inbound = only HTTP 80 from CloudFront
   - Optional: `/trainersdb1/dev/db-url` (String) — keep only if it holds just the endpoint, never a password

7. ✅ **Automate & document** (done 2026-11-08)
   - ✅ `scripts/aws-start.sh`, `aws-stop.sh`, `deploy-frontend.sh`
   - ✅ `README.md` with architecture, decisions, setup
   - ✅ 7A: AWS Budgets (existing £10 monthly budget with email alert)
   - ✅ 7B: EventBridge Scheduler `trainers-stop-rds-nightly` + `trainers-stop-ec2-nightly`, 23:00 Europe/London, role `trainers-scheduler-role` (rds:StopDBInstance + ec2:StopInstances only)
   - ✅ 7C: Mac: AWS CLI v2 installed, signed in with `aws login` (temporary credentials, no access keys), `~/trainers-backend-ops/scripts/aws.env` filled in and read-only test passed
   - ✅ 7D: PR merged into `main`
   - Optional: upgrade Node on EC2 to 22 (AWS SDK warning)

## 🎉 Project complete
Live at `https://<id>.cloudfront.net`: browse, details, S3 images, cart, checkout → RDS.

## Daily start-up / shut-down (from the Mac)
```bash
cd ~/trainers-backend-ops
aws login                # if the CLI session has expired
./scripts/aws-start.sh   # RDS → EC2 → re-point CloudFront → health check → prints site URL
./scripts/aws-stop.sh    # EC2 → RDS
```

### Manual fallback (CloudFront needs EC2's new address)
1. Start RDS → wait for **Available** → start EC2
2. **Copy** (don't type) EC2's new **Public IPv4 DNS** — it uses dashes: `ec2-18-130-58-114…`, not dots → CloudFront → `trainers-store` → **Origins** → `ec2-api` → **Edit** → paste the new domain → Save (≈5 min to deploy)
   (once 7C is set up, `./scripts/aws-start.sh` does all of this automatically)
3. Check `https://<id>.cloudfront.net/health` → `{"status":"ok","db":"ok"}`

## Study notes
See `LESSONS.md` for an in-depth explanation of everything built, plus interview questions and a quiz.
