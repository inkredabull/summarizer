#!/usr/bin/env node

import fs from "fs";
import path from "path";
import http from "http";

// ---- CONFIG ----
const OLLAMA_MODEL = "llama3.2:3b";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
const DEFAULT_OUTPUT_SUFFIX = "_summaries";
const PROMPT_FILE = "summarization-prompt-PERSONAL.txt";
const MAX_CHUNK_SIZE = 40000; // Characters per chunk - llama3.2 has 128k token context (~500k chars)
const ESTIMATED_TOKENS_PER_SECOND = 1.4; // Calibrated from actual llama3.2:3b runs (output generation rate)
const EXPECTED_YEAR = 2025; // All dates should be this year (auto-corrects discrepancies)
const SAVE_DEBUG_PROMPTS = true; // Save prompts sent to LLM for inspection

// ----------------

// Utility functions
function estimateTokens(text) {
  // Rough approximation: ~4 characters per token for English text
  return Math.ceil(text.length / 4);
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function estimateTime(inputTokens, outputTokens = 500) {
  // More realistic estimate accounting for both input processing and output generation
  // Input processing: ~100 tokens/sec (prompt processing)
  // Output generation: ~ESTIMATED_TOKENS_PER_SECOND tokens/sec
  const inputProcessingTime = inputTokens / 100; // Prompt processing is faster
  const outputGenerationTime = outputTokens / ESTIMATED_TOKENS_PER_SECOND;

  // Add overhead for model loading, context setup, etc (10%)
  const totalTime = (inputProcessingTime + outputGenerationTime) * 1.1;

  return totalTime;
}

function extractPrioritySections(text) {
  // Count "Things That Matter To Me" sections for logging and emphasis
  // These sections represent core priorities and should be tracked longitudinally
  const prioritySections = [];

  // Pattern to match "Things That Matter To Me" and its nested content
  // This captures from the header through all nested bullet points
  const regex = /\*\s+Things That Matter To Me\s*\n((?:\s+\*[^\n]*\n)*)/gi;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const section = match[0].trim();
    if (section.length > 30) { // Only include if has meaningful content
      prioritySections.push(section);
    }
  }

  return prioritySections;
}

function cleanMarkdownContent(text) {
  // Remove empty content patterns to save tokens before sending to LLM
  let cleaned = text;

  // 1. Remove bullet points that are empty or only contain whitespace
  // Matches: "* SINCE LAST TIME\n    *   \n" -> removes the empty nested bullet
  cleaned = cleaned.replace(/^(\s*\*\s*)\n/gm, '');

  // 2. Remove lines with empty key-value pairs (e.g., "STATUS :   " with no value after colon)
  // Matches: "* STATUS :   \n" or "STATUS :\n"
  cleaned = cleaned.replace(/^(\s*\*?\s*[A-Z][A-Za-z\s]*\s*:\s*)\n/gm, '');

  // 3. Remove empty list items within nested structures
  // Matches: indented bullet with only whitespace
  cleaned = cleaned.replace(/^\s{2,}\*\s*\n/gm, '');

  // 4. Remove trailing whitespace from each line
  cleaned = cleaned.replace(/[ \t]+$/gm, '');

  // 5. Collapse multiple blank lines into maximum of 2
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 6. Remove bullet points followed immediately by another bullet with no content
  // Matches: "* Topic\n    * \n" patterns
  cleaned = cleaned.replace(/^(\s*\*\s+[^\n]+)\n(\s+\*\s*\n)+/gm, '$1\n');

  // 7. Trim leading/trailing whitespace from the entire text
  cleaned = cleaned.trim();

  return cleaned;
}

async function summarizeWithOllama(text, showProgress = false) {
  const startTime = Date.now();
  const inputTokens = estimateTokens(text);

  if (showProgress) {
    const estimatedOutputTokens = 500; // Rough estimate for summary length
    const estimatedTime = estimateTime(inputTokens, estimatedOutputTokens);
    console.log(`    📊 Input: ~${inputTokens.toLocaleString()} tokens (~${text.length.toLocaleString()} chars)`);
    console.log(`    ⏱️  Estimated time: ~${formatDuration(estimatedTime)} (input + ${estimatedOutputTokens} output tokens)`);
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: text,
      stream: false
    });

    const options = {
      hostname: 'localhost',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    // Progress indicator - spinner with elapsed time
    let progressInterval = null;
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinnerIndex = 0;

    if (showProgress) {
      process.stdout.write(`    `); // Initial indent
      progressInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const spinnerChar = spinner[spinnerIndex % spinner.length];
        process.stdout.write(`\r    ${spinnerChar} Processing... ${elapsed}s`);
        spinnerIndex++;
      }, 100); // Update every 100ms for smooth animation
    }

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        // Clear progress indicator
        if (progressInterval) {
          clearInterval(progressInterval);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
        }

        // Check for HTTP errors
        if (res.statusCode !== 200) {
          let errorMsg = `Ollama returned status ${res.statusCode}`;
          try {
            const errorData = JSON.parse(data);
            if (errorData.error) {
              errorMsg += `: ${errorData.error}`;
            }
          } catch (e) {
            if (data) {
              errorMsg += `: ${data}`;
            }
          }
          reject(new Error(errorMsg));
          return;
        }

        try {
          const response = JSON.parse(data);
          if (response.response) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            if (showProgress) {
              const outputTokens = estimateTokens(response.response);
              const totalTokens = inputTokens + outputTokens;
              const effectiveRate = (totalTokens / elapsed).toFixed(1);
              console.log(`    ✓ Completed in ${elapsed}s (${effectiveRate} tokens/sec overall, ${outputTokens.toLocaleString()} output)`);
            }
            resolve(response.response.trim());
          } else {
            reject(new Error('No response from Ollama'));
          }
        } catch (error) {
          reject(new Error(`Failed to parse Ollama response: ${error.message}. Response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (error) => {
      if (progressInterval) {
        clearInterval(progressInterval);
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
      }
      reject(new Error(`Ollama request failed: ${error.message}. Is Ollama running?`));
    });

    req.write(payload);
    req.end();
  });
}

function parseDateFromContent(content, filename = '') {
  // Look for pattern like "## 10/22/25" or "# 1/5/25" (single or double hash)
  const match = content.match(/^#{1,2}\s+(\d{1,2})\/(\d{1,2})\/(\d{2})/m);

  if (!match) {
    return null;
  }

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  let year = parseInt(match[3], 10) + 2000; // Assuming 2000s
  const originalYear = year;

  // Validate month and day
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  // VALIDATION: All dates should be the expected year
  let corrected = false;

  if (year !== EXPECTED_YEAR) {
    console.warn(`  ⚠️  Date correction in ${filename}: ${month}/${day}/${originalYear - 2000} -> ${month}/${day}/${EXPECTED_YEAR - 2000}`);
    year = EXPECTED_YEAR;
    corrected = true;
  }

  return {
    month,
    year,
    day,
    originalYear: corrected ? originalYear : undefined,
    corrected,
    monthYear: `${year}-${String(month).padStart(2, '0')}`, // e.g., "2025-10"
    monthName: new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
  };
}

function chunkText(text, maxSize) {
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks = [];
  let currentChunk = "";

  // Split by paragraphs (double newlines) to keep content coherent
  const paragraphs = text.split(/\n\n+/);

  for (const paragraph of paragraphs) {
    // If adding this paragraph exceeds maxSize, save current chunk and start new one
    if (currentChunk.length + paragraph.length + 2 > maxSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = "";
    }

    // If single paragraph is larger than maxSize, split it forcefully
    if (paragraph.length > maxSize) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      // Split large paragraph into smaller pieces
      for (let i = 0; i < paragraph.length; i += maxSize) {
        chunks.push(paragraph.slice(i, i + maxSize));
      }
    } else {
      currentChunk += (currentChunk.length > 0 ? "\n\n" : "") + paragraph;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

function groupFilesByMonth(files, notesDir) {
  const groups = new Map();

  for (const file of files) {
    const fullPath = path.join(notesDir, file);

    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const dateInfo = parseDateFromContent(content, file);

      if (dateInfo) {
        const key = dateInfo.monthYear;
        if (!groups.has(key)) {
          groups.set(key, {
            monthName: dateInfo.monthName,
            files: []
          });
        }
        groups.get(key).files.push({ filename: file, dateInfo, content });
      } else {
        // Handle files without parseable dates
        if (!groups.has('unknown')) {
          groups.set('unknown', {
            monthName: 'Unknown Date',
            files: []
          });
        }
        groups.get('unknown').files.push({ filename: file, dateInfo: null, content });
      }
    } catch (error) {
      console.error(`  ✗ Error reading ${file}: ${error.message}`);
      // Still add to unknown group
      if (!groups.has('unknown')) {
        groups.set('unknown', {
          monthName: 'Unknown Date',
          files: []
        });
      }
      groups.get('unknown').files.push({ filename: file, dateInfo: null, content: '' });
    }
  }

  // Sort files within each month by day
  for (const [key, group] of groups.entries()) {
    if (key !== 'unknown') {
      group.files.sort((a, b) => {
        return a.dateInfo.day - b.dateInfo.day;
      });
    }
  }

  // Convert to array and sort by month
  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => ({ key, ...value }));
}

async function concatenateAllFiles(notesDir, outputDir) {
  // Validate input directory
  if (!fs.existsSync(notesDir)) {
    throw new Error(`Directory not found: ${notesDir}`);
  }

  const stat = fs.statSync(notesDir);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${notesDir}`);
  }

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  // Find all markdown files
  const files = fs
    .readdirSync(notesDir)
    .filter(f => f.endsWith(".md") || f.endsWith(".markdown"))
    .sort(); // Sort alphabetically for consistency

  if (files.length === 0) {
    console.log("No markdown files found in the directory.");
    return;
  }

  console.log(`Found ${files.length} markdown file(s)\n`);

  // Read and concatenate all files
  const allContent = [];
  let totalOriginalChars = 0;

  for (const file of files) {
    const fullPath = path.join(notesDir, file);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      totalOriginalChars += content.length;

      // Parse date from content for display
      const dateInfo = parseDateFromContent(content, file);
      const dateStr = dateInfo
        ? `${dateInfo.month}/${dateInfo.day}/${dateInfo.year}`
        : 'unknown date';

      console.log(`  ✓ ${file} (${dateStr}) - ${content.length.toLocaleString()} chars`);

      // Add separator with filename and date
      allContent.push(`${'='.repeat(80)}`);
      allContent.push(`FILE: ${file} | DATE: ${dateStr}`);
      allContent.push(`${'='.repeat(80)}`);
      allContent.push('');
      allContent.push(content);
      allContent.push('');
    } catch (error) {
      console.error(`  ✗ Error reading ${file}: ${error.message}`);
    }
  }

  const concatenatedText = allContent.join('\n');
  const cleanedText = cleanMarkdownContent(concatenatedText);

  // Calculate statistics
  const originalTokens = estimateTokens(concatenatedText);
  const cleanedTokens = estimateTokens(cleanedText);
  const tokensSaved = originalTokens - cleanedTokens;
  const charsSaved = concatenatedText.length - cleanedText.length;

  // Write to file
  const outputFilename = 'CONCATENATED_ALL_FILES.txt';
  const outputPath = path.join(outputDir, outputFilename);
  fs.writeFileSync(outputPath, cleanedText);

  // Display results
  console.log(`\n${'='.repeat(80)}`);
  console.log('CONCATENATION COMPLETE');
  console.log('='.repeat(80));
  console.log(`📄 Output file: ${outputFilename}`);
  console.log(`📊 Total files: ${files.length}`);
  console.log(`\n📏 Original content:`);
  console.log(`   Characters: ${concatenatedText.length.toLocaleString()}`);
  console.log(`   Tokens (estimated): ${originalTokens.toLocaleString()}`);
  console.log(`\n🧹 After cleaning:`);
  console.log(`   Characters: ${cleanedText.length.toLocaleString()}`);
  console.log(`   Tokens (estimated): ${cleanedTokens.toLocaleString()}`);
  console.log(`\n💾 Savings:`);
  console.log(`   Characters saved: ${charsSaved.toLocaleString()} (${((charsSaved / concatenatedText.length) * 100).toFixed(1)}%)`);
  console.log(`   Tokens saved: ${tokensSaved.toLocaleString()} (${((tokensSaved / originalTokens) * 100).toFixed(1)}%)`);

  // Context window analysis
  console.log(`\n🪟 Context Window Analysis:`);
  const models = [
    { name: 'llama3.2:1b/3b', context: 128000 },
    { name: 'llama3.1:8b', context: 128000 },
    { name: 'qwen2.5:7b/14b', context: 128000 },
    { name: 'claude-sonnet-4', context: 200000 },
  ];

  models.forEach(model => {
    const usage = ((cleanedTokens / model.context) * 100).toFixed(1);
    const fits = cleanedTokens < model.context ? '✅' : '❌';
    console.log(`   ${fits} ${model.name}: ${usage}% of ${model.context.toLocaleString()} token context`);
  });

  console.log('='.repeat(80));
}

async function summarizeMarkdownFiles(notesDir, outputDir, dryRun = false, parallelCount = 1) {
  // Validate input directory
  if (!fs.existsSync(notesDir)) {
    throw new Error(`Directory not found: ${notesDir}`);
  }

  const stat = fs.statSync(notesDir);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${notesDir}`);
  }

  // Create output directory (unless dry-run)
  if (!dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Find all markdown files
  const files = fs
    .readdirSync(notesDir)
    .filter(f => f.endsWith(".md") || f.endsWith(".markdown"));

  if (files.length === 0) {
    console.log("No markdown files found in the directory.");
    return;
  }

  console.log(`Found ${files.length} markdown file(s)\n`);
  console.log(`Reading files and grouping by month...\n`);

  // Group files by month (reads files and parses dates from content)
  const monthGroups = groupFilesByMonth(files, notesDir);

  // Count date corrections
  let totalCorrected = 0;
  monthGroups.forEach(group => {
    group.files.forEach(file => {
      if (file.dateInfo?.corrected) {
        totalCorrected++;
      }
    });
  });

  if (totalCorrected > 0) {
    console.log(`\n📅 Date corrections applied: ${totalCorrected} file(s) auto-corrected to 2025\n`);
  }

  console.log(`Grouped into ${monthGroups.length} month(s):\n`);

  let totalCharsOriginal = 0;
  let totalCharsCleaned = 0;

  monthGroups.forEach(group => {
    const monthCharsOriginal = group.files.reduce((sum, file) => sum + (file.content?.length || 0), 0);
    const monthCharsCleaned = group.files.reduce((sum, file) => {
      return sum + (file.content ? cleanMarkdownContent(file.content).length : 0);
    }, 0);

    totalCharsOriginal += monthCharsOriginal;
    totalCharsCleaned += monthCharsCleaned;

    const saved = monthCharsOriginal - monthCharsCleaned;
    const savedPct = ((saved / monthCharsOriginal) * 100).toFixed(1);
    console.log(`  ${group.monthName}: ${group.files.length} file(s) (~${(monthCharsCleaned / 1000).toFixed(1)}K chars, saved ${savedPct}%)`);
  });

  // Estimate total processing time based on cleaned content
  const totalSaved = totalCharsOriginal - totalCharsCleaned;
  const totalTokens = Math.ceil(totalCharsCleaned / 4); // Rough approximation
  const estimatedOutputTokens = monthGroups.length * 500; // ~500 tokens per monthly summary
  const estimatedTime = estimateTime(totalTokens, estimatedOutputTokens);

  console.log(`\n🧹 Cleaning saved: ${totalSaved.toLocaleString()} chars (${((totalSaved / totalCharsOriginal) * 100).toFixed(1)}%)`);
  console.log(`⏱️  Total content after cleaning: ~${(totalCharsCleaned / 1000).toFixed(1)}K chars (~${totalTokens.toLocaleString()} tokens)`);
  console.log(`⏱️  Estimated processing time: ~${formatDuration(estimatedTime)}`);
  console.log(`📝 Using model: ${OLLAMA_MODEL}`);
  console.log(`📦 Max chunk size: ${MAX_CHUNK_SIZE.toLocaleString()} chars (~${Math.ceil(MAX_CHUNK_SIZE / 4).toLocaleString()} tokens)\n`);

  // Warn if content per month might exceed context limits
  const avgCharsPerMonth = totalCharsCleaned / monthGroups.length;
  if (avgCharsPerMonth > MAX_CHUNK_SIZE) {
    console.log(`⚠️  Note: Content will be chunked (avg ${(avgCharsPerMonth / 1000).toFixed(1)}K chars/month exceeds ${(MAX_CHUNK_SIZE / 1000).toFixed(1)}K limit)\n`);
  }

  // Read prompt instructions once
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const promptPath = path.join(scriptDir, PROMPT_FILE);
  const promptInstructions = fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, "utf8") + "\n\n"
    : "";

  const monthlySummaries = [];
  const monthlyDetails = [];

  // Helper function to process a single month
  async function processMonth(group) {
    const result = { success: false, monthName: group.monthName, summary: null, error: null };
    const showProgress = parallelCount === 1; // Only show spinner in sequential mode

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing: ${group.monthName} (${group.files.length} files)`);
    console.log('='.repeat(60));

    const monthContent = [];
    const prioritySections = [];

    // Collect and clean content for this month (already read during grouping)
    for (const fileInfo of group.files) {
      if (fileInfo.content && fileInfo.content.trim()) {
        // Count priority sections for logging (but don't extract them)
        const filePriorities = extractPrioritySections(fileInfo.content);
        if (filePriorities.length > 0) {
          prioritySections.push(...filePriorities);
        }

        // Clean the content while KEEPING priority sections in their date context
        const cleanedContent = cleanMarkdownContent(fileInfo.content);

        monthContent.push(cleanedContent);
        const dateStr = fileInfo.dateInfo
          ? ` (${fileInfo.dateInfo.month}/${fileInfo.dateInfo.day}/${fileInfo.dateInfo.year})`
          : '';
        console.log(`  ✓ ${fileInfo.filename}${dateStr}`);
      } else {
        console.log(`  ⚠️  Skipped (empty): ${fileInfo.filename}`);
      }
    }

    // Log priority sections found
    if (prioritySections.length > 0) {
      console.log(`  📌 Found ${prioritySections.length} "Things That Matter To Me" section(s) across entries`);
    }

    if (monthContent.length === 0) {
      console.log(`  No content to summarize for ${group.monthName}`);
      return result; // Skip this month - no content
    }

    // Combine content for this month (priority sections remain in date context)
    let combinedMonthText = monthContent.join("\n\n---\n\n");

    // Add a header noting priority sections if any were found
    if (prioritySections.length > 0) {
      const priorityReminder = `
==========================================================================
NOTE: This content includes ${prioritySections.length} "Things That Matter To Me" section(s)
within their date context. (See prompt instructions for handling.)
==========================================================================

`;
      combinedMonthText = priorityReminder + combinedMonthText;
    }

    const originalLength = group.files.reduce((sum, f) => sum + (f.content?.length || 0), 0);
    const savedChars = originalLength - combinedMonthText.length;
    const savedPercent = ((savedChars / originalLength) * 100).toFixed(1);

    console.log(`\n  Total content: ${combinedMonthText.length.toLocaleString()} characters (saved ${savedChars.toLocaleString()} chars / ${savedPercent}% via cleaning)`);

    if (dryRun) {
      // In dry-run mode, show what would happen without actually calling Ollama
      const monthFilename = `${group.key}_${group.monthName.replace(/\s+/g, '_')}.txt`;

      if (combinedMonthText.length > MAX_CHUNK_SIZE) {
        const chunks = chunkText(combinedMonthText, MAX_CHUNK_SIZE);
        console.log(`  Would split into ${chunks.length} chunk(s) for processing`);

        for (let j = 0; j < chunks.length; j++) {
          console.log(`\n    [${j + 1}/${chunks.length}] Would summarize chunk...`);
          const inputTokens = estimateTokens(chunks[j]);
          const estimatedTime = estimateTime(inputTokens, 500);
          console.log(`    📊 Input: ~${inputTokens.toLocaleString()} tokens (~${chunks[j].length.toLocaleString()} chars)`);
          console.log(`    ⏱️  Estimated time: ~${formatDuration(estimatedTime)}`);
        }

        console.log(`\n  Would create final monthly summary from ${chunks.length} chunk summaries`);
      } else {
        console.log(`\n  Would summarize month directly...`);
        const monthTextWithPrompt = promptInstructions + combinedMonthText;
        const inputTokens = estimateTokens(monthTextWithPrompt);
        const estimatedTime = estimateTime(inputTokens, 500);
        console.log(`    📊 Input: ~${inputTokens.toLocaleString()} tokens (~${monthTextWithPrompt.length.toLocaleString()} chars)`);
        console.log(`    ⏱️  Estimated time: ~${formatDuration(estimatedTime)}`);
      }

      console.log(`  Would save monthly summary to: ${monthFilename}`);

      // Track that we would have created a summary
      result.success = true;
      result.summary = `[DRY RUN - ${group.monthName}]`;
      result.placeholder = `[DRY RUN PLACEHOLDER]`;
    } else {
      // Normal mode - actually summarize
      try {
        let monthlySummary;

        // Check if we need to chunk the content
        if (combinedMonthText.length > MAX_CHUNK_SIZE) {
          console.log(`  Content exceeds ${MAX_CHUNK_SIZE} chars, splitting into chunks...`);

          const chunks = chunkText(combinedMonthText, MAX_CHUNK_SIZE);
          console.log(`  Split into ${chunks.length} chunk(s)`);

          const chunkSummaries = [];

          // Summarize each chunk
          for (let j = 0; j < chunks.length; j++) {
            console.log(`\n    [${j + 1}/${chunks.length}] Summarizing chunk...`);

            try {
              // Save debug prompt for chunk if enabled
              if (SAVE_DEBUG_PROMPTS) {
                const debugFilename = `DEBUG_PROMPT_${group.key}_${group.monthName.replace(/\s+/g, '_')}_chunk${j + 1}.txt`;
                const debugPath = path.join(outputDir, debugFilename);
                fs.writeFileSync(debugPath, chunks[j]);
                console.log(`    💾 Saved chunk ${j + 1} debug prompt to: ${debugFilename}`);
              }

              const chunkSummary = await summarizeWithOllama(chunks[j], showProgress);
              chunkSummaries.push(chunkSummary);
              console.log(`    ✓ Chunk ${j + 1} complete`);
            } catch (error) {
              console.error(`    ✗ Chunk ${j + 1} failed: ${error.message}`);
              // Continue with other chunks
            }

            // Delay between chunks
            if (j < chunks.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }

          if (chunkSummaries.length === 0) {
            throw new Error("All chunks failed to summarize");
          }

          if (chunkSummaries.length < chunks.length) {
            console.log(`  ⚠️  Warning: ${chunks.length - chunkSummaries.length} chunk(s) failed`);
          }

          // Combine chunk summaries into monthly summary
          console.log(`\n  Creating final monthly summary from ${chunkSummaries.length} chunk summaries...`);
          const combinedChunkSummaries = chunkSummaries.join("\n\n---\n\n");
          const finalInput = promptInstructions + combinedChunkSummaries;

          // Save debug prompt for final combination if enabled
          if (SAVE_DEBUG_PROMPTS) {
            const debugFilename = `DEBUG_PROMPT_${group.key}_${group.monthName.replace(/\s+/g, '_')}_FINAL.txt`;
            const debugPath = path.join(outputDir, debugFilename);
            fs.writeFileSync(debugPath, finalInput);
            console.log(`  💾 Saved final combination debug prompt to: ${debugFilename}`);
          }

          monthlySummary = await summarizeWithOllama(finalInput, showProgress);
        } else {
          // Direct summarization for smaller content
          console.log(`\n  Summarizing month directly...`);
          const monthTextWithPrompt = promptInstructions + combinedMonthText;

          // Save debug prompt if enabled
          if (SAVE_DEBUG_PROMPTS) {
            const debugFilename = `DEBUG_PROMPT_${group.key}_${group.monthName.replace(/\s+/g, '_')}.txt`;
            const debugPath = path.join(outputDir, debugFilename);
            fs.writeFileSync(debugPath, monthTextWithPrompt);
            console.log(`  💾 Saved debug prompt to: ${debugFilename}`);
          }

          monthlySummary = await summarizeWithOllama(monthTextWithPrompt, showProgress);
        }

        // Save individual month summary
        const monthFilename = `${group.key}_${group.monthName.replace(/\s+/g, '_')}.txt`;
        const monthSummaryPath = path.join(outputDir, monthFilename);
        fs.writeFileSync(monthSummaryPath, monthlySummary);

        console.log(`  ✓ Monthly summary saved to: ${monthFilename}`);

        result.success = true;
        result.summary = monthlySummary;
      } catch (error) {
        console.error(`  ✗ Failed to summarize ${group.monthName}: ${error.message}`);
        result.error = error.message;
      }
    }

    return result;
  }

  // Process months in batches (parallel processing)
  for (let i = 0; i < monthGroups.length; i += parallelCount) {
    const batch = monthGroups.slice(i, i + parallelCount);
    const batchNum = Math.floor(i / parallelCount) + 1;
    const totalBatches = Math.ceil(monthGroups.length / parallelCount);

    if (parallelCount > 1 && batch.length > 1) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`BATCH ${batchNum}/${totalBatches}: Processing ${batch.length} month(s) in parallel`);
      console.log('='.repeat(60));
    }

    // Process batch in parallel
    const batchPromises = batch.map((group) =>
      processMonth(group)
    );

    const results = await Promise.all(batchPromises);

    // Collect results
    for (const result of results) {
      if (result.success) {
        monthlySummaries.push(result.summary);
        monthlyDetails.push({
          monthName: result.monthName,
          summary: result.placeholder || result.summary
        });
      }
    }

    // Small delay between batches (not needed for last batch)
    if (i + parallelCount < monthGroups.length && !dryRun) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  if (monthlySummaries.length === 0) {
    console.log("\n❌ No monthly summaries were generated.");
    return;
  }

  // Create aggregate summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${dryRun ? 'Would create' : 'Creating'} aggregate summary from ${monthlySummaries.length} month(s)...`);
  console.log('='.repeat(60));

  const aggregatePrompt = `INSTRUCTIONS: You are synthesizing monthly summaries from a year of personal journal entries. Create a comprehensive, BALANCED summary that celebrates growth while acknowledging challenges.

## CRITICAL REQUIREMENTS:

1. **START WITH WINS**: Begin by identifying and celebrating victories, progress, and positive developments
2. **Balance is Mandatory**: For every challenge or struggle mentioned, highlight corresponding efforts, growth, or wins
3. **Celebrate Consistency**: Showing up, maintaining effort, and self-awareness are victories - acknowledge them!
4. **Honor Core Priorities**: "Things That Matter" sections represent core values - track progress in these areas with special attention
5. **Empathetic & Encouraging**: Imagine summarizing for a good friend - honest about challenges but emphasizing their growth and resilience
6. **Be Specific**: Use concrete details, names, dates, metrics, and specific wins from the monthly summaries

## WRITING TONE:
This is a year-in-review for someone who has put in consistent effort. They deserve to see their progress celebrated. Frame challenges as part of a growth journey, not as defining characteristics.

## OUTPUT FORMAT:

**IMPORTANT**: Format your response in Markdown with proper heading hierarchy for readability.

Use this exact structure with Markdown headings:

# Year in Review

## The Year at a Glance
[2-3 sentences capturing the essence - START POSITIVE, emphasize growth trajectory]

## Wins & Victories
[SPECIFIC accomplishments, breakthroughs, consistent efforts, and positive developments - be generous here! Use bullet points for clarity.]

## New Habits Tried
[New behaviors, experiments, routines, or practices attempted across the year - celebrate trying new things! Use bullet points.]

## Core Priorities & Progress
[Track "Things That Matter" areas - what's going well, where energy is focused, progress made. Consider using subheadings (###) for each priority area if helpful.]

## Key Themes & Patterns
[3-5 main themes - BALANCED: note both positive patterns AND challenges as growth opportunities. Use bullet points or numbered list.]

## Challenges & Growth Edges
[Areas of struggle framed constructively - what's being learned, how they're showing up despite difficulties. Use bullet points.]

## The Path Forward
[Encouraging reflection on trajectory, strengths to build on, opportunities ahead]

## REMEMBER:
- Victories FIRST, challenges second
- For every struggle, note the effort, awareness, or growth
- This person showed up all year - honor that commitment

---

MONTHLY SUMMARIES TO SYNTHESIZE:

`;

  const aggregateInput = monthlyDetails.map((detail) => {
    return `## ${detail.monthName}\n\n${detail.summary}`;
  }).join("\n\n---\n\n");

  const finalAggregateText = aggregatePrompt + aggregateInput;

  if (dryRun) {
    console.log(`\nWould generate aggregate summary...`);
    const inputTokens = estimateTokens(finalAggregateText);
    const estimatedTime = estimateTime(inputTokens, 500);
    console.log(`    📊 Input: ~${inputTokens.toLocaleString()} tokens (~${finalAggregateText.length.toLocaleString()} chars)`);
    console.log(`    ⏱️  Estimated time: ~${formatDuration(estimatedTime)}`);
    console.log(`\nWould save aggregate summary to: AGGREGATE_SUMMARY.md`);
  } else {
    console.log(`\nGenerating aggregate summary...`);

    // Save debug prompt for aggregate if enabled
    if (SAVE_DEBUG_PROMPTS) {
      const debugPath = path.join(outputDir, "DEBUG_PROMPT_AGGREGATE.txt");
      fs.writeFileSync(debugPath, finalAggregateText);
      console.log(`💾 Saved aggregate debug prompt to: DEBUG_PROMPT_AGGREGATE.txt`);
    }

    try {
      const aggregateSummary = await summarizeWithOllama(finalAggregateText, true);

      const aggregatePath = path.join(outputDir, "AGGREGATE_SUMMARY.md");
      fs.writeFileSync(aggregatePath, aggregateSummary);

      console.log(`\n✓ Aggregate summary saved to: AGGREGATE_SUMMARY.md`);
    } catch (error) {
      console.error(`\n✗ Failed to create aggregate summary: ${error.message}`);

      // Fallback: save all monthly summaries concatenated
      const fallbackPath = path.join(outputDir, "ALL_MONTHLY_SUMMARIES.txt");
      fs.writeFileSync(fallbackPath, aggregateInput);
      console.log(`  ℹ️  Saved concatenated monthly summaries to: ALL_MONTHLY_SUMMARIES.txt`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (dryRun) {
    console.log(`DRY RUN COMPLETE - Estimates shown above`);
    console.log(`  - Would create ${monthlySummaries.length} monthly summary file(s)`);
    console.log(`  - Would create 1 aggregate summary`);
  } else {
    console.log(`Done! Summaries saved to: ${outputDir}`);
    console.log(`  - ${monthlySummaries.length} monthly summary file(s)`);
    console.log(`  - 1 aggregate summary`);
  }
  console.log('='.repeat(60));
}

function printUsage() {
  console.log(`
Markdown Summarizer using Ollama

Usage:
  node index.js <notes-directory> [output-directory] [options]

Arguments:
  notes-directory    Path to folder containing markdown files
  output-directory   (Optional) Path for output summaries
                     Default: <notes-directory>${DEFAULT_OUTPUT_SUFFIX}

Options:
  --parallel <N>     Process N months concurrently for faster completion
                     Recommended: 4-6 for M4 Mac mini (default: 1)
  --dry-run          Show estimates and analysis without running summarization
  --concatenate      Concatenate all files into a single file and report token count
  --help, -h         Show this help message

Examples:
  node index.js ~/Documents/Notes
  node index.js ~/Documents/Notes ~/Documents/Summaries
  node index.js ~/Documents/Notes --parallel 4
  node index.js ~/Documents/Notes --dry-run
  node index.js ~/Documents/Notes --parallel 4 --dry-run
  node index.js ~/Documents/Notes --concatenate

Performance:
  Sequential (default): Processes one month at a time
  Parallel (--parallel 4): Process 4 months simultaneously
    - M4 Mac mini: 4-6x faster with --parallel 4-6
    - Requires sufficient RAM (~2-3GB per parallel task)

How it works:
  1. Reads files and parses dates from content (## M/D/YY format)
  2. Groups files by month based on parsed dates
  3. Creates a summary for each month using Ollama
  4. Generates an aggregate summary across all months

Requirements:
  - Ollama installed and running (ollama.com)
  - Model pulled: ollama pull ${OLLAMA_MODEL}
  - Node.js 14+
  - Files must contain date header: ## M/D/YY or ## MM/DD/YY
`);
}

async function main() {
  const scriptStartTime = Date.now();
  console.log(`🚀 Script started at: ${new Date().toLocaleString()}\n`);

  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  // Parse flags
  const dryRun = args.includes("--dry-run");
  const concatenateMode = args.includes("--concatenate");

  // Parse --parallel flag
  let parallelCount = 1; // Default: sequential processing
  const parallelIndex = args.findIndex(arg => arg === "--parallel");
  let parallelValue = null;
  if (parallelIndex !== -1 && args[parallelIndex + 1]) {
    parallelValue = args[parallelIndex + 1];
    const parallelNum = parseInt(parallelValue, 10);
    if (isNaN(parallelNum) || parallelNum < 1) {
      console.error("Error: --parallel must be followed by a positive number");
      process.exit(1);
    }
    if (parallelNum > 8) {
      console.warn(`Warning: --parallel ${parallelNum} is high. Recommended: 4-6 for M4 Mac mini`);
    }
    parallelCount = parallelNum;
  }

  // Filter out flags and the parallel value if present
  const pathArgs = args.filter(arg => {
    if (arg.startsWith("--")) return false; // Remove flags
    if (parallelValue && arg === parallelValue) return false; // Remove parallel value
    return true;
  });

  if (pathArgs.length === 0) {
    console.error("Error: No notes directory specified");
    printUsage();
    process.exit(1);
  }

  const notesDir = path.resolve(pathArgs[0]);
  const outputDir = pathArgs[1]
    ? path.resolve(pathArgs[1])
    : path.join(path.dirname(notesDir), path.basename(notesDir) + DEFAULT_OUTPUT_SUFFIX);

  if (concatenateMode) {
    console.log(`${'='.repeat(60)}`);
    console.log(`CONCATENATE MODE - Creating single file with all content`);
    console.log('='.repeat(60));
    console.log(`Notes directory: ${notesDir}`);
    console.log(`Output directory: ${outputDir}\n`);

    await concatenateAllFiles(notesDir, outputDir);
    return; // Exit after concatenation
  }

  if (dryRun) {
    console.log(`${'='.repeat(60)}`);
    console.log(`DRY RUN MODE - No summarization will be performed`);
    console.log('='.repeat(60));
  }

  console.log(`Notes directory: ${notesDir}`);
  console.log(`Output directory: ${outputDir}`);
  if (parallelCount > 1) {
    console.log(`Parallel processing: ${parallelCount} months concurrently`);
  }
  console.log();

  await summarizeMarkdownFiles(notesDir, outputDir, dryRun, parallelCount);

  // Log completion time
  const scriptEndTime = Date.now();
  const totalDuration = (scriptEndTime - scriptStartTime) / 1000; // Convert to seconds
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Script completed at: ${new Date().toLocaleString()}`);
  console.log(`⏱️  Total execution time: ${formatDuration(totalDuration)}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
