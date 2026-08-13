#!/usr/bin/env bash
#
# Diagnostic: dumps everything about the assistant that bears on the
# "knowledge file isn't being read" bug — its system prompt, the tools it has,
# and any knowledge base / file wiring. Read-only; changes nothing.
#
# It answers the key question directly: is the customer-facts .txt actually
# wired into a *query tool / knowledge base* the model can retrieve, or is it
# just an uploaded file that Vapi never injects? (The latter is the bug.)
#
# Requires: curl, jq
#
# Usage:
#   export VAPI_PRIVATE_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#   export ASSISTANT_ID="f67cfb35-5f40-430d-b70f-718940af7a43"
#   ./scripts/inspect-vapi-assistant.sh
#
set -euo pipefail

: "${VAPI_PRIVATE_KEY:?Set VAPI_PRIVATE_KEY}"
: "${ASSISTANT_ID:?Set ASSISTANT_ID (the Vapi assistant id)}"

API="https://api.vapi.ai"
AUTH="Authorization: Bearer ${VAPI_PRIVATE_KEY}"

A=$(curl -sS "$API/assistant/${ASSISTANT_ID}" -H "$AUTH")
if [ "$(echo "$A" | jq -r 'has("model")')" != "true" ]; then
  echo "ERROR: could not read assistant ${ASSISTANT_ID}:"; echo "$A" | jq . 2>/dev/null || echo "$A"; exit 1
fi

echo "==================================================================="
echo " ASSISTANT  $(echo "$A" | jq -r '.name // "(unnamed)"')  [$ASSISTANT_ID]"
echo "==================================================================="

echo
echo "--- Model ---------------------------------------------------------"
echo "$A" | jq -r '.model | "provider: \(.provider)   model: \(.model)"'

echo
echo "--- System prompt(s) ----------------------------------------------"
echo "$A" | jq -r '.model.messages // [] | map(select(.role=="system")) | .[].content'

echo
echo "--- Attached tool IDs ---------------------------------------------"
echo "$A" | jq -r '.model.toolIds // [] | if length==0 then "  (none)" else .[] end'

echo
echo "--- Tool details (name / type / server url) -----------------------"
for tid in $(echo "$A" | jq -r '.model.toolIds // [] | .[]'); do
  T=$(curl -sS "$API/tool/${tid}" -H "$AUTH")
  echo "$T" | jq -r '"  • \(.function.name // .name // .type)   type=\(.type)   url=\(.server.url // "-")   [\(.id)]"'
done

echo
echo "--- Knowledge base wiring (this is the crux of the bug) -----------"
# A file is only retrievable if it's referenced by a knowledge base / query
# tool. Show every place a KB or file could be attached.
echo "model.knowledgeBase:      $(echo "$A" | jq -c '.model.knowledgeBase // "none"')"
echo "model.knowledgeBaseId:    $(echo "$A" | jq -r '.model.knowledgeBaseId // "none"')"
KB_QUERY_TOOLS=$(echo "$A" | jq -r '[.model.toolIds // [] | .[]] | length')
echo "query tools among tools:  checking below…"
FOUND_QUERY=0
for tid in $(echo "$A" | jq -r '.model.toolIds // [] | .[]'); do
  T=$(curl -sS "$API/tool/${tid}" -H "$AUTH")
  if [ "$(echo "$T" | jq -r '.type')" = "query" ]; then
    FOUND_QUERY=1
    echo "  query tool $tid → knowledge bases:"
    echo "$T" | jq -r '.knowledgeBases // [] | .[] | "     - name=\(.name)  fileIds=\(.fileIds)"'
  fi
done

echo
echo "==================================================================="
echo " DIAGNOSIS"
echo "==================================================================="
if [ "$FOUND_QUERY" -eq 0 ] && [ "$(echo "$A" | jq -r '.model.knowledgeBase // "none"')" = "none" ]; then
  cat <<'EOF'
  ⚠  No query tool and no knowledgeBase are attached to this assistant.
     That means any uploaded .txt (kymra-customer-facts-v1.txt,
     kymra-products.txt) is NOT being retrieved or injected — Vapi only
     consults files that are wired into a query tool / knowledge base.
     Sarah has been answering delivery/returns/lead-time questions from the
     base model's guesses, which is exactly the reported bug.

  ✅ Fix: use the deterministic `lookup_policy` function tool in this repo
     (register-vapi-facts-tool.sh → /api/vapi-facts). Facts then come from
     version-controlled code, the same way `lookup_product` already works
     for prices — no retrieval to fail.
EOF
else
  cat <<'EOF'
  A query tool / knowledge base IS attached (details above). If facts are
  still wrong, the likely causes are: (a) the facts file isn't in that KB's
  fileIds, (b) semantic retrieval is missing short policy phrases, or
  (c) a stale file (e.g. kymra-products.txt) carries old figures the model
  reads first. The deterministic `lookup_policy` tool in this repo removes
  the dependency on retrieval entirely and is the recommended fix.
EOF
fi
