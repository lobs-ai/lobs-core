#!/bin/bash
# Verification script for per-channel sessions, reactions, and tool filtering implementation

echo "=== Implementation Verification ==="
echo ""

cd ~/lobs/lobs-core

echo "✓ Checking TypeScript compilation..."
if npx tsc --noEmit 2>&1 | grep -q "error TS"; then
    echo "❌ TypeScript compilation FAILED"
    exit 1
else
    echo "✅ TypeScript compiles cleanly"
fi

echo ""
echo "✓ Checking new files exist..."
if [ ! -f "src/runner/tools/tool-sets.ts" ]; then
    echo "❌ Missing: src/runner/tools/tool-sets.ts"
    exit 1
fi
if [ ! -f "src/runner/tools/react.ts" ]; then
    echo "❌ Missing: src/runner/tools/react.ts"
    exit 1
fi
echo "✅ All new files present"

echo ""
echo "✓ Checking key implementations..."

# Check per-channel processing
if grep -q "processingChannels = new Set<string>()" src/services/main-agent.ts; then
    echo "✅ Per-channel processing Set implemented"
else
    echo "❌ Missing: processingChannels Set"
    exit 1
fi

# Check channel queues
if grep -q "channelQueues = new Map<string, PendingMessage\[\]>()" src/services/main-agent.ts; then
    echo "✅ Per-channel message queues implemented"
else
    echo "❌ Missing: channelQueues Map"
    exit 1
fi

# Check history filtering
if grep -q "WHERE channel_id = ?" src/services/main-agent.ts; then
    echo "✅ History filtering by channelId implemented"
else
    echo "❌ Missing: History filtering"
    exit 1
fi

# Check platform_message_id
if grep -q "platform_message_id TEXT" src/services/main-agent.ts; then
    echo "✅ platform_message_id column added"
else
    echo "❌ Missing: platform_message_id column"
    exit 1
fi

# Check Discord reactions
if grep -q "GuildMessageReactions" src/services/discord.ts; then
    echo "✅ GuildMessageReactions intent added"
else
    echo "❌ Missing: GuildMessageReactions intent"
    exit 1
fi

# Check react method
if grep -q "async react(channelId: string, messageId: string, emoji: string)" src/services/discord.ts; then
    echo "✅ Discord react() method implemented"
else
    echo "❌ Missing: react() method"
    exit 1
fi

# Check react tool registration
if grep -q "react: {" src/runner/tools/index.ts; then
    echo "✅ React tool registered"
else
    echo "❌ Missing: React tool registration"
    exit 1
fi

# Check session-based tool filtering
if grep -q "function getToolsForSession" src/runner/tools/tool-sets.ts; then
    echo "✅ Session-based tool filtering implemented"
else
    echo "❌ Missing: getToolsForSession"
    exit 1
fi

# Check tool filtering usage in main-agent
if grep -q "getToolsForSession(sessionType)" src/services/main-agent.ts; then
    echo "✅ Tool filtering integrated in main-agent"
else
    echo "❌ Missing: Tool filtering integration"
    exit 1
fi

# Check messageId wiring in main.ts
if grep -q "messageId: msg.messageId" src/main.ts; then
    echo "✅ messageId wired through to main agent"
else
    echo "❌ Missing: messageId wiring"
    exit 1
fi

echo ""
echo "=== All Checks Passed ✅ ==="
echo ""
echo "Next steps:"
echo "1. Build: cd ~/lobs/lobs-core && npm run build"
echo "2. Restart: lobs restart (or node dist/main.js)"
echo "3. Test Discord messages from multiple channels"
echo "4. Test react tool with emoji reactions"
echo ""
