# Launchpad curation inbox — draft operator runbook

The private text inbox is disabled by default. It depends on the unpublished
curation realm's `ReviewAccessJSON` getter and a deliberate DAO handoff. This
runbook describes the implemented controls and the remaining release gates;
it is not an activation instruction.

## Before activation

1. Verify the exact curation realm bytes, DAO administrator, five-seat limit,
   current manager roster and founder application reads on the target chain.
2. Configure `LAUNCHPAD_CURATION_RPC_URL` to one trusted, chain-homogeneous
   node. The backend checks network ID, sync state and a block less than two
   minutes old for every request. A stale or unavailable node makes the inbox
   unavailable. Do not put a mixed-chain load balancer behind this URL.
3. Approve a private-content retention, export and deletion policy; complete
   the key rotation and restore procedure; review the founder-facing terms and
   abuse escalation path. No automatic retention purge or attachment service
   is implemented yet.
4. Rehearse with two wallets: founder application, manager appointment,
   message exchange, conflict mark, immediate manager removal, and denied
   reads/writes after removal. Check wrong-chain and chainless tokens fail.
5. Only after the above, store a dedicated 32-byte key as
   `LAUNCHPAD_CURATION_INBOX_KEY_HEX` (64 hexadecimal characters) in the secret
   manager. Never reuse `ED25519_SEED`. Enable both
   `LAUNCHPAD_CURATION_ACCESS_ENABLED=1` and
   `LAUNCHPAD_CURATION_INBOX_ENABLED=1` in a monitored canary.

## Data and recovery

The SQLite database stores AES-GCM ciphertext and a random nonce for each
message. The associated data binds its chain, collection, message ID, sender,
application revision and timestamp. Wallet addresses, collection IDs,
timestamps and read/send audit metadata remain visible to database operators.
Back up the database and its key under separate access controls; losing the
key makes message contents unreadable. Database restore must preserve the
matching key. Key compromise requires a separately reviewed re-encryption
migration before wider use.

Each send requires a random 32-character hexadecimal `clientId`. Repeating the
same ID with the same message returns the existing result; reusing it with
different content fails. The UI must retain that ID across uncertain outcomes
and fetch the thread before offering another send. Message text is limited to
4,000 UTF-8 bytes. Attachments are not accepted by this API.

## Monitoring and emergency response

Monitor rate-limit responses, unavailable-role responses, stale RPC status,
decryption failures and the metadata-only audit table. Never log bearer tokens
or message content. If access evidence is unreliable, disable
`LAUNCHPAD_CURATION_INBOX_ENABLED`, restore the RPC/key only after checking
the chain and backups, then re-enable under a canary. For a compromised manager,
the DAO removes the seat or marks a collection conflict; verify the curation
getter immediately denies that wallet before resuming the inbox. The frontend
must never use a cached manager badge as authorization.
