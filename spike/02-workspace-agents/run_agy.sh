#!/bin/bash
# Usage: run_agy.sh <timeout_secs> <cwd> <outfile> -- agy args...
TO="$1"; shift
DIR="$1"; shift
OUT="$1"; shift
# remaining args are the agy invocation (without leading 'agy')
(cd "$DIR" && perl -e 'alarm shift; exec @ARGV' "$TO" agy "$@") > "$OUT" 2>&1
echo "exit=$? (see $OUT)"
