# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use an issue to describe bugs and proposed features. For a substantial change, discuss the approach before investing in an implementation.
- Never include credentials, private data, or assets that cannot be redistributed.

## Prepare a change

1. Fork the repository or create a branch from the latest `main`.
2. Keep the change focused and include tests or documentation where practical.
3. Run the project checks:

   ```sh
   bun run typecheck
   bun test
   bun run build
   ```

4. For player-facing work, test the affected flow in a WebGL2-capable browser and attach screenshots or a short recording to the pull request.

## Submit a pull request

- Open the pull request against `main` and complete the template.
- Link the issue the change addresses.
- Resolve all review conversations and keep the branch current when requested.
- Every change to `main` requires an approving review from the repository code owner, `@alexdevmotion`.
- New commits invalidate an earlier approval, so request another review after the final push.

Direct pushes, force pushes, and deletion of `main` are blocked by repository protection rules.
