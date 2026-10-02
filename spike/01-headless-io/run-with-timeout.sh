#!/bin/sh
# Usage: ./run-with-timeout.sh <seconds> <cmd> [args...]
secs="$1"; shift
exec perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
