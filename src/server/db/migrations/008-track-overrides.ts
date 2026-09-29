export const name = 'track-overrides'

// Names, languages and default tracks set by the consumer (JSON, NULL = what the source
// says). They belong to the title, not to a job: a full reprocess applies them again.
export const sql = `
ALTER TABLE titles ADD COLUMN track_overrides TEXT;
`
