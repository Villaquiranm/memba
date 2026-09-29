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
3. Approve a private-content retention, export and deletion policy, including
   the backup window; complete the key rotation and restore procedure; review
   the founder-facing terms and abuse escalation path. No attachment service
   is implemented.
4. Rehearse with two wallets: founder application, manager appointment,
   message exchange, conflict mark, immediate manager removal, and denied
   reads/writes after removal. Check wrong-chain and chainless tokens fail.
5. Only after the above, store a dedicated 32-byte key as
   `LAUNCHPAD_CURATION_INBOX_KEY_HEX` (64 hexadecimal characters) in the secret
   manager. Set `LAUNCHPAD_CURATION_INBOX_RETENTION_DAYS` to the approved
   integer policy (1–365); absent or invalid values keep the inbox disabled.
   Never reuse `ED25519_SEED`. Enable both
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

At startup, hourly, and on each authorized request, the service deletes
expired messages and read/send audit metadata for its configured chain. Reads
also filter by the retention cutoff if a sweep has not yet completed. This
deletes rows from the live SQLite database; it does not erase prior WAL pages,
SQLite free pages, logs, or off-volume Litestream snapshots. The current
off-volume backup retention is 168 hours. Set the approved policy and backup
handling before activation, and use a separately reviewed secure purge/export
procedure for legal deletion requests. An unavailable database disables the
inbox rather than serving stale content.

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
