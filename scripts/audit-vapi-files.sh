#!/usr/bin/env bash
#
# Audits the files in the Vapi account and helps clean up duplicates — e.g. the
# nine copies of kymra-sarah-knowledge-base-v7.txt. Read-only by default; only
# deletes when you explicitly pass --delete.
#
# Requires: curl, jq
#
# Usage:
#   export VAPI_PRIVATE_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#
#   # 1) List every file with id / name / size / created-at, and flag dupes:
#   ./scripts/audit-vapi-files.sh
#
#   # 2) Preview which duplicates would be removed (keeps the newest of each
#   #    duplicated name; dry run, deletes nothing):
#   ./scripts/audit-vapi-files.sh --plan
#
#   # 3) Actually delete the flagged duplicates (keeps newest per name):
#   ./scripts/audit-vapi-files.sh --delete
#
#   # Target a specific name instead of "any duplicated name":
#   ./scripts/audit-vapi-files.sh --plan  --name kymra-sarah-knowledge-base-v7.txt
#   ./scripts/audit-vapi-files.sh --delete --name kymra-sarah-knowledge-base-v7.txt
#
# SAFETY: a file that is still referenced by a query tool / knowledge base is
# never auto-deleted — the script warns and skips it. Check the assistant with
# inspect-vapi-assistant.sh first.
#
set -euo pipefail

: "${VAPI_PRIVATE_KEY:?Set VAPI_PRIVATE_KEY}"

API="https://api.vapi.ai"
AUTH="Authorization: Bearer ${VAPI_PRIVATE_KEY}"

MODE="list"          # list | plan | delete
ONLY_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan)   MODE="plan" ;;
    --delete) MODE="delete" ;;
    --list)   MODE="list" ;;
    --name)   ONLY_NAME="${2:?--name needs a value}"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

FILES=$(curl -sS "$API/file" -H "$AUTH")
# The list endpoint returns either a bare array or {data:[...]} across versions.
FILES=$(echo "$FILES" | jq 'if type=="array" then . else (.data // .files // []) end')
COUNT=$(echo "$FILES" | jq 'length')

echo "==================================================================="
echo " VAPI FILES  ($COUNT total)"
echo "==================================================================="
echo "$FILES" | jq -r '
  sort_by(.name, (.createdAt // ""))[] |
  "  \(.name // "(no name)")\n      id=\(.id)  bytes=\(.bytes // .size // "?")  created=\(.createdAt // "?")"
'

echo
echo "--- Duplicate names -----------------------------------------------"
DUPES=$(echo "$FILES" | jq -r '
  group_by(.name) | map(select(length>1)) |
  map({name: .[0].name, count: length}) | .[] |
  "  \(.name)  ×\(.count)"
')
if [ -z "$DUPES" ]; then
  echo "  (no duplicated names)"
else
  echo "$DUPES"
fi

if [ "$MODE" = "list" ]; then
  echo
  echo "Re-run with --plan to preview a cleanup, or --delete to remove"
  echo "duplicates (newest copy of each duplicated name is kept)."
  exit 0
fi

# Build the delete list: for each duplicated name (optionally only ONLY_NAME),
# keep the newest by createdAt, mark the rest for deletion.
FILTER='group_by(.name) | map(select(length>1))'
if [ -n "$ONLY_NAME" ]; then
  FILTER="$FILTER | map(select(.[0].name==\$only))"
fi
TO_DELETE=$(echo "$FILES" | jq -r --arg only "$ONLY_NAME" "
  $FILTER
  | map( sort_by(.createdAt // \"\") | .[0:-1] )   # all but the newest
  | add // []
  | .[] | \"\(.id)\t\(.name)\t\(.createdAt // \"?\")\"
")

if [ -z "$TO_DELETE" ]; then
  echo; echo "Nothing to delete."; exit 0
fi

echo
echo "--- Cleanup plan (keeping the newest copy of each name) -----------"
echo "$TO_DELETE" | while IFS=$'\t' read -r id name created; do
  echo "  DELETE  $name   id=$id  created=$created"
done

if [ "$MODE" = "plan" ]; then
  echo
  echo "Dry run only — nothing deleted. Re-run with --delete to apply."
  exit 0
fi

echo
echo "Applying deletions..."
echo "$TO_DELETE" | while IFS=$'\t' read -r id name created; do
  # Guard: refuse to delete a file still referenced by a query tool.
  IN_USE=$(curl -sS "$API/tool" -H "$AUTH" \
    | jq -r --arg id "$id" '
        (if type=="array" then . else (.data // []) end)
        | map(select(.type=="query"))
        | map(.knowledgeBases // [] | map(.fileIds // []) | add // [])
        | add // [] | index($id) // empty')
  if [ -n "$IN_USE" ]; then
    echo "  SKIP (in use by a query tool)  $name  id=$id"
    continue
  fi
  RESP=$(curl -sS -X DELETE "$API/file/${id}" -H "$AUTH")
  echo "  deleted  $name  id=$id"
done

echo "Done."
