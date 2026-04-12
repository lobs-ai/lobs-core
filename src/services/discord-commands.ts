/**
 * Discord Slash Commands
 *
 * Registers and handles Discord slash commands for lobs-core.
 * Commands: /new, /status, /tasks, /model, /clear, /help
 */

import { Client, REST, Routes, SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction, AutocompleteInteraction, MessageFlags } from "discord.js";
import type { DiscordConfig } from "./discord.js";
import type { MainAgent } from "./main-agent.js";
import type { VoiceManager } from "./voice/index.js";
import { getRawDb } from "../db/connection.js";
import { getModelForTier } from "../config/models.js";
import { getChannelModelOverride, getDefaultChatModel, getModelCatalog, isLoadedLocalModel, normalizeModelSelection, setChannelModelOverride } from "./model-catalog.js";
import { getBotName } from "../config/identity.js";
import { getDiscordDefaultTier, setDiscordDefaultTier } from "../config/models.js";
import { getCourseForChannel, getCourseForGuild, loadAllCourseConfigs, loadCourseConfig, saveCourseConfig, defaultCourseConfig, type GsiCourseConfig } from "../gsi/gsi-config.js";
import { answerStudentQuestion, formatAnswerForDiscord, formatEscalationChannelReply, formatEscalationDM, registerEscalation, resolveEscalationForTA, resolveEscalationById, getPendingEscalationTAIds, getPendingEscalationSummary, getPendingEscalationCount } from "../gsi/gsi-agent.js";
import { seedCourse } from "../gsi/gsi-seed.js";
import { logQaEvent, getCourseStats, getAllCoursesStats } from "../gsi/gsi-store.js";
import { chaseCitations } from "./citation-chaser.js";
import { analyzeCoverage, fetchPrFilesForCoverage, makeStubReview } from "./test-coverage.js";
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
        sub.setName('default')
          .setDescription('Set or clear the global Discord default tier')
          .addStringOption(opt =>
            opt.setName('tier')
              .setDescription('Tier to set as default (e.g. standard, strong) — omit to clear')
              .setRequired(false)
              .setAutocomplete(true)
          )
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

    new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask a question about course material — answered by the GSI AI assistant')
      .addStringOption(opt =>
        opt.setName('question')
          .setDescription('Your question about the course')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('gsi-setup')
      .setDescription('Configure the GSI Office Hours bot for this server (admin only)')
      .setDefaultMemberPermissions('8') // ADMINISTRATOR
      .addSubcommand(sub =>
        sub.setName('init')
          .setDescription('Initialize GSI bot for a course in this server')
          .addStringOption(opt =>
            opt.setName('course-id')
              .setDescription('Course identifier, e.g. eecs281')
              .setRequired(true)
          )
          .addStringOption(opt =>
            opt.setName('course-name')
              .setDescription('Full course name, e.g. "EECS 281: Data Structures"')
              .setRequired(true)
          )
          .addStringOption(opt =>
            opt.setName('escalation-users')
              .setDescription('Comma-separated Discord user IDs to DM when confidence is low')
              .setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub.setName('channel')
          .setDescription('Add or remove this channel from GSI monitoring')
          .addStringOption(opt =>
            opt.setName('action')
              .setDescription('Add or remove this channel')
              .setRequired(true)
              .addChoices(
                { name: 'add — monitor this channel for /ask commands', value: 'add' },
                { name: 'remove — stop monitoring this channel', value: 'remove' },
              )
          )
          .addStringOption(opt =>
            opt.setName('course-id')
              .setDescription('Course ID to associate this channel with')
              .setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub.setName('status')
          .setDescription('Show GSI configuration for this server')
      )
      .addSubcommand(sub =>
        sub.setName('seed')
          .setDescription('Re-seed the knowledge base from built-in FAQ data')
          .addStringOption(opt =>
            opt.setName('course-id')
              .setDescription('Course ID to re-seed')
              .setRequired(true)
          )
      ),
  new SlashCommandBuilder()
    .setName('gsi-stats')
    .setDescription('Show GSI bot statistics: pending escalations, course config, TA queue depth')
    .addStringOption(opt =>
      opt.setName('course-id')
        .setDescription('Course to show stats for (omit for all courses in this server)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('cite')
    .setDescription('Find papers that support or challenge a specific claim')
    .addStringOption(opt =>
      opt.setName('claim')
        .setDescription('The specific claim you want to find citations for')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('context')
        .setDescription('Optional: title or abstract of the paper you are writing')
        .setRequired(false)
    ),

    new SlashCommandBuilder()
    .setName('test-stubs')
    .setDescription('Generate test stubs for a GitHub PR')
    .addStringOption(opt =>
      opt.setName('repo')
        .setDescription('Repository in owner/repo format (e.g. lobs-ai/lobs-core)')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('pr')
        .setDescription('PR number')
        .setRequired(true)
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
      case 'ask':
        await handleAskCommand(interaction);
        break;
      case 'gsi-setup':
        await handleGsiSetupCommand(interaction);
        break;
      case 'gsi-stats':
        await handleGsiStatsCommand(interaction);
        break;
      case 'cite':
        await handleCiteCommand(interaction);
        break;
      case 'test-stubs':
        await handleTestStubsCommand(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown command', flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error(`[discord-commands] Error handling /${commandName}:`, err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An error occurred', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
}

export async function handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'model') return;
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();
  const subcommand = interaction.options.getSubcommand();

  // For /model default — autocomplete tier names
  if (subcommand === 'default' && focused.name === 'tier') {
    const VALID_TIERS = ['micro', 'small', 'medium', 'standard', 'strong'];
    const choices = VALID_TIERS
      .filter(t => !query || t.includes(query))
      .map(t => ({ name: t, value: t }));
    await interaction.respond(choices);
    return;
  }

  // For /model set — autocomplete model names + tier names
  const VALID_TIERS = ['micro', 'small', 'medium', 'standard', 'strong'];
  const tierChoices = VALID_TIERS
    .filter(t => !query || t.includes(query))
    .map(t => ({ name: `${t} (tier)`, value: t }));

  const catalog = await getModelCatalog(1500);
  const modelChoices = catalog.options
    .filter(option =>
      !query ||
      option.id.toLowerCase().includes(query) ||
      option.label.toLowerCase().includes(query)
    )
    .slice(0, 25 - tierChoices.length)
    .map(option => ({
      name: option.id.length > 100 ? option.id.slice(0, 97) + '...' : option.id,
      value: option.id,
    }));

  await interaction.respond([...tierChoices, ...modelChoices]);
}

/** /new - Start a new session */
async function handleNewCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  
  if (!mainAgentRef) {
    await interaction.reply({ content: 'Main agent not available', flags: MessageFlags.Ephemeral });
    return;
  }
  
  mainAgentRef.clearChannel(channelId);
  
  await interaction.reply({ content: '✨ Fresh session started. What\'s up?', flags: MessageFlags.Ephemeral });
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
  
  // Get memory service health (unified DB)
  let memoryHealth = '❓ Unknown';
  try {
    const { getMemoryDb } = await import("../memory/db.js");
    getMemoryDb();
    memoryHealth = '✅ Unified DB';
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
  
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: 'No active tasks.', flags: MessageFlags.Ephemeral });
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
  
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/** /model - Show or set model for this channel */
async function handleModelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'show') {
    const overrideModel = getChannelModelOverride(channelId);
    const discordDefault = getDiscordDefaultTier();
    const currentModel = overrideModel || discordDefault || getDefaultChatModel();
    let msg = `**Current model for this channel:** \`${currentModel}\`\n`;
    msg += `Channel override: ${overrideModel ? `\`${overrideModel}\`` : '`none`'}`;
    if (discordDefault) msg += ` | Discord default: \`${discordDefault}\``;
    msg += `\n\nUse \`/model set\`, \`/model default\`, \`/model reset\`, or \`/model lmstudio\`.`;
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'default') {
    const tier = interaction.options.getString('tier');
    if (!tier) {
      const current = getDiscordDefaultTier();
      await interaction.reply({
        content: current
          ? `**Discord default tier:** \`${current}\`\n\nUse \`/model default <tier>\` to change it, or \`/model default\` (with no value) to clear it.`
          : `No Discord default tier set. Using the agent default: \`${getDefaultChatModel()}\`\n\nUse \`/model default <tier>\` to set a default tier for all channels.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const VALID_TIERS = ['micro', 'small', 'medium', 'standard', 'strong'];
    const rawTier = tier.toLowerCase().trim();
    if (!VALID_TIERS.includes(rawTier)) {
      await interaction.reply({
        content: `Invalid tier \`${tier}\`. Valid tiers: ${VALID_TIERS.map(t => `\`${t}\``).join(', ')}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    setDiscordDefaultTier(rawTier as "micro" | "small" | "medium" | "standard" | "strong");
    await interaction.reply({
      content: `✅ Discord default tier set to: \`${rawTier}\`\nThis will be used in all channels that don't have their own override.`,
      flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!mainAgentRef) {
    await interaction.reply({ content: 'Main agent not available', flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'reset') {
    const discordDefault = getDiscordDefaultTier();
    mainAgentRef.setChannelModel(channelId, null);
    setChannelModelOverride(channelId, null);
    const fallback = discordDefault || getDefaultChatModel();
    await interaction.reply({ content: `✅ Channel override cleared. Using: \`${fallback}\`${discordDefault ? ' (Discord default)' : ''}`, flags: MessageFlags.Ephemeral });
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

  await interaction.reply({ content: `✅ Model for this channel set to: \`${normalizedModel}\`${note}`, flags: MessageFlags.Ephemeral });
}

/** /clear - Clear conversation history */
async function handleClearCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  
  if (!mainAgentRef) {
    await interaction.reply({ content: 'Main agent not available', flags: MessageFlags.Ephemeral });
    return;
  }
  
  mainAgentRef.clearChannel(channelId);
  
  await interaction.reply({ content: '🧹 History cleared.', flags: MessageFlags.Ephemeral });
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
    .addFields({ name: '\u200b', value: '**Lobs can also manage your Discord server** — just ask naturally:', inline: false })
    .addFields(
      { name: 'Messages', value: 'edit, delete, bulk delete, pin, unpin', inline: true },
      { name: 'Channels', value: 'create, edit, delete, permissions, categories', inline: true },
      { name: 'Threads', value: 'archive, lock, unlock, edit, delete, manage members', inline: true },
      { name: 'Webhooks', value: 'create, list, post with embeds or files', inline: true },
      { name: 'Info', value: 'guild, member, role, channel details', inline: true },
    )
    .setFooter({ text: 'Just ask — "create a #feedback channel", "archive this thread", etc.' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/** /toolsteps - Control tool step visibility for this Discord channel */
async function handleToolStepsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const mode = interaction.options.get('mode')?.value as string | undefined;

  if (!mainAgentRef) {
    await interaction.reply({ content: 'Main agent not available', flags: MessageFlags.Ephemeral });
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  mainAgentRef.setDiscordToolsMode(channelId, mode as any);

  const labels: Record<string, string> = {
    on: '🔧 Tool steps: **on** — showing tool names, inputs, and results',
    compact: '🔧 Tool steps: **compact** — showing tool names only',
    off: '🔧 Tool steps: **off** — hiding all tool steps',
  };

  await interaction.reply({ content: labels[mode] || `Tool steps set to: ${mode}`, flags: MessageFlags.Ephemeral });
}

/** /voice - Voice channel commands */
async function handleVoiceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (!voiceManagerRef) {
    await interaction.reply({ content: '🔇 Voice module not initialized.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!voiceManagerRef.isEnabled) {
    await interaction.reply({ content: '🔇 Voice is disabled. Enable it in `~/.lobs/config/voice.json`.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'Voice commands only work in servers.', flags: MessageFlags.Ephemeral });
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
        await interaction.reply({ content: `❌ ${error}`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply('👋 Left the voice channel.');
      }
      break;
    }

    case 'status': {
      const status = await voiceManagerRef.getStatus(guildId);
      if (!status) {
        await interaction.reply({ content: '🔇 Not in a voice channel.', flags: MessageFlags.Ephemeral });
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

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      break;
    }

    case 'trigger': {
      const mode = interaction.options.getString('mode', true) as 'keyword' | 'always';
      const ok = voiceManagerRef.setTriggerMode(guildId, mode);
      if (!ok) {
        await interaction.reply({ content: '❌ Not in a voice channel.', flags: MessageFlags.Ephemeral });
      } else {
        const desc = mode === 'keyword'
          ? `🗝️ Trigger mode: **keyword** — say "${getBotName()}" to get a response`
          : '📡 Trigger mode: **always** — responding to all speech';
        await interaction.reply(desc);
      }
      break;
    }

    default:
      await interaction.reply({ content: 'Unknown voice subcommand.', flags: MessageFlags.Ephemeral });
  }
}

// ── /ask — GSI Office Hours Assistant ────────────────────────────────────────

/**
 * /ask question:<text>
 *
 * Searches course materials in lobs-memory, generates an answer with citations,
 * and escalates to the human TA if confidence is below the configured threshold.
 */
async function handleGsiSetupCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({ content: '❌ `/gsi-setup` only works in a server, not in DMs.', ephemeral: true });
    return;
  }

  switch (subcommand) {
    case 'init': {
      const courseId = interaction.options.getString('course-id', true).trim().toLowerCase();
      const courseName = interaction.options.getString('course-name', true).trim();
      const escalationStr = interaction.options.getString('escalation-users', false) ?? '';
      const escalationUserIds = escalationStr
        ? escalationStr.split(',').map(s => s.trim()).filter(Boolean)
        : [];

      const existing = loadCourseConfig(courseId);
      const config: GsiCourseConfig = {
        ...(existing ?? defaultCourseConfig(courseId)),
        courseId,
        courseName,
        guildId,
        escalationUserIds,
        enabled: true,
      };
      saveCourseConfig(config);

      await interaction.reply({
        content: [
          `✅ **GSI bot initialized** for **${courseName}** (\`${courseId}\`)`,
          `Guild: \`${guildId}\``,
          escalationUserIds.length > 0
            ? `Escalation users: ${escalationUserIds.map(id => `<@${id}>`).join(', ')}`
            : '⚠️ No escalation users set — low-confidence answers will be posted with a warning.',
          ``,
          `Next steps:`,
          `• Run \`/gsi-setup channel add course-id:${courseId}\` in each channel where students should use \`/ask\``,
          `• Add course materials to the \`${courseId}-course\` memory collection`,
          `• Run \`/gsi-setup seed course-id:${courseId}\` to seed built-in FAQ data`,
        ].join('\n'),
        ephemeral: true,
      });
      break;
    }

    case 'channel': {
      const action = interaction.options.getString('action', true) as 'add' | 'remove';
      const channelId = interaction.channelId;
      const courseId = interaction.options.getString('course-id', false)?.trim().toLowerCase();

      // Find the course for this guild
      let course: GsiCourseConfig | null = null;
      if (courseId) {
        course = loadCourseConfig(courseId);
        if (course && course.guildId !== guildId) course = null;
      } else {
        course = getCourseForGuild(guildId);
      }

      if (!course) {
        await interaction.reply({
          content: courseId
            ? `❌ No GSI course found with ID \`${courseId}\` for this server. Run \`/gsi-setup init\` first.`
            : `❌ No GSI course configured for this server. Run \`/gsi-setup init\` first.`,
          ephemeral: true,
        });
        return;
      }

      const channelIds = course.channelIds ?? [];
      if (action === 'add') {
        if (!channelIds.includes(channelId)) {
          course.channelIds = [...channelIds, channelId];
          saveCourseConfig(course);
          await interaction.reply({
            content: `✅ <#${channelId}> is now monitored for \`/ask\` commands (course: **${course.courseName}**).`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: `ℹ️ This channel is already monitored for **${course.courseName}**.`, ephemeral: true });
        }
      } else {
        if (channelIds.includes(channelId)) {
          course.channelIds = channelIds.filter(id => id !== channelId);
          saveCourseConfig(course);
          await interaction.reply({
            content: `✅ <#${channelId}> removed from GSI monitoring for **${course.courseName}**.`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: `ℹ️ This channel wasn't being monitored for **${course.courseName}**.`, ephemeral: true });
        }
      }
      break;
    }

    case 'status': {
      const allCourses = loadAllCourseConfigs().filter(c => c.guildId === guildId);

      if (allCourses.length === 0) {
        await interaction.reply({
          content: `ℹ️ No GSI courses configured for this server. Run \`/gsi-setup init\` to get started.`,
          ephemeral: true,
        });
        return;
      }

      const lines = allCourses.flatMap(c => [
        `**${c.courseName}** (\`${c.courseId}\`)`,
        `  • Status: ${c.enabled ? '🟢 enabled' : '🔴 disabled'}`,
        `  • Channels: ${c.channelIds.length > 0 ? c.channelIds.map(id => `<#${id}>`).join(', ') : 'all channels'}`,
        `  • Confidence threshold: ${Math.round(c.confidenceThreshold * 100)}%`,
        `  • Escalation: ${c.escalationUserIds.length > 0 ? c.escalationUserIds.map(id => `<@${id}>`).join(', ') : 'none'}`,
        `  • Memory collections: ${c.memoryCollections.join(', ')}`,
        `  • Log channel: ${c.logChannelId ? `<#${c.logChannelId}>` : 'none'}`,
        '',
      ]);

      await interaction.reply({ content: `**GSI Status for this server:**\n\n${lines.join('\n')}`.slice(0, 2000), ephemeral: true });
      break;
    }

    case 'seed': {
      const courseId = interaction.options.getString('course-id', true).trim().toLowerCase();
      const course = loadCourseConfig(courseId);

      if (!course || course.guildId !== guildId) {
        await interaction.reply({ content: `❌ Course \`${courseId}\` not found for this server.`, ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        const result = await seedCourse(courseId, true);
        await interaction.editReply(
          result.errors.length === 0
            ? `✅ Seeded **${course.courseName}**: ${result.totalChunks} chunks indexed.`
            : `❌ Seed failed for **${course.courseName}**: ${result.errors[0]}`
        );
      } catch (err) {
        await interaction.editReply(`❌ Seed error: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    default:
      await interaction.reply({ content: `Unknown subcommand: \`${subcommand}\``, ephemeral: true });
  }
}

async function handleAskCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const question = interaction.options.getString('question', true).trim();
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  if (!guildId) {
    await interaction.reply({
      content: '❌ `/ask` only works in a server channel, not in DMs.',
      ephemeral: true,
    });
    return;
  }

  const course = getCourseForChannel(guildId, channelId);
  if (!course) {
    await interaction.reply({
      content: '❌ No course is configured for this channel. Ask your instructor to set up the GSI assistant.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const answer = await answerStudentQuestion(question, course);

    if (answer.shouldEscalate) {
      const channelReply = formatEscalationChannelReply(
        interaction.user.toString(),
        course.courseName
      );
      await interaction.editReply(channelReply);

      // Notify human TAs of the escalation
      const escalationMsg = formatEscalationDM({
        question,
        draftAnswer: answer.answer,
        confidence: answer.confidence,
        reason: `Confidence ${Math.round(answer.confidence * 100)}% below ${Math.round(course.confidenceThreshold * 100)}% threshold`,
        channelId,
        askedBy: `<@${interaction.user.id}>`,
      });

      if (course.dmEscalations) {
        // DM each TA privately and register the pending escalation so their reply loops back
        for (const userId of course.escalationUserIds) {
          try {
            const user = await interaction.client.users.fetch(userId);
            // Generate a short ID for this escalation so TAs can reply to specific questions
            const escalationId = `ask-${Math.random().toString(36).slice(2, 6)}`;
            await user.send(escalationMsg + `\n\n*Ref: \`#${escalationId}\` — if you have multiple pending questions, prefix your reply with this ID.*`);
            // Register so we can match this TA's reply DM back to the original channel
            registerEscalation({
              id: escalationId,
              taUserId: userId,
              channelId,
              guildId: interaction.guildId ?? '',
              question,
              askedBy: `<@${interaction.user.id}>`,
              courseName: course.courseName,
              draftAnswer: answer.answer,
              createdAt: Date.now(),
            });
          } catch (dmErr) {
            console.warn(`[gsi] Could not DM escalation to user ${userId}:`, dmErr);
          }
        }
      } else if (course.logChannelId) {
        // Post escalation alert to the log channel so TAs see it
        try {
          const logChannel = await interaction.client.channels.fetch(course.logChannelId);
          if (logChannel?.isTextBased()) {
            const mentions = course.escalationUserIds.map(id => `<@${id}>`).join(' ');
            const header = mentions ? `${mentions} ⚠️ **Escalation needed**\n` : '⚠️ **Escalation needed**\n';
            await (logChannel as import('discord.js').TextChannel).send(header + escalationMsg);
          }
        } catch (logErr) {
          console.warn('[gsi] Could not post escalation to log channel:', logErr);
        }
      } else {
        // Fallback: log to console so it's not silently dropped
        console.warn('[gsi] Escalation for low-confidence answer — no log channel or DM configured. TAs:', course.escalationUserIds);
      }
    } else {
      const reply = formatAnswerForDiscord(answer, course.courseName);
      await interaction.editReply(reply);
    }

    // Persist Q&A event to SQLite for analytics
    logQaEvent({
      courseId: course.courseId,
      guildId: guildId,
      channelId,
      userId: interaction.user.id,
      question,
      answer: answer.answer,
      confidence: answer.confidence,
      escalated: answer.shouldEscalate,
      answeredBy: answer.shouldEscalate ? 'ta:pending' : 'bot',
    });

    // Log to log channel if configured
    if (course.logChannelId) {
      try {
        const logChannel = await interaction.client.channels.fetch(course.logChannelId);
        if (logChannel?.isTextBased()) {
          const logMsg = [
            `📝 **Q&A Log** — ${course.courseName}`,
            `**User:** <@${interaction.user.id}>  **Channel:** <#${channelId}>`,
            `**Q:** ${question}`,
            `**Confidence:** ${Math.round(answer.confidence * 100)}%  **Escalated:** ${answer.shouldEscalate}`,
          ].join('\n');
          await (logChannel as import('discord.js').TextChannel).send(logMsg);
        }
      } catch (logErr) {
        console.warn('[gsi] Could not post to log channel:', logErr);
      }
    }
  } catch (err) {
    console.error('[gsi] Error in /ask handler:', err);
    await interaction.editReply('❌ Something went wrong processing your question. Please try again or ask your TA directly.');
  }
}

/**
 * Handle the /gsi-stats slash command.
 * Shows bot performance metrics: questions answered auto vs escalated,
 * pending escalations, and per-TA queue depth.
 */
async function handleGsiStatsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: '❌ `/gsi-stats` only works in a server.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const courseId = interaction.options.getString('course-id') ?? undefined;
  const { loadCourseConfig, loadAllCourseConfigs } = await import('../gsi/gsi-config.js');

  // Get courses to show — filter to this guild's courses
  const allCourses = courseId
    ? [loadCourseConfig(courseId)].filter(Boolean)
    : loadAllCourseConfigs().filter(c => c.guildId === interaction.guildId);
  const courses = allCourses as import('../gsi/gsi-config.js').GsiCourseConfig[];

  if (!courses.length) {
    await interaction.editReply('ℹ️ No GSI courses configured for this server. Run `/gsi-setup init` to get started.');
    return;
  }

  const pendingSummary = getPendingEscalationSummary();
  const totalPending = getPendingEscalationCount();
  const now = Date.now();

  const fields = [];

  for (const course of courses) {
    if (!course) continue;
    // Get pending escalations for TAs in this course
    const courseTA_pending = pendingSummary
      .filter(s => course.escalationUserIds.includes(s.taUserId))
      .map(s => {
        const minsAgo = Math.round((now - s.oldest) / 60000);
        return `<@${s.taUserId}>: ${s.count} pending (oldest ${minsAgo}m ago)`;
      });

    const pendingStr = courseTA_pending.length > 0
      ? courseTA_pending.join('\n')
      : 'None ✅';

    fields.push({
      name: `📚 ${course.courseName}`,
      value: [
        `**Channels:** ${course.channelIds.length} configured`,
        `**Escalation TAs:** ${course.escalationUserIds.length}`,
        `**DM escalations:** ${course.dmEscalations ? 'enabled' : 'disabled'}`,
        `**Confidence threshold:** ${Math.round((course.confidenceThreshold ?? 0.75) * 100)}%`,
        '',
        '**Pending TA escalations:**',
        pendingStr,
      ].join('\n'),
      inline: false,
    });
  }

  const embed = {
    color: 0x5865f2, // Discord blurple
    title: '📊 GSI Bot Statistics',
    description: `**${totalPending}** total pending escalation${totalPending !== 1 ? 's' : ''} across all courses`,
    fields,
    footer: { text: 'Escalations expire after 24 hours if unanswered' },
    timestamp: new Date().toISOString(),
  };

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Handle a TA reply DM that resolves a pending GSI escalation.
 * Called from the Discord messageCreate handler when a DM comes in from a TA.
 *
 * Flow:
 *   1. Student uses /ask — answer confidence is too low → bot DMs the TA
 *   2. TA replies to that DM with the correct answer
 *   3. This function posts the TA's reply back to the original course channel
 *   4. Student gets the authoritative answer with TA attribution
 *
 * @returns true if the message was handled as a GSI TA reply, false otherwise
 */
export async function handleGsiTAReply(
  message: import('discord.js').Message
): Promise<boolean> {
  const taUserId = message.author.id;

  // Quick gate: only bother for DMs from TAs with pending escalations
  if (!getPendingEscalationTAIds().has(taUserId)) return false;

  let replyText = message.content.trim();
  if (!replyText) return false;

  // Check for "#id: answer" prefix — allows precise routing when TA has multiple pending
  const idPrefixMatch = replyText.match(/^#([a-z0-9-]+):\s*/i);
  let escalation = idPrefixMatch
    ? resolveEscalationById(idPrefixMatch[1])
    : null;

  if (idPrefixMatch) {
    replyText = replyText.slice(idPrefixMatch[0].length).trim();
    if (!escalation) {
      // ID not found — tell the TA and bail
      try { await message.reply(`⚠️ No pending escalation found with ID \`#${idPrefixMatch[1]}\`. It may have expired or already been answered.`); } catch {}
      return true;
    }
  }

  // Fall back to FIFO if no ID prefix
  if (!escalation) {
    escalation = resolveEscalationForTA(taUserId);
    if (!escalation) return false;
  }

  // Acknowledge the TA in their DM
  try {
    await message.reply(
      `✅ Got it! I've posted your answer to <#${escalation.channelId}> for ${escalation.askedBy}.`
    );
  } catch {
    // Non-fatal — still post to the channel
  }

  // Post the TA's answer back to the course channel
  try {
    const channel = await message.client.channels.fetch(escalation.channelId);
    if (!channel?.isTextBased()) {
      console.warn(`[gsi] TA reply: channel ${escalation.channelId} not found or not text-based`);
      return true; // Still "handled" — just can't post
    }

    const embed = {
      color: 0x22c55e, // green
      title: `✅ TA Answer — ${escalation.courseName}`,
      description: replyText,
      fields: [
        {
          name: 'Original question',
          value: escalation.question.length > 200
            ? escalation.question.slice(0, 197) + '…'
            : escalation.question,
          inline: false,
        },
      ],
      footer: {
        text: `Answered by your TA · ${escalation.courseName}`,
      },
      timestamp: new Date().toISOString(),
    };

    await (channel as import('discord.js').TextChannel).send({
      content: `${escalation.askedBy} — your question was answered by a TA:`,
      embeds: [embed],
    });

    console.info(`[gsi] TA ${taUserId} reply posted to channel ${escalation.channelId} for ${escalation.askedBy}`);
  } catch (err) {
    console.error('[gsi] Failed to post TA reply to channel:', err);
  }

  return true;
}

async function handleTestStubsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const repoArg = interaction.options.getString('repo', true);
  const prNumber = interaction.options.getInteger('pr', true);

  const parts = repoArg.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    await interaction.reply({ content: '❌ Repo must be in `owner/repo` format, e.g. `lobs-ai/lobs-core`.', flags: MessageFlags.Ephemeral });
    return;
  }
  const [owner, repo] = parts as [string, string];

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const files = await fetchPrFilesForCoverage(owner, repo, prNumber);
    const stubReview = makeStubReview(owner, repo, prNumber);
    const report = await analyzeCoverage(files, stubReview);

    if (report.suggestions.length === 0) {
      await interaction.editReply({
        content: `✅ Coverage looks **${report.coverage}** — no stub suggestions generated for \`${owner}/${repo}#${prNumber}\`.`,
      });
      return;
    }

    const coverageEmoji = { adequate: '✅', minimal: '⚠️', missing: '🚨' }[report.coverage];
    const lines: string[] = [
      `${coverageEmoji} **Coverage: ${report.coverage}** for \`${owner}/${repo}#${prNumber}\``,
      ``,
      report.summary,
    ];

    if (report.untestedFunctions.length > 0) {
      lines.push(``, `**Untested functions:** ${report.untestedFunctions.map(f => `\`${f}\``).join(', ')}`);
    }

    lines.push(``, `**Suggested test stubs** (${report.suggestions.length}):`);
    for (const stub of report.suggestions.slice(0, 3)) {
      lines.push(``, `**${stub.testFile}** — ${stub.description}`, `\`\`\`typescript`, stub.stubCode.slice(0, 600), `\`\`\``);
    }

    // Discord messages have a 2000 char limit — truncate gracefully
    const fullMsg = lines.join('\n');
    const msg = fullMsg.length > 1900 ? fullMsg.slice(0, 1900) + '\n…*(truncated)*' : fullMsg;

    await interaction.editReply({ content: msg });
  } catch (err) {
    console.error('[discord-commands] /test-stubs error:', err);
    await interaction.editReply({ content: `❌ Coverage analysis failed: ${(err as Error).message}` });
  }
}

async function handleCiteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const claim = interaction.options.getString('claim', true);
  const context = interaction.options.getString('context') ?? undefined;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await chaseCitations({ claim, paperContext: context, maxResults: 8 });
    const top5 = result.suggestions.slice(0, 5);

    if (top5.length === 0) {
      await interaction.editReply({ content: '🔍 No relevant papers found for that claim. Try rephrasing.' });
      return;
    }

    const stanceEmoji = (stance: string) =>
      stance === 'supporting' ? '✅' : stance === 'contradicting' ? '⚔️' : '🔗';

    const fields = top5.map((s) => ({
      name: `${stanceEmoji(s.stance)} ${s.title.slice(0, 80)}${s.title.length > 80 ? '…' : ''} (${s.year ?? '?'})`,
      value: `${s.relevanceNote.slice(0, 200)}\n[View paper](${s.url})`,
    }));

    const embed = new EmbedBuilder()
      .setTitle('📚 Citation Suggestions')
      .setDescription(`**Claim:** ${claim.slice(0, 200)}`)
      .addFields(fields)
      .setColor(0x5865f2)
      .setTimestamp();

    const total = result.suggestions.length;
    if (total > 5) {
      embed.setFooter({ text: `${total - 5} more results available via POST /api/research/cite` });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[discord-commands] /cite error:', err);
    await interaction.editReply({ content: `❌ Citation search failed: ${(err as Error).message}` });
  }
}

