/**
 * imagine — Image generation tool via lobs-imagine service.
 * Calls the persistent Python image generation server and saves results.
 */

import type { ToolDefinition, ToolExecutorResult } from "../types.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const IMAGINE_URL = "http://localhost:7421";
const OUTPUT_DIR = join(process.env.HOME || "/tmp", "lobs/lobs-imagine/outputs");

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
        description: "Image width in pixels (256-2048, default 768). Must be divisible by 8.",
      },
      height: {
        type: "number",
        description: "Image height in pixels (256-2048, default 768). Must be divisible by 8.",
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

  try {
    // Check if service is running
    const healthRes = await fetch(`${IMAGINE_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);

    if (!healthRes || !healthRes.ok) {
      return "Error: lobs-imagine service is not running. Start it with: cd ~/lobs/lobs-imagine && source .venv/bin/activate && python server.py";
    }

    const health = (await healthRes.json()) as { model_loaded: boolean };
    if (!health.model_loaded) {
      return "Error: lobs-imagine model is still loading. Try again in a moment.";
    }

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

    // Save to file
    if (!existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `imagine-${timestamp}-${result.seed}.png`;
    const filepath = join(OUTPUT_DIR, filename);

    writeFileSync(filepath, Buffer.from(result.image, "base64"));

    return [
      `Image generated successfully!`,
      `File: ${filepath}`,
      `Size: ${result.width}x${result.height}`,
      `Seed: ${result.seed}`,
      `Time: ${result.elapsed}s`,
      `Prompt: ${prompt}`,
    ].join("\n");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error generating image: ${msg}`;
  }
}
