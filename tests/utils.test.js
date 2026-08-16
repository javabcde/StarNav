// lib/utils.js 共享帮助函数测试（2026-08-16 架构评审候选 3 新增）：
// boolString 宽松语义（backup/systemSettings 域共用）、strictBoolString 严格语义
// （AI 设置域）、limitText 截断原语、textResponse 自定义头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { boolString, limitText, strictBoolString, textResponse } from '../src/lib/utils.js';
test('boolString：宽松语义——1/true/yes/on（忽略大小写与空白）为 true，其余 false', () => {
  for (const truthy of ['1', 'true', 'yes', 'on', ' YES ', 'On', 'True', 1, true]) {
    assert.equal(boolString(truthy), 'true');
  }
  for (const falsy of ['0', 'no', 'off', 'false', 'abc', 0, false]) {
    assert.equal(boolString(falsy), 'false');
  }
});

test('boolString：空值回退 fallback 而非 false', () => {
  for (const empty of [undefined, null, '']) {
    assert.equal(boolString(empty, 'true'), 'true');
    assert.equal(boolString(empty), 'false');
  }
});
test('strictBoolString：仅字面量 true/\'true\' 为 true，其余一律 false（AI 设置域语义）', () => {
  assert.equal(strictBoolString('true'), 'true');
  assert.equal(strictBoolString(true), 'true');
  assert.equal(strictBoolString('1'), 'false');
  assert.equal(strictBoolString('yes'), 'false');
  assert.equal(strictBoolString(false), 'false');
  assert.equal(strictBoolString(''), 'false');
  assert.equal(strictBoolString(undefined), 'false');
});


test('limitText：cleanText 后按 max 截断', () => {
  assert.equal(limitText('  abcdef  ', 3), 'abc');
  assert.equal(limitText('', 3), '');
  assert.equal(limitText('abc', 10), 'abc');
});

test('textResponse：支持自定义响应头（Content-Type 覆盖与扩展头）', () => {
  const plain = textResponse('ok');
  assert.equal(plain.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(plain.status, 200);

  const custom = textResponse('svg', 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
  assert.equal(custom.headers.get('Content-Type'), 'image/svg+xml');
  assert.equal(custom.headers.get('Cache-Control'), 'public, max-age=3600');
});
