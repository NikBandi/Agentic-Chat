import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Bus, BusError, INBOX_CAP, MESSAGE_KEEP } from '../src/bus.js';
import { Store } from '../src/store.js';

let bus;
beforeEach(() => { bus = new Bus(new Store(null)); });

const join = (name, team) => bus.touch(name, team);
const texts = (r) => r.messages.map((m) => m.text);

describe('registration', () => {
  test('new agent requires a team', () => {
    assert.throws(() => bus.touch('alice', ''), BusError);
    assert.throws(() => bus.touch('alice'), /unknown agent/);
  });
  test('registers with team and adds to team members', () => {
    const a = join('alice', 'frontend');
    assert.equal(a.team, 'frontend');
    assert.deepEqual(bus.s.teams.frontend.members, ['alice']);
  });
  test('known agent can touch without team; lead needs no team', () => {
    join('alice', 'frontend');
    assert.equal(bus.touch('alice').team, 'frontend');
    assert.equal(bus.touch('lead').team, 'lead');
  });
  test('name validation', () => {
    assert.throws(() => bus.touch('bad name', 't'), /bad agent name/);
    assert.throws(() => bus.touch('x'.repeat(41), 't'), /bad agent name/);
    assert.throws(() => bus.touch('-a', 't'), /bad agent name/);
    assert.throws(() => bus.touch('alice', 'bad team!'), /bad team name/);
  });
  test('names are lowercased and @ stripped', () => {
    assert.equal(bus.touch('@Alice', 'Frontend').name, 'alice');
    assert.equal(bus.s.agents.alice.team, 'frontend');
  });
  test('human "you" is never registered', () => {
    assert.equal(bus.touch('you', 'x'), null);
    assert.deepEqual(bus.s.agents, {});
  });
  test('moving teams updates membership', () => {
    join('alice', 'a');
    bus.touch('alice', 'b');
    assert.deepEqual(bus.s.teams.a.members, []);
    assert.deepEqual(bus.s.teams.b.members, ['alice']);
  });
});

describe('messaging', () => {
  test('DM delivered only to target', () => {
    join('alice', 'fe'); join('bob', 'fe'); join('carol', 'be');
    bus.send('alice', '@bob', 'psst');
    assert.deepEqual(texts(bus.read('bob')), ['psst']);
    assert.equal(bus.read('carol').messages.length, 0);
    assert.equal(bus.read('alice').messages.length, 0);
  });
  test('DM ignores @mentions inside text for other agents', () => {
    join('alice', 'fe'); join('bob', 'fe'); join('carol', 'be');
    bus.send('alice', '@bob', 'hey @carol');
    assert.equal(bus.read('carol').messages.length, 0);
  });
  test('@team reaches team members but not sender or other teams', () => {
    join('alice', 'fe'); join('bob', 'fe'); join('carol', 'be');
    const m = bus.send('alice', '@fe', 'standup');
    assert.equal(m.channel, '#fe');
    assert.deepEqual(texts(bus.read('bob')), ['standup']);
    assert.equal(bus.read('alice').messages.length, 0);
    assert.equal(bus.read('carol').messages.length, 0);
  });
  test('@team in text mentions team', () => {
    join('alice', 'fe'); join('bob', 'fe'); join('carol', 'be');
    bus.send('carol', '#general', 'ping @fe please');
    assert.equal(bus.read('bob').messages.length, 1);
    assert.equal(bus.read('alice').messages.length, 1);
  });
  test('channel message without a mention does NOT reach inboxes', () => {
    join('alice', 'fe'); join('bob', 'fe');
    bus.send('alice', '#fe', 'nobody is mentioned');
    bus.send('alice', '', 'default channel');
    assert.equal(bus.pending('bob'), 0);
    assert.equal(bus.read('bob').messages.length, 0);
  });
  test('default channel is sender team, human falls back to #general', () => {
    join('alice', 'fe');
    assert.equal(bus.send('alice', '', 'x').channel, '#fe');
    assert.equal(bus.send('you', '', 'x').channel, '#general');
  });
  test('mention in a channel message reaches that agent', () => {
    join('alice', 'fe'); join('bob', 'be');
    bus.send('alice', '#fe', 'hello @bob');
    assert.deepEqual(texts(bus.read('bob')), ['hello @bob']);
  });
  test('mentions of unknown names are ignored', () => {
    join('alice', 'fe'); join('bob', 'fe');
    const m = bus.send('alice', '#fe', 'hi @ghost and @bob');
    assert.deepEqual(m.mentions, ['bob']);
  });
  test('email-like text is not a mention', () => {
    join('alice', 'fe'); join('bob', 'fe');
    const m = bus.send('alice', '#fe', 'mail me at x@bob');
    assert.deepEqual(m.mentions, []);
  });
  test('unknown @target throws 404', () => {
    join('alice', 'fe');
    assert.throws(() => bus.send('alice', '@nobody', 'hi'), (e) => e instanceof BusError && e.status === 404);
  });
  test('empty message throws', () => {
    join('alice', 'fe');
    assert.throws(() => bus.send('alice', '#fe', '   '), /empty/);
  });
  test('messages from the human mention agents', () => {
    join('bob', 'fe');
    bus.send('you', '', 'hey @bob');
    assert.deepEqual(texts(bus.read('bob')), ['hey @bob']);
  });
  test('isFor never true for own message', () => {
    const a = join('alice', 'fe');
    const m = bus.send('alice', '#fe', '@alice @fe self');
    assert.equal(bus.isFor(m, a), false);
  });
});

describe('read / cursor', () => {
  test('read advances cursor: second read is empty', () => {
    join('alice', 'fe'); join('bob', 'fe');
    bus.send('alice', '@bob', 'one');
    assert.equal(bus.pending('bob'), 1);
    assert.equal(bus.read('bob').messages.length, 1);
    assert.equal(bus.pending('bob'), 0);
    assert.deepEqual(bus.read('bob'), { messages: [], skipped: 0 });
  });
  test('only new messages after a read', () => {
    join('alice', 'fe'); join('bob', 'fe');
    bus.send('alice', '@bob', 'one');
    bus.read('bob');
    bus.send('alice', '@bob', 'two');
    assert.deepEqual(texts(bus.read('bob')), ['two']);
  });
  test(`caps at ${INBOX_CAP} newest with skipped count`, () => {
    join('alice', 'fe'); join('bob', 'fe');
    for (let i = 1; i <= 35; i++) bus.send('alice', '@bob', `m${i}`);
    const r = bus.read('bob');
    assert.equal(INBOX_CAP, 30);
    assert.equal(r.messages.length, 30);
    assert.equal(r.skipped, 5);
    assert.equal(r.messages[0].text, 'm6');
    assert.equal(r.messages.at(-1).text, 'm35');
    assert.equal(bus.read('bob').messages.length, 0);
  });
  test('agent joining later does not receive old messages', () => {
    join('alice', 'fe');
    bus.send('alice', '@fe', 'before');
    bus.send('you', '', 'also before @fe');
    join('bob', 'fe');
    assert.equal(bus.pending('bob'), 0);
    bus.send('alice', '@fe', 'after');
    assert.deepEqual(texts(bus.read('bob')), ['after']);
  });
  test(`state keeps the newest ${MESSAGE_KEEP} messages; older ones go to the store archive`, () => {
    const archived = [];
    bus.store.archive = (items) => archived.push(...items);
    join('alice', 'fe'); join('bob', 'fe');
    for (let i = 1; i <= MESSAGE_KEEP + 201; i++) bus.send('alice', '@bob', `m${i}`);
    assert.equal(bus.s.messages.length, MESSAGE_KEEP);
    assert.equal(archived.length, 201);
    assert.equal(archived[0].text, 'm1');
    assert.equal(bus.s.messages[0].text, 'm202');
    assert.throws(() => bus.show(1), /archived/);
    const r = bus.read('bob'); // inbox still capped and newest-first as before
    assert.equal(r.messages.at(-1).text, `m${MESSAGE_KEEP + 201}`);
    assert.equal(r.messages.length, INBOX_CAP);
  });
  test('read for unknown agent throws 404', () => {
    assert.throws(() => bus.read('ghost'), (e) => e.status === 404);
  });
  test('show returns full message / 404', () => {
    join('alice', 'fe');
    const m = bus.send('alice', '#fe', 'full text');
    assert.equal(bus.show(m.id).text, 'full text');
    assert.equal(bus.show(String(m.id)).id, m.id);
    assert.throws(() => bus.show(999), (e) => e.status === 404);
  });
  test('channelLog returns channel messages regardless of mentions, and DMs when no channel', () => {
    join('alice', 'fe'); join('bob', 'fe');
    bus.send('alice', '#fe', 'c1');
    bus.send('alice', '#fe', 'c2');
    bus.send('alice', '@bob', 'dm');
    assert.deepEqual(texts(bus.channelLog('bob', '#fe')), ['c1', 'c2']);
    assert.deepEqual(texts(bus.channelLog('bob', 'fe', 1)), ['c2']);
    assert.equal(bus.channelLog('bob', 'fe', 1).skipped, 1);
    assert.deepEqual(texts(bus.channelLog('bob', '')), ['dm']);
    assert.deepEqual(texts(bus.channelLog('alice', '')), ['dm']);
  });
});

describe('claims', () => {
  beforeEach(() => { join('alice', 'fe'); join('bob', 'be'); });

  test('claim succeeds and lists', () => {
    const r = bus.claim('alice', ['src/a.js', 'src/ui/'], 'work');
    assert.deepEqual(r, { ok: true, claimed: ['src/a.js', 'src/ui/'] });
    assert.equal(bus.claims().length, 2);
    assert.equal(bus.claims('alice')[0].why, 'work');
    assert.equal(bus.claims('bob').length, 0);
  });
  test('paths are normalized', () => {
    bus.claim('alice', ['.\\src\\a.js']);
    assert.equal(bus.claims()[0].path, 'src/a.js');
  });
  test('conflicts are all-or-nothing', () => {
    bus.claim('alice', ['src/a.js']);
    const r = bus.claim('bob', ['src/free.js', 'src/a.js']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.conflicts, [{ path: 'src/a.js', owner: 'alice', claim: 'src/a.js' }]);
    assert.equal(bus.claims('bob').length, 0, 'free.js must not be claimed');
  });
  test('dir / glob conflicts', () => {
    bus.claim('alice', ['src/api/']);
    assert.equal(bus.claim('bob', ['src/api/users.ts']).ok, false);
    bus.claim('alice', ['web/**/*.css']);
    assert.equal(bus.claim('bob', ['web/x/a.css']).ok, false);
    assert.equal(bus.claim('bob', ['web/x/a.js']).ok, true);
  });
  test('re-claiming own path is idempotent', () => {
    bus.claim('alice', ['src/a.js']);
    const r = bus.claim('alice', ['src/a.js']);
    assert.equal(r.ok, true);
    assert.equal(bus.claims('alice').length, 1);
  });
  test('own overlapping claims never conflict', () => {
    bus.claim('alice', ['src/']);
    assert.equal(bus.claim('alice', ['src/a.js']).ok, true);
  });
  test('duplicate paths in one call are deduped', () => {
    bus.claim('alice', ['a.js', './a.js']);
    assert.equal(bus.claims('alice').length, 1);
  });
  test('empty path list throws', () => {
    assert.throws(() => bus.claim('alice', []), /no paths/);
    assert.throws(() => bus.claim('alice', ['.']), /no paths/);
  });
  test('release specific', () => {
    bus.claim('alice', ['a.js', 'b.js']);
    const r = bus.release('alice', ['a.js']);
    assert.deepEqual(r, { released: 1, paths: ['a.js'] });
    assert.deepEqual(bus.claims('alice').map((c) => c.path), ['b.js']);
  });
  test('release --all only touches own claims', () => {
    bus.claim('alice', ['a.js', 'b.js']);
    bus.claim('bob', ['c.js']);
    assert.equal(bus.release('alice', [], true).released, 2);
    assert.deepEqual(bus.claims().map((c) => c.agent), ['bob']);
  });
  test("cannot release another agent's claim", () => {
    bus.claim('alice', ['a.js']);
    assert.equal(bus.release('bob', ['a.js']).released, 0);
    assert.equal(bus.claims().length, 1);
  });
  test('released path can be claimed by others', () => {
    bus.claim('alice', ['a.js']);
    bus.release('alice', ['a.js']);
    assert.equal(bus.claim('bob', ['a.js']).ok, true);
  });
  test('check: owner / free / mine', () => {
    bus.claim('alice', ['src/api/']);
    assert.deepEqual(bus.check('bob', 'src/api/x.ts'), { free: false, owner: 'alice', claim: 'src/api/' });
    assert.deepEqual(bus.check('alice', 'src/api/x.ts'), { free: true, mine: true });
    assert.deepEqual(bus.check('bob', 'src/other.ts'), { free: true, mine: false });
    assert.deepEqual(bus.check('bob', '.\\src\\other.ts'), { free: true, mine: false });
  });
  test('claim by unknown agent throws 404', () => {
    assert.throws(() => bus.claim('ghost', ['a.js']), (e) => e.status === 404);
  });
});

describe('activity log', () => {
  test('claims and releases are logged', () => {
    join('alice', 'fe');
    bus.claim('alice', ['a.js']);
    bus.release('alice', ['a.js']);
    const t = bus.s.activity.map((e) => e.text);
    assert.ok(t.includes('alice joined team fe'));
    assert.ok(t.includes('alice claimed a.js'));
    assert.ok(t.includes('alice released a.js'));
  });
  test('re-claim does not log again', () => {
    join('alice', 'fe');
    bus.claim('alice', ['a.js']);
    const n = bus.s.activity.length;
    bus.claim('alice', ['a.js']);
    assert.equal(bus.s.activity.length, n);
  });
  test('messages do not go into activity', () => {
    join('alice', 'fe'); join('bob', 'fe');
    const n = bus.s.activity.length;
    bus.send('alice', '@bob', 'secret-text');
    bus.send('alice', '#fe', 'chan-text');
    assert.equal(bus.s.activity.length, n);
    assert.ok(!bus.s.activity.some((e) => /secret-text|chan-text/.test(e.text)));
  });
  test('activity is capped at 1000', () => {
    for (let i = 0; i < 1100; i++) bus.log('e' + i);
    assert.equal(bus.s.activity.length, 1000);
    assert.equal(bus.s.activity.at(-1).text, 'e1099');
  });
});
