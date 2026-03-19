---
description: Generate images locally using the imagine tool and lobs-imagine service
tags: [image, imagine, generate, picture, art, visual, draw, create-image, illustration]
---

# Image Generation

## Overview
You can generate images locally using the `imagine` tool. This calls the lobs-imagine service which runs a Stable Diffusion model (Z-Image-Turbo) on Apple Silicon MPS.

## Usage
Call the `imagine` tool with a descriptive prompt. The tool will:
1. Check if the lobs-imagine service is running
2. Send the prompt to the model
3. Save the resulting PNG to `~/lobs/lobs-imagine/outputs/`
4. Return the file path, seed, and generation time

## Important Notes
- **Cold start:** First request loads the model (~3-4 minutes). Subsequent requests are faster.
- **Generation time:** Expect 60-120+ seconds per image at 768x768. Be patient.
- **Memory:** The model uses ~12GB of unified memory. It auto-unloads after 10 minutes idle.
- **Tell the user** generation will take a moment before calling the tool — don't leave them waiting silently.

## Parameters
- `prompt` (required): Descriptive text of the image. Be specific and detailed for best results.
- `negative_prompt` (optional): What to avoid in the image.
- `width` (optional, default 768): Image width in pixels (256-2048, divisible by 8).
- `height` (optional, default 768): Image height in pixels (256-2048, divisible by 8).
- `steps` (optional, default 9): Inference steps. More = higher quality but slower.
- `seed` (optional): Random seed for reproducibility.

## Prompt Tips
- Be descriptive: "A golden retriever puppy playing in autumn leaves, warm sunlight, shallow depth of field" beats "dog"
- Include style cues: "digital art", "photograph", "watercolor", "oil painting", "cinematic lighting"
- Include composition cues: "close-up", "wide angle", "aerial view", "portrait"
- Negative prompts help: "blurry, low quality, distorted, watermark" is a good default

## Example
```
imagine({
  prompt: "A cyberpunk city street at night, neon signs reflecting on wet pavement, rain, cinematic lighting, detailed, 8k",
  negative_prompt: "blurry, low quality, distorted",
  width: 768,
  height: 768,
  steps: 9
})
```

## Troubleshooting
- If the service isn't running, tell the user to start it: `cd ~/lobs/lobs-imagine && source .venv/bin/activate && python server.py`
- If generation is slow, try smaller dimensions (512x512) or fewer steps
- If you get OOM errors, the model may need to be unloaded first: `curl -X POST localhost:7421/unload`
