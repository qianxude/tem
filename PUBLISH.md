# Publishing Guide

This document describes how to publish `@qianxude/tem` to npm and manage version releases.

## Quick Start

```sh
# Patch release (bug fixes)
bun run version:patch

# Minor release (new features)
bun run version:minor

# Major release (breaking changes)
bun run version:major
```

Then push and publish:
```sh
git push origin main --tags
bun run publish:pkg
```

## Scripts Reference

| Script | Description |
|--------|-------------|
| `bun run version:patch` | Bump patch version (0.1.0 → 0.1.1) |
| `bun run version:minor` | Bump minor version (0.1.0 → 0.2.0) |
| `bun run version:major` | Bump major version (0.1.0 → 1.0.0) |
| `bun run publish:pkg` | Publish to npm registry |

## Workflow Details

### Version Bump Process

When you run a version script (e.g., `bun run version:patch`):

1. **Validates** the bump type and checks for uncommitted changes
2. **Updates** `package.json` version field
3. **Creates** a git commit: `chore(release): bump version to X.Y.Z`
4. **Creates** an annotated git tag: `vX.Y.Z`

### Publishing Checklist

Before publishing:

- [ ] All tests pass: `bun test`
- [ ] Type check passes: `bun run typecheck`
- [ ] Lint passes: `bun run lint`
- [ ] Version has been bumped: `bun run version:<type>`
- [ ] Changes are pushed: `git push origin main --tags`

### First-Time Setup

If you haven't published before:

```sh
# Login to npm (creates ~/.npmrc)
bunx npm login

# Test with dry-run (no actual publish)
bun publish --dry-run
```

## Package Configuration

### Files Included

The `files` field in `package.json` controls what gets published:

```json
{
  "files": ["src/**/*", "README.md", "LICENSE"]
}
```

Excludes: tests, scripts, docs, examples, config files.

### Registry Settings

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
```

- `access: public` - Required for scoped packages (@qianxude/tem)
- Scoped packages are private by default without this setting

## Manual Version Bump (Alternative)

If you need more control, use the script directly:

```sh
./scripts/version.sh patch   # or minor/major
```

Or manually:

```sh
# 1. Update version in package.json
# 2. Stage and commit
git add package.json
git commit -m "chore(release): bump version to 0.2.0"
git tag -a v0.2.0 -m "Release 0.2.0"

# 3. Push and publish
git push origin main --tags
bun run publish:pkg
```

## Troubleshooting

**Error: "You have uncommitted changes"**
- Commit or stash changes before running version scripts

**Error: "missing authentication"**
- Run `bunx npm login` to authenticate with npm

**Tag already exists**
- Delete the tag locally: `git tag -d vX.Y.Z`
- Delete remotely: `git push origin :refs/tags/vX.Y.Z`
- Then re-run version script

## See Also

- [Bun publish docs](https://bun.sh/docs/cli/publish)
- [npm semantic versioning](https://docs.npmjs.com/about-semantic-versioning)
