#!/bin/bash
# agents.sh — Manage standalone agent Docker containers
# Usage: ./agents.sh [start|stop|restart|status|logs|build]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.agents.yml"

# Load .env if it exists
[[ -f "$SCRIPT_DIR/.env" ]] && set -a && source "$SCRIPT_DIR/.env" && set +a

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  echo -e "${CYAN}agents.sh${NC} — Manage Briggs, Sam, and Lena"
  echo ""
  echo "Usage: ./agents.sh <command> [agent]"
  echo ""
  echo "Commands:"
  echo "  start   [agent]   Start all agents (or one)"
  echo "  stop    [agent]   Stop all agents (or one)"
  echo "  restart [agent]   Restart all agents (or one)"
  echo "  status            Show running status"
  echo "  logs    <agent>   Tail logs for an agent"
  echo "  build             Build/rebuild the Docker image"
  echo "  shell   <agent>   Open a shell in an agent's container"
  echo ""
  echo "Examples:"
  echo "  ./agents.sh start          # start all three"
  echo "  ./agents.sh start briggs   # start just briggs"
  echo "  ./agents.sh logs sam       # tail sam's logs"
  echo "  ./agents.sh status         # see who's running"
}

check_compose() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo -e "${RED}Error:${NC} $COMPOSE_FILE not found. Run ./scripts/generate-compose.sh first."
    exit 1
  fi
}

cmd_build() {
  check_compose
  echo -e "${CYAN}Building agent image...${NC}"
  docker compose -f "$COMPOSE_FILE" build
  echo -e "${GREEN}✅ Build complete${NC}"
}

cmd_start() {
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
  cmd_status
}

cmd_stop() {
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

cmd_restart() {
  check_compose
  local agent="${1:-}"
  if [[ -n "$agent" ]]; then
    echo -e "${CYAN}Restarting ${agent}...${NC}"
    docker compose -f "$COMPOSE_FILE" restart "$agent"
  else
    echo -e "${CYAN}Restarting all agents...${NC}"
    docker compose -f "$COMPOSE_FILE" restart
  fi
  echo -e "${GREEN}✅ Restarted${NC}"
  cmd_status
}

cmd_status() {
  check_compose
  echo ""
  echo -e "${CYAN}Agent Status${NC}"
  echo "─────────────────────────────────────────────"
  
  for container in lobs-agent-briggs lobs-agent-sam lobs-agent-lena; do
    local name="${container#lobs-agent-}"
    local state
    state=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "not found")
    
    case "$state" in
      running)
        local uptime
        uptime=$(docker inspect --format='{{.State.StartedAt}}' "$container" 2>/dev/null | cut -d. -f1 | sed 's/T/ /')
        echo -e "  ${GREEN}●${NC} ${name}  —  running since ${uptime}"
        ;;
      exited)
        echo -e "  ${RED}●${NC} ${name}  —  exited"
        ;;
      *)
        echo -e "  ${YELLOW}○${NC} ${name}  —  ${state}"
        ;;
    esac
  done
  echo ""
}

cmd_logs() {
  check_compose
  local agent="${1:-}"
  if [[ -z "$agent" ]]; then
    echo -e "${RED}Usage:${NC} ./agents.sh logs <agent>"
    exit 1
  fi
  docker compose -f "$COMPOSE_FILE" logs -f --tail=50 "$agent"
}

cmd_shell() {
  check_compose
  local agent="${1:-}"
  if [[ -z "$agent" ]]; then
    echo -e "${RED}Usage:${NC} ./agents.sh shell <agent>"
    exit 1
  fi
  docker compose -f "$COMPOSE_FILE" exec "$agent" /bin/bash
}

# Main
case "${1:-}" in
  start)   cmd_start "${2:-}" ;;
  stop)    cmd_stop "${2:-}" ;;
  restart) cmd_restart "${2:-}" ;;
  status)  cmd_status ;;
  logs)    cmd_logs "${2:-}" ;;
  build)   cmd_build ;;
  shell)   cmd_shell "${2:-}" ;;
  -h|--help|help) usage ;;
  *)
    usage
    exit 1
    ;;
esac
