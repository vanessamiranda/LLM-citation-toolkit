/**
 * Opportunity analysis
 *
 * Reads the latest AI visibility results and prepares
 * evidence-backed growth opportunities.
 *
 * This first version does NOT invent recommendations.
 * It simply connects selected commercial prompts with
 * the evidence already captured in latest.json.
 */

import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url);

const latestPath = new URL("data/latest.json", ROOT);
const opportunitiesPath = new URL("data/opportunities.json", ROOT);

const latest = JSON.parse(
  await readFile(latestPath, "utf8")
);

/*
 * Start with the three highest-value commercial themes.
 *
 * p03 = Premier comparison
 * p04 = Priority banking
 * p09 = Wealth management
 */
const TARGET_PROMPTS = {
  p03: {
    topic: "Premier Banking",
    businessGoal: "Generate qualified Premier and affluent banking enquiries"
  },

  p04: {
    topic: "Priority Banking",
    businessGoal: "Generate qualified Premier and affluent banking enquiries"
  },

  p09: {
    topic: "Wealth Management",
    businessGoal: "Generate qualified wealth management enquiries"
  }
};

/*
 * Find records belonging to each prompt.
 *
 * We only store observed evidence from latest.json.
 * Content recommendations will be added in the next step.
 */
const opportunities = Object.entries(TARGET_PROMPTS).map(
  ([promptId, definition]) => {

    const records = (latest.records ?? []).filter(
      record => record.promptId === promptId
    );

    const successfulRecords = records.filter(
      record => record.status === "ok"
    );

    const sources = [
      ...new Set(
        successfulRecords.flatMap(
          record => record.sources ?? []
        )
      )
    ];

    return {
      promptId,

      topic: definition.topic,

      businessGoal: definition.businessGoal,

      evidence: {
        aiResultsObserved: successfulRecords.length,
        enginesObserved: [
          ...new Set(
            successfulRecords.map(record => record.engine)
          )
        ],
        citedSources: sources
      },

      contentAnalysis: {
        status: "pending",
        hsbcPages: [],
        competitorPages: [],
        gaps: []
      },

      recommendations: {
        status: "pending",
        actions: []
      }
    };
  }
);

const output = {
  generatedAt: new Date().toISOString(),

  methodology: {
    aiVisibility: "Observed from latest.json",
    contentGap: "Pending live-page comparison",
    recommendations: "Pending evidence-backed analysis"
  },

  opportunities
};

await writeFile(
  opportunitiesPath,
  JSON.stringify(output, null, 2) + "\n"
);

console.log(
  `Created ${opportunities.length} commercial opportunities.`
);
