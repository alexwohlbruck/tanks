#!/usr/bin/env bash
# Prints the next release version from the git tags (v<major>.<minor>.<patch>).
# usage: tools/release.sh [auto|patch|minor|major]
#   auto (the default) bumps the patch number, or the minor / major number when a commit since
#   the last release says [minor] / [major] in its message. With no release yet: v1.0.0.
set -euo pipefail
cd "$(dirname "$0")/.."
bump="${1:-auto}"
last=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
if [ -z "$last" ]; then
  echo v1.0.0
  exit 0
fi
if [ "$bump" = auto ]; then
  log=$(git log --format=%B "$last..HEAD")
  if grep -qi '\[major\]' <<<"$log"; then bump=major
  elif grep -qi '\[minor\]' <<<"$log"; then bump=minor
  else bump=patch; fi
fi
IFS=. read -r major minor patch <<<"${last#v}"
case "$bump" in
  major) echo "v$((major + 1)).0.0" ;;
  minor) echo "v$major.$((minor + 1)).0" ;;
  patch) echo "v$major.$minor.$((patch + 1))" ;;
  *) echo "unknown bump: $bump" >&2; exit 1 ;;
esac
