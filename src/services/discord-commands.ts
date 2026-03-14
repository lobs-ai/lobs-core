/**
 * Discord Slash Commands
 *
 * Registers and handles Discord slash commands for lobs-core.
 * Commands: /new, /status, /tasks, /model, /clear, /help
 */

import { Client, REST, Routes, SlashCommandBuilder, EmbedBuilder, CommandInteraction, ChatInputCommandInteraction } from "discord.js";
import type { DiscordConfig } from "./discord.js";
import type { MainAgent } from "./main-agent.js";
import { getRawDb } from "../db/connection.js";
import { getModelForTier } from "../config/models.js";

let mainAgentRef: MainAgent | null = null;

/** Set the main agent reference for command handlers */
export function setMainAgentForCommands(agent: MainAgent): void {
  mainAgentRef = agent;
}

/** Register slash commands with Discord */
export async function registerSlashCommands(client: Client, config: DiscordConfig): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName('new')
      .setDescription('Start a fresh conversation'),
    
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show bot and system status'),
    
    new SlashCommandBuilder()
      .setName('tasks')
      .setDescription('List active and recent tasks'),
    
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Show or set the AI model for this channel')
      .addStringOption(opt =>
        opt.setName('name')
          .setDescription('Model to use (haiku/sonnet/opus or full model string)')
          .setRequired(false)
      ),
    
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Clear conversation history for this channel'),
    
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show available commands'),
    
    new SlashCommandBuilder()
      .setName('toolsteps')
      .setDescription('Control tool step visibility in this channel')
      .addStringOption(opt =>
        opt.setName('mode')
          .setDescription('on = full details, compact = tool names only, off = hide all')
          .setRequired(false)
          .addChoices(
            { name: 'on — show tool names + inputs + results', value: 'on' },
            { name: 'compact — show tool names only', value: 'compact' },
            { name: 'off — hide all tool steps', value: 'off' },
          )
      ),
  ];

  const rest = new REST({ version: '10' }).setToken(config.botToken);
  const commandData = commands.map(c => c.toJSON());
  
  try {
    console.log('[discord-commands] Registering global slash commands...');
    // Register globally so commands work in DMs + all guilds
    await rest.put(
      Routes.applicationCommands(client.user!.id),
      { body: commandData },
    );
    console.log('[discord-commands] Global slash commands registered successfully');
  } catch (err) {
    console.error('[discord-commands] Failed to register global slash commands:', err);
  }
}

/** Handle slash command interactions */
export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  
  const { commandName } = interaction;
  
  try {
    switch (commandName) {
      case 'new':
        await handleNewCommand(interaction);
        break;
      case 'status':
        await handleStatusCommand(interaction);
        break;
      case 'tasks':
        await handleTasksCommand(interaction);
        break;
      case 'model':
        await handleModelCommand(interaction);
        break;
      case 'clear':
        await handleClearCommand(interaction);
        break;
      case 'help':
        await handleHelpCommand(interaction);
        break;
      case 'toolsteps':
        await handleToolStepsCommand(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
    }
  } catch (err) {
    console.error(`[discord-commands] Error handling /${commandName}:`, err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An error occurred', ephemeral: true });
      }
    } catch {}
  }
}

/** /new - Start a new session */
async function handleNewCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const db = getRawDb();
  
  // Clear main_agent_messages for this channel
  db.prepare('DELETE FROM main_agent_messages WHERE channel_id = ?').run(channelId);
  
  // Update channel_sessions to idle
  db.prepare(`
    INSERT INTO channel_sessions (channel_id, status, last_activity)
    VALUES (?, 'idle', datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      status = 'idle',
      last_activity = datetime('now'),
      context_summary = NULL
  `).run(channelId);
  
  await interaction.reply({ content: '✨ Fresh session started. What\'s up?', ephemeral: true });
}

/** /status - Show bot status */
async function handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getRawDb();
  const startTime = process.uptime();
  const hours = Math.floor(startTime / 3600);
  const minutes = Math.floor((startTime % 3600) / 60);
  const uptime = `${hours}h ${minutes}m`;
  
  // Count active workers
  const busyAgents = db.prepare('SELECT COUNT(*) as count FROM agent_status WHERE status = ?').get('busy') as { count: number };
  
  // Count active tasks
  const activeTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?').get('active') as { count: number };
  
  // Get memory server health (check if port 7420 is responding)
  let memoryHealth = '❓ Unknown';
  try {
    const memCheck = await fetch('http://localhost:7420/health', { signal: AbortSignal.timeout(2000) });
    memoryHealth = memCheck.ok ? '✅ Healthy' : '⚠️ Degraded';
  } catch {
    memoryHealth = '❌ Down';
  }
  
  const model = process.env.LOBS_MODEL || getModelForTier('strong');
  
  const embed = new EmbedBuilder()
    .setTitle('🤖 lobs-core Status')
    .setColor(0x2dd4bf)
    .addFields(
      { name: 'Uptime', value: uptime, inline: true },
      { name: 'Active Workers', value: String(busyAgents.count), inline: true },
      { name: 'Tasks in Queue', value: String(activeTasks.count), inline: true },
      { name: 'Memory Server', value: memoryHealth, inline: true },
      { name: 'Model', value: model, inline: false },
    )
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/** /tasks - List active/recent tasks */
async function handleTasksCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getRawDb();
  
  const tasks = db.prepare(`
    SELECT id, title, status, agent, model_tier
    FROM tasks
    WHERE status IN ('active', 'blocked', 'running')
    ORDER BY updated_at DESC
    LIMIT 10
  `).all() as Array<{
    id: string;
    title: string;
    status: string;
    agent: string | null;
    model_tier: string | null;
  }>;
  
  if (tasks.length === 0) {
    await interaction.reply({ content: 'No active tasks.', ephemeral: true });
    return;
  }
  
  const fields = tasks.map(t => ({
    name: `${t.title.substring(0, 50)}${t.title.length > 50 ? '...' : ''}`,
    value: `**Status:** ${t.status} | **Agent:** ${t.agent || 'unassigned'} | **Tier:** ${t.model_tier || 'standard'}`,
    inline: false,
  }));
  
  const embed = new EmbedBuilder()
    .setTitle('📋 Active Tasks')
    .setColor(0x3b82f6)
    .addFields(fields)
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/** /model - Show or set model for this channel */
async function handleModelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const db = getRawDb();
  const modelName = interaction.options.get('name')?.value as string | undefined;
  
  if (!modelName) {
    // Show current model
    const session = db.prepare('SELECT model_override FROM channel_sessions WHERE channel_id = ?')
      .get(channelId) as { model_override: string | null } | undefined;
    
    const currentModel = session?.model_override || process.env.LOBS_MODEL || getModelForTier('strong');
    
    await interaction.reply({
      content: `**Current model for this channel:** \`${currentModel}\`\n\nTo change: \`/model name:<model>\``,
      ephemeral: true,
    });
    return;
  }
  
  // Set model override
  // Normalize short names
  const normalizedModel = normalizeModelName(modelName);
  
  if (!mainAgentRef) {
    await interaction.reply({ content: 'Main agent not available', ephemeral: true });
    return;
  }
  
  mainAgentRef.setChannelModel(channelId, normalizedModel);
  
  await interaction.reply({ content: `✅ Model for this channel set to: \`${normalizedModel}\``, ephemeral: true });
}

/** /clear - Clear conversation history */
async function handleClearCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const db = getRawDb();
  
  db.prepare('DELETE FROM main_agent_messages WHERE channel_id = ?').run(channelId);
  
  db.prepare(`
    INSERT INTO channel_sessions (channel_id, status, last_activity)
    VALUES (?, 'idle', datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      status = 'idle',
      last_activity = datetime('now'),
      context_summary = NULL
  `).run(channelId);
  
  await interaction.reply({ content: '🧹 History cleared.', ephemeral: true });
}

/** /help - Show available commands */
async function handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('📚 Available Commands')
    .setColor(0x8b5cf6)
    .setDescription('lobs-core Discord bot commands')
    .addFields(
      { name: '/new', value: 'Start a fresh conversation (clears history)', inline: false },
      { name: '/status', value: 'Show bot and system status', inline: false },
      { name: '/tasks', value: 'List active and recent tasks', inline: false },
      { name: '/model [name]', value: 'Show or set the AI model for this channel', inline: false },
      { name: '/toolsteps [mode]', value: 'Control tool step visibility (on/compact/off)', inline: false },
      { name: '/clear', value: 'Clear conversation history', inline: false },
      { name: '/help', value: 'Show this help message', inline: false },
    )
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/** /toolsteps - Control tool step visibility for this Discord channel */
async function handleToolStepsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const mode = interaction.options.get('mode')?.value as string | undefined;

  if (!mainAgentRef) {
    await interaction.reply({ content: 'Main agent not available', ephemeral: true });
    return;
  }

  if (!mode) {
    // Show current setting
    const current = mainAgentRef.getDiscordToolsMode(channelId);
    const descriptions: Record<string, string> = {
      on: '**on** — tool names, inputs, and results',
      compact: '**compact** — tool names only',
      off: '**off** — no tool steps shown',
    };
    await interaction.reply({
      content: `🔧 Tool steps in this channel: ${descriptions[current]}\n\nChange with \`/toolsteps mode:<on|compact|off>\``,
      ephemeral: true,
    });
    return;
  }

  mainAgentRef.setDiscordToolsMode(channelId, mode as any);

  const labels: Record<string, string> = {
    on: '🔧 Tool steps: **on** — showing tool names, inputs, and results',
    compact: '🔧 Tool steps: **compact** — showing tool names only',
    off: '🔧 Tool steps: **off** — hiding all tool steps',
  };

  await interaction.reply({ content: labels[mode] || `Tool steps set to: ${mode}`, ephemeral: true });
}

/** Normalize short model names to tier names or full identifiers */
function normalizeModelName(name: string): string {
  const lower = name.toLowerCase();
  // Map friendly names to tiers
  const tierAliases: Record<string, string> = {
    'haiku': 'small',
    'sonnet': 'medium',
    'opus': 'strong',
    'micro': 'micro',
    'small': 'small',
    'medium': 'medium',
    'standard': 'standard',
    'strong': 'strong',
  };
  
  // If it's a known alias or tier name, resolve to the actual model from config
  if (tierAliases[lower]) {
    return getModelForTier(tierAliases[lower]);
  }
  
  return name;
}
