#!/data/data/com.termux/files/usr/bin/bash
#===============================================================================
# TradingBot - Android Start Script
# Place this in your home directory or run from android/
# Usage: bash start.sh
#===============================================================================

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SESSION_NAME="tradingbot"

# Parse arguments
FOREGROUND=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --foreground|-f) FOREGROUND=true; shift ;;
    --kill|-k)
      echo -e "${YELLOW}Stopping bot...${NC}"
      screen -XS "$SESSION_NAME" quit 2>/dev/null || true
      if command -v termux-wake-unlock &> /dev/null; then
        termux-wake-unlock 2>/dev/null || true
      fi
      echo -e "${GREEN}Bot stopped.${NC}"
      exit 0
      ;;
    --status|-s)
      if screen -list | grep -q "$SESSION_NAME"; then
        echo -e "${GREEN}Bot is running.${NC}"
        exit 0
      else
        echo -e "${RED}Bot is not running.${NC}"
        exit 1
      fi
      ;;
    --logs|-l)
      tail -f "$PROJECT_DIR/logs/bot.log" 2>/dev/null || echo -e "${YELLOW}No log file found.${NC}"
      exit 0
      ;;
    --help|-h)
      echo "Usage: bash start.sh [OPTION]"
      echo "Start the TradingBot on Android via Termux."
      echo ""
      echo "Options:"
      echo "  -f, --foreground   Run in foreground (not in screen)"
      echo "  -k, --kill         Stop the bot"
      echo "  -s, --status       Check if bot is running"
      echo "  -l, --logs         Tail the log file"
      echo "  -h, --help         Show this help"
      exit 0
      ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
  echo -e "${RED}Node.js is not installed. Run the setup script first.${NC}"
  echo -e "${YELLOW}  bash android/termux-setup.sh${NC}"
  exit 1
fi

# Check if dependencies are installed
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo -e "${YELLOW}Dependencies not installed. Installing...${NC}"
  cd "$PROJECT_DIR" && npm install
fi

# Check if config exists
if [ ! -f "$PROJECT_DIR/config/config.json" ]; then
  echo -e "${RED}Config file not found at $PROJECT_DIR/config/config.json${NC}"
  echo -e "${YELLOW}Run the setup script first: bash android/termux-setup.sh${NC}"
  exit 1
fi

# Foreground mode (simple node run)
if [ "$FOREGROUND" = true ]; then
  echo -e "${GREEN}Starting TradingBot in foreground...${NC}"
  cd "$PROJECT_DIR"
  node index.js
  exit $?
fi

# Screen mode (background)
echo -e "${YELLOW}"
echo "╔══════════════════════════════════════════════╗"
echo "║     TradingBot for Android                   ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# Acquire wake lock
if command -v termux-wake-lock &> /dev/null; then
  echo -e "${YELLOW}• Acquiring wake lock (prevents sleep)...${NC}"
  termux-wake-lock
fi

# Check if already running
if screen -list | grep -q "$SESSION_NAME"; then
  echo -e "${YELLOW}• Bot is already running in session '${SESSION_NAME}'.${NC}"
  echo ""
  echo -e "  ${BOLD}Reattach:${NC}  screen -r $SESSION_NAME"
  echo -e "  ${BOLD}Detach:${NC}    Ctrl+A, D"
  echo -e "  ${BOLD}Stop:${NC}      bash start.sh --kill"
  exit 0
fi

# Start bot
cd "$PROJECT_DIR"
screen -dmS "$SESSION_NAME" bash -c "
  echo 'TradingBot started at \$(date)' >> logs/bot.log 2>/dev/null
  node index.js 2>&1 | tee -a logs/bot.log
"

echo -e "${GREEN}✓ Bot started in background session '${SESSION_NAME}'.${NC}"
echo ""
echo -e "  ${BOLD}Reattach:${NC}  screen -r $SESSION_NAME"
echo -e "  ${BOLD}Detach:${NC}    Ctrl+A, D"
echo -e "  ${BOLD}Stop:${NC}      bash start.sh --kill"
echo -e "  ${BOLD}Logs:${NC}      bash start.sh --logs"
echo ""