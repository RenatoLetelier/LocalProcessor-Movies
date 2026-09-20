export const name = 'logs'

// AUTOINCREMENT keeps ids monotonic after the oldest rows are pruned, which the
// "load older entries" pagination (before=<id>) relies on
export const sql = `
CREATE TABLE logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  level    TEXT NOT NULL,
  category TEXT NOT NULL,
  message  TEXT NOT NULL,
  job_id   TEXT,
  title_id TEXT,
  context  TEXT
);
CREATE INDEX logs_job_id ON logs (job_id);
CREATE INDEX logs_title_id ON logs (title_id);
`
