import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Pin the workspace root to this project to silence the lockfile warning
  // caused by a parent-directory package-lock.json.
  outputFileTracingRoot: path.join(__dirname),

  // Native bindings used by server-side RAG/DuckDB must not be bundled
  serverExternalPackages: [
    '@mastra/duckdb',
    'duckdb',
    'duckdb-async',
    'pdf-parse',
    'mammoth',
    'rtf-parser',
    'node-html-parser',
  ],

  // Map .js imports to .ts files so Node ESM-style imports work with webpack.
  // This is needed because TypeScript source files import each other with
  // '.js' extensions (the recommended pattern for native ESM), but webpack
  // only knows about the .ts files.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
