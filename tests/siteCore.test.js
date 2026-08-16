// 站点核心模块（siteCore.js）直接测试 + 解环回归锁：
// 1) siteCore 六个共享原语的运行时行为（纯函数部分）；
// 2) siteService 垫片同一性（re-export 与真实模块同引用——存量 import 面不变）；
// 3) 源码级无环断言：submission/transfer 不得再 import siteService，
//    siteCore 不得反向依赖 siteService/submission/transfer（2026-08-16 架构评审候选 1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDuplicateError,
  findDuplicateSite,
  getAllSites,
  getPrependSortOrder,
  normalizeDuplicateUrlKey,
  normalizeSitePayload,
} from '../src/services/siteCore.js';
import * as siteService from '../src/services/siteService.js';

const SRC = new URL('../src/services/', import.meta.url);

test('siteCore：六个共享原语全部导出且可调用', () => {
  for (const fn of [buildDuplicateError, findDuplicateSite, getAllSites, getPrependSortOrder, normalizeDuplicateUrlKey, normalizeSitePayload]) {
    assert.equal(typeof fn, 'function');
  }
});

test('siteCore：去重键规范化——www/尾斜杠/大小写归一，保留 query，http==https', () => {
  assert.equal(normalizeDuplicateUrlKey('https://www.Example.com/Path/'), 'example.com/path');
  assert.equal(normalizeDuplicateUrlKey('http://example.com/path?A=1'), 'example.com/path?a=1');
  assert.equal(normalizeDuplicateUrlKey('example.com/path'), 'example.com/path');
  assert.equal(normalizeDuplicateUrlKey(''), '');
});

test('siteCore：载荷规范化——必填缺失抛错、可见性回退、标签归一、空间 id 归一', () => {
  assert.throws(() => normalizeSitePayload({ name: 'A', url: 'https://a.test' }), /Name, URL and Catelog are required/);
  const site = normalizeSitePayload({ name: ' A ', url: 'https://a.test', catelog: '工具', tags: 'x, y', space_id: '7' });
  assert.equal(site.name, 'A');
  assert.equal(site.visibility, 'public');
  assert.deepEqual(site.tags, ['x', 'y']);
  assert.equal(site.space_id, 7);
});

test('siteCore：重复错误构造——code/scope/duplicate 齐备', () => {
  const err = buildDuplicateError({ id: 3, name: 'N', url: 'https://u.test' }, 'submit');
  assert.equal(err.code, 'DUPLICATE_URL');
  assert.equal(err.scope, 'submit');
  assert.equal(err.duplicate.id, 3);
});

test('siteCore 垫片同一性：siteService re-export 与真实模块同引用（存量测试 import 面不变）', () => {
  assert.equal(siteService.getAllSites, getAllSites);
  assert.equal(siteService.normalizeDuplicateUrlKey, normalizeDuplicateUrlKey);
  assert.equal(siteService.normalizeSitePayload, normalizeSitePayload);
  assert.equal(siteService.findDuplicateSite, findDuplicateSite);
  assert.equal(siteService.buildDuplicateError, buildDuplicateError);
  assert.equal(siteService.getPrependSortOrder, getPrependSortOrder);
});

test('解环回归锁：submission/transfer 不再 import siteService，siteCore 不反向依赖', () => {
  for (const file of ['submissionService.js', 'transferService.js']) {
    const source = readFileSync(new URL(file, SRC), 'utf8');
    assert.ok(!/from '\.\/siteService\.js'/.test(source), `${file} 不得再经 siteService 取共享原语`);
  }
  const coreSource = readFileSync(new URL('siteCore.js', SRC), 'utf8');
  for (const dep of ['siteService.js', 'submissionService.js', 'transferService.js']) {
    assert.ok(!coreSource.includes(`'./${dep}'`), `siteCore 不得依赖 ${dep}`);
  }
});
