#!/bin/bash

# Version bump script for @qianxude/tem
# Usage: ./scripts/version.sh [patch|minor|major]

set -e

BUMP_TYPE=${1:-patch}

# Validate bump type
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
    echo "Error: Invalid version bump type. Use: patch, minor, or major"
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "Error: You have uncommitted changes. Please commit or stash them first."
    exit 1
fi

# Get current version
CURRENT_VERSION=$(cat package.json | grep -o '"version": "[^"]*"' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

case $BUMP_TYPE in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
NEW_TAG="v$NEW_VERSION"

echo "Bumping version: $CURRENT_VERSION -> $NEW_VERSION"

# Update package.json using jq if available, otherwise sed
if command -v jq &> /dev/null; then
    jq ".version = \"$NEW_VERSION\"" package.json > package.json.tmp && mv package.json.tmp package.json
else
    # Cross-platform sed (works on both macOS and Linux)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
    else
        sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
    fi
fi

# Stage package.json
git add package.json

# Create commit
git commit -m "chore(release): bump version to $NEW_VERSION"

# Create git tag
git tag -a "$NEW_TAG" -m "Release $NEW_VERSION"

echo ""
echo "✅ Version bumped to $NEW_VERSION"
echo "✅ Created commit: $(git rev-parse --short HEAD)"
echo "✅ Created tag: $NEW_TAG"
echo ""
echo "Next steps:"
echo "  1. Review the commit: git show HEAD"
echo "  2. Push to remote: git push origin main --tags"
echo "  3. Publish to npm: bun run publish:pkg"
echo ""
