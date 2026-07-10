#!/usr/bin/env bash
# Claude Code status line - percentages only
# Example: 97% left · 5h 12% · 7d 8%

input=$(cat)

cwd=$(echo "$input" | jq -r '.cwd')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'
BOLD='\033[1m'

user=$(whoami)
host=$(hostname -s)

home="$HOME"
short_cwd="${cwd/#$home/~}"

# Git branch
git_branch=""
if git -C "$cwd" rev-parse --is-inside-work-tree --no-optional-locks 2>/dev/null | grep -q true; then
  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
  if [ -n "$branch" ]; then
    git_branch=" $(printf '\033[0;33m')‹${branch}›$(printf '\033[0m')"
  fi
fi

# Color a percentage: green <50, yellow 50-79, red 80+
color_pct() {
  local pct="$1"

  if [ "$pct" -ge 80 ]; then
    printf '\033[0;31m'
  elif [ "$pct" -ge 50 ]; then
    printf '\033[0;33m'
  else
    printf '\033[0;32m'
  fi
}

# Model slug (between branch and context stats)
model_id=$(echo "$input" | jq -r '.model.id // empty' | sed 's/^claude-//')
model_display=""
if [ -n "$model_id" ]; then
  model_display=" $(printf '\033[0;36m')[${model_id}]$(printf '\033[0m')"
fi

# Build stats: 97% left · 5h 12% · 7d 8%
parts=()

if [ -n "$used_pct" ]; then
  left_pct=$(printf '%.0f' "$(LC_ALL=C echo "100 - $used_pct" | bc)")
  used_int=$(printf '%.0f' "$used_pct")
  clr=$(color_pct "$used_int")
  parts+=("${clr}${left_pct}% left$(printf '\033[0m')")
fi

# Rate limits (5h and 7d remaining %)
five_h_used=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
seven_d_used=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

if [ -n "$five_h_used" ]; then
  five_h_left=$(printf '%.0f' "$(LC_ALL=C echo "100 - $five_h_used" | bc)")
  five_h_used_int=$(printf '%.0f' "$five_h_used")
  clr=$(color_pct "$five_h_used_int")
  parts+=("${clr}5h ${five_h_left}%$(printf '\033[0m')")
fi

if [ -n "$seven_d_used" ]; then
  seven_d_left=$(printf '%.0f' "$(LC_ALL=C echo "100 - $seven_d_used" | bc)")
  seven_d_used_int=$(printf '%.0f' "$seven_d_used")
  clr=$(color_pct "$seven_d_used_int")
  parts+=("${clr}7d ${seven_d_left}%$(printf '\033[0m')")
fi

# Join parts with " · "
stats=""
for i in "${!parts[@]}"; do
  if [ "$i" -gt 0 ]; then
    stats="${stats} · "
  fi
  stats="${stats}${parts[$i]}"
done

stats_display=""
if [ -n "$stats" ]; then
  stats_display=" ${stats}"
fi

printf '%b' "${GREEN}${user}${RESET}${CYAN}@${host}${RESET} ${BOLD}${BLUE}${short_cwd}${RESET}${git_branch}${model_display}${stats_display}"