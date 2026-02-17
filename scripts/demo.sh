#!/usr/bin/env bash
# Simulates an ambient terminal session for the demo GIF.
# Run with: bash scripts/demo.sh
# Record with: vhs docs/demo.tape

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
DIM='\033[0;90m'
BOLD='\033[1m'
RED='\033[0;31m'
RESET='\033[0m'

type_text() {
  local text="$1"
  local delay="${2:-0.035}"
  for (( i=0; i<${#text}; i++ )); do
    printf '%s' "${text:$i:1}"
    sleep "$delay"
  done
}

prompt() {
  printf "${GREEN}❯${RESET} "
}

# --- Scene 1: Build fails ---
prompt
type_text "pnpm build"
echo
sleep 0.3
echo -e "${DIM}> ambient-shell@0.1.0 build${RESET}"
echo -e "${DIM}> tsc${RESET}"
sleep 0.2
echo ""
echo -e "${RED}src/auth.ts(42,18)${RESET}: error TS2345: Argument of type '${BOLD}string${RESET}'"
echo -e "  is not assignable to parameter of type '${BOLD}UserConfig${RESET}'."
echo ""
echo -e "${RED}Found 1 error.${RESET}"
sleep 1.8

# --- Scene 2: Ask naturally (no 'r' prefix) ---
echo ""
prompt
type_text "why did the build fail"
echo
sleep 0.5
echo -e "${CYAN}ambient →${RESET} tsc found a type error in ${BOLD}auth.ts:42${RESET}. You're passing"
sleep 0.08
echo -e "  a raw string to authenticate() but it expects a"
sleep 0.08
echo -e "  ${BOLD}UserConfig${RESET} object. The captured build output shows:"
sleep 0.08
echo -e "  ${DIM}TS2345: string not assignable to UserConfig${RESET}"
sleep 2.2

# --- Scene 3: Agent fixes it ---
echo ""
prompt
type_text "r fix"
echo
sleep 0.6
echo -e "${YELLOW}[claude]${RESET} Fixing type error in src/auth.ts..."
sleep 1
echo -e "${GREEN}✓${RESET} Changed ${DIM}authenticate(token)${RESET} → ${BOLD}authenticate({ token })${RESET}"
sleep 2

# --- Scene 4: Store knowledge ---
echo ""
prompt
type_text 'r remember "authenticate() takes UserConfig, not raw string"'
echo
sleep 0.3
echo -e "${GREEN}✓${RESET} remembered"
sleep 1.8

# --- Scene 5: Recall in new session ---
echo ""
printf "${DIM}   ─── next session ───${RESET}\n"
sleep 1.2
echo ""
prompt
type_text 'r "how does authenticate work"'
echo
sleep 0.5
echo -e "${CYAN}ambient →${RESET} authenticate() in ${BOLD}src/auth.ts${RESET} takes a UserConfig"
sleep 0.08
echo -e "  object with a token field. You fixed a type error here"
sleep 0.08
echo -e "  yesterday where a raw string was being passed instead."
sleep 3
