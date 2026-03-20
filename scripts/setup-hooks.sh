#!/bin/bash
# Installs git hooks for lobs-core.
# Run: npm run setup-hooks

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "❌ .git/hooks directory not found — are you in a git repo?"
  exit 1
fi

# Copy pre-push hook and make executable
cp "$SCRIPT_DIR/pre-push" "$HOOKS_DIR/pre-push"
chmod +x "$HOOKS_DIR/pre-push"

echo "✅ pre-push hook installed at .git/hooks/pre-push"
echo "   Runs: tsc --noEmit + vitest run before every push."
