#!/bin/bash
set -e

# ── Siftly Launcher ───────────────────────────────────────────────────────────
# Run this once to set up and start Siftly.
# After first run, just run it again to start the app.
# ─────────────────────────────────────────────────────────────────────────────

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${BLUE}  Siftly${NC}"
echo "  AI-powered bookmark manager"
echo ""

# ── 1. Create .env if missing ────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo '  Creating .env with default DATABASE_URL...'
  echo 'DATABASE_URL="file:./prisma/dev.db"' > .env
  echo ""
fi

# ── 2. Install dependencies if needed ─────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
  echo ""
fi

# ── 3. Set up database ────────────────────────────────────────────────────────
GENERATED_CLIENT="app/generated/prisma/client/index.js"
SCHEMA_FILE="prisma/schema.prisma"

# Only regenerate if client is missing or schema is newer
if [ ! -f "$GENERATED_CLIENT" ] || [ "$SCHEMA_FILE" -nt "$GENERATED_CLIENT" ]; then
  echo "  Generating Prisma client..."
  npx prisma generate
fi

if [ ! -f "prisma/dev.db" ]; then
  echo "  Setting up database..."
  npx prisma migrate deploy 2>/dev/null || npx prisma db push
else
  # Ensure migrations are up-to-date on existing databases
  npx prisma migrate deploy 2>/dev/null || true
fi
echo ""

# ── 4. Check auth ─────────────────────────────────────────────────────────────
if command -v claude &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Claude CLI detected — AI features will use your subscription automatically"
else
  echo -e "  ${YELLOW}i${NC} Claude CLI not found. Add your API key in Settings after opening the app."
fi
echo ""

# ── 5. Start Cloudflare tunnel if token is present ───────────────────────────
PORT=${PORT:-3000}

# Source tunnel token from .env
if grep -q "CLOUDFLARE_TUNNEL_TOKEN" .env 2>/dev/null; then
  CLOUDFLARE_TUNNEL_TOKEN=$(grep "^CLOUDFLARE_TUNNEL_TOKEN=" .env | cut -d= -f2-)
fi

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo -e "  ${GREEN}✓${NC} Cloudflare tunnel starting in background"
  cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
  TUNNEL_PID=$!
  trap "kill $TUNNEL_PID 2>/dev/null" EXIT
fi

# ── 6. Start Telegram bot if token is configured ─────────────────────────────
TELEGRAM_TOKEN=""
for env_file in ".env.local" ".env"; do
  if [ -f "$env_file" ] && grep -q "^TELEGRAM_BOT_TOKEN=" "$env_file" 2>/dev/null; then
    val=$(grep "^TELEGRAM_BOT_TOKEN=" "$env_file" | cut -d= -f2-)
    if [[ -n "$val" && "$val" != "PASTE_YOUR_TOKEN_HERE" ]]; then
      TELEGRAM_TOKEN="$val"
      break
    fi
  fi
done

if [[ -n "$TELEGRAM_TOKEN" ]]; then
  if command -v python3 &>/dev/null && [ -f "telegram_bot.py" ]; then
    echo -e "  ${GREEN}✓${NC} Starting Telegram bot in background"
    python3 telegram_bot.py &
    BOT_PID=$!
    trap "kill $BOT_PID 2>/dev/null; kill ${TUNNEL_PID:-} 2>/dev/null" EXIT
  else
    echo -e "  ${YELLOW}i${NC} Telegram bot skipped — python3 not found or telegram_bot.py missing"
  fi
else
  echo -e "  ${YELLOW}i${NC} Telegram bot skipped — set TELEGRAM_BOT_TOKEN in .env.local to enable"
fi
echo ""

# ── 7. Open browser and start ─────────────────────────────────────────────────
echo "  Starting on http://localhost:$PORT"
echo "  Press Ctrl+C to stop"
echo ""

# Cross-platform browser open
open_browser() {
  local url="$1"
  case "$(uname -s)" in
    Darwin)  open "$url" ;;
    Linux)   xdg-open "$url" 2>/dev/null || sensible-browser "$url" 2>/dev/null ;;
    MINGW*|MSYS*|CYGWIN*) start "$url" ;;
    *)       echo "  Open $url in your browser" ;;
  esac
}

(sleep 2 && open_browser http://localhost:$PORT) &

npx next dev -p $PORT
