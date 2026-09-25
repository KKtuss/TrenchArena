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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),
  webpack: config => {
    config.resolve.symlinks = false;
    config.cache = false;
    return config;
  },
};

module.exports = nextConfig;
