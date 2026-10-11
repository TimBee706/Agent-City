# Releasing Claude City

Claude City is a VS Code extension, published to the **Visual Studio Marketplace** (and optionally Open VSX).

## One-time setup

1. Create a publisher at https://marketplace.visualstudio.com/manage (needs an Azure DevOps organization).
2. Set `"publisher"` in `package.json` to that publisher id (currently the placeholder `local`; `vsce publish` rejects it).
3. Create a Personal Access Token (Azure DevOps, scope *Marketplace → Manage*) and run `npx vsce login <publisher>`.

## Every release

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. `npm ci && npm run typecheck && npm test`
3. `npm run package` - builds the production bundles and `claude-city.vsix`; inspect with `npx vsce ls`.
4. Install the `.vsix` locally (*Extensions: Install from VSIX…*) and smoke test: open the city, demo mode, hooks install/remove.
5. `git tag v<version>` and push the tag.
6. `npx vsce publish` (or upload the `.vsix` at the Marketplace management page).
