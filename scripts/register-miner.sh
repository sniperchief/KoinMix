#!/usr/bin/env bash
#
# Register the KoinMix miner on the Telegraph MinerRegistry.
#
# Exists as a script rather than a documented command line for two reasons.
# First, `registerMiner` has no update function: a wrong argument costs a
# deregister/re-register cycle plus an epoch wait, so the checks below run every
# time rather than relying on someone remembering them. Second, it can be
# invoked as a single argument-free command from PowerShell, which otherwise
# mangles the JSON intents array when passing it to a native executable.
#
#   & "C:\Program Files\Git\bin\bash.exe" scripts/register-miner.sh
#
# Dry-run by default: it simulates the transaction and stops. Nothing is
# broadcast until you pass --send AND type the confirmation it asks for.
#
# The private key is never read, echoed, stored, or passed on a command line.
# It stays in Foundry's encrypted keystore and cast prompts for the password.

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
# Override any of these from the environment, e.g.
#   DIAMOND=0x... RPC=https://mainnet.base.org ./scripts/register-miner.sh

YAML_URL="${YAML_URL:-https://koinmix-production.up.railway.app/telegraph/koinmix.yaml}"
DIAMOND="${DIAMOND:-0x122396E8602BEed349434AA6E83123E7dD97F5A0}"   # Base Sepolia
RPC="${RPC:-https://sepolia.base.org}"
ACCOUNT="${ACCOUNT:-koinmix-deployer}"       # cast wallet keystore name
INTENTS="${INTENTS:-[\"crypto_price\"]}"
MIN_PRICE="${MIN_PRICE:-10000}"              # 6-decimal USDC; 10000 = $0.01

SEND=false
[ "${1:-}" = "--send" ] && SEND=true

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAILED:\033[0m %s\n' "$1" >&2; exit 1; }
ok()   { printf '  \033[32mok\033[0m  %s\n' "$1"; }

bold "KoinMix miner registration"
echo

# ── 1. Required inputs ──────────────────────────────────────────────────────
if [ -z "${MINER_FEE_ADDRESS:-}" ]; then
  echo "MINER_FEE_ADDRESS is the EVM address that receives payouts."
  read -rp "  Payout address (0x...): " MINER_FEE_ADDRESS
fi

[[ "$MINER_FEE_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]] \
  || fail "MINER_FEE_ADDRESS is not a 20-byte EVM address: $MINER_FEE_ADDRESS"
ok "payout address looks well-formed"

command -v cast >/dev/null 2>&1 || fail "foundry's \`cast\` is not on PATH"
ok "cast $(cast --version 2>/dev/null | head -1 | awk '{print $3}')"

# ── 2. The descriptor must be reachable, and its hash is what gets committed ─
# The chain stores the SHA-256 of the bytes served at YAML_URL. Every node
# recomputes it after fetching. Hashing the LIVE response rather than the local
# file is the whole point: a local checkout can differ from what is deployed
# (line endings alone are enough) and the local copy is not what nodes read.
echo
bold "Descriptor"
HTTP_CODE=$(curl -s -o /tmp/koinmix-reg.yaml -w '%{http_code}' --max-time 30 "$YAML_URL") \
  || fail "could not reach $YAML_URL"
[ "$HTTP_CODE" = "200" ] || fail "$YAML_URL returned HTTP $HTTP_CODE"
ok "reachable ($(wc -c < /tmp/koinmix-reg.yaml) bytes)"

YAML_HASH="0x$(sha256sum /tmp/koinmix-reg.yaml | cut -d' ' -f1)"   # SHA-256, NOT keccak256
ok "sha256 $YAML_HASH"

# base_url inside the descriptor must agree with where it is actually served,
# or nodes will fetch the descriptor from one host and route requests to another.
DECLARED=$(grep -m1 '^base_url:' /tmp/koinmix-reg.yaml | awk '{print $2}')
SERVED_ORIGIN=$(printf '%s' "$YAML_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
[ "$DECLARED" = "$SERVED_ORIGIN" ] \
  || fail "base_url in the descriptor is '$DECLARED' but it is served from '$SERVED_ORIGIN'"
ok "base_url matches the serving origin"

# ── 3. Network sanity ───────────────────────────────────────────────────────
echo
bold "Network"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC") || fail "RPC unreachable: $RPC"
ok "chain id $CHAIN_ID via $RPC"

CODE=$(cast code "$DIAMOND" --rpc-url "$RPC")
[ "${#CODE}" -gt 4 ] || fail "no contract at $DIAMOND on chain $CHAIN_ID — wrong network or wrong address"
ok "registry contract present at $DIAMOND"

# ── 4. Summary ──────────────────────────────────────────────────────────────
echo
bold "Transaction"
cat <<SUMMARY
  yamlUrl      $YAML_URL
  yamlHash     $YAML_HASH
  feeAddress   $MINER_FEE_ADDRESS
  minPriceUsdc $MIN_PRICE  (\$$(awk "BEGIN{printf \"%.2f\", $MIN_PRICE/1000000}"))
  intents      $INTENTS
  registry     $DIAMOND  (chain $CHAIN_ID)
SUMMARY

# ── 5. Simulate ─────────────────────────────────────────────────────────────
# `cast call` runs the transaction against live state without broadcasting, so a
# revert surfaces here for free instead of costing gas.
echo
bold "Simulating (nothing is broadcast)"
if SIM=$(cast call "$DIAMOND" \
      "registerMiner(string,bytes32,address,uint256,string[])" \
      "$YAML_URL" "$YAML_HASH" "$MINER_FEE_ADDRESS" "$MIN_PRICE" "$INTENTS" \
      --rpc-url "$RPC" --from "$MINER_FEE_ADDRESS" 2>&1); then
  ok "simulation succeeded${SIM:+ (returned $SIM)}"
else
  echo "$SIM" | sed 's/^/    /'
  fail "simulation reverted — the real transaction would too. Fix this first."
fi

if [ "$SEND" = false ]; then
  echo
  bold "Dry run complete. Nothing was sent."
  echo "  To broadcast:  ./scripts/register-miner.sh --send"
  exit 0
fi

# ── 6. Broadcast ────────────────────────────────────────────────────────────
echo
bold "About to broadcast a real, irreversible transaction"
echo "  There is no update function. Correcting any value above means"
echo "  deregistering, re-registering, and waiting another epoch."
echo
read -rp "  Type REGISTER to continue: " CONFIRM
[ "$CONFIRM" = "REGISTER" ] || { echo "  aborted."; exit 1; }

cast wallet list 2>/dev/null | grep -q "$ACCOUNT" \
  || fail "no keystore named '$ACCOUNT'. Create one with: cast wallet import $ACCOUNT --interactive"

echo
cast send "$DIAMOND" \
  "registerMiner(string,bytes32,address,uint256,string[])" \
  "$YAML_URL" "$YAML_HASH" "$MINER_FEE_ADDRESS" "$MIN_PRICE" "$INTENTS" \
  --rpc-url "$RPC" --account "$ACCOUNT"

echo
bold "Submitted."
echo "  Registration activates at the next epoch boundary (~300 blocks),"
echo "  not immediately. Check the leaderboard after that, not before."
