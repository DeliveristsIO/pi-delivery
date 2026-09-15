#!/usr/bin/env bash
# One-shot bootstrap: install the Pi packages this project needs, then link its resources.
# Package installation runs first; linking stays delegated to the offline installer.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PI_SUBAGENTS_SPEC='npm:pi-subagents@0.67.0'
SPARK_SPEC='npm:@adityaaria/spark'
fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

CHECK=0; SKIP_VERIFY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) CHECK=1; shift ;;
        --skip-verify) SKIP_VERIFY=1; shift ;;
        --help|-h)
            printf '%s\n' 'Usage: bash setup.sh [--check] [--skip-verify]' \
                'Installs the pinned pi-subagents and SPARK Pi packages, then links this checkout' \
                '(skills, agent profiles and the delivery extension) through install.sh.' \
                'Packages install before linking, so a link conflict never blocks installation.' \
                '--check prints planned actions only: no installs, no links, no verification.' \
                '--skip-verify skips the disposable Pi loading check.' \
                'Nothing is ever replaced; a conflicting path must be removed or moved by hand and' \
                'this script rerun. Requires pi, Node.js, Bash and GNU coreutils.'
            exit 0 ;;
        *) fail "Unknown argument: $1" 2 ;;
    esac
done

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [[ "$CHECK" == 0 ]]; then
    { ln --version >/dev/null 2>&1 || gln --version >/dev/null 2>&1; } || fail 'GNU coreutils ln (or gln) is required for no-clobber linking.'
    command -v pi >/dev/null 2>&1 || fail 'Install pi first (for example: mise use --global pi@latest), then rerun this script.'
fi

package_installed() {
    local spec="$1" name base
    name="${spec#npm:}"
    if [[ -f "$AGENT_DIR/settings.json" ]] && grep -qF -- "$spec" "$AGENT_DIR/settings.json"; then return 0; fi
    # Strip the version from the package basename only: '@adityaaria/spark' has a leading '@'.
    base="${name##*/}"; base="${base%%@*}"
    [[ -n "$base" ]] || return 1
    if [[ -d "$AGENT_DIR/npm" ]]; then
        if [[ -e "$AGENT_DIR/npm/$base" || -e "$AGENT_DIR/npm/node_modules/$base" ]]; then return 0; fi
        if [[ -n "$(find "$AGENT_DIR/npm" -maxdepth 3 -name "$base" -print -quit 2>/dev/null)" ]]; then return 0; fi
    fi
    return 1
}

install_package() {
    local spec="$1"
    if package_installed "$spec"; then printf 'Already installed: %s\n' "$spec"; return 0; fi
    if [[ "$CHECK" == 1 ]]; then printf 'Would install: %s\n' "$spec"; return 0; fi
    printf 'Installing: %s\n' "$spec"
    npm_config_ignore_scripts=true pi install "$spec" \
        || fail "Package installation failed: $spec. Fix the reported error and rerun; nothing was linked."
}

report_conflict() {
    local out="$1" target
    printf '%s\n' "$out"
    target="$(printf '%s\n' "$out" | sed -n 's/^Refusing conflicting path: \(.*\) (remove or move it, then rerun)$/\1/p' | head -n 1)"
    [[ -z "$target" ]] || printf 'Conflicting path: %s\n' "$target"
}

link_resources() {
    local out
    if ! out="$(bash "$ROOT/install.sh" --check 2>&1)"; then
        report_conflict "$out"
        fail 'Delivery resources were not linked. Remove or move the conflicting path above, then rerun this script; the packages are already installed.'
    fi
    if [[ "$CHECK" == 1 ]]; then printf '%s\n' "$out"; return 0; fi
    if ! out="$(bash "$ROOT/install.sh" 2>&1)"; then
        report_conflict "$out"
        fail 'Delivery resources were not linked. Resolve the path named above by hand, then rerun this script; the packages are already installed.'
    fi
    printf '%s\n' "$out"
}

STATUS=0
install_package "$PI_SUBAGENTS_SPEC"
install_package "$SPARK_SPEC"
link_resources
if [[ "$CHECK" == 1 ]]; then
    printf '%s\n' 'Check only; nothing was installed, linked or verified.'
elif [[ "$SKIP_VERIFY" == 1 ]]; then
    printf '%s\n' 'Skipped the disposable Pi loading check (--skip-verify).'
elif [[ ! -f "$ROOT/tests/check-installed.mjs" ]]; then
    printf '%s\n' 'Loading check skipped: tests/check-installed.mjs is not part of this release.'
else
    if ! node "$ROOT/tests/check-installed.mjs" "$ROOT"; then
        STATUS=1
        printf 'Loading check failed. Inspect its output before starting Pi; installed packages and links were left as they are.\n' >&2
    fi
fi
if [[ "$CHECK" == 0 && ! -e "$AGENT_DIR/delivery.json" ]]; then
    printf '%s\n' 'No delivery routes configured yet: run /delivery setup in a Git repository you trust.'
fi
if [[ "$CHECK" == 1 ]]; then exit 0; fi
printf '%s\n' 'Delivery bootstrap finished. Fully exit Pi and start it again with pi --continue.'
exit "$STATUS"
