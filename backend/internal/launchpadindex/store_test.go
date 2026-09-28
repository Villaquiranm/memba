package launchpadindex

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/samouraiworld/memba/backend/internal/db"
	_ "modernc.org/sqlite"
)

func testScope(chain, publication string) Scope {
	return Scope{
		ChainID: chain, RealmPath: TokenRealmPath,
		PublicationHeight: 100, PublicationHash: [32]byte{1},
		PublicationIdentity: publication,
	}
}

func testHeader(height int64, hash, parent byte) BlockHeader {
	return BlockHeader{
		ChainID: "test-13", Height: height, Hash: [32]byte{hash},
		ParentHash: [32]byte{parent}, Time: time.Date(2026, 9, 28, 1, 2, 3, 0, time.UTC),
	}
}

func testStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	database, err := db.Open(filepath.Join(t.TempDir(), "memba.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := MigrateStore(context.Background(), database); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(context.Background(), database, testScope("test-13", "publication-a"))
	if err != nil {
		t.Fatal(err)
	}
	return store, database
}

func testCreation(t *testing.T, height int64, id string) ObservedCreation {
	t.Helper()
	attrs := validEvent(t, id)
	if id == "T2" {
		attrs[2].Value = TokenRealmPath + ".T2.0000002"
	}
	created, err := ParseTokenCreated(TokenRealmPath, TokenCreatedType, attrs)
	if err != nil {
		t.Fatal(err)
	}
	return ObservedCreation{TokenCreated: created, BlockHeight: height, TxIndex: 0,
		EventIndex: 0, RawAttributes: attrs}
}

func TestStoreAppendReplayRollbackAndIsolation(t *testing.T) {
	ctx := context.Background()
	store, database := testStore(t)
	empty := testHeader(101, 2, 1)
	if err := store.AppendBlock(ctx, empty, nil); err != nil {
		t.Fatal(err)
	}
	created := testCreation(t, 102, "T1")
	block := testHeader(102, 3, 2)
	if err := store.AppendBlock(ctx, block, []ObservedCreation{created}); err != nil {
		t.Fatal(err)
	}
	second := testCreation(t, 103, "T2")
	if err := store.AppendBlock(ctx, testHeader(103, 4, 3), []ObservedCreation{second}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendBlock(ctx, block, []ObservedCreation{created}); err != nil {
		t.Fatalf("idempotent replay: %v", err)
	}
	conflict := block
	conflict.Hash = [32]byte{4}
	if err := store.AppendBlock(ctx, conflict, []ObservedCreation{created}); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("conflicting replay: %v", err)
	}
	if err := store.RollbackTo(ctx, Cursor{Height: 100, Hash: [32]byte{9}}); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("wrong anchor: %v", err)
	}
	if err := store.RollbackTo(ctx, Cursor{Height: 99, Hash: [32]byte{1}}); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("rollback below anchor: %v", err)
	}
	if err := store.RollbackTo(ctx, Cursor{Height: 101, Hash: empty.Hash}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM launchpad_creation_events WHERE scope_key = ?`, store.key).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback kept event: count=%d err=%v", count, err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM launchpad_blocks WHERE scope_key = ?`, store.key).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rollback kept divergent block: count=%d err=%v", count, err)
	}
	newBlock := testHeader(102, 5, 2)
	newBlock.Time = newBlock.Time.Add(time.Minute)
	if err := store.AppendBlock(ctx, newBlock, []ObservedCreation{created}); err != nil {
		t.Fatalf("append after reorg: %v", err)
	}
	newTip := testHeader(103, 6, 5)
	newTip.Time = newTip.Time.Add(time.Minute)
	if err := store.AppendBlock(ctx, newTip, []ObservedCreation{second}); err != nil {
		t.Fatalf("same ticker with distinct token ID: %v", err)
	}
	var replacementTime string
	if err := database.QueryRowContext(ctx, `SELECT header_time FROM launchpad_blocks WHERE scope_key = ? AND height = 102`, store.key).
		Scan(&replacementTime); err != nil || replacementTime != newBlock.Time.Format(time.RFC3339Nano) {
		t.Fatalf("stale fork time survived replacement: %q %v", replacementTime, err)
	}
	other, err := OpenStore(ctx, database, testScope("gnoland-1", "publication-a"))
	if err != nil {
		t.Fatal(err)
	}
	otherEvent := created
	otherEvent.BlockHeight = 101
	otherBlock := testHeader(101, 7, 1)
	otherBlock.ChainID = "gnoland-1"
	if err := other.AppendBlock(ctx, otherBlock, []ObservedCreation{otherEvent}); err != nil {
		t.Fatalf("same T1 on another chain: %v", err)
	}
	generation, err := OpenStore(ctx, database, testScope("test-13", "publication-b"))
	if err != nil {
		t.Fatal(err)
	}
	if err := generation.AppendBlock(ctx, testHeader(101, 8, 1), []ObservedCreation{otherEvent}); err != nil {
		t.Fatalf("same T1 in another publication generation: %v", err)
	}
}

func TestStoreAppendAtomicOnDuplicateAndMalformedEvidence(t *testing.T) {
	ctx := context.Background()
	store, database := testStore(t)
	first := testCreation(t, 101, "T1")
	if err := store.AppendBlock(ctx, testHeader(101, 2, 1), []ObservedCreation{first}); err != nil {
		t.Fatal(err)
	}
	duplicate := first
	duplicate.BlockHeight = 102
	if err := store.AppendBlock(ctx, testHeader(102, 3, 2), []ObservedCreation{duplicate}); err == nil {
		t.Fatal("duplicate T1 committed")
	}
	cursor, err := store.Cursor(ctx)
	if err != nil || cursor.Height != 101 {
		t.Fatalf("cursor advanced after failed insert: %+v %v", cursor, err)
	}
	var blocks int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM launchpad_blocks WHERE scope_key = ?`, store.key).Scan(&blocks); err != nil || blocks != 1 {
		t.Fatalf("partial block committed: %d %v", blocks, err)
	}
	bad := testCreation(t, 102, "T2")
	bad.RawAttributes[0].Value = "T3"
	if err := store.AppendBlock(ctx, testHeader(102, 3, 2), []ObservedCreation{bad}); !errors.Is(err, ErrInvalidBlock) {
		t.Fatalf("forged event accepted: %v", err)
	}
	if err := store.AppendBlock(ctx, testHeader(103, 4, 3), nil); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("height gap accepted: %v", err)
	}
	if err := store.AppendBlock(ctx, testHeader(102, 3, 9), nil); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("parent mismatch accepted: %v", err)
	}
}

func TestStoreRejectsAlteredReplayEvidence(t *testing.T) {
	ctx := context.Background()
	store, database := testStore(t)
	header := testHeader(101, 2, 1)
	event := testCreation(t, 101, "T1")
	if err := store.AppendBlock(ctx, header, []ObservedCreation{event}); err != nil {
		t.Fatal(err)
	}
	reordered := event
	reordered.RawAttributes = append([]Attribute(nil), event.RawAttributes...)
	reordered.RawAttributes[0], reordered.RawAttributes[1] = reordered.RawAttributes[1], reordered.RawAttributes[0]
	if err := store.AppendBlock(ctx, header, []ObservedCreation{reordered}); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("raw attribute reorder accepted: %v", err)
	}
	changed := testCreation(t, 101, "T2")
	if err := store.AppendBlock(ctx, header, []ObservedCreation{changed}); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("changed event identity accepted: %v", err)
	}
	if err := store.AppendBlock(ctx, header, nil); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("missing replay event accepted: %v", err)
	}
	cursor, err := store.Cursor(ctx)
	if err != nil || cursor.Height != 101 || cursor.Hash != header.Hash {
		t.Fatalf("replay changed cursor: %+v %v", cursor, err)
	}
	var tokenID string
	if err := database.QueryRowContext(ctx, `SELECT token_id FROM launchpad_creation_events WHERE scope_key = ?`, store.key).
		Scan(&tokenID); err != nil || tokenID != "T1" {
		t.Fatalf("replay changed durable event: %q %v", tokenID, err)
	}
}

func TestStoreRollbackToPublicationAnchor(t *testing.T) {
	ctx := context.Background()
	store, database := testStore(t)
	if err := store.AppendBlock(ctx, testHeader(101, 2, 1), []ObservedCreation{testCreation(t, 101, "T1")}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendBlock(ctx, testHeader(102, 3, 2), nil); err != nil {
		t.Fatal(err)
	}
	if err := store.RollbackTo(ctx, Cursor{Height: 100, Hash: [32]byte{1}}); err != nil {
		t.Fatal(err)
	}
	var blocks, events int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM launchpad_blocks WHERE scope_key = ?`, store.key).Scan(&blocks); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM launchpad_creation_events WHERE scope_key = ?`, store.key).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if blocks != 0 || events != 0 {
		t.Fatalf("anchor rollback kept descendants: blocks=%d events=%d", blocks, events)
	}
	replacement := testHeader(101, 4, 1)
	if err := store.AppendBlock(ctx, replacement, []ObservedCreation{testCreation(t, 101, "T1")}); err != nil {
		t.Fatalf("append replacement above anchor: %v", err)
	}
	cursor, err := store.Cursor(ctx)
	if err != nil || cursor.Height != 101 || cursor.Hash != replacement.Hash {
		t.Fatalf("replacement cursor: %+v %v", cursor, err)
	}
}

func TestStoreSchemaCoexistsWithBackedUpMembaDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "memba.sqlite")
	first, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(first); err != nil {
		t.Fatal(err)
	}
	if err := MigrateStore(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := MigrateStore(ctx, first); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	store, err := OpenStore(ctx, first, testScope("test-13", "publication-a"))
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := store.Cursor(ctx)
	if err != nil || cursor.Height != 100 || cursor.Hash != ([32]byte{1}) {
		t.Fatalf("initial cursor: %+v, %v", cursor, err)
	}
	if err := store.AppendBlock(ctx, testHeader(101, 2, 1), []ObservedCreation{testCreation(t, 101, "T1")}); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	if err := db.Migrate(second); err != nil {
		t.Fatal(err)
	}
	if err := MigrateStore(ctx, second); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(ctx, second, testScope("test-13", "publication-a"))
	if err != nil {
		t.Fatal(err)
	}
	cursor, err = reopened.Cursor(ctx)
	if err != nil || cursor.Height != 101 || cursor.Hash != ([32]byte{2}) {
		t.Fatalf("reopened cursor: %+v, %v", cursor, err)
	}
	var storedTime, rawAttrs string
	if err := second.QueryRowContext(ctx, `SELECT b.header_time, e.raw_attrs_json
		FROM launchpad_blocks b JOIN launchpad_creation_events e
		ON e.scope_key = b.scope_key AND e.height = b.height WHERE b.scope_key = ?`, reopened.key).
		Scan(&storedTime, &rawAttrs); err != nil || storedTime != testHeader(101, 2, 1).Time.Format(time.RFC3339Nano) || rawAttrs == "" {
		t.Fatalf("reopened block evidence: time=%q attrs=%q err=%v", storedTime, rawAttrs, err)
	}
	var appMigrations int
	if err := second.QueryRowContext(ctx, `SELECT COUNT(*) FROM _migrations`).Scan(&appMigrations); err != nil || appMigrations == 0 {
		t.Fatalf("normal migrations unavailable: count=%d err=%v", appMigrations, err)
	}
}

func TestStoreScopeIsolationAndSchemaDrift(t *testing.T) {
	ctx := context.Background()
	database, err := db.Open(filepath.Join(t.TempDir(), "memba.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := MigrateStore(ctx, database); err != nil {
		t.Fatal(err)
	}
	a, err := OpenStore(ctx, database, testScope("test-13", "publication-a"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := OpenStore(ctx, database, testScope("gnoland-1", "publication-a"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := OpenStore(ctx, database, testScope("test-13", "publication-b"))
	if err != nil {
		t.Fatal(err)
	}
	if a.key == b.key || a.key == c.key || b.key == c.key {
		t.Fatal("chain or publication generation reused a scope key")
	}
	if _, err := OpenStore(ctx, database, Scope{ChainID: "test-13", RealmPath: TokenRealmPath}); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("unanchored scope accepted: %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE launchpad_schema_versions SET checksum = ? WHERE version = 1`,
		"0000000000000000000000000000000000000000000000000000000000000000"); err != nil {
		t.Fatal(err)
	}
	if err := MigrateStore(ctx, database); !errors.Is(err, ErrStoreSchema) {
		t.Fatalf("schema drift accepted: %v", err)
	}
}
