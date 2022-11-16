import * as core from '@actions/core';
import * as github from '@actions/github';

import {
  addComment,
  addLabels,
  getHotfixLabel,
  getHugePrComment,
  getJIRAClient,
  getJIRAIssueKeys,
  getNoIdComment,
  getPRDescription,
  getPRTitleComment,
  isHumongousPR,
  isNotBlank,
  shouldSkipBranchLint,
  shouldUpdatePRDescription,
  updatePrDetails,
  isIssueStatusValid,
  getInvalidIssueStatusComment,
} from './utils';
import { PullRequestParams, JIRADetails, JIRALintActionInputs } from './types';
import { DEFAULT_PR_ADDITIONS_THRESHOLD } from './constants';

const getInputs = (): JIRALintActionInputs => {
  const JIRA_TOKEN: string = core.getInput('jira-token', { required: true });
  const JIRA_BASE_URL: string = core.getInput('jira-base-url', { required: true });
  const GITHUB_TOKEN: string = core.getInput('github-token', { required: true });
  const BRANCH_IGNORE_PATTERN: string = core.getInput('skip-branches', { required: false }) || '';
  const SKIP_COMMENTS: boolean = core.getInput('skip-comments', { required: false }) === 'true';
  const PR_THRESHOLD = parseInt(core.getInput('pr-threshold', { required: false }), 10);
  const VALIDATE_ISSUE_STATUS: boolean = core.getInput('validate_issue_status', { required: false }) === 'true';
  const ALLOWED_ISSUE_STATUSES: string = core.getInput('allowed_issue_statuses');

  return {
    JIRA_TOKEN,
    GITHUB_TOKEN,
    BRANCH_IGNORE_PATTERN,
    SKIP_COMMENTS,
    PR_THRESHOLD: isNaN(PR_THRESHOLD) ? DEFAULT_PR_ADDITIONS_THRESHOLD : PR_THRESHOLD,
    JIRA_BASE_URL: JIRA_BASE_URL.endsWith('/') ? JIRA_BASE_URL.replace(/\/$/, '') : JIRA_BASE_URL,
    VALIDATE_ISSUE_STATUS,
    ALLOWED_ISSUE_STATUSES,
  };
};

async function run(): Promise<void> {
  try {
    const {
      JIRA_TOKEN,
      JIRA_BASE_URL,
      GITHUB_TOKEN,
      BRANCH_IGNORE_PATTERN,
      SKIP_COMMENTS,
      PR_THRESHOLD,
      VALIDATE_ISSUE_STATUS,
      ALLOWED_ISSUE_STATUSES,
    } = getInputs();

    const defaultAdditionsCount = 800;
    const prThreshold: number = PR_THRESHOLD ? Number(PR_THRESHOLD) : defaultAdditionsCount;

    const {
      payload: {
        repository,
        organization: { login: owner },
        pull_request: pullRequest,
      },
    } = github.context;

    if (typeof repository === 'undefined') {
      throw new Error(`Missing 'repository' from github action context.`);
    }

    const { name: repo } = repository;

    const {
      base: { ref: baseBranch },
      head: { ref: headBranch },
      number: prNumber = 0,
      body: prBody = '',
      additions = 0,
      title = '',
    } = pullRequest as PullRequestParams;

    // common fields for both issue and comment
    const commonPayload = {
      owner,
      repo,
      issue_number: prNumber,
    };

    // github client with given token
    const client = github.getOctokit(GITHUB_TOKEN).rest;

    const existingComments = await client.issues.listComments({ ...commonPayload });
    const commentAlreadyExists = (body: string): boolean =>
      existingComments.data.find((a) => a.body && a.body.toLowerCase() === body.toLowerCase()) !== undefined;

    if (!headBranch && !baseBranch) {
      const commentBody = 'jira-lint is unable to determine the head and base branch';
      const comment = {
        ...commonPayload,
        body: commentBody,
      };
      await addComment(client, comment);
      core.setFailed('Unable to get the head and base branch');
      process.exit(1);
    }

    console.log('Base branch -> ', baseBranch);
    console.log('Head branch -> ', headBranch);

    if (shouldSkipBranchLint(headBranch, BRANCH_IGNORE_PATTERN)) {
      process.exit(0);
    }

    let resultText: string[] = [];

    const issueKeys = getJIRAIssueKeys(headBranch);
    if (!issueKeys.length) {
      const comment = {
        ...commonPayload,
        body: getNoIdComment(headBranch),
      };
      if (!commentAlreadyExists(comment.body)) {
        await addComment(client, comment);
      } else {
        console.log('Missing JIRA issue id comment already added, skipping.');
      }
      core.setFailed('JIRA issue id is missing in your branch.');
      process.exit(1);
    }

    // use the last match (end of the branch name)
    const issueKey = issueKeys[issueKeys.length - 1];
    console.log(`JIRA key -> ${issueKey}`);

    const { getTicketDetails } = getJIRAClient(JIRA_BASE_URL, JIRA_TOKEN);
    const details: JIRADetails = await getTicketDetails(issueKey);

    if (details.key) {
      const podLabel = details?.project?.name || '';
      const hotfixLabel: string = getHotfixLabel(baseBranch);
      const typeLabel: string = details?.type?.name || '';
      const labels: string[] = [podLabel, hotfixLabel, typeLabel].filter(isNotBlank);

      console.log('Adding lables -> ', labels);

      await addLabels(client, {
        ...commonPayload,
        labels,
      });

      if (!isIssueStatusValid(VALIDATE_ISSUE_STATUS, ALLOWED_ISSUE_STATUSES.split(','), details)) {
        const invalidIssueStatusComment = {
          ...commonPayload,
          body: getInvalidIssueStatusComment(details.status, ALLOWED_ISSUE_STATUSES),
        };

        console.log('Adding comment for invalid issue status');

        if (!commentAlreadyExists(invalidIssueStatusComment.body)) {
          await addComment(client, invalidIssueStatusComment);
        } else {
          console.log('Invalid issue status comment already exists, skipping.');
        }

        resultText.push('The found jira issue does is not in acceptable statuses.');
      }

      if (shouldUpdatePRDescription(prBody)) {
        console.log(`Updating PR Body with JIRA Details: ${prBody}`);
        const prData = {
          owner,
          repo,
          pull_number: prNumber,
          body: getPRDescription(prBody, details),
        };
        await updatePrDetails(client, prData);

        // add comment for PR title
        if (!SKIP_COMMENTS) {
          const prTitleComment = {
            ...commonPayload,
            body: getPRTitleComment(details.summary, title),
          };

          console.log('Adding comment for the PR title');

          if (!commentAlreadyExists(prTitleComment.body)) {
            await addComment(client, prTitleComment);
          } else {
            console.log('PR title comment already exists, skipping.');
          }
          // add a comment if the PR is huge
          if (isHumongousPR(additions, prThreshold)) {
            const hugePrComment = {
              ...commonPayload,
              body: getHugePrComment(additions, prThreshold),
            };
            console.log('Adding comment for huge PR');
            if (!commentAlreadyExists(hugePrComment.body)) {
              await addComment(client, hugePrComment);
            } else {
              console.log('Humongous PR comment already exists, skipping.');
            }
          }
        }
      }
    } else {
      const comment = {
        ...commonPayload,
        body: getNoIdComment(headBranch),
      };
      if (!commentAlreadyExists(comment.body)) {
        await addComment(client, comment);
      } else {
        console.log('invalid JIRA issue comment already exists, skipping.');
      }
      resultText.push('Invalid JIRA key. Please create a branch with a valid JIRA issue key.');
    }

    if (resultText.length === 0) {
      process.exit(0);
    } else {
      const resultString = resultText.join(', ').trim().slice(0, -1) + '.';
      core.setFailed(resultString);
      process.exit(1);
    }
  } catch (error) {
    console.log({ error });
    core.setFailed((error as any).message);
    process.exit(1);
  }
}

run();
