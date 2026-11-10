import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normPath, covers, overlaps, toRepoPath } from '../src/paths.js';

describe('normPath', () => {
  test('converts backslashes', () => assert.equal(normPath('src\\api\\users.ts'), 'src/api/users.ts'));
  test('strips leading ./ (repeated too)', () => {
    assert.equal(normPath('./src/a.js'), 'src/a.js');
    assert.equal(normPath('././src/a.js'), 'src/a.js');
    assert.equal(normPath('.\\src\\a.js'), 'src/a.js');
  });
  test('collapses duplicate slashes', () => assert.equal(normPath('src//api///a.js'), 'src/api/a.js'));
  test('keeps trailing slash for dirs', () => assert.equal(normPath('src\\api\\'), 'src/api/'));
  test('empty, dot and whitespace become empty', () => {
    assert.equal(normPath(''), '');
    assert.equal(normPath('.'), '');
    assert.equal(normPath('  '), '');
  });
  test('trims whitespace', () => assert.equal(normPath('  a/b.js '), 'a/b.js'));
});

describe('covers', () => {
  for (const fold of [false, true]) {
    test(`file claim (fold=${fold})`, () => {
      assert.ok(covers('src/a.js', 'src/a.js', fold));
      assert.ok(!covers('src/a.js', 'src/b.js', fold));
      assert.ok(!covers('src/a.js', 'src/a.jsx', fold));
    });
    test(`dir claim (fold=${fold})`, () => {
      assert.ok(covers('src/api/', 'src/api/users.ts', fold));
      assert.ok(covers('src/api/', 'src/api/deep/x.ts', fold));
      assert.ok(!covers('src/api/', 'src/apix/users.ts', fold));
      assert.ok(!covers('src/api/', 'src/other.ts', fold));
    });
  }
  test('dir claim covers the dir path itself', () => assert.ok(covers('src/api/', 'src/api', false)));

  test('glob *', () => {
    assert.ok(covers('src/*.css', 'src/a.css', false));
    assert.ok(!covers('src/*.css', 'src/sub/a.css', false));
    assert.ok(!covers('src/*.css', 'src/a.js', false));
  });
  test('glob **', () => {
    assert.ok(covers('src/**', 'src/a/b/c.js', false));
    assert.ok(covers('src/**/*.css', 'src/a/b/c.css', false));
    assert.ok(!covers('src/**/*.css', 'lib/a.css', false));
  });
  test('glob **/ matches zero or more directories', () => {
    assert.ok(covers('src/**/*.css', 'src/a.css', false));
    assert.ok(covers('**/*.css', 'a.css', false));
    assert.ok(covers('**/*.css', 'x/y/a.css', false));
  });
  test('glob ?', () => {
    assert.ok(covers('src/?.js', 'src/a.js', false));
    assert.ok(!covers('src/?.js', 'src/ab.js', false));
    assert.ok(!covers('src/?.js', 'src//.js', false));
  });
  test('glob {a,b}', () => {
    assert.ok(covers('src/*.{js,ts}', 'src/a.js', false));
    assert.ok(covers('src/*.{js,ts}', 'src/a.ts', false));
    assert.ok(!covers('src/*.{js,ts}', 'src/a.css', false));
  });
  test('glob escapes regex metacharacters', () => {
    assert.ok(covers('src/a.js*', 'src/a.js', false));
    assert.ok(!covers('src/a.j*', 'src/aXjs', false));
    assert.ok(covers('src/(x)/*.js', 'src/(x)/a.js', false));
  });
  test('case folding', () => {
    assert.ok(covers('SRC/A.js', 'src/a.JS', true));
    assert.ok(!covers('SRC/A.js', 'src/a.JS', false));
    assert.ok(covers('SRC/', 'src/a.js', true));
    assert.ok(!covers('SRC/', 'src/a.js', false));
    assert.ok(covers('SRC/**/*.CSS', 'src/x/a.css', true));
    assert.ok(!covers('SRC/**/*.CSS', 'src/x/a.css', false));
  });
});

describe('overlaps', () => {
  const o = (a, b) => overlaps(a, b, false);
  test('file vs file', () => {
    assert.ok(o('src/a.js', 'src/a.js'));
    assert.ok(!o('src/a.js', 'src/b.js'));
  });
  test('file vs dir (both directions)', () => {
    assert.ok(o('src/a.js', 'src/'));
    assert.ok(o('src/', 'src/a.js'));
    assert.ok(!o('lib/a.js', 'src/'));
  });
  test('dir vs dir nesting', () => {
    assert.ok(o('src/', 'src/api/'));
    assert.ok(o('src/api/', 'src/'));
    assert.ok(o('src/', 'src/'));
  });
  test('disjoint dirs', () => {
    assert.ok(!o('src/api/', 'src/ui/'));
    assert.ok(!o('src/api/', 'src/apix/'));
    assert.ok(!o('src/', 'lib/'));
  });
  test('glob vs file', () => {
    assert.ok(o('src/**/*.css', 'src/a/b.css'));
    assert.ok(o('src/a/b.css', 'src/**/*.css'));
    assert.ok(!o('src/**/*.css', 'src/a/b.js'));
  });
  test('glob vs dir', () => {
    assert.ok(o('src/**/*.css', 'src/'));
    assert.ok(o('src/**/*.css', 'src/ui/'));
    assert.ok(o('src/ui/', 'src/**/*.css'));
    assert.ok(!o('src/**/*.css', 'lib/'));
  });
  test('glob vs glob: different extensions do not overlap', () => {
    assert.ok(!o('src/**/*.css', 'src/**/*.js'));
    assert.ok(!o('*.css', '*.js'));
  });
  test('glob vs glob: same prefix overlaps', () => {
    assert.ok(o('src/**/*.css', 'src/**/*.css'));
    assert.ok(o('src/**/*.css', 'src/ui/*.css'));
  });
  test('glob vs glob: disjoint prefixes do not overlap', () => {
    assert.ok(!o('src/**/*.js', 'lib/**/*.js'));
  });
  test('fold applies', () => {
    assert.ok(overlaps('SRC/a.js', 'src/a.js', true));
    assert.ok(!overlaps('SRC/a.js', 'src/a.js', false));
    assert.ok(overlaps('SRC/', 'src/x/', true));
  });

  test('file claim without slash acts as a dir, so it overlaps a glob under it',
    () => assert.ok(o('src/api', 'src/api/**/*.js')));

  test('globs whose extensions share a suffix (.min.js vs .js) overlap',
    () => assert.ok(o('**/*.min.js', '**/*.js')));
});

describe('toRepoPath', () => {
  const root = path.resolve('some', 'repo');
  test('inside root: relative and absolute', () => {
    assert.equal(toRepoPath('src/a.js', root), 'src/a.js');
    assert.equal(toRepoPath(path.join(root, 'src', 'a.js'), root), 'src/a.js');
  });
  test('outside root returns null', () => {
    assert.equal(toRepoPath(path.resolve(root, '..', 'other', 'a.js'), root), null);
    assert.equal(toRepoPath('../a.js', root), null);
  });
  test('the root itself returns null', () => assert.equal(toRepoPath(root, root), null));
  test('file whose name starts with ".." is inside root',
    () => assert.equal(toRepoPath('..foo/x.js', root), '..foo/x.js'));
});
