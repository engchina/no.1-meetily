CREATE TABLE meeting_speaker_timelines (
    meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    turns TEXT NOT NULL,
    names TEXT NOT NULL DEFAULT '{}'
);
