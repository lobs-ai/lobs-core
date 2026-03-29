#!/bin/bash
# Generic CI runner for lobs task workflows.
# Usage: ci.sh <repo_path>
# Detects project type and runs appropriate checks.
# Exit 0 = pass, non-zero = fail.

set -euo pipefail

REPO="$1"

if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  echo "no buildable project at: $REPO"
  exit 0
fi

cd "$REPO"

# Node/TypeScript project
if [ -f "package.json" ]; then
  # Install if node_modules missing
  if [ ! -d "node_modules" ]; then
    echo ":: Installing dependencies..."
    npm install --prefer-offline 2>&1 || true
  fi

  # Type check
  if grep -q '"typecheck"' package.json 2>/dev/null; then
    echo ":: Running typecheck..."
    npm run typecheck 2>&1
  elif grep -q '"tsc"' package.json 2>/dev/null || [ -f "tsconfig.json" ]; then
    echo ":: Running tsc --noEmit..."
    npx tsc --noEmit 2>&1 || true
  fi

  # Lint (non-fatal — warn but don't fail)
  if grep -q '"lint"' package.json 2>/dev/null; then
    echo ":: Running lint..."
    npm run lint 2>&1 || echo ":: Lint had warnings/errors (non-fatal)"
  fi

  # Tests
  if grep -q '"test"' package.json 2>/dev/null; then
    echo ":: Running tests..."
    npm test 2>&1
  else
    echo ":: No test script found — skipping"
  fi

  echo ":: CI passed"
  exit 0
fi

# Python project
if [ -f "requirements.txt" ] || [ -f "pyproject.toml" ] || [ -f "setup.py" ]; then
  if [ -f "pytest.ini" ] || [ -f "pyproject.toml" ] || [ -d "tests" ]; then
    echo ":: Running pytest..."
    python3 -m pytest 2>&1 || exit 1
  fi
  echo ":: CI passed"
  exit 0
fi

# Static site / single-file HTML (no CI needed)
if ls *.html 1>/dev/null 2>&1 || [ -f "docker-compose.yml" ] || [ -f "Dockerfile" ]; then
  echo ":: Static/container project — no CI to run"
  exit 0
fi

echo ":: Unknown project type — no CI to run"
exit 0
