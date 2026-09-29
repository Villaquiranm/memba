-- Bound retention sweeps by chain and timestamp without scanning every thread.
CREATE INDEX idx_launchpad_curation_messages_retention
    ON launchpad_curation_messages (chain_id, created_at);

CREATE INDEX idx_launchpad_curation_audit_retention
    ON launchpad_curation_message_audit (chain_id, created_at);
