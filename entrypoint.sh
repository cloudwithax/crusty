#!/bin/bash

# agent-browser daemon starts automatically on first command - no pre-start needed

# run the bot
exec bun run dist/index.js
