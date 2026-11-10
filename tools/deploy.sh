#!/usr/bin/env bash
# Build and publish the game (static site + game server) to a Docker host.
# usage: DEPLOY_HOST=user@host [DEPLOY_DIR=/opt/tanks] [PROXY_NETWORK=caddy] [TANKS_VERSION=v1.2.3] tools/deploy.sh
# Pushes to main deploy through GitHub Actions (.github/workflows/deploy.yml), which picks the
# next version (tools/release.sh) and tags it; run this by hand only to deploy from a checkout.
# The host needs Docker and a reverse proxy on PROXY_NETWORK that routes /api/* and /ws/* to
# tanks-api:3001 and the rest to tanks:80 (see deploy/). public/assets must already be built
# (README "Build the assets").
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEPLOY_HOST:?set DEPLOY_HOST=user@host}"
DIR="${DEPLOY_DIR:-/opt/tanks}"
# the release the client and the server report (vite.config.ts, server/index.ts)
export TANKS_VERSION="${TANKS_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
bun run build
rm -f dist/ref-*.png
ssh "$DEPLOY_HOST" "mkdir -p '$DIR/dist' '$DIR/src' '$DIR/data'"
rsync -az --delete dist/ "$DEPLOY_HOST:$DIR/dist/"
# server build context: sources, lockfile and the game data the simulation reads
rsync -az --delete --exclude node_modules --exclude 'server/data' \
  package.json bun.lock src server "$DEPLOY_HOST:$DIR/src/"
rsync -az --delete --relative public/assets/data "$DEPLOY_HOST:$DIR/src/"
rsync -az deploy/docker-compose.yml deploy/nginx.conf "$DEPLOY_HOST:$DIR/"
ssh "$DEPLOY_HOST" "cd '$DIR' && PROXY_NETWORK='${PROXY_NETWORK:-caddy}' TANKS_VERSION='$TANKS_VERSION' docker compose up -d --build && docker compose restart tanks"
echo "deployed $TANKS_VERSION"
