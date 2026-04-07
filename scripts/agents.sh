#!/bin/bash
# agents.sh — Manage standalone agents (local mode or Docker)
# Usage: ./agents.sh [start|stop|restart|status|logs|build] [agent]
#
# Modes:
#   --local   Run as local Node processes (default — no Docker needed)
#   --docker  Run via Docker Compose

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR/.."
COMPOSE_FILE="$REPO_DIR/docker-compose.agents.yml"
AGENTS_JSON="$HOME/.lobs/agents.json"
PID_DIR="$HOME/.lobs/agent-pids"
LOG_DIR="$HOME/.lobs/agent-logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

# Default to local mode
MODE="local"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# Parse --local/--docker flag from any position
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --local)  MODE="local" ;;
    --docker) MODE="docker" ;;
    *)        ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

# Read agent names from agents.json
get_agents() {
  python3 -c "
import json
with open('$AGENTS_JSON') as f:
    cfg = json.load(f)
for name in sorted(cfg.get('standalone', {}).keys()):
    print(name)
"
}

# Read port for an agent
get_port() {
  python3 -c "
import json
with open('$AGENTS_JSON') as f:
    cfg = json.load(f)
print(cfg['standalone']['$1']['port'])
"
}

usage() {
  echo -e "${CYAN}agents.sh${NC} — Manage Briggs, Sam, and Lena"
  echo ""
  echo "Usage: ./agents.sh [--local|--docker] <command> [agent]"
  echo ""
  echo "Commands:"
  echo "  start   [agent]   Start all agents (or one)"
  echo "  stop    [agent]   Stop all agents (or one)"
  echo "  restart [agent]   Restart all agents (or one)"
  echo "  status            Show running status"
  echo "  logs    <agent>   Tail logs for an agent"
  echo "  build             Build/rebuild the Docker image (docker mode only)"
  echo ""
  echo -e "Mode: ${CYAN}${MODE}${NC} (override with --local or --docker)"
  echo ""
  echo "Examples:"
  echo "  ./agents.sh start              # start all three locally"
  echo "  ./agents.sh start briggs       # start just briggs"
  echo "  ./agents.sh logs sam           # tail sam's logs"
  echo "  ./agents.sh status             # see who's running"
  echo "  ./agents.sh --docker start     # use Docker instead"
}

# ─── Local Mode ───────────────────────────────────────────

local_is_running() {
  local agent="$1"
  local pidfile="$PID_DIR/$agent.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    else
      rm -f "$pidfile"
    fi
  fi
  return 1
}

local_start_one() {
  local agent="$1"
  local port
  port=$(get_port "$agent")
  local data_dir="$HOME/.lobs-agents/$agent"

  if local_is_running "$agent"; then
    echo -e "  ${YELLOW}⚠${NC}  $agent already running (pid $(cat "$PID_DIR/$agent.pid"))"
    return
  fi

  if [[ ! -d "$data_dir" ]]; then
    echo -e "  ${RED}✗${NC}  $agent — data dir not found: $data_dir"
    return 1
  fi

  # Make sure dist/ is built
  if [[ ! -f "$REPO_DIR/dist/main.js" ]]; then
    echo -e "${CYAN}Building lobs-core...${NC}"
    (cd "$REPO_DIR" && npm run build)
  fi

  local logfile="$LOG_DIR/$agent.log"

  LOBS_ROOT="$data_dir" \
  LOBS_PORT="$port" \
  NODE_ENV=production \
    nohup node "$REPO_DIR/dist/main.js" \
    > "$logfile" 2>&1 &

  local pid=$!
  echo "$pid" > "$PID_DIR/$agent.pid"
  echo -e "  ${GREEN}●${NC}  $agent started (pid $pid, port $port, log: $logfile)"
}

local_stop_one() {
  local agent="$1"
  local pidfile="$PID_DIR/$agent.pid"

  if ! local_is_running "$agent"; then
    echo -e "  ${DIM}○${NC}  $agent not running"
    return
  fi

  local pid
  pid=$(cat "$pidfile")
  kill "$pid" 2>/dev/null
  # Wait up to 5s for graceful shutdown
  for i in {1..10}; do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  # Force kill if still running
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  echo -e "  ${YELLOW}●${NC}  $agent stopped (was pid $pid)"
}

local_status() {
  echo ""
  echo -e "${CYAN}Agent Status${NC} ${DIM}(local mode)${NC}"
  echo "─────────────────────────────────────────────"

  for agent in $(get_agents); do
    local port
    port=$(get_port "$agent")
    if local_is_running "$agent"; then
      local pid
      pid=$(cat "$PID_DIR/$agent.pid")
      # Check if it's actually responding
      if curl -sf "http://localhost:$port/health" > /dev/null 2>&1; then
        echo -e "  ${GREEN}●${NC}  $agent  —  healthy (pid $pid, port $port)"
      else
        echo -e "  ${YELLOW}●${NC}  $agent  —  running but not responding (pid $pid, port $port)"
      fi
    else
      echo -e "  ${DIM}○${NC}  $agent  —  stopped"
    fi
  done
  echo ""
}

local_logs() {
  local agent="$1"
  local logfile="$LOG_DIR/$agent.log"
  if [[ ! -f "$logfile" ]]; then
    echo -e "${RED}No log file for $agent${NC}"
    exit 1
  fi
  tail -f -n 50 "$logfile"
}

# ─── Docker Mode ──────────────────────────────────────────

check_compose() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo -e "${RED}Error:${NC} $COMPOSE_FILE not found. Run ./scripts/generate-compose.sh first."
    exit 1
  fi
}

docker_start() {
  check_compose
  local agent="${1:-}"
  if [[ -n "$agent" ]]; then
    echo -e "${CYAN}Starting ${agent}...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d "$agent"
  else
    echo -e "${CYAN}Starting all agents...${NC}"
    docker compose -f "$COMPOSE_FILE" up -d
  fi
  echo -e "${GREEN}✅ Started${NC}"
  docker_status
}

docker_stop() {
  check_compose
  local agent="${1:-}"
  if [[ -n "$agent" ]]; then
    echo -e "${YELLOW}Stopping ${agent}...${NC}"
    docker compose -f "$COMPOSE_FILE" stop "$agent"
  else
    echo -e "${YELLOW}Stopping all agents...${NC}"
    docker compose -f "$COMPOSE_FILE" down
  fi
  echo -e "${GREEN}✅ Stopped${NC}"
}

docker_status() {
  check_compose
  echo ""
  echo -e "${CYAN}Agent Status${NC} ${DIM}(docker mode)${NC}"
  echo "─────────────────────────────────────────────"

  for agent in $(get_agents); do
    local container="lobs-agent-$agent"
    local state
    state=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "not found")

    case "$state" in
      running)
        local uptime
        uptime=$(docker inspect --format='{{.State.StartedAt}}' "$container" 2>/dev/null | cut -d. -f1 | sed 's/T/ /')
        echo -e "  ${GREEN}●${NC}  $agent  —  running since ${uptime}"
        ;;
      exited)
        echo -e "  ${RED}●${NC}  $agent  —  exited"
        ;;
      *)
        echo -e "  ${YELLOW}○${NC}  $agent  —  ${state}"
        ;;
    esac
  done
  echo ""
}

docker_logs() {
  check_compose
  local agent="$1"
  docker compose -f "$COMPOSE_FILE" logs -f --tail=50 "$agent"
}

docker_build() {
  check_compose
  echo -e "${CYAN}Building agent image...${NC}"
  docker compose -f "$COMPOSE_FILE" build
  echo -e "${GREEN}✅ Build complete${NC}"
}

# ─── Main ─────────────────────────────────────────────────

cmd="${1:-}"
target="${2:-}"

case "$MODE" in
  local)
    case "$cmd" in
      start)
        if [[ -n "$target" ]]; then
          local_start_one "$target"
        else
          echo -e "${CYAN}Starting all agents (local)...${NC}"
          for agent in $(get_agents); do
            local_start_one "$agent"
          done
        fi
        echo ""
        local_status
        ;;
      stop)
        if [[ -n "$target" ]]; then
          local_stop_one "$target"
        else
          echo -e "${YELLOW}Stopping all agents...${NC}"
          for agent in $(get_agents); do
            local_stop_one "$agent"
          done
        fi
        ;;
      restart)
        if [[ -n "$target" ]]; then
          local_stop_one "$target"
          local_start_one "$target"
        else
          for agent in $(get_agents); do
            local_stop_one "$agent"
            local_start_one "$agent"
          done
        fi
        echo ""
        local_status
        ;;
      status)  local_status ;;
      logs)
        if [[ -z "$target" ]]; then
          echo -e "${RED}Usage:${NC} ./agents.sh logs <agent>"
          exit 1
        fi
        local_logs "$target"
        ;;
      build)
        echo -e "${CYAN}Building lobs-core...${NC}"
        (cd "$REPO_DIR" && npm run build)
        echo -e "${GREEN}✅ Build complete${NC}"
        ;;
      -h|--help|help) usage ;;
      *) usage; exit 1 ;;
    esac
    ;;
  docker)
    case "$cmd" in
      start)   docker_start "$target" ;;
      stop)    docker_stop "$target" ;;
      restart)
        docker_stop "$target"
        docker_start "$target"
        ;;
      status)  docker_status ;;
      logs)
        if [[ -z "$target" ]]; then
          echo -e "${RED}Usage:${NC} ./agents.sh logs <agent>"
          exit 1
        fi
        docker_logs "$target"
        ;;
      build)   docker_build ;;
      -h|--help|help) usage ;;
      *) usage; exit 1 ;;
    esac
    ;;
esac
