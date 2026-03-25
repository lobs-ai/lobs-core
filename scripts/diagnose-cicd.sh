#!/bin/bash
# CI/CD Health Diagnostics Script
# Checks all known issues and reports status

set -e

echo "=========================================="
echo "CI/CD HEALTH DIAGNOSTIC REPORT"
echo "Generated: $(date -u)"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_mark="${GREEN}✓${NC}"
cross="${RED}✗${NC}"
warning="${YELLOW}⚠${NC}"

# Issue 1: Dockerfile Assets
echo "Issue #1: Dockerfile missing dashboard/static"
echo "---"
if grep -q "COPY dashboard/ ./dashboard/" /Users/lobs/paw/paw-hub/deploy/Dockerfile 2>/dev/null && \
   grep -q "COPY static/ ./static/" /Users/lobs/paw/paw-hub/deploy/Dockerfile 2>/dev/null; then
    echo -e "${check_mark} RESOLVED: Dockerfile has all asset COPYs"
    ls -la /Users/lobs/paw/paw-hub/dashboard/index.html 2>/dev/null && echo "  Dashboard files present: ✓" || echo "  Dashboard files: ? (file check failed)"
else
    echo -e "${cross} BROKEN: Dockerfile missing dashboard or static COPY"
fi
echo ""

# Issue 2: nodemailer dependency
echo "Issue #2: Missing nodemailer in package.json"
echo "---"
if grep -q "nodemailer" /Users/lobs/paw/paw-hub/package.json 2>/dev/null; then
    echo -e "${check_mark} FIXED: nodemailer found in package.json"
    grep "nodemailer" /Users/lobs/paw/paw-hub/package.json | head -1 | sed 's/^/  /'
else
    echo -e "${cross} BROKEN: nodemailer NOT in package.json"
    echo "  Required by: server.js (sendConfirmEmail function)"
    echo "  Impact: Silent email failures in production"
fi
echo ""

# Issue 3: paw-plugin branch status
echo "Issue #3: paw-plugin detached HEAD status"
echo "---"
if cd /Users/lobs/paw/paw-plugin 2>/dev/null; then
    HEAD=$(git rev-parse --abbrev-ref HEAD)
    SHORT=$(git rev-parse --short HEAD)
    
    if [ "$HEAD" = "HEAD" ]; then
        echo -e "${warning} DETACHED: Currently on $SHORT"
        echo "  Expected: named branch"
        echo "  Fix: git checkout -b fix/orphan-timeout-and-agent-id $SHORT && git push -u origin"
    else
        echo -e "${check_mark} ON BRANCH: $HEAD ($SHORT)"
    fi
    
    # Check for unpushed commits
    UNPUSHED=$(git log origin/main..$HEAD --oneline 2>/dev/null | wc -l)
    if [ "$UNPUSHED" -gt 0 ]; then
        echo "  Unpushed commits: $UNPUSHED"
        git log origin/main..$HEAD --oneline 2>/dev/null | sed 's/^/    /'
    fi
else
    echo -e "${cross} ERROR: Could not access /Users/lobs/paw/paw-plugin"
fi
echo ""

# Issue 4: lobs-sets-sail PR #25 status
echo "Issue #4: lobs-sets-sail PR #25 branch freshness"
echo "---"
if cd /Users/lobs/paw/lobs-sets-sail 2>/dev/null; then
    MAIN_COMMIT=$(git rev-parse origin/main 2>/dev/null | cut -c1-7)
    CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null | cut -c1-7)
    
    if [ "$MAIN_COMMIT" = "$CURRENT_COMMIT" ]; then
        echo -e "${check_mark} FRESH: Current branch is up-to-date with main"
    else
        BEHIND=$(git rev-list --count main..origin/main 2>/dev/null || echo "?")
        echo -e "${warning} STALE: Branch may need rebase"
        echo "  Main: $MAIN_COMMIT"
        echo "  Current: $CURRENT_COMMIT"
        echo "  Fix: git fetch origin main && git rebase origin/main && git push --force-with-lease"
    fi
    
    # Check for docker-build.yml references
    if grep -r "docker-build.yml" .github/workflows/ 2>/dev/null | grep -v "^Binary"; then
        echo -e "${cross} WARNING: Found references to docker-build.yml (may be deleted)"
    else
        echo "  No broken docker-build.yml references found"
    fi
else
    echo -e "${cross} ERROR: Could not access /Users/lobs/paw/lobs-sets-sail"
fi
echo ""

# Summary of CI workflow health
echo "Workflow Status Summary"
echo "---"

for repo in "lobs-core" "lobs-sets-sail" "paw-hub"; do
    repo_path="/Users/lobs/paw/$repo"
    [ "$repo" = "lobs-core" ] && repo_path="/Users/lobs/lobs/$repo"
    
    if [ -d "$repo_path/.github/workflows" ]; then
        echo "📦 $repo:"
        for wf in "$repo_path/.github/workflows"/*.yml; do
            if [ -f "$wf" ]; then
                name=$(basename "$wf")
                echo "  - $name ✓"
            fi
        done
    else
        echo "📦 $repo: No workflows directory"
    fi
done
echo ""

echo "=========================================="
echo "For detailed analysis, see:"
echo "  - docs/ci-cd-root-cause-analysis.md"
echo "  - docs/ci-cd-issues-quickref.md"
echo "=========================================="
