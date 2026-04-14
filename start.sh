#!/bin/bash
echo "Clearing any existing Telegram sessions..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true" > /dev/null
sleep 30
echo "Starting bot..."
while true; do
  node bot.js
  echo "Bot exited. Waiting 30 seconds before restart..."
  sleep 30
done
