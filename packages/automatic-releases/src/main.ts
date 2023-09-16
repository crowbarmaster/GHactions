import * as core from '@actions/core';
import {context, getOctokit} from '@actions/github';
import {GitHub} from '@actions/github/lib/utils';
import * as types from '@octokit/types';
import {RestEndpointMethodTypes} from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types';
import {dumpGitHubEventPayload} from './keybaseUtils';
import {sync as commitParser} from 'conventional-commits-parser';
import {getChangelogOptions, ReposCompareCommitsResponseCommitsItem} from './utils';
import {isBreakingChange, generateChangelogFromParsedCommits, parseGitTag, ParsedCommits} from './utils';
import semverValid from 'semver/functions/valid';
import semverRcompare from 'semver/functions/rcompare';
import semverLt from 'semver/functions/lt';
import {uploadReleaseArtifacts} from './uploadReleaseArtifacts';

type GitCreateRefParams = types.Endpoints['POST /repos/{owner}/{repo}/git/refs']['parameters'];
type GitGetRefParams = types.Endpoints['GET /repos/{owner}/{repo}/git/ref/{ref}']['parameters'];
type RepoCreateReleaseDetails = Promise<RestEndpointMethodTypes['repos']['createRelease']['response']>;
type ReposListTagsParams = types.Endpoints['GET /repos/{owner}/{repo}/tags']['parameters'];
type ReposGetReleaseByTagParams = types.Endpoints['GET /repos/{owner}/{repo}/releases/tags/{tag}']['parameters'];
type ReposCreateReleaseParams = types.Endpoints['POST /repos/{owner}/{repo}/releases']['parameters'];

type GitTagDetailObject = {
  semverTag: string;
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  zipball_url: string;
  tarball_url: string;
  node_id: string;
};

type Args = {
  repoToken: string;
  automaticReleaseTag: string;
  draftRelease: boolean;
  preRelease: boolean;
  releaseTitle: string;
  releaseBody: string;
  files: string[];
};

const getAndValidateArgs = (): Args => {
  const args = {
    repoToken: core.getInput('repo_token', {required: true}),
    automaticReleaseTag: core.getInput('automatic_release_tag', {required: false}),
    draftRelease: JSON.parse(core.getInput('draft', {required: true})),
    preRelease: JSON.parse(core.getInput('prerelease', {required: true})),
    releaseTitle: core.getInput('title', {required: false}),
    releaseBody: core.getInput('body', {required: false}),
    files: [] as string[],
  };

  const inputFilesStr = core.getInput('files', {required: false});
  if (inputFilesStr) {
    args.files = inputFilesStr.split(/\r?\n/);
  }

  return args;
};

const createReleaseTag = async (client: InstanceType<typeof GitHub>, refInfo: GitCreateRefParams) => {
  core.startGroup('Generating release tag');
  const friendlyTagName = refInfo.ref.substring(10); // 'refs/tags/latest' => 'latest'
  core.info(`Attempting to create or update release tag "${friendlyTagName}"`);

  try {
    await client.rest.git.createRef(refInfo);
  } catch (err) {
    const existingTag = refInfo.ref.substring(5); // 'refs/tags/latest' => 'tags/latest'
    if (err instanceof Error) {
      core.info(
        `Could not create new tag "${refInfo.ref}" (${err.message}) therefore updating existing tag "${existingTag}"`,
      );
    }
    await client.rest.git.updateRef({
      ...refInfo,
      ref: existingTag,
      force: true,
    });
  }

  core.info(`Successfully created or updated the release tag "${friendlyTagName}"`);
  core.endGroup();
};

const deletePreviousGitHubRelease = async (
  client: InstanceType<typeof GitHub>,
  releaseInfo: ReposGetReleaseByTagParams,
) => {
  core.startGroup(`Deleting GitHub releases associated with the tag "${releaseInfo.tag}"`);
  try {
    core.info(`Searching for releases corresponding to the "${releaseInfo.tag}" tag`);
    const resp = await client.rest.repos.getReleaseByTag(releaseInfo);

    core.info(`Deleting release: ${resp.data.id}`);
    await client.rest.repos.deleteRelease({
      owner: releaseInfo.owner,
      repo: releaseInfo.repo,
      release_id: resp.data.id,
    });
  } catch (err) {
    if (err instanceof Error) {
      core.info(`Could not find release associated with tag "${releaseInfo.tag}" (${err.message})`);
    }
  }
  core.endGroup();
};

const generateNewGitHubRelease = async (
  client: InstanceType<typeof GitHub>,
  releaseInfo: ReposCreateReleaseParams,
): Promise<RepoCreateReleaseDetails> => {
  core.startGroup(`Generating new GitHub release for the "${releaseInfo.tag_name}" tag`);

  core.info('Creating new release');
  const resp = await client.rest.repos.createRelease(releaseInfo);
  core.endGroup();
  return resp;
};

const searchForPreviousReleaseTag = async (
  client: InstanceType<typeof GitHub>,
  currentReleaseTag: string,
  tagInfo: ReposListTagsParams,
): Promise<string> => {
  const validSemver = semverValid(currentReleaseTag);
  if (!validSemver) {
    throw new Error(
      `The parameter "automatic_release_tag" was not set and the current tag "${currentReleaseTag}" does not appear to conform to semantic versioning.`,
    );
  }

  const listTagsOptions = client.rest.repos.listTags.endpoint.merge(tagInfo);
  const tl = await client.paginate<GitTagDetailObject>(listTagsOptions);

  const tagList = tl
    .map((tag: GitTagDetailObject) => {
      core.debug(`Currently processing tag ${tag.name}`);
      const t = semverValid(tag.name);
      let semTag: string = '';
      if (t !== null) {
        semTag = t;
      }
      return {
        ...tag,
        semverTag: semTag,
      };
    })
    .filter((tag: GitTagDetailObject) => {
      return tag.semverTag !== null;
    })
    .sort((a, b) => {
      return semverRcompare(a.semverTag, b.semverTag);
    });

  let previousReleaseTag = '';
  for (const tag of tagList) {
    if (semverLt(tag.semverTag, currentReleaseTag)) {
      previousReleaseTag = tag.name;
      break;
    }
  }

  return previousReleaseTag;
};

const getCommitsSinceRelease = async (
  client: InstanceType<typeof GitHub>,
  tagInfo: GitGetRefParams,
  currentSha: string,
): Promise<ReposCompareCommitsResponseCommitsItem[]> => {
  core.startGroup('Retrieving commit history');
  let resp;

  core.info('Determining state of the previous release');
  let previousReleaseRef = '' as string;
  core.info(`Searching for SHA corresponding to previous "${tagInfo.ref}" release tag`);
  try {
    resp = await client.rest.git.getRef(tagInfo);
    previousReleaseRef = parseGitTag(tagInfo.ref);
  } catch (err) {
    if (err instanceof Error) {
      core.info(
        `Could not find SHA corresponding to tag "${tagInfo.ref}" (${err.message}). Assuming this is the first release.`,
      );
      previousReleaseRef = 'HEAD';
    }
  }

  core.info(`Retrieving commits between ${previousReleaseRef} and ${currentSha}`);
  try {
    resp = await client.rest.repos.compareCommits({
      owner: tagInfo.owner,
      repo: tagInfo.repo,
      base: previousReleaseRef,
      head: currentSha,
    });
    core.info(
      `Successfully retrieved ${resp.data.commits.length} commits between ${previousReleaseRef} and ${currentSha}`,
    );
  } catch (err) {
    if (err instanceof Error) {
      // istanbul ignore next
      core.warning(`Could not find any commits between ${previousReleaseRef} and ${currentSha}`);
    }
  }

  let commits = [];
  if (resp?.data?.commits) {
    commits = resp.data.commits;
  }
  core.debug(`Currently ${commits.length} number of commits between ${previousReleaseRef} and ${currentSha}`);

  core.endGroup();
  return commits;
};

export const getChangelog = async (
  client: InstanceType<typeof GitHub>,
  owner: string,
  repo: string,
  commits: ReposCompareCommitsResponseCommitsItem[],
): Promise<string> => {
  const parsedCommits: ParsedCommits[] = [];
  core.startGroup('Generating changelog');

  for (const commit of commits) {
    core.debug(`Processing commit: ${JSON.stringify(commit)}`);
    core.debug(`Searching for pull requests associated with commit ${commit.sha}`);
    const pulls = await client.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: owner,
      repo: repo,
      commit_sha: commit.sha,
    });
    if (pulls.data.length) {
      core.info(`Found ${pulls.data.length} pull request(s) associated with commit ${commit.sha}`);
    }

    const clOptions = await getChangelogOptions();
    const parsedCommitMsg = commitParser(commit.commit.message, clOptions);

    // istanbul ignore next
    if (parsedCommitMsg.merge) {
      core.debug(`Ignoring merge commit: ${parsedCommitMsg.merge}`);
      continue;
    }

    parsedCommitMsg.extra = {
      commit: commit,
      pullRequests: [],
      breakingChange: false,
    };

    parsedCommitMsg.extra.pullRequests = pulls.data.map((pr) => {
      return {
        number: pr.number,
        url: pr.html_url,
      };
    });

    parsedCommitMsg.extra.breakingChange = isBreakingChange({
      body: parsedCommitMsg.body,
      footer: parsedCommitMsg.footer,
    });
    core.debug(`Parsed commit: ${JSON.stringify(parsedCommitMsg)}`);
    parsedCommits.push(parsedCommitMsg);
    core.info(`Adding commit "${parsedCommitMsg.header}" to the changelog`);
  }

  const changelog = generateChangelogFromParsedCommits(parsedCommits);
  core.debug('Changelog:');
  core.debug(changelog);

  core.endGroup();
  return changelog;
};

export const main = async (): Promise<void> => {
  try {
    const args = getAndValidateArgs();

    // istanbul ignore next
    const client = getOctokit(args.repoToken);

    core.startGroup('Initializing the Automatic Releases action');
    dumpGitHubEventPayload();
    core.debug(`Github context: ${JSON.stringify(context)}`);
    core.endGroup();

    core.startGroup('Determining release tags');
    const tagRef: string = context.ref;
    core.info(`Current tag ref: ${tagRef}`);
    const parsedTag: string = parseGitTag(tagRef);
    core.info(`Parsed tag ref: ${parsedTag}`);
    const releaseTag = args.automaticReleaseTag ? args.automaticReleaseTag : parsedTag;
    if (!releaseTag) {
      throw new Error(
        `The parameter "automatic_release_tag" was not set and this does not appear to be a GitHub tag event. (Event: ${context.ref})`,
      );
    }

    const previousReleaseTag = args.automaticReleaseTag
      ? args.automaticReleaseTag
      : await searchForPreviousReleaseTag(client, releaseTag, {
          owner: context.repo.owner,
          repo: context.repo.repo,
        });
    core.endGroup();

    const commitsSinceRelease = await getCommitsSinceRelease(
      client,
      {
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: `tags/${previousReleaseTag}`,
      },
      context.sha,
    );

    const changelog = await getChangelog(client, context.repo.owner, context.repo.repo, commitsSinceRelease);

    if (args.automaticReleaseTag) {
      await createReleaseTag(client, {
        owner: context.repo.owner,
        ref: `refs/tags/${args.automaticReleaseTag}`,
        repo: context.repo.repo,
        sha: context.sha,
      });

      await deletePreviousGitHubRelease(client, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        tag: args.automaticReleaseTag,
      });
    }

    const releaseParams = {
      owner: context.repo.owner,
      repo: context.repo.repo,
      tag_name: releaseTag,
      name: args.releaseTitle ? args.releaseTitle : releaseTag,
      body: args.releaseBody ? args.releaseBody : changelog,
      draft: args.draftRelease,
      prerelease: args.preRelease,
    };

    const releaseUploadInfo = await generateNewGitHubRelease(client, releaseParams);

    await uploadReleaseArtifacts(client, releaseParams, releaseUploadInfo.data.id, args.files);

    core.debug(`Exporting environment variable AUTOMATIC_RELEASES_TAG with value ${releaseTag}`);
    core.exportVariable('AUTOMATIC_RELEASES_TAG', releaseTag);
    core.setOutput('automatic_releases_tag', releaseTag);
    core.setOutput('upload_url', releaseUploadInfo.data.upload_url);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
      throw error;
    }
  }
};
