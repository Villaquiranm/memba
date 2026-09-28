-- The new Launchpad NFT ledger is separate from the legacy NFT cache. Every
-- event is scoped to a verified chain ID and the exact emitting realm. Current
-- ownership is derived from the last event, so rollback never leaves a stale
-- mutable owner projection behind.
CREATE TABLE launchpad_nft_ownership_events (
    chain_id       TEXT NOT NULL,
    pkg_path       TEXT NOT NULL,
    event_block    INTEGER NOT NULL,
    event_tx_index INTEGER NOT NULL,
    event_index    INTEGER NOT NULL,
    collection_id  TEXT NOT NULL,
    token_number   INTEGER NOT NULL CHECK (token_number > 0),
    kind           TEXT NOT NULL CHECK (kind IN ('minted', 'transferred', 'burned', 'revoked')),
    from_owner     TEXT NOT NULL,
    to_owner       TEXT NOT NULL,
    actor          TEXT NOT NULL,
    reason         TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (chain_id, event_block, event_tx_index, event_index)
);

CREATE INDEX idx_launchpad_nft_token_history
    ON launchpad_nft_ownership_events
    (chain_id, collection_id, token_number, event_block DESC, event_tx_index DESC, event_index DESC);
CREATE INDEX idx_launchpad_nft_owner_events
    ON launchpad_nft_ownership_events (chain_id, to_owner);

-- A separate, chain-scoped cursor. Each row is written only after its whole
-- block has been applied; the hashes also permit bounded multi-block rollback.
CREATE TABLE launchpad_nft_indexed_blocks (
    chain_id TEXT NOT NULL,
    height   INTEGER NOT NULL,
    hash     TEXT NOT NULL,
    PRIMARY KEY (chain_id, height)
);
