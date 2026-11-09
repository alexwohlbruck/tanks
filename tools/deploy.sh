#!/usr/bin/env bash
# Build and publish the game to a static host.
# usage: DEPLOY_HOST=user@host [DEPLOY_DIR=/opt/tanks] [PROXY_NETWORK=caddy] tools/deploy.sh
# The host needs Docker and a reverse proxy on PROXY_NETWORK that routes the site to tanks:80
# (see deploy/). public/assets must already be built (README "Build the assets").
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEPLOY_HOST:?set DEPLOY_HOST=user@host}"
DIR="${DEPLOY_DIR:-/opt/tanks}"
bun run build
rm -f dist/ref-*.png
ssh "$DEPLOY_HOST" "mkdir -p '$DIR/dist'"
rsync -az --delete dist/ "$DEPLOY_HOST:$DIR/dist/"
rsync -az deploy/docker-compose.yml deploy/nginx.conf "$DEPLOY_HOST:$DIR/"
ssh "$DEPLOY_HOST" "cd '$DIR' && PROXY_NETWORK='${PROXY_NETWORK:-caddy}' docker compose up -d && docker compose restart tanks"
echo "deployed to $DEPLOY_HOST:$DIR"
