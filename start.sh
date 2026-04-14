#!/bin/bash
while true; do
  node bot.js
  echo "Bot exited. Waiting 15 seconds before restart..."
  sleep 15
done
