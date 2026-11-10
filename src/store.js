// JSON-file persistence with debounced atomic writes (write tmp, then rename).
import fs from 'node:fs';
import path from 'node:path';

export function emptyState() {
  return {
    seq: 0, // last message id
    messages: [],
    agents: {},
    teams: {},
    claims: [],
    tasks: [],
    mergeRequests: [],
    hotFiles: [],
    interfaces: [],
    activity: [], // dashboard-only log; agents never read it
  };
}

export class Store {
  constructor(file, { delay = 50 } = {}) {
    this.file = file;
    this.delay = delay;
    this.timer = null;
    this.state = emptyState();
    if (file && fs.existsSync(file)) {
      Object.assign(this.state, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  }

  save() {
    this.onChange?.();
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
}
