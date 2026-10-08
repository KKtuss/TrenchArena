const fs = require('fs');
const path = require('path');

// This Windows volume rejects readlink even for regular files (EISDIR /
// Incorrect function). Webpack treats EINVAL as "not a symlink".
for (const method of ['readlink', 'readlinkSync']) {
  const original = fs[method].bind(fs);
  fs[method] = (...args) => {
    try {
      return original(...args);
    } catch (error) {
      if (error && (error.code === 'EISDIR' || error.code === 'UNKNOWN')) {
        const normalized = new Error(`EINVAL: invalid argument, ${method} '${args[0]}'`);
        normalized.code = 'EINVAL';
        throw normalized;
      }
      throw error;
    }
  };
}

const { securityHeaders } = require('./lib/security-headers');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@pokearena/solana-client'],
  outputFileTracingRoot: path.join(__dirname),
  webpack: config => {
    // Windows volume rejects readlink; keep symlink resolution on Linux/VPS
    // so pnpm's .pnpm store layout still resolves @solana/web3.js deps.
    if (process.platform === 'win32') {
      config.resolve.symlinks = false;
    }
    // Workspace copy under apps/web/node_modules is not always linked; pin the
    // browser-safe rotation entry so Next does not fall through to package root.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@pokearena/tournament/rotation': path.join(
        __dirname,
        'node_modules/@pokearena/tournament/dist/src/rotation.js',
      ),
    };
    config.cache = false;
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders(),
      },
    ];
  },
};

module.exports = nextConfig;
