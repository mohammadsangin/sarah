#!/usr/bin/env bash
#
# Registers the "lookup_product" function tool with Vapi, points it at the
# deployed /api/vapi-tool endpoint, attaches it to the assistant, and appends
# the lookup instruction to the assistant's system prompt.
#
# Requires: curl, jq
#
# Usage:
#   export VAPI_PRIVATE_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#   export VAPI_TOOL_URL="https://<your-deployment>/api/vapi-tool"
#   export ASSISTANT_ID="f67cfb35"     # use the full assistant UUID from Vapi
#   ./scripts/register-vapi-tool.sh
#
set -euo pipefail

: "${VAPI_PRIVATE_KEY:?Set VAPI_PRIVATE_KEY}"
: "${VAPI_TOOL_URL:?Set VAPI_TOOL_URL to the deployed /api/vapi-tool URL}"
: "${ASSISTANT_ID:?Set ASSISTANT_ID (the Vapi assistant id)}"

API="https://api.vapi.ai"
AUTH="Authorization: Bearer ${VAPI_PRIVATE_KEY}"
INSTRUCTION="If the caller asks about products, prices, availability, or specs, call lookup_product before answering — never guess."

echo "==> Creating the lookup_product function tool..."
TOOL_PAYLOAD=$(jq -n --arg url "$VAPI_TOOL_URL" '{
  type: "function",
  function: {
    name: "lookup_product",
    description: "Look up live product information (price, availability, specs) from the store catalog.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What the caller is asking about, e.g. product name, type, or feature."
        }
      },
      required: ["query"]
    }
  },
  server: { url: $url }
}')

TOOL_RESP=$(curl -sS -X POST "$API/tool" -H "$AUTH" -H "Content-Type: application/json" -d "$TOOL_PAYLOAD")
TOOL_ID=$(echo "$TOOL_RESP" | jq -r '.id // empty')
if [ -z "$TOOL_ID" ]; then
  echo "ERROR: tool creation failed:"; echo "$TOOL_RESP" | jq . 2>/dev/null || echo "$TOOL_RESP"; exit 1
fi
echo "    created tool id: $TOOL_ID"

echo "==> Reading current assistant config..."
ASSISTANT=$(curl -sS "$API/assistant/${ASSISTANT_ID}" -H "$AUTH")
if [ "$(echo "$ASSISTANT" | jq -r 'has("model")')" != "true" ]; then
  echo "ERROR: could not read assistant ${ASSISTANT_ID}:"; echo "$ASSISTANT" | jq . 2>/dev/null || echo "$ASSISTANT"; exit 1
fi

echo "==> Attaching tool + appending system-prompt instruction..."
# Merge: add TOOL_ID to model.toolIds (dedup), and append the instruction to the
# existing system message (or create one if none exists).
PATCH=$(echo "$ASSISTANT" | jq \
  --arg tid "$TOOL_ID" \
  --arg instr "$INSTRUCTION" '
  .model as $m
  | ($m.toolIds // []) as $ids
  | ($ids + [$tid] | unique) as $newids
  | ($m.messages // []) as $msgs
  | (if ($msgs | map(.role) | index("system")) != null
       then ($msgs | map(if .role == "system"
              then .content = ((.content // "") + "\n" + $instr) else . end))
       else ($msgs + [{role:"system", content:$instr}]) end) as $newmsgs
  | { model: ($m + { toolIds: $newids, messages: $newmsgs }) }
')

PATCH_RESP=$(curl -sS -X PATCH "$API/assistant/${ASSISTANT_ID}" -H "$AUTH" -H "Content-Type: application/json" -d "$PATCH")
if [ "$(echo "$PATCH_RESP" | jq -r '.id // empty')" = "" ]; then
  echo "ERROR: assistant update failed:"; echo "$PATCH_RESP" | jq . 2>/dev/null || echo "$PATCH_RESP"; exit 1
fi

echo "    tool ids now: $(echo "$PATCH_RESP" | jq -c '.model.toolIds')"
echo "==> Done. lookup_product created ($TOOL_ID) and attached to assistant ${ASSISTANT_ID}."
