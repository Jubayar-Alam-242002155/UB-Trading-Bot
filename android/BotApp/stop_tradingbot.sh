#!/data/data/com.termux/files/usr/bin/bash
#===============================================================================
# TradingBot - Termux:Widget Stop Script
# Place this in ~/.shortcuts/ alongside start_tradingbot.sh
#===============================================================================

# Kill the screen session
screen -XS tradingbot quit 2>/dev/null || true

# Release wake lock
termux-wake-unlock 2>/dev/null || true

# Notify
termux-notification --id tradingbot --title "TradingBot" --content "Bot stopped" 2>/dev/null || true