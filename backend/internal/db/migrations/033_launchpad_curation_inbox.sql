-- Private founder/manager text messages are separate from public curation
-- receipts. The body is AES-GCM ciphertext; collection, sender, revision and
-- timestamps remain visible to the database operator for access and audit.
CREATE TABLE launchpad_curation_messages (
    id          TEXT PRIMARY KEY,
    chain_id    TEXT NOT NULL,
    collection  TEXT NOT NULL,
    revision    INTEGER NOT NULL CHECK (revision > 0),
    sender      TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    nonce       BLOB NOT NULL,
    ciphertext  BLOB NOT NULL
);

CREATE INDEX idx_launchpad_curation_thread
    ON launchpad_curation_messages (chain_id, collection, created_at DESC, id DESC);

CREATE UNIQUE INDEX idx_launchpad_curation_client_id
    ON launchpad_curation_messages (chain_id, sender, client_id);

-- Audit metadata only. Never write message text or token material here.
CREATE TABLE launchpad_curation_message_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id    TEXT NOT NULL,
    collection  TEXT NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('read', 'send')),
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_launchpad_curation_audit_scope
    ON launchpad_curation_message_audit (chain_id, collection, created_at DESC);
