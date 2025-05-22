# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages OpenAI's GPT-4 API to provide intelligent feedback and suggestions on
your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code
review process.

## Features

- Reviews pull requests using OpenAI's GPT-4 API.
- Provides intelligent comments and suggestions for improving your code.
- Filters out files that match specified exclude patterns.
- Easy to set up and integrate into your GitHub workflow.

## Setup

1. To use this GitHub Action, you need an OpenAI API key. If you don't have one, sign up for an API key
   at [OpenAI](https://beta.openai.com/signup).

2. Add the OpenAI API key as a GitHub Secret in your repository with the name `OPENAI_API_KEY`. You can find more
   information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/code-reviewer.yml` file in your repository and add the following content:

```yaml
name: AI Code Reviewer

on:
  pull_request:
    branches:
      - main

    types:
      - opened
      - synchronize

permissions:
  contents: read
  pull-requests: write
        
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v4

      - name: AI Code Reviewer
        uses: kodif-team/ai-codereviewer@v3.4
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-4.1"
          EXCLUDE: "**/*.json, **/*.md"
          GUIDELINES: |
            - Use descriptive variable names (user_count not uc)
            - Follow PEP 8 style guidelines
            - Use list comprehensions for simple transformations
            - Prefer pathlib over os.path for file operations
            - Use context managers (with statements) for resource management
            - Add type hints for function parameters and return values            
            - Ensure robust error handling and logging mechanisms are in place
            - Handle edge cases and errors gracefully
            - Write unit tests for new functions
```

4. Customize the `EXCLUDE` input if you want to ignore certain file patterns from being reviewed.
5. Provide the `GUIDELINES` input to fine-tune code review.

6. Commit the changes to your repository, and AI Code Reviewer will start working on your future pull requests.

## How It Works

The AI Code Reviewer GitHub Action retrieves the pull request diff, filters out excluded files, and sends code chunks to
the OpenAI API. It then generates review comments based on the AI's response and adds them to the pull request.

## Current Limitations

It can't create a comment to the whole PR without attaching to a specific code line.

Assume that we want to ensure that PR title contains Jira ticket and that description lists the changes, we can't do that currently

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Code Reviewer GitHub
Action.

Let the maintainer generate the final package (`yarn build` & `yarn package`).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
