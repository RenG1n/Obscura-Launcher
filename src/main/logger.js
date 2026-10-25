'use strict';
// Logger with secret redaction. Nothing sensitive may reach a log file or the UI.
const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const REDACTED = '[REDACTED]';

// Pattern-based redaction: a safety net for secrets we did not register explicitly.
const PATTERNS = [
  // command line flags: --accessToken xxx / --uuid xxx / --xuid xxx / --clientId xxx
  [/(--(?:accessToken|session|xuid|clientId)[ =])(\S+)/gi, `$1${REDACTED}`],
  // Authorization headers
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/(XBL3\.0\s+x=)[^\s"']+/gi, `$1${REDACTED}`],
  // JSON-ish fields
  [/("(?:access_token|refresh_token|id_token|Token|identityToken|RpsTicket|accessToken|refreshToken)"\s*:\s*")[^"]+(")/g, `$1${REDACTED}$2`],
  // JWT-shaped strings (3 base64url segments, header starts with eyJ)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED]
];

class Redactor {
  constructor() {
    this.secrets = new Set();
  }
  /** Register an exact secret value; every occurrence will be masked. */
  addSecret(value) {
    if (typeof value === 'string' && value.length >= 6) this.secrets.add(value);
  }
  clearSecrets() {
    this.secrets.clear();
  }
  redact(input) {
    let text = typeof input === 'string' ? input : String(input);
    for (const secret of this.secrets) {
      if (text.includes(secret)) text = text.split(secret).join(REDACTED);
    }
    for (const [re, replacement] of PATTERNS) text = text.replace(re, replacement);
    return text;
  }
}

class Logger {
  /**
   * @param {{ dir: string|null, redactor?: Redactor, echo?: boolean }} opts
   */
  constructor({ dir, redactor = new Redactor(), echo = false } = {}) {
    this.redactor = redactor;
    this.echo = echo;
    this.file = null;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, 'launcher.log');
        try {
          if (fs.statSync(this.file).size > MAX_LOG_BYTES) fs.renameSync(this.file, this.file + '.old');
        } catch { /* no previous log */ }
      } catch {
        this.file = null;
      }
    }
  }
  _write(level, message) {
    const safe = this.redactor.redact(message);
    const line = `${new Date().toISOString()} [${level}] ${safe}\n`;
    if (this.file) {
      try { fs.appendFileSync(this.file, line); } catch { /* logging must never crash the app */ }
    }
    if (this.echo) process.stderr.write(line);
  }
  info(message) { this._write('INFO', message); }
  warn(message) { this._write('WARN', message); }
  error(message) {
    this._write('ERROR', message instanceof Error ? `${message.name}: ${message.message}` : message);
  }
  /** Redact arbitrary text (e.g. an error message) before it is shown to the user. */
  safe(text) { return this.redactor.redact(text); }
}

module.exports = { Logger, Redactor, REDACTED };
