#!/data/data/com.termux/files/usr/bin/bash
#
# backup-history.sh — pull the agent's history down to this device.
#
# The run archive lives on a Railway volume, which no other machine can
# reach. This copies it into ./history next to the project, so the full
# record sits on hardware you own.
#
# It is incremental. The archive is append-only, so whatever you already
# have never changes; the script asks the server how many bytes exist,
# compares that to the local copy, and downloads only the difference.
# A day's runs are a few hundred KB, so a daily backup over mobile data
# costs approximately nothing.
#
# Usage:
#   bash backup-history.sh                 # incremental
#   bash backup-history.sh --full          # start over from byte zero
#
# Requires AGENT_PASSCODE. Either export it, or put it in .backup-env
# next to this script as: AGENT_PASSCODE=...

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/history"
BASE="${AGENT_URL:-https://referral-market-production.up.railway.app}"

FULL=0
ENV_FILE="$HOME/.darkly-backup-env"

while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1 ;;
    --passcode) shift; AGENT_PASSCODE="${1:-}" ;;
    --save-passcode)
      shift
      printf 'AGENT_PASSCODE=%s\n' "${1:-}" > "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      echo "Saved to $ENV_FILE (${#1} characters)."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Read the passcode by PARSING the file, never by sourcing it.
#
# Sourcing executes the file as shell, which means a stray $ or quote in
# the value crashes the script with something unrelated to the actual
# problem -- and it makes a secrets file into executable code, which is a
# bad habit even when you wrote the file yourself.
if [ -z "${AGENT_PASSCODE:-}" ] && [ -f "$ENV_FILE" ]; then
  AGENT_PASSCODE=$(
    sed -n 's/^[[:space:]]*AGENT_PASSCODE[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" \
      | head -1 | tr -d '\r'
  )
  # Tolerate a value someone wrapped in quotes.
  AGENT_PASSCODE=${AGENT_PASSCODE#\"}; AGENT_PASSCODE=${AGENT_PASSCODE%\"}
  AGENT_PASSCODE=${AGENT_PASSCODE#\'}; AGENT_PASSCODE=${AGENT_PASSCODE%\'}
fi

if [ -z "${AGENT_PASSCODE:-}" ]; then
  echo "No passcode found."
  if [ -f "$ENV_FILE" ]; then
    echo "  $ENV_FILE exists but has no usable AGENT_PASSCODE= line."
  else
    echo "  $ENV_FILE does not exist."
  fi
  echo
  echo "Save it with:"
  echo "  bash backup-history.sh --save-passcode YOURPASSCODE"
  exit 1
fi

# Catch the two ways this has actually gone wrong, rather than sending a
# bad passcode and reporting a confusing 401.
case "$AGENT_PASSCODE" in
  '$'[A-Za-z_]*|'${'*)
    # An unexpanded shell variable, not a passcode. A '$' elsewhere in the
    # value is fine and is left alone -- the file is parsed, not executed.
    echo "The stored passcode looks like an unexpanded shell variable"
    echo "($AGENT_PASSCODE), not an actual value."
    echo "Re-save it with:  bash backup-history.sh --save-passcode YOURPASSCODE"
    exit 1
    ;;
  ghp_*|github_pat_*)
    echo "That looks like a GitHub token, not the console passcode."
    echo "AGENT_PASSCODE is the passcode you type to log into Darkly."
    exit 1
    ;;
  your-passcode*|YOURPASSCODE*)
    echo "The stored passcode is still the placeholder text."
    echo "Re-save it with:  bash backup-history.sh --save-passcode YOURPASSCODE"
    exit 1
    ;;
esac

echo "Using a passcode of ${#AGENT_PASSCODE} characters."

mkdir -p "$DEST"

fetch() {
  local key="$1" local_file="$2" append="$3"

  local meta
  meta=$(curl -sS -H "x-agent-passcode: $AGENT_PASSCODE" \
    "$BASE/export-history?file=$key&meta=1") || {
      echo "  !! could not reach the agent"; return 1; }

  case "$meta" in
    *Unauthorized*)
      echo "  !! $key: the server rejected the passcode."
      echo "     It must match AGENT_PASSCODE in the Railway variables —"
      echo "     the same passcode you use to log into the console."
      return 1 ;;
    *"Not found"*)
      echo "  !! $key: the server has no /export-history route."
      echo "     The deployed build predates it. Run 'railway up' and retry."
      return 1 ;;
    *'"error"'*)
      echo "  !! $key: $meta"
      return 1 ;;
  esac

  local remote_bytes
  remote_bytes=$(echo "$meta" | grep -o '"bytes":[0-9]*' | head -1 | cut -d: -f2)
  remote_bytes=${remote_bytes:-0}

  local have=0
  if [ "$append" = "1" ] && [ "$FULL" = "0" ] && [ -f "$local_file" ]; then
    have=$(wc -c < "$local_file" | tr -d ' ')
  fi

  if [ "$remote_bytes" -eq 0 ]; then
    echo "  $key: nothing on the server yet"
    return 0
  fi

  # A local copy LARGER than the server's means the archive was rebuilt
  # or the volume was replaced — the bytes no longer correspond. Appending
  # from here would splice unrelated records together into a file that
  # parses fine and is quietly wrong. Set the old copy aside (never delete
  # it; it may be the only record of that period) and start over.
  if [ "$append" = "1" ] && [ "$have" -gt "$remote_bytes" ]; then
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    mv "$local_file" "$local_file.superseded-$stamp"
    echo "  $key: server archive is smaller than the local copy — it was rebuilt."
    echo "       previous copy kept as $(basename "$local_file").superseded-$stamp"
    have=0
  fi

  if [ "$append" = "1" ] && [ "$have" -eq "$remote_bytes" ]; then
    echo "  $key: up to date ($(( have / 1024 )) KB)"
    return 0
  fi

  local offset=0
  [ "$append" = "1" ] && offset=$have

  if [ "$append" = "1" ]; then
    curl -sS -H "x-agent-passcode: $AGENT_PASSCODE" \
      "$BASE/export-history?file=$key&offset=$offset" >> "$local_file" || return 1
    echo "  $key: +$(( (remote_bytes - offset) / 1024 )) KB (now $(( remote_bytes / 1024 )) KB)"
  else
    # Snapshot files are rewritten in place, so they are replaced whole.
    # Write to a temp file first: a failed download must not destroy the
    # last good backup.
    curl -sS -H "x-agent-passcode: $AGENT_PASSCODE" \
      "$BASE/export-history?file=$key" > "$local_file.tmp" || return 1
    mv "$local_file.tmp" "$local_file"
    echo "  $key: $(( remote_bytes / 1024 )) KB (replaced)"
  fi
}

echo "Backing up to $DEST"
echo

# Append-only: only the new tail is fetched.
fetch runs   "$DEST/darkly-runs.jsonl"      1

# Snapshots: small, rewritten in place, so copied whole.
fetch trades "$DEST/darkly-trades.json"     0
fetch state  "$DEST/darkly-autotrader.json" 0

echo
if [ -f "$DEST/darkly-runs.jsonl" ]; then
  echo "Runs archived locally: $(wc -l < "$DEST/darkly-runs.jsonl" | tr -d ' ')"
fi
echo "Done. Nothing here is ever deleted or overwritten in place."
