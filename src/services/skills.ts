/**
 * Skills Service — load and match structured skill instructions.
 *
 * Skills are loaded from:
 * - Built-in: src/skills/ (compiled into the project)
 * - User: ~/.lobs/skills/ (custom skills)
 *
 * Each skill is a directory with a SKILL.md file containing:
 * - YAML frontmatter (description, tags)
 * - Markdown instructions for the worker
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getLobsRoot } from "../config/lobs.js";

export interface Skill {
  name: string;
  description: string;
  tags: string[];
  instructions: string;  // Full content of SKILL.md
  path: string;          // Where it was loaded from
}

class SkillsService {
  private skills: Skill[] = [];
  
  /** Load skills from both built-in and user directories */
  loadAll(): void {
    this.skills = [];
    
    // Built-in skills (in source tree or dist/)
    // When running from dist/, __dirname is dist/services/
    // Skills should be at dist/skills/
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);
    const builtinDir = resolve(currentDir, "../skills");
    
    if (existsSync(builtinDir)) {
      this.loadFromDir(builtinDir);
    }
    
    // User skills
    const userDir = join(getLobsRoot(), "skills");
    if (existsSync(userDir)) {
      this.loadFromDir(userDir);
    }
  }
  
  private loadFromDir(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const skillDir = join(dir, entry.name);
        const skillFile = join(skillDir, "SKILL.md");
        
        if (!existsSync(skillFile)) continue;
        
        try {
          const content = readFileSync(skillFile, "utf-8");
          const { description, tags } = this.parseFrontmatter(content);
          
          this.skills.push({
            name: entry.name,
            description,
            tags,
            instructions: content,
            path: skillDir,
          });
        } catch (err) {
          // Skip invalid skill files
          console.warn(`[skills] Failed to load ${skillFile}: ${err}`);
        }
      }
    } catch (err) {
      // Directory doesn't exist or isn't readable
      console.warn(`[skills] Failed to load from ${dir}: ${err}`);
    }
  }
  
  /** Parse YAML-like frontmatter from SKILL.md */
  private parseFrontmatter(content: string): { description: string; tags: string[] } {
    // Look for --- fenced block at start
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { description: "", tags: [] };
    
    const fm = match[1];
    const descMatch = fm.match(/description:\s*(.+)/);
    const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
    
    return {
      description: descMatch?.[1]?.trim() || "",
      tags: tagsMatch?.[1]?.split(",").map(t => t.trim().replace(/['"]/g, "")) || [],
    };
  }
  
  /** Find skills matching a task's context */
  matchSkills(taskTitle: string, taskNotes: string, agentType: string): Skill[] {
    const text = `${taskTitle} ${taskNotes} ${agentType}`.toLowerCase();
    return this.skills.filter(skill => 
      skill.tags.some(tag => text.includes(tag.toLowerCase()))
    );
  }
  
  /** Get all loaded skills */
  getAll(): Skill[] {
    return [...this.skills];
  }
}

export const skillsService = new SkillsService();
