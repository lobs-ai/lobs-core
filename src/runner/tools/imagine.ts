/**
 * imagine — Image generation tool via lobs-imagine service.
 * Calls the persistent Python image generation server and saves results.
 */

import type { ToolDefinition, ToolExecutorResult } from "../types.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getLobsRoot } from "../../config/lobs.js";

const IMAGINE_URL = "http://localhost:7421";
const OUTPUT_DIR = join(process.env.HOME || "/tmp", "lobs/lobs-imagine/outputs");
const MEDIA_DIR = join(getLobsRoot(), "media");

export const imagineToolDefinition: ToolDefinition = {
  name: "imagine",
  description:
    "Generate an image from a text prompt using local AI image generation. Returns the file path of the saved PNG image. The image generation service must be running (lobs-imagine on port 7421).",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate. Be descriptive for best results.",
      },
      negative_prompt: {
        type: "string",
        description: "What to avoid in the image (optional).",
      },
      width: {
        type: "number",
        description: "Image width in pixels (256-1024, default 512). Must be divisible by 8. Use 512 for drafts, regenerate at 768-1024 for final versions.",
      },
      height: {
        type: "number",
        description: "Image height in pixels (256-1024, default 512). Must be divisible by 8. Use 512 for drafts, regenerate at 768-1024 for final versions.",
      },
      steps: {
        type: "number",
        description: "Number of inference steps (1-50, default 9). More steps = higher quality but slower.",
      },
      seed: {
        type: "number",
        description: "Random seed for reproducibility (optional).",
      },
    },
    required: ["prompt"],
  },
};

export async function imagineTool(
  params: Record<string, unknown>,
  context?: { toolUseId?: string },
): Promise<ToolExecutorResult> {
  const prompt = params.prompt as string;
  if (!prompt) return "Error: prompt is required";

  // Build request body
  const body: Record<string, unknown> = { prompt };
  if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
  if (params.width) body.width = params.width;
  if (params.height) body.height = params.height;
  if (params.steps) body.steps = params.steps;
  if (params.seed !== undefined) body.seed = params.seed;
  // Idempotency key prevents duplicate generations on retry
  if (context?.toolUseId) body.request_id = context.toolUseId;

  try {
    // Check if service is running
    const healthRes = await fetch(`${IMAGINE_URL}/health`, {
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (!healthRes || !healthRes.ok) {
      return "Error: lobs-imagine service is not running. Start it with: cd ~/lobs/lobs-imagine && source .venv/bin/activate && python server.py";
    }

    const health = (await healthRes.json()) as { model_loaded: boolean };
    // Model loading happens lazily on first generate request.
    // The 5-minute timeout on the generate call covers model load time.

    // Generate image
    const res = await fetch(`${IMAGINE_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000), // 5 minute timeout for generation
    });

    if (!res.ok) {
      const err = await res.text();
      return `Error from lobs-imagine: ${res.status} ${err}`;
    }

    const result = (await res.json()) as {
      image: string;
      seed: number;
      elapsed: number;
      width: number;
      height: number;
    };

    // Save to outputs dir (archive)
    if (!existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `imagine-${timestamp}-${result.seed}.png`;
    const filepath = join(OUTPUT_DIR, filename);
    const imageBuffer = Buffer.from(result.image, "base64");
    writeFileSync(filepath, imageBuffer);

    // Save to media dir for web serving
    if (!existsSync(MEDIA_DIR)) {
      mkdirSync(MEDIA_DIR, { recursive: true });
    }
    const mediaId = randomUUID();
    const mediaFilename = `${mediaId}.png`;
    const mediaPath = join(MEDIA_DIR, mediaFilename);
    writeFileSync(mediaPath, imageBuffer);

    return [
      `Image generated successfully!`,
      `File: ${filepath}`,
      `Size: ${result.width}x${result.height}`,
      `Seed: ${result.seed}`,
      `Time: ${result.elapsed}s`,
      `Prompt: ${prompt}`,
      ``,
      `![Generated image](/api/media/${mediaFilename})`,
    ].join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error generating image: ${msg}`;
  }
}
