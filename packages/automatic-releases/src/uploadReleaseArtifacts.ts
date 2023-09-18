import * as core from '@actions/core';
import {globby} from 'globby';
import {createReadStream, statSync} from 'fs';
import * as types from '@octokit/types';
import path from 'path';
import md5File from 'md5-file';
import {GitHub} from '@actions/github/lib/utils';

type ReposCreateReleaseParams = types.Endpoints['POST /repos/{owner}/{repo}/releases']['parameters'];

/* eslint-disable  @typescript-eslint/no-explicit-any */
export const uploadReleaseArtifacts = async (
  client: InstanceType<typeof GitHub>,
  releaseParams: ReposCreateReleaseParams,
  uploadId: number,
  files: string[],
): Promise<void> => {
  core.startGroup('Uploading release artifacts');
  for (const fileGlob of files) {
    const paths = await globby(fileGlob, {});
    if (paths.length == 0) {
      core.error(`${fileGlob} doesn't match any files`);
    }

    for (const filePath of paths) {
      core.info(`Uploading: ${filePath}`);
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        core.debug(`Skipping ${filePath}, since its not a file`);
        return;
      }
      const file_size = stat.size;
      if (file_size === 0) {
        core.debug(`Skipping ${filePath}, since its size is 0`);
        return;
      }

      const nameWithExt = path.basename(filePath);
      try {
        await client.rest.repos.uploadReleaseAsset({
          url: releaseParams.data.upload_url,
          headers: {
            'content-type': 'binary/octet-stream',
            'content-length': file_size,
          },
          owner: releaseParams.owner,
          repo: releaseParams.repo,
          release_id: uploadId,
          name: nameWithExt,
          data: createReadStream(filePath) as any,
        });
      } catch (err) {
        if (err instanceof Error) {
          core.info(
            `Problem uploading ${filePath} as a release asset (${err.message}). Will retry with the md5 hash appended to the filename.`,
          );
        }
        const hash = await md5File(filePath);
        const basename = path.basename(filePath, path.extname(filePath));
        const ext = path.extname(filePath);
        const newName = `${basename}-${hash}${ext}`;
        await client.rest.repos.uploadReleaseAsset({
          owner: releaseParams.owner,
          repo: releaseParams.repo,
          release_id: uploadId,
          name: newName,
          data: createReadStream(filePath) as any,
        });
      }
    }
  }
  core.endGroup();
};
