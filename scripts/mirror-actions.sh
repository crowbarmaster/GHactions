#!/usr/bin/env bash

set -e

if [[ $# -ne 1 ]]; then
  echo "This needs a release tag. e.g. $0 v0.0.1"
  exit 1
fi

if [[ -z "$GITHUB_SUPER_TOKEN" ]]; then
  echo "This script needs a GitHub personal access token."
  exit 1
fi

ACTION_AUTOMATIC_RELEASES_REPO="GH-Automatic-Releases"
TAG=$1
GITHUB_LOGIN="crowbarmaster"
RELEASE_BODY="Details available at [crowbarmaster/GHactions@${TAG}](https://github.com/crowbarmaster/GHactions/releases/tag/${TAG})."

PRERELEASE="false"
if [[ "$TAG" == "latest" ]]; then
  PRERELEASE="true"
fi

if [[ "$GITHUB_REPOSITORY" != "crowbarmaster/GHactions" ]]; then
  echo "This mirror script is only meant to be run from crowbarmaster/GHactions, not ${GITHUB_REPOSITORY}. Nothing to do here."
  exit 0
fi

create_tagged_release() {
  REPO=$1
  pushd /tmp/${REPO}/

  # Set the local git identity
  git config user.email "${GITHUB_LOGIN}@users.noreply.github.com"
  git config user.name "$GITHUB_LOGIN"

  # Obtain the release ID for the previous release of $TAG (if present).
  local previous_release_id=$(curl --user ${GITHUB_LOGIN}:${GITHUB_SUPER_TOKEN} --request GET --silent https://api.github.com/repos/${GITHUB_LOGIN}/${REPO}/releases/tags/${TAG} | jq '.id')

  # Delete the previous release (if present)
  if [[ -n "$previous_release_id" ]]; then
    echo "Deleting previous release: ${previous_release_id}"
    curl \
      --user ${GITHUB_LOGIN}:${GITHUB_SUPER_TOKEN} \
      --request DELETE \
      --silent \
      https://api.github.com/repos/${GITHUB_LOGIN}/${REPO}/releases/${previous_release_id}
  fi

  # Delete previous identical tags, if present
  git tag -d $TAG || true
  git push origin :$TAG || true

  # Add all the changed files and push the changes upstream
  git add -f .
  git commit -m "Update release files for tag: ${TAG}" || true
  git push -f origin master:master
  git tag $TAG
  git push origin $TAG

  # Generate a skeleton release on GitHub
  curl \
    --user ${GITHUB_LOGIN}:${GITHUB_SUPER_TOKEN} \
    --request POST \
    --silent \
    --data @- \
    https://api.github.com/repos/${GITHUB_LOGIN}/${REPO}/releases <<END
  {
    "tag_name": "$TAG",
    "name": "Auto-generated release for tag $TAG",
    "body": "$RELEASE_BODY",
    "draft": false,
    "prerelease": $PRERELEASE
  }
END
  popd
}

# Mirroring Automatic Releases
rm -rf "/tmp/${ACTION_AUTOMATIC_RELEASES_REPO}"
git clone "https://crowbarmaster:${GITHUB_SUPER_TOKEN}@github.com/crowbarmaster/${ACTION_AUTOMATIC_RELEASES_REPO}.git" /tmp/${ACTION_AUTOMATIC_RELEASES_REPO}
cp -R packages/automatic-releases/dist /tmp/${ACTION_AUTOMATIC_RELEASES_REPO}/
cp packages/automatic-releases/README.md /tmp/${ACTION_AUTOMATIC_RELEASES_REPO}/
cp packages/automatic-releases/action.yml /tmp/${ACTION_AUTOMATIC_RELEASES_REPO}/
cp LICENSE /tmp/${ACTION_AUTOMATIC_RELEASES_REPO}/
create_tagged_release "$ACTION_AUTOMATIC_RELEASES_REPO"
