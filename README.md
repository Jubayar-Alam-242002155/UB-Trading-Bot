<<<<<<< HEAD
# TradingBot

Professional modular Minecraft Java Edition trading bot built with Mineflayer.

## Implemented capabilities

- Connects to the configured server
- Logs connection status
- Logs all chat messages
- Logs disconnect/kick reasons
- Logs errors
- Auto-runs `/login <password>` when chat contains `/login`
- Auto-runs `/register <password> <password>` when chat contains `/register`
- Reconnects automatically after disconnect with configurable delay
- Caps reconnect attempts to prevent infinite reconnect spam
- Logs GUI metadata on window open (title, id, slot count, all slot item details)
- Runs periodic stock market scans with random interval per cycle
- Parses company prices from market ticker lore and stores full history
- Maintains portfolio state with realized/unrealized profit tracking
- Scores buy/sell opportunities using multi-factor decision engine
- Executes buy/sell through verified GUI navigation with lag-safe waits/timeouts

## Project structure

```
TradingBot/
  index.js
  config.js
  market.js
  market/
    marketReader.js
    decisionEngine.js
    priceHistory.js
    portfolio.js
  gui/
    guiNavigator.js
    companyWindow.js
    buyMenu.js
    sellMenu.js
  utils/
    scheduler.js
    delay.js
    parser.js
    logger.js
  inventory.js
  login.js
  manualControl.js
  storage.js
  logger.js
  utils.js
  config/
    config.json
  data/
    prices.json
    portfolio.json
  storage/
    prices.json
    portfolio.json
  logs/
  README.md
```

## Setup

1. Use Node.js LTS compatible with Mineflayer `4.37.1` (Node >= 22).
2. Update `config/config.json` with your real server and bot account.
3. Install dependencies:
   - `npm install`
4. Start bot:
   - `npm start`

## Notes

- Configure `account.password` in `config/config.json` to enable Phase 2 auto-login/register.
- Reconnect behavior is controlled by `reconnect.enabled`, `reconnect.delayMs`, `reconnect.maxDelayMs`, `reconnect.backoffMultiplier`, `reconnect.jitterMs`, and `reconnect.maxAttempts`.
- If verification-style kicks repeat, manual fallback can pause reconnect and wait for console command (`manualVerification.*` settings).
- Manual control mode is configured by `manualControl.enabled` and `manualControl.lookStepDegrees`.
- Market/trading behavior is configured via `market.*`, `trading.*`, and `debug.*`.
- Writes structured market/portfolio data to `storage/*.json` and mirrored copies to `data/*.json`.

## Manual control mode (terminal commands)

Type commands in the same terminal while the bot is running:

- `manual on` / `manual off`
- `manual status`
- `manual help`
- `look <up|down|left|right> [degrees]`
- `move <forward|back|left|right|jump|sprint|sneak> <on|off>`
- `stop`
- `say <message>`
=======
# UB-Trading-Bot
A smart Minecraft Java trading bot built with Mineflayer. Features automated stock trading, portfolio tracking, GUI parsing, event-driven market monitoring, survival automation, death recovery, and intelligent buy/sell strategies for custom economy servers.
>>>>>>> 90d3672329dd117ce6285e611eb2598c7e4b0f25
