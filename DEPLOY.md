# Deploy to AWS (EC2, Mumbai)

You do the AWS clicks, then paste the commands below. Takes ~15 minutes.

## 0. Before you start
- Rotate your Supabase **service key** (it was shared in chat): Project Settings -> API Keys. Put the new one in `.env`.
- In `.env` set `APP_PASSWORD=<your password>`. The deployed site asks for it (browser sign-in box, any username). Never commit `.env`.
  Without it, anyone with the URL can trade on your accounts.

## 1. Launch the server
1. AWS Console -> top-right region **Asia Pacific (Mumbai) ap-south-1**.
2. EC2 -> **Launch instance**: name `delta-demo`, **Ubuntu Server 24.04 LTS**, type **t3.small**, create a new key pair (download the `.pem`), 20 GB disk.
3. Network settings -> create security group with inbound: SSH (22) from **My IP**, HTTP (80) and HTTPS (443) from Anywhere. Do **not** open 5173.
4. Launch. Then EC2 -> **Elastic IPs** -> Allocate -> Associate with the instance (so the address never changes).

## 2. Pick your web address (HTTPS is required for the websocket)
- Have a domain? Add an **A record** -> your Elastic IP. Your address is `trade.yourdomain.com`.
- No domain? Use a free one built from the IP: for IP `13.233.10.20` the address is `13-233-10-20.sslip.io`.

Put that address in `deploy/Caddyfile` (replace `trade.example.com`).

## 3. Copy the project (PowerShell on your PC, from the project folder's parent)
```powershell
scp -i C:\path\to\key.pem -r "delta clone" ubuntu@YOUR_ELASTIC_IP:~/delta-demo
```
(this also copies `.env`, which holds your secrets, so only do it to your own server). If `node_modules` was copied it is harmless; setup reinstalls.

## 4. Install and start (on the server)
```bash
ssh -i C:\path\to\key.pem ubuntu@YOUR_ELASTIC_IP
bash ~/delta-demo/deploy/setup-ec2.sh
```
It installs Node, PM2 (keeps it running + restarts on reboot) and Caddy (automatic HTTPS).

## 5. Check
- `pm2 status` shows `delta-demo` online; `curl localhost:5173/health` returns `{"ok":true,...}`.
- Open `https://your-address`, sign in with any username and your `APP_PASSWORD`.

## Updating later
Copy changed files with `scp`, then on the server: `pm2 restart delta-demo`. Logs: `pm2 logs delta-demo`.

## Costs / notes
- t3.small is roughly $15-20/month in Mumbai plus a little for the Elastic IP; stop the instance when not using it to save money (orders will not fill while it is stopped).
- Supabase free tier is enough for this.


---

# Frontend on Vercel, backend on AWS

Vercel hosts only the page (`index.html`, `css/`, `js/`). The engine and database stay on your AWS server, because Vercel cannot run a long-lived process.

1. **Do the AWS steps above first.** You need the backend's HTTPS address, e.g. `https://13-233-10-20.sslip.io`.
   Test it: open that address in a browser, sign in with the password. The app should work from there too.
2. **Point the UI at it.** In the Vercel project: Settings -> Environment Variables -> add `BACKEND_URL` = `https://<your-backend-address>` (all environments). The build step (`scripts/gen-config.js`) writes it into `js/config.js`, so the address is not stored in git.
3. **Deploy to Vercel** (from the project folder on your PC):
   ```powershell
   npm i -g vercel
   vercel login
   vercel --prod
   ```
   Accept the defaults. `vercel.json` publishes the project root as a static site, and `.vercelignore` keeps `.env`, `server/`, `deploy/` and `supabase/` out of the upload. Check that `.env` is not listed in Vercel's uploaded files.
4. **Open the Vercel URL.** The app asks for the password once and remembers it in that browser.

Notes:
- Every change to the UI = `vercel --prod` again. Every change to the engine = copy files to AWS and `pm2 restart delta-demo`.
- If you change `APP_PASSWORD` on the server, clear the saved password in the browser (site data) or it will ask again.
- The market data (prices, chart, order book) still comes straight from Delta in the browser; only orders and accounts go through your AWS backend.
