#!/usr/bin/env bash
pkill -f "uvicorn app.main:app" && echo "Backend stopped." || echo "Backend was not running."
