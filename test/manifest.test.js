'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../manifest.json');

test('内容脚本覆盖普通 iframe 与关联来源 frame', () => {
  const entry = manifest.content_scripts[0];
  assert.equal(entry.all_frames, true);
  assert.equal(entry.match_about_blank, true);
  assert.equal(entry.match_origin_as_fallback, true);
});
