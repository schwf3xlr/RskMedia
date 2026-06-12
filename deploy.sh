#!/bin/bash
set -e

# ===== CONFIGURATION — EDIT THESE =====
DOMAIN="media.rskbot.ru"
GIT_REPO="https://github.com/schwf3xlr/RskMedia.git"
GIT_TOKEN=""  # leave empty for public repos
DB_NAME="rskmedia"
DB_USER="rskmedia"
DB_PASSWORD="Kfmerkdnf290K"
JWT_SECRET="f25d7b1ddee2018057a5a17ccdeb2f7188f9b2cc95aac89dbfac03287fce55e2"
S3_ENDPOINT="https://s3.ru1.storage.beget.cloud"
S3_REGION="ru-1"
S3_ACCESS_KEY="M6P5LA27L39K51RC1XA1"
S3_SECRET_KEY="w7AqqL4dMsL3CThDGpUgmQLPxmA22YT2gRhviwWN"
S3_BUCKET="d40edd4c3fad-rskmedia"
ADMIN_EMAIL="admin@rskbot.ru"  # for Let's Encrypt

# ======================================

log() { echo; echo "==> $1"; echo "======================"; }

log "Updating system packages"
apt-get update -qq
apt-get upgrade -y -qq

log "Installing prerequisites (curl, gnupg, ca-certificates)"
apt-get install -y -qq curl gnupg ca-certificates

log "Installing Node.js 22.x via NodeSource"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

log "Installing PostgreSQL, nginx, certbot"
apt-get install -y -qq nginx postgresql postgresql-contrib certbot python3-certbot-nginx

log "Starting PostgreSQL"
systemctl start postgresql
systemctl enable postgresql

log "Creating database and user"
sudo -u postgres psql <<SQL
CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

log "Cloning repository"
mkdir -p /opt
if [ -z "$GIT_TOKEN" ]; then
  git clone "$GIT_REPO" /opt/media
else
  REPO_AUTH=$(echo "$GIT_REPO" | sed "s|https://|https://${GIT_TOKEN}@|")
  git clone "$REPO_AUTH" /opt/media
fi

log "Creating .env"
cat > /opt/media/.env <<ENVEOF
# Server
PORT=3000
NODE_ENV=production

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}

# JWT
JWT_SECRET=${JWT_SECRET}

# S3 Storage
S3_ENDPOINT=${S3_ENDPOINT}
S3_REGION=${S3_REGION}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_BUCKET=${S3_BUCKET}

# Upload
MAX_FILE_SIZE_MB=500
MAX_PHOTO_SIZE_MB=50
ENVEOF

log "Installing npm dependencies"
cd /opt/media
npm install --production

log "Initializing database"
node scripts/init-db.js

log "Installing pm2"
npm install -g pm2

log "Starting app with pm2"
pm2 start app.js --name media --env production
pm2 save
pm2 startup systemd -u root --hp /root 2>&1 | tail -5

log "Configuring nginx"
cat > /etc/nginx/sites-available/media <<'NGINXEOF'
server {
    server_name DOMAIN_PLACEHOLDER;
    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINXEOF
sed -i "s/DOMAIN_PLACEHOLDER/${DOMAIN}/g" /etc/nginx/sites-available/media
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/media /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx

log "Obtaining SSL certificate"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$ADMIN_EMAIL"

log "Verifying"
sleep 2
pm2 logs media --lines 5 --nostream
curl -s -o /dev/null -w "HTTP %{http_code}\n" "https://${DOMAIN}/"

echo ""
echo "============================================"
echo "  DEPLOY COMPLETE"
echo "  Site: https://${DOMAIN}"
echo "  Admin token: check the output above"
echo "============================================"
