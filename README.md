# Markdown Summarizer

Automatically summarize Markdown notes using Ollama (local LLM).

## Features

- Summarizes all Markdown files in a folder
- Uses Ollama for local LLM processing
- Groups files by month and creates monthly summaries
- Generates an aggregate summary across all months
- Full control over prompts and model selection
- Simple command-line interface

## Requirements

- Ollama installed and running ([ollama.com](https://ollama.com))
- Node.js 14 or higher
- A model pulled (e.g., `ollama pull llama3.2`)

## Installation

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Or download from https://ollama.com
```

### 2. Start Ollama and pull a model

```bash
# Start Ollama (runs in background)
ollama serve

# In another terminal, pull a model
ollama pull llama3.2

# Other good options:
# ollama pull mistral
# ollama pull qwen2.5
```

### 3. Navigate to the project

```bash
cd /Users/inkredabull/scripts/markdown-summarizer
```

No dependencies needed - uses only Node.js built-in modules.

## Usage

### Basic usage
```bash
node index.js <notes-directory>
```

This will create a `<notes-directory>_summaries` folder with all summaries.

### Specify output directory
```bash
node index.js <notes-directory> <output-directory>
```

### Examples

```bash
# Summarize notes from Tahoe export
node index.js ~/Downloads/TahoeNotes

# Specify custom output location
node index.js ~/Documents/Notes ~/Documents/Summaries

# Parallel processing for faster completion (recommended for M4 Mac)
node index.js ~/Downloads/TahoeNotes --parallel 4

# Dry run to see estimates without processing
node index.js ~/Downloads/TahoeNotes --dry-run

# Combine parallel and dry-run
node index.js ~/Downloads/TahoeNotes --parallel 4 --dry-run

# Show help
node index.js --help
```

## Output

The script creates:

- Individual monthly summary files (e.g., `2025-10_October_2025.txt`)
- `AGGREGATE_SUMMARY.txt` - A comprehensive summary synthesizing all monthly summaries

## Performance Optimization

### Parallel Processing

For faster processing, use the `--parallel <N>` flag to process multiple months concurrently:

```bash
node index.js ~/Downloads/TahoeNotes --parallel 4
```

**Performance gains:**
- Sequential (default): One month at a time - 12 months = ~60 minutes
- `--parallel 4`: Four months simultaneously - 12 months = ~15 minutes (4x faster)
- `--parallel 6`: Six months simultaneously - 12 months = ~10 minutes (6x faster)

**Hardware recommendations:**
- **M4 Mac mini (24GB)**: `--parallel 4` to `--parallel 6` (recommended)
- **M1/M2/M3 Mac (16GB)**: `--parallel 3` to `--parallel 4`
- **Older hardware**: Test with `--parallel 2` and increase if stable

**Memory requirements:**
- Each parallel task uses ~2-3GB RAM
- `--parallel 4` = ~8-12GB RAM needed
- Monitor Activity Monitor during first run to verify system stability

**Progress indicators:**
- Sequential mode: Shows animated spinner with elapsed time
- Parallel mode: Cleaner output without spinner to avoid visual interference

### Using Dry Run

Use `--dry-run` to see time estimates before committing to a full run:

```bash
node index.js ~/Downloads/TahoeNotes --parallel 4 --dry-run
```

This shows you:
- How many months will be processed
- Token counts and character counts per month
- Estimated processing time
- Whether content will be chunked

## Customizing Summarization

Edit `summarization-prompt.txt` to customize how Ollama summarizes your notes. This file contains instructions that get prepended to your content before summarization.

Example prompt instructions might include:
- Focus areas (themes, action items, decisions)
- Output format preferences
- Level of detail desired
- Special handling instructions

Unlike Apple Intelligence, Ollama gives you full control over:
- Model selection (choose based on speed/quality tradeoffs)
- Prompt engineering (detailed instructions are actually followed)
- Temperature and other generation parameters (edit code to customize)
- Complete privacy (all processing happens locally)

## How It Works

1. Scans the input directory for `.md` and `.markdown` files
2. Reads each file and parses the date from content (looks for "## M/D/YY" pattern)
3. **Validates dates** against expected year (2025), auto-corrects any discrepancies with warnings
4. Groups files by month and sorts chronologically within each month
5. **Cleans content** to save tokens:
   - Removes empty bullet points and nested lists
   - Strips empty key-value pairs (e.g., "STATUS: " with no value)
   - Removes trailing whitespace and excessive blank lines
   - Reports token savings (typically 5-15% reduction)
6. For each month:
   - Concatenates all cleaned notes from that month
   - If content exceeds `MAX_CHUNK_SIZE`, splits into chunks and summarizes each
   - Prepends instructions from `summarization-prompt.txt`
   - Creates a monthly summary via Ollama
   - Saves to individual monthly file (e.g., `2025-10_October_2025.txt`)
7. Creates an aggregate summary:
   - Combines all monthly summaries
   - Synthesizes overarching themes and patterns
   - Saves to `AGGREGATE_SUMMARY.txt`
8. Shows real-time progress with visual indicators and timing stats

This monthly-based approach:
- Keeps individual summarization tasks manageable
- Provides structured chronological summaries
- Enables tracking of themes and patterns over time
- Works entirely locally with full control over the LLM
- Optimizes token usage through intelligent content cleaning

## Troubleshooting

### "Ollama request failed" error
Make sure Ollama is running:
```bash
ollama serve
```

### "Model not found" error
Pull the model first:
```bash
ollama pull llama3.2
```

### Slow performance
- Try a smaller/faster model (e.g., `qwen2.5:7b` instead of larger models)
- Ensure Ollama is using your GPU if available
- Check Ollama logs: `journalctl -u ollama`

### "Ollama returned status 500" error
This usually means the input exceeded the model's context window:
- **mistral-small** has ~2048 token context (~8k chars) - too small for most use cases
- **Recommended models** with larger context windows:
  - `llama3.2` (128k context)
  - `mistral` (32k context)
  - `qwen2.5` (32k context)
- Adjust `MAX_CHUNK_SIZE` based on your model's limits
- The script will automatically chunk content if needed

## Configuration

Edit these constants in `index.js`:

- `OLLAMA_MODEL` - Model to use (default: `"llama3.2"`)
  - Options: `"mistral"`, `"qwen2.5"`, `"llama3.1"`, etc.
- `OLLAMA_URL` - Ollama API endpoint (default: `"http://localhost:11434/api/generate"`)
- `DEFAULT_OUTPUT_SUFFIX` - Suffix for default output directory (default: `"_summaries"`)
- `PROMPT_FILE` - Filename for summarization instructions (default: `"summarization-prompt.txt"`)
- `MAX_CHUNK_SIZE` - Maximum characters per chunk (default: `15000`)
- `ESTIMATED_TOKENS_PER_SECOND` - For time estimates (default: `30`)
- `EXPECTED_YEAR` - Expected year for all dates, auto-corrects discrepancies (default: `2025`)

## Date Format

The script parses dates from **file content**, not filenames. Each file should contain a date header in the format: `## M/D/YY` or `## MM/DD/YY`

Examples in file content:
- `## 10/22/25` → October 22, 2025
- `## 1/5/25` → January 5, 2025
- `## 12/3/25` → December 3, 2025

**Date Validation:**
- All dates are validated against `EXPECTED_YEAR` (default: 2025)
- Scrivener errors (e.g., `## 2/5/24` instead of `## 2/5/25`) are automatically corrected
- Corrections are logged with warnings: `⚠️  Date correction in file.md: 2/5/24 -> 2/5/25`
- Summary shows total corrections: `📅 Date corrections applied: 1 file(s) auto-corrected to 2025`

Files without a parseable date pattern will be grouped under "Unknown Date".

## License

MIT
