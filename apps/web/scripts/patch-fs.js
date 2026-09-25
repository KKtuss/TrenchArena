const fs = require('fs');

function patch(target, method) {
  const original = target[method].bind(target);
  target[method] = (...args) => {
    try {
      return original(...args);
    } catch (error) {
      if (error && (error.code === 'EISDIR' || error.code === 'UNKNOWN')) {
        const normalized = new Error(`EINVAL: invalid argument, ${method}`);
        normalized.code = 'EINVAL';
        throw normalized;
      }
      throw error;
    }
  };
}

patch(fs, 'readlinkSync');
patch(fs, 'readlink');
if (fs.promises?.readlink) {
  const original = fs.promises.readlink.bind(fs.promises);
  fs.promises.readlink = async (...args) => {
    try {
      return await original(...args);
    } catch (error) {
      if (error && (error.code === 'EISDIR' || error.code === 'UNKNOWN')) {
        const normalized = new Error('EINVAL: invalid argument, readlink');
        normalized.code = 'EINVAL';
        throw normalized;
      }
      throw error;
    }
  };
}
