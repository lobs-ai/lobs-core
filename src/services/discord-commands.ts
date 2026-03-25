/**
 * Discord Slash Commands
 *
 * Registers and handles Discord slash commands for lobs-core.
 * Commands: /new, /status, /tasks, /model, /clear, /help
 */

import { Client, REST, Routes, SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from "discord.js";
import type { DiscordConfig } from "./discord.js";
import type { MainAgent } from "./main-agent.js";
import type { VoiceManager } from "./voice/index.js";
import { getRawDb } from "../db/connection.js";
import { getModelForTier } from "../config/models.js";
import { getChannelModelOverride, getDefaultChatModel, getModelCatalog, isLoadedLocalModel, normalizeModelSelection, setChannelModelOverride } from "./model-catalog.js";

let mainAgentRef: MainAgent | null = null;
let voiceManagerRef: VoiceManager | null = null;

/** Set the main agent reference for command handlers */
export function setMainAgentForCommands(agent: MainAgent): void {
  mainAgentRef = agent;
}

/** Set the voice manager reference for voice commands */
export function setVoiceManagerForCommands(manager: VoiceManager): void {
  voiceManagerRef = manager;
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
      .addSubcommand(sub =>
        sub.setName('show')
          .setDescription('Show the current model for this channel')
      )
      .addSubcommand(sub =>
        sub.setName('set')
          .setDescription('Set a model for this channel')
          .addStringOption(opt =>
            opt.setName('name')
              .setDescription('Model to use')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('reset')
          .setDescription('Clear the channel model override and use the default')
      )
      .addSubcommand(sub =>
        sub.setName('lmstudio')
          .setDescription('List models currently loaded in LM Studio')
      ),
    
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Clear conversation history for this channel'),
    
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show available commands'),
    
    new SlashCommandBuilder()
      .setName('voice')
      .setDescription('Voice channel commands')
      .addSubcommand(sub =>
        sub.setName('join')
          .setDescription('Join a voice channel')
          .addChannelOption(opt =>
            opt.setName('channel')
              .setDescription('Voice channel to join (defaults to your current channel)')
              .setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub.setName('leave')
          .setDescription('Leave the current voice channel')
      )
      .addSubcommand(sub =>
        sub.setName('status')
          .setDescription('Show voice session status')
      )
      .addSubcommand(sub =>
        sub.setName('trigger')
          .setDescription('Set when Lobs responds in voice')
          .addStringOption(opt =>
            opt.setName('mode')
              .setDescription('Trigger mode')
              .setRequired(true)
              .addChoices(
                { name: 'keyword — respond when name is said', value: 'keyword' },
                { name: 'always — respond to everything', value: 'always' },
              )
          )
      ),

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
      case 'voice':
        await handleVoiceCommand(interaction);
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

export async function handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'model') return;
  const focused = interaction.options.getFocused().toLowerCase();
  const catalog = await getModelCatalog(1500);

  const choices = catalog.options
    .filter(option =>
      !focused ||
      option.id.toLowerCase().includes(focused) ||
      option.label.toLowerCase().includes(focused)
    )
    .slice(0, 25)
    .map(option => ({
      name: option.id.length > 100 ? option.id.slice(0, 97) + '...' : option.id,
      value: option.id,
    }));

  await interaction.respond(choices);
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
  
  // Get memory service health (in-process)
  let memoryHealth = '❓ Unknown';
  try {
    const { isMemoryReady } = await import("./memory/index.js");
    memoryHealth = isMemoryReady() ? '✅ In-Process' : '⚠️ Not Ready';
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
      { name: 'Memory', value: memoryHealth, inline: true },
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
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'show') {
    const overrideModel = getChannelModelOverride(channelId);
    const currentModel = overrideModel || getDefaultChatModel();
    await interaction.reply({
      content: `**Current model for this channel:** \`${currentModel}\`\nOverride: ${overrideModel ? `\`${overrideModel}\`` : '`none`'}\n\nUse \`/model set\`, \`/model reset\`, or \`/model lmstudio\`.`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === 'lmstudio') {
    const catalog = await getModelCatalog(1500);
    const content = catalog.lmstudio.reachable
      ? (catalog.lmstudio.loadedModels.length > 0
          ? catalog.lmstudio.loadedModels.map(id => `- \`lmstudio/${id}\``).join('\n')
          : 'LM Studio is reachable but no models are currently loaded.')
      : `LM Studio is unreachable at \`${catalog.lmstudio.baseUrl}\``;
    await interaction.reply({
      content: `**LM Studio models**\n${content}`,
      ephemeral: true,
    });
    return;
  }

  if (!mainAgentRef) {
    await interaction.reply({ content: 'Main agent not available', ephemeral: true });
    return;
  }

  if (subcommand === 'reset') {
    mainAgentRef.setChannelModel(channelId, null);
    setChannelModelOverride(channelId, null);
    await interaction.reply({ content: `✅ Model override cleared. Using default: \`${getDefaultChatModel()}\``, ephemeral: true });
    return;
  }

  const modelName = interaction.options.getString('name', true);
  const normalizedModel = await normalizeModelSelection(modelName);
  mainAgentRef.setChannelModel(channelId, normalizedModel);
  setChannelModelOverride(channelId, normalizedModel);

  let note = '';
  if (normalizedModel.startsWith('lmstudio/')) {
    const loaded = await isLoadedLocalModel(normalizedModel);
    note = loaded ? '\nLM Studio reports this model is currently loaded.' : '\nWarning: LM Studio does not currently report this model as loaded.';
  }

  await interaction.reply({ content: `✅ Model for this channel set to: \`${normalizedModel}\`${note}`, ephemeral: true });
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
      { name: '/model show', value: 'Show the active model for this channel', inline: false },
      { name: '/model set name:<model>', value: 'Set a model for this channel with autocomplete', inline: false },
      { name: '/model lmstudio', value: 'List currently loaded LM Studio models', inline: false },
      { name: '/model reset', value: 'Clear the channel override and use the default model', inline: false },
      { name: '/toolsteps [mode]', value: 'Control tool step visibility (on/compact/off)', inline: false },
      { name: '/voice join [channel]', value: 'Join a voice channel (STT + TTS)', inline: false },
      { name: '/voice leave', value: 'Leave the voice channel', inline: false },
      { name: '/voice status', value: 'Show voice session status', inline: false },
      { name: '/voice trigger <mode>', value: 'Set voice response trigger (keyword/always)', inline: false },
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

/** /voice - Voice channel commands */
async function handleVoiceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (!voiceManagerRef) {
    await interaction.reply({ content: '🔇 Voice module not initialized.', ephemeral: true });
    return;
  }

  if (!voiceManagerRef.isEnabled) {
    await interaction.reply({ content: '🔇 Voice is disabled. Enable it in `~/.lobs/config/voice.json`.', ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Voice commands only work in servers.', ephemeral: true });
    return;
  }

  switch (subcommand) {
    case 'join': {
      await interaction.deferReply();

      // Try specified channel, else user's current voice channel
      let channelId = interaction.options.getChannel('channel')?.id;

      if (!channelId) {
        const member = interaction.guild?.members.cache.get(interaction.user.id);
        channelId = member?.voice.channelId ?? undefined;

        if (!channelId) {
          await interaction.editReply('❌ Join a voice channel first, or specify one with the `channel` option.');
          return;
        }
      }

      const error = await voiceManagerRef.join(guildId, channelId);
      if (error) {
        await interaction.editReply(`❌ ${error}`);
      } else {
        const channel = interaction.guild?.channels.cache.get(channelId);
        await interaction.editReply(`🎙️ Joined **${channel?.name ?? channelId}**. Say my name to talk to me!`);
      }
      break;
    }

    case 'leave': {
      const error = await voiceManagerRef.leave(guildId);
      if (error) {
        await interaction.reply({ content: `❌ ${error}`, ephemeral: true });
      } else {
        await interaction.reply('👋 Left the voice channel.');
      }
      break;
    }

    case 'status': {
      const status = await voiceManagerRef.getStatus(guildId);
      if (!status) {
        await interaction.reply({ content: '🔇 Not in a voice channel.', ephemeral: true });
        return;
      }

      const uptime = Math.round((Date.now() - status.connectedSince) / 1000);
      const isHealthy = status.sttHealthy && status.ttsHealthy;
      const modeLabel = status.mode === 'realtime' ? '🔴 Realtime (OpenAI)' : '🔧 Sidecar (STT/TTS)';
      const embed = new EmbedBuilder()
        .setTitle('🎙️ Voice Status')
        .setColor(isHealthy ? 0x00ff00 : 0xff0000)
        .addFields(
          { name: 'Channel', value: status.channelName ?? status.channelId, inline: true },
          { name: 'Mode', value: modeLabel, inline: true },
          { name: 'Users', value: String(status.usersInChannel), inline: true },
          { name: 'Uptime', value: `${uptime}s`, inline: true },
          ...(status.mode === 'sidecar' ? [
            { name: 'Trigger Mode', value: status.triggerMode, inline: true },
            { name: 'Transcript', value: `${status.transcriptLength} entries`, inline: true },
            { name: 'STT', value: status.sttHealthy ? '✅ Healthy' : '❌ Down', inline: true },
            { name: 'TTS', value: status.ttsHealthy ? '✅ Healthy' : '❌ Down', inline: true },
          ] : [
            { name: 'API', value: isHealthy ? '✅ Connected' : '❌ Disconnected', inline: true },
          ]),
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }

    case 'trigger': {
      const mode = interaction.options.getString('mode', true) as 'keyword' | 'always';
      const ok = voiceManagerRef.setTriggerMode(guildId, mode);
      if (!ok) {
        await interaction.reply({ content: '❌ Not in a voice channel.', ephemeral: true });
      } else {
        const desc = mode === 'keyword'
          ? '🗝️ Trigger mode: **keyword** — say "Lobs" to get a response'
          : '📡 Trigger mode: **always** — responding to all speech';
        await interaction.reply(desc);
      }
      break;
    }

    default:
      await interaction.reply({ content: 'Unknown voice subcommand.', ephemeral: true });
  }
}
