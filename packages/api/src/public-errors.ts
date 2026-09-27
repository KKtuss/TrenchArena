const HIDDEN_ERROR_NAMES = new Set([
  'TypeError',
  'RangeError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'ReferenceError',
]);

const INTERNAL_DETAIL = /(?:\n\s+at\s)|(?:[A-Za-z]:\\)|(?:\/(?:home|usr|app|var|tmp)\/)|node_modules|process\.env/;

export function toPublicError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    if (INTERNAL_DETAIL.test(error.message)) {
      return { code: 'ProtocolError', message: 'Request could not be processed.' };
    }
    const code = HIDDEN_ERROR_NAMES.has(error.name) ? 'ProtocolError' : error.name;
    return { code, message: error.message };
  }
  return { code: 'ProtocolError', message: 'Request could not be processed.' };
}

export function logInternalError(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error('protocol error');
    return;
  }
  if (HIDDEN_ERROR_NAMES.has(error.name) || INTERNAL_DETAIL.test(error.message)) {
    console.error('protocol error', error.name);
  }
}
