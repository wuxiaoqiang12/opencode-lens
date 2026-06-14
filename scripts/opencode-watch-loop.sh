#!/bin/bash
# opencode-watch-loop.sh — polls lens instances every 15s for permission/question
SCRIPT="${OPENCODE_WATCH_SCRIPT:-$HOME/.hermes/scripts/opencode-watch.py}"
while true; do
    python3 "$SCRIPT"
    sleep 15
done
