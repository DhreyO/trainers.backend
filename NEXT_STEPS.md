# Trainers Store — Progress & Next Steps

## Done ✅
- Backend (Express) on EC2 under pm2, reading/writing **RDS MySQL** (`trainers-db1`)
- Trainer images served from **S3** (`dhrey-store-v3`)
- Frontend (React + Vite) works locally: browse, details, images, cart, checkout
- Orders saved to RDS `orders` table, stock decremented
- CORS, `/health` (checks DB), rate limiting, admin key on `POST /products`, `HOST` setting for Nginx
- All backend work is on branch `claude/aws-trainer-retrieval-issue-5jfgac` (not merged to `main` yet)

## Before the break 💤
- [ ] Stop EC2, then stop RDS
- [ ] Remember: **stopped RDS auto-restarts after 7 days**. If the break is longer, snapshot and delete it (restore with the same DB identifier later)
- [ ] Set an AWS Budgets alert (e.g. $5)

## When resuming ▶️
**Start-up order:** start RDS → wait until "Available" → start EC2 → note the **new public IP**
(it changes on every stop/start, because there's no Elastic IP)

1. **Bring it back up**
   - SSH/Session Manager into EC2 → `pm2 status` → `curl localhost:3000/health` should return `{"status":"ok","db":"ok"}`
   - Frontend `.env`: `VITE_API_URL=http://<new-IP>:3000` (or `http://<new-IP>` once Nginx is in place)

2. **Cut RDS cost** (biggest bill)
   - Cost Explorer → Service = RDS → Group by **Usage type**: find the driver
   - Modify: `db.t4g.micro`, Single-AZ, 20 GB gp3, backup retention 1 day, Performance Insights and Enhanced Monitoring off, Public access **No**
   - Check the engine version: if MySQL 5.7/8.0, check for Extended Support charges and upgrade to 8.4

3. **Close port 3000 with Nginx**
   - `git pull && npm install` in `~/trainers.backend`
   - Install Nginx → `sudo cp deploy/nginx-trainers.conf /etc/nginx/conf.d/trainers.conf` → `sudo nginx -t && sudo systemctl enable --now nginx`
   - `.env`: add `HOST=127.0.0.1` and `ADMIN_KEY=<openssl rand -hex 24>` → `pm2 restart trainers --update-env && pm2 save`
   - Security group: allow **80**, remove **3000**, set SSH 22 to **My IP**
   - RDS security group: 3306 **only from the EC2 security group**

4. **Fix the frontend build**
   - Replace `tsconfig.json` with the version that has `"jsx": "react-jsx"` and `"types": ["vite/client"]`
   - Delete leftover starter files (`src/main.ts`, `src/counter.ts`)
   - `npm run build` → creates `dist/`

5. **Host the frontend**
   - New **private** S3 bucket for the site (separate from the images bucket)
   - CloudFront with two origins: S3 (via **OAC**) as default, EC2 for `/products*`, `/orders*`, `/health` (caching disabled)
   - Frontend calls relative paths, so it no longer needs the EC2 IP or a rebuild when the IP changes
   - EC2 port 80 only from the prefix list `com.amazonaws.global.cloudfront.origin-facing`
   - Set `CORS_ORIGIN` in EC2 `.env` to the CloudFront URL

6. **Extra hardening (SAA showcase)**
   - Replace SSH with **SSM Session Manager** (remove port 22)
   - DB password in **SSM Parameter Store (SecureString)**, read via the EC2 **IAM role**

7. **Automate & document**
   - `scripts/aws-start.sh` / `aws-stop.sh` (start RDS → EC2 → update the CloudFront origin; stop in reverse)
   - README with architecture diagram + reasoning (cost, security, trade-offs) for interviews
   - Open a PR and merge this branch into `main`

## Ask Claude to pick up from
> "Continue from NEXT_STEPS.md in trainers.backend — I'm on step N."
