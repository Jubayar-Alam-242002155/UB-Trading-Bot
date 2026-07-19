# TradingBot for Android (Termux)

Runs the Minecraft stock trading bot on Android using Termux.

## Prerequisites

- Android 8.0+ (API 26+)
- [Termux](https://termux.com/) from F-Droid (NOT Google Play - it's outdated)
- At least 150 MB free storage
- Stable internet connection

## Installation (One Command)

Open Termux and run:

```bash
curl -sL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/android/termux-setup.sh | bash
```

Or manual setup:

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs-lts git screen openssh
git clone <your-repo-url>
cd TradingBot/android
chmod +x termux-setup.sh
./termux-setup.sh
```

## Configuration

Edit `config/config.json` with the correct server details:

```bash
nano config/config.json
```

Key settings for Android:
- **Keep screen on**: Install `Termux:WakeLock` from F-Droid to prevent Android from killing the bot
- **Battery optimization**: Disable battery optimization for Termux in Android settings

## Running the Bot

### Basic Run

```bash
cd ~/TradingBot
node index.js
```

### With Screen (recommended - runs in background)

```bash
cd ~/TradingBot
screen -S tradingbot node index.js
```

Detach: `Ctrl+A, D`
Reattach: `screen -r tradingbot`
Kill screen session: `screen -XS tradingbot quit`

### With Termux:WakeLock (prevents sleep)

```bash
cd ~/TradingBot
termux-wake-lock
node index.js
```

## Android-Specific Notes

### Keep alive in background
- Install **Termux:WakeLock** and **Termux:Boot** from F-Droid
- Use `termux-wake-lock` before starting the bot
- Disable battery optimization for Termux

### Auto-start on boot (with Termux:Boot)

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/tradingbot << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/TradingBot
screen -dmS tradingbot node index.js
EOF
chmod +x ~/.termux/boot/tradingbot
```

### Scheduled restart (cron)

```bash
pkg install -y termux-services
mkdir -p ~/.termux/cron
echo "0 */6 * * * cd ~/TradingBot && screen -XS tradingbot quit && sleep 2 && screen -dmS tradingbot node index.js" > ~/.termux/cron/restart_tradingbot
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot stops when screen off | Install Termux:WakeLock, disable battery optimization |
| "pkg: command not found" | Run `pkg update` first |
| "Cannot find module mineflayer" | Run `npm install` in project root |
| Termux keeps crashing | Clear Termux data: Settings → Apps → Termux → Clear Data |
| Connection timeout | Check server IP/port, switch between WiFi/mobile data |

## File Structure

```
android/
├── README.md          # This file
├── termux-setup.sh    # One-command installer for Termux
├── start.sh           # Startup script with wake lock
└── BotApp/            # (Optional) Termux:Widget shortcut script