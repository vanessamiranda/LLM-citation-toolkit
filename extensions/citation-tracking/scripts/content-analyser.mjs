/**
 * Content Analyser
 *
 * Reads URLs observed in latest.json,
 * fetches the public pages,
 * and measures content elements.
 *
 * No recommendations are generated here.
 * This file only collects evidence.
 */

import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url);

const latestPath = new URL("data/latest.json", ROOT);
const outputPath = new URL("data/content-analysis.json", ROOT);

const latest = JSON.parse(
  await readFile(latestPath, "utf8")
);

// Commercial prompts we currently want to analyse
const TARGET_PROMPTS = ["p03", "p04", "p09"];

/**
 * Remove HTML tags and clean text.
 */
function cleanText(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract simple measurable content signals.
 */
function analyseHtml(html, url) {
  const text = cleanText(html);

  const titleMatch = html.match(
    /<title[^>]*>([\s\S]*?)<\/title>/i
  );

  const h1Matches = [
    ...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)
  ];

  const h2Matches = [
    ...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)
  ];

  const faqMatches =
    text.match(/\bFAQ\b|frequently asked questions/gi) ?? [];

  const tableMatches =
    html.match(/<table[\s>]/gi) ?? [];

  const listMatches =
    html.match(/<(ul|ol)[\s>]/gi) ?? [];

  const schemaMatches = [
    ...html.matchAll(
      /"@type"\s*:\s*"([^"]+)"/gi
    )
  ];

  const schemaTypes = [
    ...new Set(
      schemaMatches.map(match => match[1])
    )
  ];

  return {
    url,

    title: titleMatch
      ? cleanText(titleMatch[1])
      : null,

    wordCount: text
      ? text.split(/\s+/).length
      : 0,

    headings: {
      h1Count: h1Matches.length,
      h1: h1Matches.map(match =>
        cleanText(match[1])
      ),

      h2Count: h2Matches.length,
      h2: h2Matches.map(match =>
        cleanText(match[1])
      )
    },

    contentElements: {
      faqDetected: faqMatches.length > 0,
      tableCount: tableMatches.length,
      listCount: listMatches.length
    },

    structuredData: {
      typesFound: schemaTypes
    }
  };
}

/**
 * Fetch and analyse one page.
 */
async function analysePage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 AI-Visibility-Content-Analyser/1.0"
      }
    });

    if (!response.ok) {
      return {
        url,
        status: "error",
        httpStatus: response.status
      };
    }

    const html = await response.text();

    return {
      status: "ok",
      httpStatus: response.status,
      ...analyseHtml(html, url)
    };

  } catch (error) {
    return {
      url,
      status: "error",
      error: error.message
    };
  }
}

/**
 * Collect URLs from successful AI observations.
 */
const records = (latest.records ?? []).filter(
  record =>
    TARGET_PROMPTS.includes(record.promptId) &&
    record.status === "ok"
);

const promptGroups = {};

for (const record of records) {

  if (!promptGroups[record.promptId]) {
    promptGroups[record.promptId] = new Set();
  }

  for (const source of record.sources ?? []) {

    // Sources may be strings or objects.
    const url =
      typeof source === "string"
        ? source
        : source.url;

    if (
      url &&
      /^https?:\/\//i.test(url)
    ) {
      promptGroups[record.promptId].add(url);
    }
  }
}

/**
 * Analyse each unique URL.
 */
const analysis = [];

for (const [promptId, urls] of Object.entries(promptGroups)) {

  const pages = [];

  for (const url of urls) {
    console.log(`Analysing: ${url}`);

    const result = await analysePage(url);

    pages.push(result);
  }

  analysis.push({
    promptId,
    pages
  });
}

const output = {
  generatedAt: new Date().toISOString(),

  methodology: {
    source:
      "Public URLs observed in latest.json AI citation results",

    measurement:
      "Live HTML page analysis",

    recommendationGeneration:
      false
  },

  analysis
};

await writeFile(
  outputPath,
  JSON.stringify(output, null, 2) + "\n"
);

console.log(
  `Content analysis completed for ${analysis.length} prompts.`
);
