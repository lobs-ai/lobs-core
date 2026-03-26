-- fix-intel-sweep-data.sql
-- Cleans up garbage data from broken intel sweep pipeline and updates feed queries.
-- Run with: sqlite3 <your-db-file> < scripts/fix-intel-sweep-data.sql
-- Tables are created at runtime, so this script will only work after the app has started at least once.

-- 1. Clear garbage insights
DELETE FROM intel_insights WHERE 1=1;

-- 2. Clear garbage sources
DELETE FROM intel_sources WHERE 1=1;

-- 3. Reset research queue items that came from intel
DELETE FROM research_briefs WHERE queue_item_id IN (SELECT id FROM research_queue WHERE tags LIKE '%intel-sweep%');
DELETE FROM research_queue WHERE tags LIKE '%intel-sweep%';

-- 4. Update feed search queries with better, more targeted queries
UPDATE intel_feeds SET search_queries = '["AI autonomous agent architecture 2025 2026 site:arxiv.org OR site:github.com OR site:huggingface.co","LLM function calling tool use multi-agent framework","agentic AI coding assistant Cursor Windsurf Copilot"]' WHERE name = 'AI Agent Architecture';

UPDATE intel_feeds SET search_queries = '["agentic AI research paper arxiv.org 2025","autonomous agent planning reasoning paper NeurIPS ICML","LLM agent memory architecture benchmark evaluation","multi-agent coordination paper arxiv","AI agent self-improvement learning paper"]' WHERE name = 'Agentic Engineering Research';

UPDATE intel_feeds SET search_queries = '["LLM framework LangChain LlamaIndex CrewAI new release","RAG retrieval augmented generation advanced techniques","LLM inference optimization vLLM TensorRT SGLang","AI developer tools SDK new release 2025 2026"]' WHERE name = 'LLM Tooling & Frameworks';

UPDATE intel_feeds SET search_queries = '["small language model Phi Qwen Gemma local inference","llama.cpp GGUF quantization performance benchmark","on-device AI model edge deployment MLX","ollama LM Studio local model serving update"]' WHERE name = 'Local & Small Models';
