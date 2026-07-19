#!/data/data/com.termux/files/usr/bin/bash
#===============================================================================
# TradingBot - Termux (Android) Setup Script
# Installs all dependencies and clones the bot repository.
#===============================================================================

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BOLD}${GREEN}"
echo "╔══════════════════════════════════════════════╗"
echo "║     TradingBot - Termux Setup                ║"
echo "║     Minecraft Stock Trading Bot for Android  ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ------------------------------------------------------------------
# 1. Update package lists
# ------------------------------------------------------------------
echo -e "${YELLOW}[1/6] Updating Termux packages...${NC}"
pkg update -y && pkg upgrade -y

# ------------------------------------------------------------------
# 2. Install required packages
# ------------------------------------------------------------------
echo -e "${YELLOW}[2/6] Installing Node.js, Git, Screen, and utilities...${NC}"
pkg install -y nodejs-lts git screen openssh termux-services

# ------------------------------------------------------------------
# 3. Clone the repository (if not already cloned)
# ------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/YOUR_USER/TradingBot.git}"
PROJECT_DIR="$HOME/TradingBot"

if [ -d "$PROJECT_DIR" ]; then
  echo -e "${YELLOW}[3/6] Project directory already exists. Updating...${NC}"
  cd "$PROJECT_DIR"
  git pull
else
  echo -e "${YELLOW}[3/6] Cloning TradingBot repository...${NC}"
  git clone "$REPO_URL" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

# ------------------------------------------------------------------
# 4. Install Node.js dependencies
# ------------------------------------------------------------------
echo -e "${YELLOW}[4/6] Installing npm dependencies...${NC}"
npm install

# ------------------------------------------------------------------
# 5. Create config directory and default config if missing
# ------------------------------------------------------------------
echo -e "${YELLOW}[5/6] Ensuring config files exist...${NC}"
mkdir -p config data storage logs debug

if [ ! -f config/config.json ]; then
  cat > config/config.json << 'CONFIGEOF'
{
  "server": {
    "host": "play.unitedbangla.fun",
    "port": 25565
  },
  "account": {
    "username": "Tahsan_69",
    "password": "CHANGE_ME",
    "auth": "offline"
  },
  "reconnect": {
    "enabled": true,
    "delayMs": 10000,
    "maxDelayMs": 60000,
    "backoffMultiplier": 1.5,
    "jitterMs": 2000,
    "maxAttempts": 10
  },
  "manualVerification": {
    "enabled": true,
    "fallbackAfterAttempts": 3,
    "retryCommand": "retry"
  },
  "manualControl": {
    "enabled": true,
    "lookStepDegrees": 20
  },
  "market": {
    "command": "/stockmarket",
    "minCheckIntervalMs": 30000,
    "maxCheckIntervalMs": 50000,
    "updateKeywords": [
      "market update",
      "market updated",
      "market crash",
      "market rise",
      "stock update",
      "stocks updated",
      "stock market",
      "ticker"
    ],
    "marketAnnouncementDedupMs": 5000,
    "mainWindowTitleContains": "UB Stock Market",
    "tickerItemName": "Live Market Ticker",
    "postLoginHomeCommand": "/home home1",
    "postLoginTeleportTimeoutMs": 6000,
    "postLoginTeleportFallbackDelayMs": 3000,
    "postLoginTeleportMovementThreshold": 3,
    "postLoginTeleportSuccessKeywords": ["teleport", "warped", "home"],
    "buyConfirmButtonTimeoutMs": 10000,
    "buyConfirmationResultTimeoutMs": 12000,
    "sellConfirmButtonTimeoutMs": 10000,
    "sellConfirmationResultTimeoutMs": 12000,
    "guiOpenTimeoutMs": 15000,
    "guiStepTimeoutMs": 10000,
    "guiActionDelayMs": 700
  },
  "trading": {
    "enabled": true,
    "reserveCash": 200,
    "maxAllocationPerCompany": 0.35,
    "maxSharesPerCompany": 500,
    "marketMinPrice": 800,
    "marketMaxPrice": 1200,
    "fallbackBuyBelow": 900,
    "fallbackSellAbove": 800,
    "cooldownMs": 20000,
    "minHoldDurationMs": 120000,
    "buyAggressiveness": 1,
    "sellAggressiveness": 1,
    "scoreThresholdBuy": 0.55,
    "scoreThresholdSell": 0.55,
    "rollingWindowSize": 30
  },
  "debug": {
    "enabled": false,
    "logWindowContents": false,
    "logClicks": true,
    "logParsedPrices": true,
    "logDecisions": true
  },
  "strategy": {
    "buyThreshold": 830,
    "sellThreshold": 1095
  },
  "logLevel": "info"
}
CONFIGEOF
  echo -e "${YELLOW}  Default config created. Edit config/config.json to set your credentials.${NC}"
fi

# ------------------------------------------------------------------
# 6. Create start script
# ------------------------------------------------------------------
echo -e "${YELLOW}[6/6] Creating start script...${NC}"

cat > "$HOME/start-tradingbot.sh" << 'STARTEOF'
#!/data/data/com.termux/files/usr/bin/bash
#===============================================================================
# TradingBot - Android Start Script
# Acquires wake lock, starts the bot in a screen session.
#===============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PROJECT_DIR="$HOME/TradingBot"
SESSION_NAME="tradingbot"

# Check if already running
if screen -list | grep -q "$SESSION_NAME"; then
  echo -e "${YELLOW}Bot is already running in screen session '${SESSION_NAME}'.${NC}"
  echo -e "  Reattach:  ${BOLD}screen -r $SESSION_NAME${NC}"
  echo -e "  Stop:      ${BOLD}screen -XS $SESSION_NAME quit${NC}"
  exit 0
fi

# Acquire wake lock (prevents Android from sleeping)
if command -v termux-wake-lock &> /dev/null; then
  echo -e "${YELLOW}Acquiring wake lock...${NC}"
  termux-wake-lock
fi

# Start bot in screen session
echo -e "${GREEN}Starting TradingBot in screen session '${SESSION_NAME}'...${NC}"
cd "$PROJECT_DIR"
screen -dmS "$SESSION_NAME" node index.js

echo -e "${GREEN}Bot started!${NC}"
echo -e ""
echo -e "  Reattach:  ${BOLD}screen -r $SESSION_NAME${NC}"
echo -e "  Detach:    ${BOLD}Ctrl+A, D${NC}"
echo -e "  Stop:      ${BOLD}screen -XS $SESSION_NAME quit${NC}"
echo -e "  Logs:      ${BOLD}cat $PROJECT_DIR/logs/bot.log${NC}"
STARTEOF

chmod +x "$HOME/start-tradingbot.sh"

# ------------------------------------------------------------------
# Done
# ------------------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║  Setup Complete!                             ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}1. Edit config:${NC}"
echo -e "     nano $PROJECT_DIR/config/config.json"
echo ""
echo -e "  ${BOLD}2. Start bot:${NC}"
echo -e "     bash ~/start-tradingbot.sh"
echo ""
echo -e "  ${BOLD}3. View logs:${NC}"
echo -e "     tail -f $PROJECT_DIR/logs/bot.log"
echo ""
echo -e "  ${BOLD}4. Stop bot:${NC}"
echo -e "     screen -XS tradingbot quit"
echo ""
echo -e "  ${BOLD}5. Reattach to bot:${NC}"
echo -e "     screen -r tradingbot"
echo ""