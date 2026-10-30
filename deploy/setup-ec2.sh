#!/usr/bin/env bash
# Run on a fresh Ubuntu 22.04/24.04 EC2 instance:  bash setup-ec2.sh
set -e
sudo apt-get update -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs caddy
sudo npm install -g pm2
cd ~/delta-demo
grep -q "^APP_PASSWORD=." .env 2>/dev/null || { echo "Set APP_PASSWORD in ~/delta-demo/.env first"; exit 1; }
grep -q "YOUR-ADDRESS-HERE" deploy/Caddyfile && { echo "Edit deploy/Caddyfile and put your address in first"; exit 1; }
npm install --omit=dev
[ -f .env ] || { echo "Create ~/delta-demo/.env first (copy .env.example)"; exit 1; }
pm2 start deploy/ecosystem.config.cjs
pm2 save
sudo env PATH=$PATH pm2 startup systemd -u $USER --hp $HOME >/dev/null || true
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
echo "Done. Check: pm2 status  |  curl localhost:5173/health"
