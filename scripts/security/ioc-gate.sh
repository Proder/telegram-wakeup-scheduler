#!/usr/bin/env bash
set -euo pipefail

# Static-only repository IOC gate. It must never execute repository code.

root=$(git rev-parse --show-toplevel)
cd "$root"

gate_path="scripts/security/ioc-gate.sh"
failures=0
warnings=0
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/ioc-gate.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT

tracked="$tmpdir/tracked.bin"
changed="$tmpdir/changed.bin"

git ls-files -z | LC_ALL=C sort -zu > "$tracked"

is_exact_scan_eligible() {
  case "$1" in
    "$gate_path"|security/evidence/*|security/incidents/*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

is_scannable() {
  case "$1" in
    "$gate_path"|security/evidence/*|security/incidents/*|node_modules/*|*/node_modules/*|vendor/*|*/vendor/*|dist/*|*/dist/*|build/*|*/build/*|.next/*|*/.next/*|generated/*|*/generated/*|__generated__/*|*/__generated__/*|*.min.js|*.map|*.lock|package-lock.json|pnpm-lock.yaml|yarn.lock)
      return 1
      ;;
    *.js|*.cjs|*.mjs|*.jsx|*.ts|*.tsx|*.json|*.sh|*.bash|*.zsh|*.yml|*.yaml|*.toml|*.config|*.gradle|*.dart|*.py|*.rb|*.go|*.rs|*.java|*.kt|*.swift)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_handwritten_script() {
  case "$1" in
    */node_modules/*|*/vendor/*|*/dist/*|*/build/*|*/.next/*|*/generated/*|*/__generated__/*|*.generated.js|*.generated.ts|*.min.js)
      return 1
      ;;
    *.js|*.cjs|*.mjs|*.jsx|*.ts|*.tsx)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

report() {
  printf 'IOC gate: %q: %s\n' "$1" "$2" >&2
  failures=$((failures + 1))
}

warn() {
  printf 'IOC gate warning: %q: %s\n' "$1" "$2" >&2
  warnings=$((warnings + 1))
}

while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue

  if LC_ALL=C grep -Iq . "$file" 2>/dev/null; then
    if is_exact_scan_eligible "$file"; then
      if LC_ALL=C grep -Eq "global[.]o[[:space:]]*=" "$file"; then
        report "$file" "loader marker assignment detected"
      fi

      if LC_ALL=C grep -Eq "['\"]5-[0-9]+-[0-9]+-du['\"]" "$file"; then
        report "$file" "known loader-family marker detected"
      fi
    fi

    if is_scannable "$file"; then
      if LC_ALL=C grep -Eq "eval[[:space:]]*[(]" "$file" && \
         LC_ALL=C grep -Eq "atob[[:space:]]*[(]|Buffer[.]from[^;]*(base64|base64url)" "$file"; then
        report "$file" "eval and Base64 decoder occur in the same file"
      fi

      if LC_ALL=C grep -Eq "createRequire|module[.]createRequire" "$file" && \
         LC_ALL=C awk 'length($0) >= 1500 && $0 ~ /[A-Za-z0-9+\/_=-]{1200}/ {found=1} END {exit !found}' "$file"; then
        report "$file" "createRequire shim combined with a large encoded-looking line"
      fi
    fi
  fi
done < "$tracked"

base=${IOC_BASE_SHA:-}
if [ -n "$base" ] && [ "$base" != "0000000000000000000000000000000000000000" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  git diff --name-only -z --diff-filter=ACMR "$base...HEAD" | LC_ALL=C sort -zu > "$changed"
else
  cp "$tracked" "$changed"
fi

suffixes="$tmpdir/suffixes.tsv"
: > "$suffixes"

while IFS= read -r -d '' file; do
  is_scannable "$file" || continue
  [ -f "$file" ] || continue
  LC_ALL=C grep -Iq . "$file" 2>/dev/null || continue

  if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null && \
     is_handwritten_script "$file" && \
     LC_ALL=C grep -Eq "createRequire|module[.]createRequire" "$file"; then
    if ! git show "$base:$file" 2>/dev/null | LC_ALL=C grep -Eq "createRequire|module[.]createRequire"; then
      report "$file" "new createRequire/module.createRequire shim introduced"
    fi
  fi

  if is_handwritten_script "$file"; then
    current_max=$(LC_ALL=C awk '{if (length($0) > max) max=length($0)} END {print max+0}' "$file")
    base_max=0
    if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
      base_max=$(git show "$base:$file" 2>/dev/null | LC_ALL=C awk '{if (length($0) > max) max=length($0)} END {print max+0}')
    fi
    if [ "$current_max" -ge 6000 ] && { [ "$base_max" -lt 6000 ] || [ $((current_max - base_max)) -ge 4000 ]; }; then
      report "$file" "new or expanded hand-written source line is at least 6000 bytes"
    fi
  fi

  if LC_ALL=C awk 'length($0) >= 2000 && $0 ~ /[A-Za-z0-9+\/_=-]{1600}/ {found=1} END {exit !found}' "$file"; then
    warn "$file" "unusually long encoded-looking line added or modified"
  fi

  size=$(wc -c < "$file" | tr -d ' ')
  if [ "$size" -ge 4096 ]; then
    digest=$(tail -c 4096 "$file" | shasum -a 256 | awk '{print $1}')
    printf '%s\t%s\n' "$digest" "$file" >> "$suffixes"
  fi
done < "$changed"

if [ -s "$suffixes" ]; then
  cut -f1 "$suffixes" | LC_ALL=C sort | uniq -d > "$tmpdir/duplicate-digests.txt"
  while IFS= read -r digest; do
    [ -n "$digest" ] || continue
    files=$(awk -F '\t' -v d="$digest" '$1 == d {print $2}' "$suffixes" | paste -sd ',' -)
    warn "$files" "identical 4096-byte suffix appears in multiple changed source/config files"
  done < "$tmpdir/duplicate-digests.txt"
fi

if [ "$failures" -ne 0 ]; then
  printf 'IOC gate failed with %d finding(s). Review as inert text; do not execute the files.\n' "$failures" >&2
  exit 1
fi

printf 'IOC gate passed: no high-confidence repository indicators detected; warnings=%d.\n' "$warnings"
