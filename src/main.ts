import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const GUIDELINES:string = core.getInput("GUIDELINES");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return response.data as unknown as string;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number; side: "LEFT" | "RIGHT" }>> {
  const comments: Array<{ body: string; path: string; line: number; side: "LEFT" | "RIGHT" }> = [];

  for (const file of parsedDiff) {
    const currentFilePath = file.to;
    if (!currentFilePath || currentFilePath === "/dev/null") continue;

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      console.log(prompt);
      
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newCommentsForFile = createComment(aiResponse).map(comment => ({
          ...comment,
          path: currentFilePath,
        }));

        if (newCommentsForFile.length > 0) {
          comments.push(...newCommentsForFile);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  const diffLines = chunk.changes
    .map((change) => {
      let lineNumber: number;
      if (change.type === 'add') {
        lineNumber = change.ln;
      } else if (change.type === 'del') {
        lineNumber = change.ln;
      } else if (change.type === 'normal') {
        lineNumber = change.ln2;
      } else {
        return (change as any).content;
      }
      return `${lineNumber} ${change.content}`;
    })
    .join("\\n");

  return `
## Role  
You are a code review assistant that provides objective, constructive feedback on pull requests.

## How to Review (Instructions):
- Provide feedback ONLY when there are actionable improvements to suggest
- If no issues are found, return an empty reviews array
- Format all comments in GitHub Markdown
- Focus exclusively on the code changes, not PR titles or descriptions
- Be specific and actionable in your feedback
- IMPORTANT: NEVER suggest adding comments to the code.

## What to Review (Guidelines):
- Ensure code is clean and readable
- Avoid unnecessary complexity and code duplication
- Manage dependencies effectively and audit for vulnerabilities
- Use descriptive nouns for variables, verbs for functions, and avoid abbreviations.
- Keep functions small and focused (single responsibility)
${GUIDELINES}

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:
---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${diffLines}
\`\`\`
`;
}

const reviewsJsonSchema =
{
  "type": "object",
  "properties": {
    "reviews": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "lineNumber": { "type": "integer" },
          "changeType": { "type": "enum", "enum": ["+", "-"] },
          "reviewComment": { "type": "string" }
        },
        "required": ["lineNumber", "changeType", "reviewComment"]
      }
    }
  },
  "required": ["reviews"]
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: number;
  changeType: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  const maxRetries = 3;
  const retryDelayMs = 1000;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        ...queryConfig,
        // @ts-ignore
        response_format: { 
          type: "json_schema" as any, 
          // @ts-ignore
          json_schema: {
            name: "code_reviews",
            description: "Schema for code review comments.",
            schema: reviewsJsonSchema,            
          }
        },
        messages: [
          {
            role: "system",
            content: prompt,
          },
        ],
      });

      const res = response.choices[0].message?.content?.trim() || "{}";
      console.log(response.choices[0].message?.content);
      return JSON.parse(res).reviews;
      
    } catch (error) {
      lastError = error;
      core.error(`OpenAI API call failed (attempt ${attempt} of ${maxRetries}): ${error}`);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError;
}

function createComment(
  aiResponses: Array<{
    lineNumber: number;
    changeType: string;
    reviewComment: string;
  }>
): Array<{ body: string; line: number; side: "LEFT" | "RIGHT" }> {
  return aiResponses.flatMap((aiResponse) => {
    const lineNum = aiResponse.lineNumber;
    if (isNaN(lineNum) || lineNum <= 0) {
      console.log(`Invalid line number: ${aiResponse}`);
      return []
    }

    return {
      body: aiResponse.reviewComment,
      line: lineNum,
      side: aiResponse.changeType === "+" ? "RIGHT" : "LEFT",
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number; side: "LEFT" | "RIGHT" }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
    
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("EXCLUDE")
    .split(",")
    .map((s: string) => s.trim());

  const filteredDiff = parsedDiff.filter((file: File) => {
    return !excludePatterns.some((pattern: string) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  core.setFailed(error.message);
});
