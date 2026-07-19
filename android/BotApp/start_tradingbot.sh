#!/data/data/com.termux/files/usr/bin/bash
#===============================================================================
# TradingBot - Termux:Widget Launcher
# Place this in ~/.shortcuts/ for Termux:Widget to detect it.
# Then you can add a homescreen widget that starts the bot with one tap.
#===============================================================================

# Kill any existing session
screen -XS tradingbot quit 2>/dev/null || true

# Acquire wake lock
termux-wake-lock 2>/dev/null || true

# Start bot
cd ~/TradingBot
screen -dmS tradingbot node index.js

# Notify
termux-notification --id tradingbot --title "TradingBot" --content "Bot started" --action "screen -r tradingbot" 2>/dev/null || true