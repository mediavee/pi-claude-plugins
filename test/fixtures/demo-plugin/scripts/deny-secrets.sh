#!/bin/sh
input=$(cat)
case "$input" in
  *.env*)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"reading .env is not allowed by demo-plugin"}}'
    ;;
  *)
    exit 0
    ;;
esac
