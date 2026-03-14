/**
 * Loop detector — detects when an agent is making the same tool calls repeatedly without progress.
 * 
 * Patterns detected:
 * 1. Generic repeat: same tool + same input called repeatedly
 * 2. Poll no progress: same tool returning identical output (input may vary)
 * 3. Ping-pong: alternating between two tools without progress
 */

interface ToolCallRecord {
  name: string;
  inputHash: string;  // Hash of JSON.stringify(input)
  outputHash: string; // Hash of first 500 chars of output
  timestamp: number;
}

export interface LoopDetectionResult {
  detected: boolean;
  type: "generic-repeat" | "poll-no-progress" | "ping-pong" | null;
  message: string | null;
  severity: "warning" | "critical" | null;
}

export class LoopDetector {
  private history: ToolCallRecord[] = [];
  private readonly maxHistory = 30;
  private readonly warningThreshold = 8;    // same call 8 times → warning
  private readonly criticalThreshold = 15;  // same call 15 times → critical (break)

  /** Record a tool call and check for loops */
  record(name: string, input: Record<string, unknown>, output: string): LoopDetectionResult {
    const inputHash = simpleHash(JSON.stringify(input));
    const outputHash = simpleHash(output.substring(0, 500));
    
    this.history.push({ name, inputHash, outputHash, timestamp: Date.now() });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return this.detect();
  }

  reset(): void {
    this.history = [];
  }

  private detect(): LoopDetectionResult {
    // 1. Generic repeat: same tool + same input repeated
    const genericRepeat = this.detectGenericRepeat();
    if (genericRepeat) return genericRepeat;

    // 2. Poll no progress: same tool + same output (input may vary)
    const pollNoProgress = this.detectPollNoProgress();
    if (pollNoProgress) return pollNoProgress;

    // 3. Ping-pong: alternating A/B/A/B pattern
    const pingPong = this.detectPingPong();
    if (pingPong) return pingPong;

    return { detected: false, type: null, message: null, severity: null };
  }

  private detectGenericRepeat(): LoopDetectionResult | null {
    if (this.history.length < this.warningThreshold) return null;
    
    const recent = this.history.slice(-this.criticalThreshold);
    const last = recent[recent.length - 1];
    const sameCount = recent.filter(
      r => r.name === last.name && r.inputHash === last.inputHash
    ).length;

    if (sameCount >= this.criticalThreshold) {
      return {
        detected: true,
        type: "generic-repeat",
        message: `CRITICAL: Tool '${last.name}' called ${sameCount} times with identical input. Breaking loop.`,
        severity: "critical",
      };
    }
    if (sameCount >= this.warningThreshold) {
      return {
        detected: true,
        type: "generic-repeat",
        message: `WARNING: Tool '${last.name}' called ${sameCount} times with identical input. Consider a different approach.`,
        severity: "warning",
      };
    }
    return null;
  }

  private detectPollNoProgress(): LoopDetectionResult | null {
    if (this.history.length < this.warningThreshold) return null;
    
    const recent = this.history.slice(-this.warningThreshold);
    const last = recent[recent.length - 1];
    const sameOutput = recent.filter(
      r => r.name === last.name && r.outputHash === last.outputHash
    ).length;

    if (sameOutput >= this.warningThreshold) {
      return {
        detected: true,
        type: "poll-no-progress",
        message: `WARNING: Tool '${last.name}' returning identical results ${sameOutput} times. No progress detected.`,
        severity: "warning",
      };
    }
    return null;
  }

  private detectPingPong(): LoopDetectionResult | null {
    if (this.history.length < 8) return null;
    
    const recent = this.history.slice(-8);
    
    // Check if it alternates: A B A B A B A B
    const isAlternating = recent.every((r, i) => {
      if (i < 2) return true;
      return r.name === recent[i - 2].name && r.inputHash === recent[i - 2].inputHash;
    });

    if (isAlternating && recent[0].name !== recent[1].name) {
      return {
        detected: true,
        type: "ping-pong",
        message: `WARNING: Alternating between '${recent[0].name}' and '${recent[1].name}' without progress. Break the pattern.`,
        severity: "warning",
      };
    }
    return null;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
