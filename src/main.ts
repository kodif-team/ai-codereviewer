import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { retry } from "@octokit/plugin-retry";

import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const GUIDELINES:string = core.getInput("GUIDELINES");

const MyOctokit = Octokit.plugin(retry);
const octokit = new MyOctokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  baseSha: string;
  headSha: string;
  nodeId: string;
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
    baseSha: prResponse.data.base.sha,
    headSha: prResponse.data.head.sha,
    nodeId: prResponse.data.node_id,
  };
}

async function getBaseFileContent(prDetails: PRDetails, filePath: string): Promise<string> {
  try {
    const response = await octokit.repos.getContent({
      owner: prDetails.owner,
      repo: prDetails.repo,
      path: filePath,
      ref: prDetails.baseSha,
    });

    // The content is base64 encoded
    // @ts-ignore
    if (response.data.content) {
      // @ts-ignore
      return Buffer.from(response.data.content, "base64").toString("utf-8");
    }
    return "";
  } catch (error) {
    console.log(`Base file content not found for ${filePath}`);
    return "";
  }
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number; side: "LEFT" | "RIGHT" }>> {
  const comments: Array<{ body: string; path: string; line: number; side: "LEFT" | "RIGHT" }> = [];

  for (const file of parsedDiff) {
    const currentFilePath = file.to;
    if (!currentFilePath || currentFilePath === "/dev/null") continue;

    const baseFileContent = await getBaseFileContent(prDetails, currentFilePath);
    const prompt = createPrompt(file, prDetails, baseFileContent);
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
  return comments;
}

function createDiffLines(chunk: Chunk): string {
  return chunk.changes
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
  .join("\n");
}


function createPrompt(file: File, prDetails: PRDetails, baseFileContent: string): string {
  const diffLines = file.chunks.map(chunk => {
    return createDiffLines(chunk);
  }).join("\n\n");


  return `
## Role  
You are a code review assistant that provides objective, constructive feedback on pull requests.

## How to Review (Instructions):
- Use the base file content to understand the context of the code changes.
- Provide feedback only for the diff when there are actionable improvements to suggest
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

Pull request title: ${prDetails.title}
Pull request description:
---
${prDetails.description}
---

Base file content:
\`\`\`
${baseFileContent}
\`\`\`

Review the following code diff in the file "${file.to}" and use the base file content to understand the context of the code changes.

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
          "changeType": { "type": "string", "description": "Either '+' for additions or '-' for deletions" },
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
    temperature: 0.0,
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

  try {

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments,
      event: "COMMENT",
    });

  } catch (error) {
    console.warn("Error creating review comments batch:", error);
    for (const comment of comments) {
      try {
        await octokit.pulls.createReview({
          owner,
          repo,
          pull_number,
          comments: [comment],
          event: "COMMENT",
        });
      } catch (error) {
        console.error("Error creating review comment:", comment, error);
      }
    }
  }
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const results: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    results.push(array.slice(i, i + chunkSize));
  }
  return results;
}

async function getExistingCommentsGraphQL(prDetails: PRDetails): Promise<Array<{ path: string; line: number; body: string; side: "LEFT" | "RIGHT" }>> {
  const query = `
    query GetPullRequestReviewThreads($owner: String!, $repo: String!, $pullNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pullNumber) {
          reviewThreads(first: 100) { # Adjust pagination as needed
            nodes {
              isOutdated
              isResolved
              diffSide # LEFT or RIGHT side of the diff
              comments(first: 100) { # Adjust pagination for comments
                nodes {
                  path
                  body
                  actualHeadLine: line # Line number in the HEAD of the PR
                  originalBaseLine: originalLine # Line number in the BASE of the PR
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    console.log('Getting existing comments with GraphQL:', query);
    const gqlResponse: any = await graphql(query, {
      owner: prDetails.owner,
      repo: prDetails.repo,
      pullNumber: prDetails.pull_number,
      headers: {
        authorization: `token ${GITHUB_TOKEN}`,
      },
    });

    const existingComments: Array<{ path: string; line: number; body: string; side: "LEFT" | "RIGHT" }> = [];
    gqlResponse.repository.pullRequest.reviewThreads.nodes.forEach((thread: any) => {
      if (!thread.isOutdated) {
        const threadSide = thread.diffSide === "LEFT" ? "LEFT" : "RIGHT"; // Ensure valid enum values

        thread.comments.nodes.forEach((commentNode: any) => {
          let relevantLineNumber: number;

          if (threadSide === "LEFT") {
            relevantLineNumber = commentNode.originalBaseLine;
          } else { // RIGHT
            relevantLineNumber = commentNode.actualHeadLine;
          }

          // Ensure line number is valid for the comment context
          if (relevantLineNumber === null || relevantLineNumber === undefined) {
            console.log("Skipping comment without a valid line number for its side:", commentNode.body, "on thread side:", threadSide);
            return; // Continue to the next comment
          }

          existingComments.push({
            path: commentNode.path,
            line: relevantLineNumber,
            body: commentNode.body,
            side: threadSide,
          });
        });
      }
    });
    return existingComments;
  } catch (error) {
    console.error("Error fetching comments with GraphQL:", error);
    core.setFailed("Failed to fetch existing comments using GraphQL.");
    return []; // Return empty or throw, depending on desired error handling
  }
}

async function main() {
  const prDetails = await getPRDetails();

  const response = await octokit.repos.compareCommits({
    owner: prDetails.owner,
    repo: prDetails.repo,
    base: prDetails.baseSha,
    head: prDetails.headSha,
    headers: {
      accept: "application/vnd.github.v3.diff",
    },
  });
  const diff = String(response.data);

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
  if (comments.length === 0) {
    console.log("No comments to create");
    return;
  }

  const existingComments = await getExistingCommentsGraphQL(prDetails);
  console.log('Existing comments:', existingComments.length);

  const existingCommentsSet = new Set(
    existingComments.map(comment => `${comment.path}:${comment.line}:${comment.side}`)
  );

  const isDuplicate = (newComment: { body: string; path: string; line: number; side: "LEFT" | "RIGHT" }) => {
    const commentIdentifier = `${newComment.path}:${newComment.line}:${newComment.side}`;
    return existingCommentsSet.has(commentIdentifier);
  };

  const uniqueComments = comments.filter(comment => !isDuplicate(comment));

  const BATCH_SIZE = 50;
  const commentBatches = chunkArray(uniqueComments, BATCH_SIZE);

  for (const batch of commentBatches) {
    console.log(`Creating review comment batch ${commentBatches.indexOf(batch) + 1} of ${commentBatches.length}`);
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      batch
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  core.setFailed(error.message);
});
