#!/usr/bin/env bash
# Link-only installer. No package installation, network, or configuration writes.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
normalize_path() {
    local input="$1" part
    local -a parts=() stack=()
    [[ "$input" != *$'\n'* ]] || fail 'Newlines in installation paths are unsupported.'
    [[ "$input" == /* ]] || input="$PWD/$input"
    IFS=/ read -r -a parts <<< "$input"
    for part in "${parts[@]}"; do
        case "$part" in
            ''|.) ;;
            ..) if [[ ${#stack[@]} -gt 0 ]]; then unset 'stack[${#stack[@]}-1]'; fi ;;
            *) stack+=("$part") ;;
        esac
    done
    local IFS=/
    printf '/%s\n' "${stack[*]}"
}
link_destination() {
    local value
    value="$(readlink -- "$1")" || return 1
    [[ "$value" == /* ]] || value="$(dirname -- "$1")/$value"
    normalize_path "$value"
}
configure() {
    CHECK=0; SOURCES=(); TARGETS=(); ACTIONS=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --check) CHECK=1; shift ;;
            --help|-h)
                printf '%s\n' 'Usage: bash install.sh [--check]' \
                    'Offline links into PI_CODING_AGENT_DIR or ~/.pi/agent.' \
                    '--check validates without changes; nothing is ever replaced.' \
                    'Requires Bash and GNU coreutils (ln, or gln on macOS).'
                exit 0 ;;
            *) fail "Unknown argument: $1" 2 ;;
        esac
    done
    LN=ln
    if ! ln --version >/dev/null 2>&1; then LN=gln; fi
    "$LN" --version >/dev/null 2>&1 || fail 'GNU coreutils ln (or gln) is required for no-clobber linking.'
    AGENT_DIR="$(normalize_path "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}")"
    local p entry
    for p in skills/orchestrate-delivery skills/security-review skills/select-task-model \
             agents/delivery-coder.md agents/delivery-reviewer.md agents/delivery-security.md extensions/delivery; do
        case "$p" in
            skills/*) entry="$ROOT/$p/SKILL.md" ;;
            agents/*) entry="$ROOT/$p" ;;
            extensions/*) entry="$ROOT/$p/index.ts" ;;
        esac
        [[ -f "$entry" ]] || fail "Missing or invalid package source: $entry"
        SOURCES+=("$ROOT/$p"); TARGETS+=("$AGENT_DIR/$p")
    done
}
preflight() {
    local i target parent actual
    for i in "${!TARGETS[@]}"; do
        target="${TARGETS[$i]}"; parent="$(dirname -- "$target")"
        while :; do
            if [[ -e "$parent" || -L "$parent" ]] && [[ ! -d "$parent" ]]; then
                fail "Refusing non-directory ancestor: $parent"
            fi
            [[ "$parent" != / ]] || break
            parent="$(dirname -- "$parent")"
        done
        ACTIONS[$i]=create
        if [[ -L "$target" ]]; then
            actual="$(link_destination "$target")"
            if [[ "$actual" == "${SOURCES[$i]}" ]]; then ACTIONS[$i]=skip; continue; fi
        fi
        [[ ! -e "$target" && ! -L "$target" ]] || fail "Refusing conflicting path: $target (remove or move it, then rerun)"
    done
}
install_links() {
    local i target source
    for i in "${!TARGETS[@]}"; do
        target="${TARGETS[$i]}"; source="${SOURCES[$i]}"
        if [[ "${ACTIONS[$i]}" == skip ]]; then printf 'Already linked: %s\n' "$target"; continue; fi
        mkdir -p -- "$(dirname -- "$target")"
        # -T refuses directories as well as files/symlinks appearing after preflight.
        "$LN" -sT -- "$source" "$target" || fail "Target appeared after preflight: $target"
        printf 'Linked: %s -> %s\n' "$target" "$source"
    done
}
main() {
    configure "$@"; preflight
    if [[ "$CHECK" == 1 ]]; then printf '%s\n' 'Preflight passed; no changes made.'; return; fi
    install_links
    printf '%s\n' 'Delivery installed. After active workers settle, fully restart Pi.'
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi