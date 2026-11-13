#!/usr/bin/env bash
#
# Contract checks for the Gemini reviewer: CLI pin, model and thinking level,
# flat turn cap and wall-clock ceiling (LAB-7944; earlier ENG-7656 / ENG-6428),
# plus the deny policy, failure classification and prompt rules on that step.
#
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
WF="$REPO_ROOT/.github/workflows/gemini-code.yml"

PASS=0
FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL + 1)); }
# Only a clean miss (grep exit 1) counts as absent; an unreadable file does not.
absent() { grep -F -q -- "$1" "$WF"; [ "$?" -eq 1 ]; }

echo "gemini-cli-pin.test.sh"

pins="$(grep -o -E '@google/gemini-cli@[^[:space:]"]+' "$WF" | sort -u)"
if [ "$pins" = "@google/gemini-cli@0.68.0" ]; then
  ok "every CLI install pins 0.68.0"
else
  bad "every CLI install pins 0.68.0" "pins: $(printf '%s' "${pins:-none}" | tr '\n' ' ')"
fi

# The workflow_call `model:` input, up to the next input.
MODEL_INPUT="$(awk '/^      model:[[:space:]]*$/ { on = 1; next } on && /^      [A-Za-z0-9_-]+:[[:space:]]*$/ { exit } on { print }' "$WF")"
if printf '%s\n' "$MODEL_INPUT" | grep -q -E '^[[:space:]]+default: "gemini-4-carbon"[[:space:]]*$' \
  && printf '%s\n' "$MODEL_INPUT" | grep -q -E '^[[:space:]]+description: .*gemini-4-carbon'; then
  ok "model input defaults to gemini-4-carbon and says so"
else
  bad "model input defaults to gemini-4-carbon and says so" "$MODEL_INPUT"
fi

SETTINGS="$(awk -v start="cat > .gemini/settings.json <<'SETTINGS_EOF'" '
  index($0, start) { on = 1; next }
  on && /^[[:space:]]*SETTINGS_EOF$/ { exit }
  on { print }
' "$WF")"
# One parse of the heredoc. Each line is <key>=<JSON value>.
probe="$(printf '%s\n' "$SETTINGS" | python3 -I -c '
import json, sys
try:
    s = json.load(sys.stdin)
except ValueError:
    print("json=invalid")
    sys.exit(0)
def get(d, *keys):
    for k in keys:
        d = d.get(k) if isinstance(d, dict) else None
    return d
overrides = get(s, "modelConfigs", "customOverrides")
levels = [get(o, "modelConfig", "generateContentConfig", "thinkingConfig", "thinkingLevel")
          for o in (overrides if isinstance(overrides, list) else [])
          if isinstance(o, dict) and o.get("match") == {"model": "gemini-4-carbon"}]
print("json=ok")
print("carbon_levels=" + json.dumps(levels))
print("turns=" + json.dumps(get(s, "model", "maxSessionTurns")))
')"
# shellcheck disable=SC2016  # literal ${{ is the Actions expression opener
if [ -n "$SETTINGS" ] && ! printf '%s\n' "$SETTINGS" | grep -F -q '${{' \
  && printf '%s\n' "$probe" | grep -q -x -F 'json=ok'; then
  ok "settings.json heredoc is literal JSON (no \${{ }})"
else
  bad "settings.json heredoc is literal JSON (no \${{ }})" "probe=${probe:-none}"
fi

if printf '%s\n' "$probe" | grep -q -x -F 'carbon_levels=["HIGH"]'; then
  ok "gemini-4-carbon override sets thinkingLevel HIGH"
else
  bad "gemini-4-carbon override sets thinkingLevel HIGH" "probe=${probe:-none}"
fi

if printf '%s\n' "$probe" | grep -q -x -F 'turns=80'; then
  ok "maxSessionTurns is a flat 80"
else
  bad "maxSessionTurns is a flat 80" "probe=${probe:-none}"
fi

for gone in 'id: turns' 'steps.turns' '50 + n * 3'; do
  if absent "$gone"; then
    ok "size-aware turn step removed: no '$gone'"
  else
    bad "size-aware turn step removed: no '$gone'" "$(grep -n -F -- "$gone" "$WF")"
  fi
done

# Job-scoped: other jobs set their own timeout-minutes. TIMEOUT is the job's
# timeout-minutes line with the comment lines directly above it.
TIMEOUT="$(awk '/^  gemini-review:[[:space:]]*$/ { on = 1; next } on && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { exit } on { print }' "$WF" \
  | awk '/^    #/ { note = note $0 "\n"; next } /^    timeout-minutes:/ { printf "%s%s\n", note, $0; exit } { note = "" }')"
if printf '%s\n' "$TIMEOUT" | grep -q -E '^    timeout-minutes: 30[[:space:]]*$'; then
  ok "gemini-review timeout is 30 minutes"
else
  bad "gemini-review timeout is 30 minutes" "${TIMEOUT:-no job-level timeout-minutes}"
fi
if printf '%s\n' "$TIMEOUT" | grep '^    #' | grep -q -E '(^|[^0-9])30 min' \
  && printf '%s\n' "$TIMEOUT" | grep '^    #' | grep -q -E '(^|[^0-9])80 (session )?turns'; then
  ok "timeout comment states 30 minutes and 80 turns"
else
  bad "timeout comment states 30 minutes and 80 turns" "${TIMEOUT:-no comment}"
fi

if grep -F -q 'ci-review-deny.toml' "$WF"; then
  ok "policy-engine deny file"
else
  bad "policy-engine deny file" "no ci-review-deny.toml"
fi

DENY="$(awk '/ci-review-deny.toml/,/^[[:space:]]*EOF$/' "$WF")"
if printf '%s\n' "$DENY" | grep -F -q 'decision = "deny"' \
  && printf '%s\n' "$DENY" | grep -F -q 'write_file' \
  && ! printf '%s\n' "$DENY" | grep -F -q 'run_shell_command'; then
  ok "deny policy lists write/web not shell"
else
  bad "deny policy lists write/web not shell" "deny=$DENY"
fi

if grep -F -q 'id: purged' "$WF"; then
  ok "purged-paths step"
else
  bad "purged-paths step" "no id: purged"
fi

if grep -F -q 'kind=turn_limit' "$WF"; then
  ok "turn-limit failure classification"
else
  bad "turn-limit failure classification" "no kind=turn_limit"
fi

if grep -F -q 'steps.sanitize.outcome == '"'"'failure'"'" "$WF" \
  && grep -F -q 'steps.gemini.outputs.summary' "$WF"; then
  ok "failclass runs on sanitizer fail and reads summary"
else
  bad "failclass runs on sanitizer fail and reads summary" "classifier still gemini-only/error-only"
fi

if grep -F -q 'GEMINI_API_KEY="$gemini_key" TRACE="$TRACE" STDERR="$stderr" DEST="$class" STATUS="$status" bash "$class_script"' "$WF"; then
  ok "classifier receives the key"
else
  bad "classifier receives the key" "classifier call does not prefix GEMINI_API_KEY"
fi

class_line=$(grep -n -F 'bash "$class_script"' "$WF" | head -1 | cut -d: -f1)
unset_line=$(grep -n -F 'unset gemini_key' "$WF" | head -1 | cut -d: -f1)
if [ -n "$class_line" ] && [ -n "$unset_line" ] && [ "$unset_line" -gt "$class_line" ]; then
  ok "key is dropped only after classification"
else
  bad "key is dropped only after classification" "unset gemini_key at ${unset_line:-missing}, classifier at ${class_line:-missing}"
fi

if grep -F -q 'the tool call fails the job' "$WF" \
  && grep -F -q 'including a skill that does not apply' "$WF" \
  && ! grep -F -q 'A skill that does not apply is not a failure' "$WF"; then
  ok "prompt requires activate_skill even when not applicable"
else
  bad "prompt requires activate_skill even when not applicable" "old skip permission still present"
fi

if grep -F -q 'FatalTurnLimitedError' "$WF"; then
  ok "fallback names FatalTurnLimitedError"
else
  bad "fallback names FatalTurnLimitedError" "notice still generic-only"
fi

if grep -F -q 'Retrying the same PR is likely unhelpful' "$WF"; then
  ok "turn-limit notice does not forbid retry as impossible"
else
  bad "turn-limit notice does not forbid retry as impossible" "still says will hit the same cap"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
