'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-test-'));

const manifestJson = () => ({
  latest: { release: '1.99.0', snapshot: '26w01a' },
  versions: [
    { id: '26w01a', type: 'snapshot', url: 'https://piston-meta.mojang.com/v1/packages/aaa/26w01a.json', sha1: 'aaa', releaseTime: '2026-01-01T00:00:00+00:00' },
    { id: '1.99.0', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/bbb/1.99.0.json', sha1: 'bbb', releaseTime: '2025-12-01T00:00:00+00:00' },
    { id: '1.16.5', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/ccc/1.16.5.json', sha1: 'ccc', releaseTime: '2021-01-01T00:00:00+00:00' },
    { id: 'evil', type: 'release', url: 'https://evil.example.com/x.json', releaseTime: '' },
    { id: '../../etc', type: 'release', url: 'https://piston-meta.mojang.com/x.json', releaseTime: '' }
  ]
});

const okFetch = (json = manifestJson()) => async () => ({ ok: true, status: 200, json: async () => json });
const failFetch = async () => { throw new TypeError('fetch failed'); };

/** A fake game process. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

module.exports = { tmp, manifestJson, okFetch, failFetch, fakeChild };
