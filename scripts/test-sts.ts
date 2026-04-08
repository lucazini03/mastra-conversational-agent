// Compatibility launcher for legacy docs/commands.
// This keeps `npx tsx scripts/test-sts.ts` working by delegating
// to the maintained CLI entrypoint.
import '../src/client/cli.ts';
