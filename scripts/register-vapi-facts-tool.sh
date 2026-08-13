#!/usr/bin/env bash
#
# Registers the "lookup_policy" function tool with Vapi, points it at the
# deployed /api/vapi-facts endpoint, attaches it to the assistant, and appends
# the lookup instruction to the assistant's system prompt.
#
# This is the delivery/returns/lead-time/warranty counterpart to
# register-vapi-tool.sh (which does the same for products / lookup_product).
#
# Requires: curl, jq
#
# Usage:
#   export VAPI_PRIVATE_KEY="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
#   export VAPI_FACTS_URL="https://<your-deployment>/api/vapi-facts"
#   export ASSISTANT_ID="f67cfb35-5f40-430d-b70f-718940af7a43"   # full UUID
#   ./scripts/register-vapi-facts-tool.sh
#
set -euo pipefail

: "${VAPI_PRIVATE_KEY:?Set VAPI_PRIVATE_KEY}"
: "${VAPI_FACTS_URL:?Set VAPI_FACTS_URL to the deployed /api/vapi-facts URL}"
: "${ASSISTANT_ID:?Set ASSISTANT_ID (the Vapi assistant id)}"

API="https://api.vapi.ai"
AUTH="Authorization: Bearer ${VAPI_PRIVATE_KEY}"
INSTRUCTION="For delivery cost or the free-delivery threshold, delivery time or lead times, returns or refunds, warranty, whether a bulb is included, or VAT, call lookup_policy before answering — never guess these and never say you cannot provide them. Lead times vary by maker, so include the product name or maker (for example Soho or Mullan) in the query when you call it. Speak the tool's result as-is; do not add figures of your own."

echo "==> Creating the lookup_policy function tool..."
TOOL_PAYLOAD=$(jq -n --arg url "$VAPI_FACTS_URL" '{
  type: "function",
  function: {
    name: "lookup_policy",
    description: "Look up official Kymra Lighting company facts: delivery cost and the free-delivery threshold, delivery lead times (which vary by maker — Soho stock vs Mullan made-to-order), returns and refunds, warranty, whether a bulb is included, and VAT. Call this for any such question instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The caller'\''s question, e.g. '\''how much is delivery'\'', '\''how long for a Mullan pendant'\'', '\''what'\''s your returns policy'\''. For lead-time questions, include the product name or maker if known."
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
# Merge: add TOOL_ID to model.toolIds (dedup), and append the instruction to
# the existing system message (or create one if none exists). The instruction
# is only appended if it isn't already present, so re-running is idempotent.
PATCH=$(echo "$ASSISTANT" | jq \
  --arg tid "$TOOL_ID" \
  --arg instr "$INSTRUCTION" '
  .model as $m
  | ($m.toolIds // []) as $ids
  | ($ids + [$tid] | unique) as $newids
  | ($m.messages // []) as $msgs
  | (if ($msgs | map(.role) | index("system")) != null
       then ($msgs | map(if .role == "system"
              then .content = (if ((.content // "") | contains($instr))
                                 then .content
                                 else ((.content // "") + "\n" + $instr) end)
              else . end))
       else ($msgs + [{role:"system", content:$instr}]) end) as $newmsgs
  | { model: ($m + { toolIds: $newids, messages: $newmsgs }) }
')

PATCH_RESP=$(curl -sS -X PATCH "$API/assistant/${ASSISTANT_ID}" -H "$AUTH" -H "Content-Type: application/json" -d "$PATCH")
if [ "$(echo "$PATCH_RESP" | jq -r '.id // empty')" = "" ]; then
  echo "ERROR: assistant update failed:"; echo "$PATCH_RESP" | jq . 2>/dev/null || echo "$PATCH_RESP"; exit 1
fi

echo "    tool ids now: $(echo "$PATCH_RESP" | jq -c '.model.toolIds')"
echo "==> Done. lookup_policy created ($TOOL_ID) and attached to assistant ${ASSISTANT_ID}."
echo
echo "Quick test once deployed:"
echo "  curl -s -X POST \"$VAPI_FACTS_URL\" -H 'content-type: application/json' \\"
echo "    -d '{\"message\":{\"toolCallList\":[{\"id\":\"t1\",\"function\":{\"arguments\":{\"query\":\"how much is delivery\"}}}]}}'"
